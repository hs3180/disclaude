"""Remote-only regressions for the verified nbmodel overlay.

Run inside the existing Jupyter deployment or its candidate image. These tests
load staged source into this test process; they do not patch a running server,
create kernels or write user Notebooks.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import nbformat
import jupyter_server_nbmodel
from pycrdt import Doc
from jupyter_ydoc.ynotebook import YNotebook


def load_module(name, filename):
    source = Path(filename).read_text()
    compile(source, str(filename), "exec")
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    setattr(jupyter_server_nbmodel, name.rsplit(".", 1)[1], module)
    return module


parser = argparse.ArgumentParser()
parser.add_argument("--staged", required=True)
args, remaining = parser.parse_known_args()
staged = Path(args.staged)
runtime = load_module("jupyter_server_nbmodel.runtime", staged / "runtime.py")
actions = load_module("jupyter_server_nbmodel.actions", staged / "actions.py")
stack_module = load_module("jupyter_server_nbmodel.execution_stack", staged / "execution_stack.py")
for name in ("handlers", "extension"):
    load_module(f"jupyter_server_nbmodel.{name}", staged / f"{name}.py")


def notebook():
    value = YNotebook(Doc())
    value.set(nbformat.v4.new_notebook(cells=[
        nbformat.v4.new_code_cell("print('first')", id="first", metadata={"custom": {"keep": True}}),
        nbformat.v4.new_code_cell("print('second')", id="second"),
        nbformat.v4.new_markdown_cell("human content", id="human", attachments={"keep.txt": {"text/plain": "keep"}}),
    ], metadata={"custom": "keep"}))
    return value


def metadata(cell="first", source="print('first')", uid="original"):
    return {"document_id": "json:notebook:document", "cell_id": cell,
            "request_id": uid, "kernel_id": "kernel", "kernel_incarnation": "incarnation-1",
            "source_hash": hashlib.sha256(source.encode()).hexdigest()}


def message(kind, **content):
    return {"header": {"msg_type": kind, "session": "incarnation-1"}, "content": content}


def output_text(outputs):
    return "".join(o.get("text", "") for o in outputs)


class RetentionTests(unittest.IsolatedAsyncioTestCase):
    async def test_non_consuming_snapshots_do_not_extend_ttl(self):
        now = [0]
        results = runtime.RetainedResults(10, 2, 1024, clock=lambda: now[0])
        await results.finish("original", {"status": "ok", "outputs": "[]", "nested": {"value": 1}})
        first = results.snapshot("original")
        first["nested"]["value"] = 9
        now[0] = 9
        self.assertEqual(results.snapshot("original")["nested"]["value"], 1)
        now[0] = 10
        with self.assertRaises(runtime.ResultExpired):
            results.snapshot("original")
        self.assertEqual(len(results), 0)

    async def test_quota_refuses_admission_without_evicting_unexpired_results(self):
        results = runtime.RetainedResults(10, 1, 1024)
        await results.finish("original", {"status": "ok", "outputs": "[]"})
        with self.assertRaises(runtime.ResultQuotaExceeded):
            results.admit()
        self.assertEqual(results.snapshot("original")["status"], "ok")

    async def test_pending_requests_do_not_expire(self):
        now = [0]
        results = runtime.RetainedResults(10, 2, 1024, clock=lambda: now[0])
        results["pending"] = {"pending": True, "outputs": []}
        now[0] = 100
        self.assertEqual(results.prune(), [])
        self.assertIn("pending", results)

    async def test_oversized_payload_has_complete_artifact_and_bounded_status(self):
        saved = []
        async def archive(uid, result):
            saved.append((uid, result))
            return "nbmodel-results/kernel/original.json"
        results = runtime.RetainedResults(10, 2, 1024, archive=archive)
        complete = {"status": "ok", "outputs": json.dumps([{"output_type": "stream", "text": "x" * 4000}]),
                    "source": "print('original')", "source_hash": "original-source", "kernel_incarnation": "incarnation-1"}
        await results.finish("original", complete)
        preview = results.snapshot("original")
        self.assertTrue(preview["outputs_truncated"])
        self.assertEqual(preview["result_artifact"], "nbmodel-results/kernel/original.json")
        self.assertEqual(saved[0][1], complete)
        self.assertLess(len(json.dumps(preview)), 1024)
        self.assertTrue(results.progress([{"text": "x" * 4000}])["result_artifact_pending"])

    async def test_oversized_payload_without_archive_is_an_explicit_failure(self):
        results = runtime.RetainedResults(10, 2, 1024)
        with self.assertRaisesRegex(RuntimeError, "artifact store"):
            await results.finish("original", {"outputs": "x" * 2000})


class FakeClient:
    allow_stdin = False
    def __init__(self):
        self.started = []
        self.release = asyncio.Event()
        self.ready = asyncio.Event()
        self.ready.set()
        self.interrupted = False
        self.incarnation = "incarnation-1"
        self.hook = None

    def kernel_info(self):
        return "native-info"

    async def get_shell_msg(self, **kwargs):
        return {"header": {"msg_type": "kernel_info_reply", "session": self.incarnation},
                "parent_header": {"msg_id": "native-info"}}

    async def wait_for_ready(self, **kwargs):
        await self.ready.wait()
        self.interrupted = False

    async def execute_interactive(self, source, output_hook, stdin_hook, allow_stdin=False):
        self.started.append(source)
        output_hook(message("stream", name="stdout", text="started\n"))
        if self.hook:
            self.hook()
        if source == "slow":
            await self.release.wait()
        if self.interrupted:
            self.interrupted = False
            output_hook(message("error", ename="KeyboardInterrupt", evalue="", traceback=[]))
            return {"content": {"status": "error", "execution_count": len(self.started)}}
        return {"content": {"status": "ok", "execution_count": len(self.started)}}


async def until(predicate):
    for _ in range(500):
        if predicate():
            return
        await asyncio.sleep(0.002)
    raise AssertionError("Test fixture did not reach expected state")


class CancellationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.results = runtime.RetainedResults(10, 10, 65536)
        self.control = runtime.ExecutionControl()
        self.queue = asyncio.Queue()
        self.client = FakeClient()
        self.interrupts = 0
        self.pid = 123
        self.worker = asyncio.create_task(actions.kernel_worker(
            "kernel", self.client, None, self.queue, self.results, stack_module.PendingInput(),
            self.control, lambda: self.pid))

    async def asyncTearDown(self):
        self.client.release.set()
        self.client.ready.set()
        self.worker.cancel()
        await asyncio.gather(self.worker, return_exceptions=True)

    def put(self, uid, source):
        self.results[uid] = stack_module.NO_RESULT
        self.queue.put_nowait((uid, source, {"source_hash": hashlib.sha256(source.encode()).hexdigest()}))

    async def interrupt(self):
        self.interrupts += 1
        self.client.interrupted = True
        self.client.release.set()

    async def cancel(self, uid):
        await runtime.cancel_target(self.control, self.results, uid, self.interrupt, lambda: self.pid)

    async def test_queued_target_does_not_interrupt_running_request(self):
        self.put("A", "slow")
        await until(lambda: self.control.phase == "running")
        self.put("B", "never")
        await self.cancel("B")
        self.assertEqual(self.interrupts, 0)
        self.client.release.set()
        await self.queue.join()
        self.assertEqual(self.client.started, ["slow"])
        self.assertEqual(self.results["A"]["status"], "ok")
        self.assertEqual(self.results["B"]["error"]["ename"], "CancelledError")

    async def test_finished_target_does_not_interrupt_next_running_request(self):
        self.put("A", "quick")
        await self.queue.join()
        self.put("B", "slow")
        await until(lambda: self.control.active_id == "B" and self.control.phase == "running")
        await self.cancel("A")
        self.assertEqual(self.interrupts, 0)
        self.client.release.set()
        await self.queue.join()
        self.assertEqual(self.results["B"]["status"], "ok")

    async def test_running_cancel_waits_for_readiness_before_next_dispatch(self):
        self.put("A", "slow")
        await until(lambda: self.control.phase == "running")
        self.put("B", "next")
        self.client.ready.clear()
        await self.cancel("A")
        await asyncio.sleep(0.02)
        self.assertEqual(self.client.started, ["slow"])
        self.client.ready.set()
        await self.queue.join()
        self.assertEqual(self.results["A"]["status"], "error")
        self.assertTrue(self.results["A"]["cancellation_requested"])
        self.assertEqual(self.results["B"]["status"], "ok")

    async def test_repeated_running_cancel_sends_only_one_interrupt(self):
        self.put("A", "slow")
        await until(lambda: self.control.phase == "running")
        await self.cancel("A")
        await self.cancel("A")
        await self.queue.join()
        self.assertEqual(self.interrupts, 1)

    async def test_failed_readiness_preserves_native_result_and_blocks_next_request(self):
        self.put("A", "slow")
        await until(lambda: self.control.phase == "running")
        self.put("B", "never")
        async def fail_ready(**kwargs):
            raise TimeoutError("readiness failed")
        self.client.wait_for_ready = fail_ready
        await self.cancel("A")
        await self.queue.join()
        await self.worker
        self.assertEqual(self.client.started, ["slow"])
        self.assertEqual(self.results["A"]["status"], "error")
        self.assertIn("KeyboardInterrupt", self.results["A"]["outputs"])
        self.assertFalse(self.results["A"]["kernel_ready"])
        self.assertEqual(self.results["A"]["continuation_error"]["ename"], "KernelReadinessUnverified")
        self.assertFalse(self.results["B"]["execution_started"])
        self.assertTrue(self.control.quarantined)

    async def test_native_restart_during_cancel_preserves_original_incarnation(self):
        self.put("A", "slow")
        await until(lambda: self.control.phase == "running")
        self.client.incarnation = "replacement-instance"
        await self.cancel("A")
        await self.queue.join()
        await self.worker
        self.assertEqual(self.results["A"]["kernel_incarnation"], "incarnation-1")
        self.assertFalse(self.results["A"]["kernel_ready"])
        self.assertTrue(self.control.quarantined)

    async def test_completion_race_does_not_interrupt_following_request(self):
        self.put("A", "quick")
        self.put("B", "slow")
        await until(lambda: self.control.active_id == "B" and self.control.phase == "running")
        await self.cancel("A")
        self.assertEqual(self.interrupts, 0)
        self.client.release.set()
        await self.queue.join()
        self.assertEqual(self.results["A"]["status"], "ok")
        self.assertEqual(self.results["B"]["status"], "ok")

    async def test_native_completion_during_stop_retains_ok_and_only_targets_original(self):
        self.put("A", "slow")
        await until(lambda: self.control.phase == "running")
        self.put("B", "next")
        async def raced_interrupt():
            self.interrupts += 1
            self.client.release.set()
            await asyncio.sleep(0)
        await runtime.cancel_target(self.control, self.results, "A", raced_interrupt, lambda: self.pid)
        await self.queue.join()
        self.assertEqual(self.interrupts, 1)
        self.assertEqual(self.results["A"]["status"], "ok")
        self.assertTrue(self.results["A"]["cancellation_requested"])
        self.assertEqual(self.results["B"]["status"], "ok")

    async def test_preparing_cancel_does_not_dispatch_or_interrupt(self):
        prepared = asyncio.Event()
        release = asyncio.Event()
        async def get_cell(ydoc, metadata, documents):
            if metadata["request_id"] == "A":
                prepared.set()
                await release.wait()
            return None
        with patch.object(actions, "_get_ycell", get_cell):
            self.put("A", "never")
            await prepared.wait()
            self.put("B", "next")
            await self.cancel("A")
            release.set()
            await self.queue.join()
        self.assertEqual(self.interrupts, 0)
        self.assertEqual(self.client.started, ["next"])
        self.assertFalse(self.results["A"]["execution_started"])
        self.assertEqual(self.results["B"]["status"], "ok")

    async def test_unknown_request_does_not_interrupt(self):
        with self.assertRaises(ValueError):
            await self.cancel("missing")
        self.assertEqual(self.interrupts, 0)

    async def test_changed_kernel_process_refuses_interrupt(self):
        self.put("A", "slow")
        await until(lambda: self.control.phase == "running")
        self.pid = 456
        with self.assertRaises(runtime.TargetChanged):
            await self.cancel("A")
        self.assertEqual(self.interrupts, 0)

    async def test_expected_native_incarnation_mismatch_does_not_execute(self):
        self.results["A"] = stack_module.NO_RESULT
        self.queue.put_nowait(("A", "never", {"kernel_incarnation": "old-instance"}))
        await self.queue.join()
        self.assertEqual(self.client.started, [])
        self.assertFalse(self.results["A"]["execution_started"])


class OutputTests(unittest.TestCase):
    def setUp(self):
        self.doc = notebook()
        self.outputs = []
        self.state = actions._StreamState()
        self.registry = {}
        self.context = runtime.OutputContext(self.doc, "print('first')", metadata(), self.registry)
        self.cell = self.context.begin()

    def emit(self, kind, **content):
        actions._output_hook(self.outputs, self.cell, self.state, message(kind, **content), self.context)

    def test_wait_true_keeps_outputs_until_next_output(self):
        self.emit("stream", name="stdout", text="before")
        self.emit("clear_output", wait=True)
        self.assertEqual(output_text(self.outputs), "before")
        self.assertEqual(output_text(self.cell["outputs"].to_py()), "before")
        self.emit("stream", name="stdout", text="after")
        self.assertEqual(output_text(self.outputs), "after")
        self.assertEqual(output_text(self.cell["outputs"].to_py()), "after")

    def test_wait_false_clears_immediately(self):
        self.emit("stream", name="stdout", text="before")
        self.emit("clear_output", wait=False)
        self.assertEqual(self.outputs, [])
        self.assertEqual(self.cell["outputs"].to_py(), [])

    def test_display_id_updates_multiple_positions(self):
        for _ in range(2):
            self.emit("display_data", data={"text/plain": "before"}, metadata={"custom": 1}, transient={"display_id": "shared"})
        self.emit("update_display_data", data={"text/plain": "after", "text/html": "<b>after</b>"}, metadata={"custom": 2}, transient={"display_id": "shared"})
        self.assertEqual(len(self.outputs), 2)
        self.assertEqual(len(self.cell["outputs"]), 2)
        for output in self.outputs + self.cell["outputs"].to_py():
            self.assertEqual(output["data"]["text/plain"], "after")
            self.assertEqual(output["metadata"]["custom"], 2)

    def test_display_update_reaches_another_cell_in_same_notebook(self):
        self.emit("display_data", data={"text/plain": "before"}, metadata={}, transient={"display_id": "shared"})
        self.context.finish()
        second = runtime.OutputContext(self.doc, "print('second')", metadata("second", "print('second')", "next"), self.registry)
        second_cell = second.begin()
        actions._output_hook([], second_cell, actions._StreamState(), message("update_display_data", data={"text/plain": "after"}, metadata={}, transient={"display_id": "shared"}), second)
        self.assertEqual(self.cell["outputs"].to_py()[0]["data"]["text/plain"], "after")

    def test_source_change_detaches_outputs_and_keeps_original_history(self):
        self.emit("stream", name="stdout", text="old result")
        source = self.cell["source"]
        source += " # human edit"
        self.emit("stream", name="stdout", text=" still original")
        self.context.finish()
        self.assertEqual(self.cell["outputs"].to_py(), [])
        self.assertIn("human edit", str(self.cell["source"]))
        self.assertEqual(output_text(self.outputs), "old result still original")
        self.assertEqual(self.cell["metadata"][self.context.provenance_key]["resultState"], "historical")
        self.assertEqual(self.cell["metadata"]["custom"], {"keep": True})
        self.assertEqual(self.doc.source["cells"][2]["attachments"]["keep.txt"], {"text/plain": "keep"})

    def test_deleted_cell_does_not_write_into_another_cell(self):
        del self.doc.ycells[0]
        self.emit("stream", name="stdout", text="historical")
        self.context.finish()
        self.assertTrue(self.context.stale)
        self.assertEqual(self.doc.ycells[0]["outputs"].to_py(), [])
        self.assertEqual(output_text(self.outputs), "historical")

    def test_stream_controls_and_error_structure_are_preserved(self):
        self.emit("stream", name="stdout", text="progress 1\rprogress 2\n")
        self.emit("stream", name="stderr", text="warning\n")
        self.emit("error", ename="ValueError", evalue="example", traceback=["trace"])
        outputs = self.cell["outputs"].to_py()
        self.assertEqual(outputs[0]["text"], "progress 2\n")
        self.assertEqual(outputs[1]["name"], "stderr")
        self.assertEqual(outputs[2]["ename"], "ValueError")
        self.assertEqual(outputs[2]["traceback"], ["trace"])


class StackTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = FakeClient()
        self.client.stop_channels = lambda: None
        async def interrupt_kernel(kernel_id):
            self.client.interrupted = True
            self.client.release.set()
        manager = SimpleNamespace(get_kernel=lambda kernel_id: SimpleNamespace(
            client=lambda: self.client, provisioner=SimpleNamespace(pid=123)),
            interrupt_kernel=interrupt_kernel)
        self.stack = stack_module.ExecutionStack(manager, None, result_max_records=2)

    async def asyncTearDown(self):
        self.client.release.set()
        for queue in self.stack._ExecutionStack__tasks.values():
            await queue.join()
        await self.stack.dispose()

    async def test_original_terminal_gets_retain_context_and_result(self):
        uid = self.stack.put("kernel", "quick", {"cell_id": "first", "document_id": "document"})
        await until(lambda: isinstance(self.stack._ExecutionStack__execution_results["kernel"][uid], dict)
                    and self.stack._ExecutionStack__execution_results["kernel"][uid].get("pending") is not True)
        first = self.stack.get("kernel", uid)
        second = self.stack.get("kernel", uid)
        self.assertEqual(first, second)
        self.assertEqual(first["source"], "quick")
        self.assertEqual(first["document_id"], "document")
        self.assertEqual(first["source_hash"], hashlib.sha256(b"quick").hexdigest())
        self.assertEqual(first["kernel_incarnation"], "incarnation-1")

    async def test_global_quota_refuses_another_kernel_without_evicting(self):
        first = self.stack.put("kernel", "quick")
        second = self.stack.put("kernel", "quick")
        with self.assertRaises(runtime.ResultQuotaExceeded):
            self.stack.put("other-kernel", "never")
        await self.stack._ExecutionStack__tasks["kernel"].join()
        self.assertEqual(self.stack.get("kernel", first)["status"], "ok")
        self.assertEqual(self.stack.get("kernel", second)["status"], "ok")

    async def test_missing_queue_read_creates_no_kernel_or_worker(self):
        self.assertEqual(self.stack.pending("unowned-random-kernel"), [])
        self.assertEqual(self.stack._ExecutionStack__kernel_clients, {})
        self.assertEqual(self.stack._ExecutionStack__workers, {})
        policy = self.stack.execution_policy()
        self.assertEqual(policy["terminal_gets"], "non_consuming")
        self.assertEqual(policy["request_quota"], 2)
        self.assertEqual(self.stack._ExecutionStack__workers, {})

    async def test_failed_readiness_refuses_new_submission_without_worker_restart(self):
        uid = self.stack.put("kernel", "slow")
        await until(lambda: self.client.started == ["slow"])
        async def fail_ready(**kwargs):
            raise TimeoutError("readiness failed")
        self.client.wait_for_ready = fail_ready
        await self.stack.interrupt("kernel", uid)
        await self.stack._ExecutionStack__tasks["kernel"].join()
        worker = self.stack._ExecutionStack__workers["kernel"]
        await worker
        with self.assertRaisesRegex(runtime.TargetChanged, "dispatch refused"):
            self.stack.put("kernel", "never")
        self.assertIs(self.stack._ExecutionStack__workers["kernel"], worker)
        self.assertEqual(self.client.started, ["slow"])
        self.assertFalse(self.stack.get("kernel", uid)["kernel_ready"])

    async def test_stdin_opt_out_reaches_native_execute_request(self):
        self.client.allow_stdin = True
        received = []
        original = self.client.execute_interactive
        async def execute(source, output_hook, stdin_hook, allow_stdin=False):
            received.append((stdin_hook, allow_stdin))
            return await original(source, output_hook, stdin_hook, allow_stdin=allow_stdin)
        self.client.execute_interactive = execute
        uid = self.stack.put("kernel", "quick", {"allow_stdin": False})
        await self.stack._ExecutionStack__tasks["kernel"].join()
        self.assertEqual(received, [(None, False)])
        self.assertEqual(self.stack.get("kernel", uid)["status"], "ok")


class LiveSourceTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_move_rebinds_source_observer_and_preserves_original_history(self):
        doc = notebook()
        ctx = runtime.OutputContext(doc, "print('first')", metadata(), {})
        cell = ctx.begin()
        outputs = []
        actions._output_hook(outputs, cell, actions._StreamState(), message("stream", name="stdout", text="original"), ctx)
        clone = doc.get_cell(0)
        with doc.ycells.doc.transaction():
            del doc.ycells[0]
            doc.ycells.insert(1, doc.create_ycell(clone))
        await asyncio.sleep(0)
        moved = doc.ycells[1]
        self.assertEqual(moved["id"], "first")
        self.assertEqual(output_text(moved["outputs"].to_py()), "original")
        source = moved["source"]
        source += " # human edit after move"
        await asyncio.sleep(0)
        self.assertEqual(moved["outputs"].to_py(), [])
        self.assertEqual(output_text(outputs), "original")
        self.assertTrue(ctx.stale)
        ctx.finish()

    async def test_finish_does_not_recreate_a_subscription_from_a_pending_move_callback(self):
        doc = notebook()
        ctx = runtime.OutputContext(doc, "print('first')", metadata(), {})
        ctx.begin()
        clone = doc.get_cell(0)
        with doc.ycells.doc.transaction():
            del doc.ycells[0]
            doc.ycells.insert(1, doc.create_ycell(clone))
        ctx.finish()
        await asyncio.sleep(0)
        self.assertIsNone(ctx.source_subscription)
        self.assertIsNone(ctx.cells_subscription)

    async def test_deleted_cell_does_not_write_into_another_stable_cell(self):
        doc = notebook()
        ctx = runtime.OutputContext(doc, "print('first')", metadata(), {})
        cell = ctx.begin()
        outputs = []
        state = actions._StreamState()
        del doc.ycells[0]
        await asyncio.sleep(0)
        actions._output_hook(outputs, cell, state, message("stream", name="stdout", text="deleted original"), ctx)
        self.assertEqual(doc.ycells[0]["id"], "second")
        self.assertEqual(doc.ycells[0]["outputs"].to_py(), [])
        self.assertEqual(output_text(outputs), "deleted original")
        self.assertTrue(ctx.stale)
        ctx.finish()

    async def test_source_edit_clears_current_outputs_before_another_kernel_message(self):
        doc = notebook()
        ctx = runtime.OutputContext(doc, "print('first')", metadata(), {})
        cell = ctx.begin()
        outputs = []
        actions._output_hook(outputs, cell, actions._StreamState(), message("stream", name="stdout", text="original"), ctx)
        source = cell["source"]
        source += " # live human edit"
        await asyncio.sleep(0)
        self.assertEqual(cell["outputs"].to_py(), [])
        self.assertEqual(output_text(outputs), "original")
        self.assertTrue(ctx.stale)
        ctx.finish()

    async def test_cleaned_document_is_loaded_with_supported_create_option(self):
        doc = notebook()
        calls = []
        async def get_document(**kwargs):
            calls.append(kwargs)
            self.assertTrue(kwargs["create"])
            return doc
        extension = SimpleNamespace(get_document=get_document)
        documents = []
        result = await actions._get_ycell(extension, metadata(), documents)
        self.assertEqual(result["id"], "first")
        self.assertEqual(documents, [doc])
        self.assertEqual(calls[0]["room_id"], "json:notebook:document")


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *remaining])

"""One native Jupyter client queue per managed Notebook kernel.

Jupyter's execute_interactive waits for the matching IOPub idle and shell
reply. A separate native subscriber observes external runs and late display
updates. This module does not implement a kernel WebSocket protocol.
"""

from __future__ import annotations

import asyncio
import copy
import json
import uuid
from dataclasses import dataclass, field
from queue import Empty

import nbformat
from jupyter_client import AsyncKernelClient
from jupyter_client.session import Session
from jupyter_core.utils import ensure_async
from pycrdt import Map, Text
from tornado.web import HTTPError

from .documents import cell, source_hash
from .ledger import ACTIVE


class ExecutionSession(Session):
    """Give the native request its already-persisted identity before send."""

    before_execute = None

    def msg(self, msg_type, content=None, parent=None, header=None, metadata=None):
        message = super().msg(msg_type, content, parent, header, metadata)
        if msg_type == "execute_request":
            if self.before_execute is None:
                raise RuntimeError("execution has no durable request identity")
            request_id = self.before_execute()
            message["header"]["msg_id"] = request_id
            message["msg_id"] = request_id
        return message


@dataclass
class KernelRuntime:
    document_id: str
    kernel_id: str
    incarnation: str
    process: object
    client: AsyncKernelClient
    monitor: AsyncKernelClient
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=64))
    worker: asyncio.Task | None = None
    observer: asyncio.Task | None = None
    active_run: str | None = None
    quarantined: bool = False
    idle: dict[str, asyncio.Event] = field(default_factory=dict)


class Executions:
    def __init__(self, manager, sessions, documents, ledger, *, max_output_bytes=2_000_000):
        self.manager = manager
        self.sessions = sessions
        self.documents = documents
        self.ledger = ledger
        self.max_output_bytes = max_output_bytes
        self.runtimes: dict[str, KernelRuntime] = {}
        self.bound_entries: dict[str, object] = {}
        self.lock = asyncio.Lock()

    def valid(self, runtime: KernelRuntime):
        try:
            manager = self.manager.get_kernel(runtime.kernel_id)
            return (not runtime.quarantined and manager.provisioner is not None and
                    manager.provisioner.process is runtime.process and
                    manager.provisioner.pid is not None and
                    runtime.process.poll() is None)
        except (KeyError, HTTPError, AttributeError):
            return False

    async def bind(self, notebook: dict, kernel_name: str = "python3"):
        locator = self.documents.locate(notebook)
        document_id = locator["identity"]["documentId"]
        async with self.lock:
            runtime = self.runtimes.get(document_id)
            if runtime and self.valid(runtime):
                return {"kernelId": runtime.kernel_id, "kernelIncarnation": runtime.incarnation}
            if not runtime and len(self.runtimes) >= self.documents.max_rooms:
                raise HTTPError(429, reason="managed kernel observer limit reached")
            sessions = await ensure_async(self.sessions.list_sessions())
            matching = [s for s in sessions if s["path"] == locator["contentPath"]]
            if len(matching) > 1:
                raise HTTPError(409, reason="Notebook has multiple kernel sessions")
            session = matching[0] if matching else await ensure_async(self.sessions.create_session(
                path=locator["contentPath"], type="notebook", kernel_name=kernel_name
            ))
            kernel_id = session["kernel"]["id"]
            if any(s["kernel"]["id"] == kernel_id and s["path"] != locator["contentPath"] for s in sessions):
                raise HTTPError(409, reason="kernel is shared with another Notebook")
            manager = self.manager.get_kernel(kernel_id)
            process = getattr(manager.provisioner, "process", None)
            pid = getattr(manager.provisioner, "pid", None)
            if process is None or pid is None:
                raise HTTPError(501, reason="managed local kernel incarnation cannot be verified")
            if runtime and runtime.quarantined and process is runtime.process:
                raise HTTPError(409, reason="kernel requires explicit restart/reconciliation after uncoordinated or unknown execution")
            incarnation = str(uuid.uuid4())
            if runtime:
                self.quarantine(runtime, "kernel incarnation changed")
                await self._close_runtime(runtime)
            with self.ledger.transaction():
                self.ledger.db.execute(
                    "INSERT INTO kernels VALUES (?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET "
                    "kernel_id=excluded.kernel_id,incarnation=excluded.incarnation,"
                    "process_id=excluded.process_id,server_boot=excluded.server_boot",
                    (document_id, kernel_id, incarnation, pid, self.ledger.boot),
                )
            client = AsyncKernelClient(session=ExecutionSession())
            monitor = AsyncKernelClient()
            for value in (client, monitor):
                value.load_connection_info(manager.get_connection_info())
                value.start_channels()
                try:
                    await value.wait_for_ready(timeout=15)
                except BaseException:
                    client.stop_channels()
                    monitor.stop_channels()
                    raise
            runtime = KernelRuntime(document_id, kernel_id, incarnation, process, client, monitor)
            self.runtimes[document_id] = runtime
            runtime.observer = asyncio.create_task(self._observe(runtime))
            runtime.worker = asyncio.create_task(self._work(runtime))
            return {"kernelId": kernel_id, "kernelIncarnation": incarnation}

    def claim(self, document_id: str, owner: str, principal: str, expected: int):
        with self.ledger.transaction():
            current = self.ledger.controller(document_id)
            if self.ledger.active(document_id) and not (
                current and current["owner_id"] == owner and current["principal"] == principal
                and not self.ledger.paused(document_id)
            ):
                raise HTTPError(409, reason="stop the active execution before taking control")
            try:
                return self.ledger.claim(document_id, owner, principal, expected)
            except ValueError as error:
                raise HTTPError(409, reason=str(error)) from None

    def handle(self, run: dict):
        return dict(run["target"], requestId=run["request_id"])

    def existing_submission(self, run: dict, request: dict, principal: str):
        if (run["target"] != request["target"] or run["source"] != request["source"]
                or run["details"]["principal"] != principal):
            return {"state": "rejected", "reason": "runId already identifies another request"}
        if run["state"] == "unknown":
            return {"state": "unknown", "runId": run["run_id"],
                    "reason": run["details"].get("reason", "execution outcome unknown")}
        return {"state": "accepted", "handle": self.handle(run)}

    @staticmethod
    def fenced_observation(target: dict):
        return {"state": "not_started", "runId": target["runId"],
                "target": copy.deepcopy(target), "submissionFenced": True}

    def fence_unsubmitted(self, target: dict, principal: str):
        locator = self.documents.locate(target["notebook"])
        document_id = locator["identity"]["documentId"]
        run_id = target["runId"]
        with self.ledger.transaction():
            existing = self.ledger.run(run_id)
            if existing is not None:
                if existing["target"] != target or existing["details"]["principal"] != principal:
                    return {"state": "unknown", "runId": run_id,
                            "reason": "runId identifies a different recorded execution"}
                return {"state": "recorded", "observation": self.status(target["notebook"], run_id)}
            fenced = self.ledger.submission_fence(run_id)
            if fenced is not None:
                if fenced["target"] != target or fenced["principal"] != principal:
                    return {"state": "unknown", "runId": run_id,
                            "reason": "runId identifies a different submission fence"}
                return self.fenced_observation(fenced["target"])
            if not self.ledger.owns(document_id, target["controller"], principal, allow_paused=True):
                current = self.ledger.controller(document_id)
                return {"state": "ownership_lost", "currentGeneration": current["generation"] if current else 0}
            runtime = self.runtimes.get(document_id)
            if (not runtime or not self.valid(runtime) or runtime.kernel_id != target["kernelId"]
                    or runtime.incarnation != target["kernelIncarnation"]):
                return {"state": "unknown", "runId": run_id,
                        "reason": "original kernel incarnation is not verified; no absence proof"}
            # No await: absence and the permanent late-submit fence commit together.
            self.ledger.fence_submission(target, principal)
            return self.fenced_observation(target)

    async def submit(self, request: dict, principal: str):
        target = copy.deepcopy(request["target"])
        document_id = target["notebook"]["identity"]["documentId"]
        if self.ledger.submission_fence(target["runId"]):
            return {"state": "not_started", "reason": "runId is permanently fenced before submission"}
        existing = self.ledger.run(target["runId"])
        if existing:
            return self.existing_submission(existing, request, principal)
        entry, locator = await self.documents.acquire(target["notebook"])
        keep = False
        try:
            runtime = self.runtimes.get(document_id)
            with self.ledger.transaction():
                if self.ledger.submission_fence(target["runId"]):
                    return {"state": "not_started", "reason": "runId is permanently fenced before submission"}
                existing = self.ledger.run(target["runId"])
                if existing is not None:
                    return self.existing_submission(existing, request, principal)
                if not runtime or not self.valid(runtime) or (
                    runtime.kernel_id != target["kernelId"] or
                    runtime.incarnation != target["kernelIncarnation"]
                ):
                    return {"state": "not_started", "reason": "kernel incarnation is not current"}
                if not self.ledger.owns(document_id, target["controller"], principal):
                    return {"state": "rejected", "reason": "Notebook ownership changed"}
                current = self.documents.snapshot(entry, locator, target["cellId"])
                if (current["revision"] != target["expectedRevision"] or
                    current["sourceHash"] != target["sourceHash"] or
                    current["source"] != request["source"]):
                    return {"state": "rejected", "reason": "live Notebook source or revision changed"}
                if cell(entry.document, target["cellId"]).get("cell_type") != "code":
                    return {"state": "rejected", "reason": "only code cells can execute"}
                if runtime.queue.full():
                    return {"state": "not_started", "reason": "kernel execution queue limit reached"}
                self.ledger.insert(target, request["source"], str(uuid.uuid4()), principal)
            self.bound_entries[target["runId"]] = entry
            runtime.queue.put_nowait(target["runId"])
            keep = True
            return {"state": "accepted", "handle": self.handle(self.ledger.run(target["runId"]))}
        finally:
            if not keep:
                self.documents.release(entry)

    def authorized_run(self, run: dict, runtime: KernelRuntime, entry, *, allow_paused=False):
        return (self.valid(runtime) and run["target"]["kernelIncarnation"] == runtime.incarnation
                and self.ledger.owns(runtime.document_id, run["target"]["controller"],
                                     run["details"]["principal"], allow_paused=allow_paused)
                and source_hash(str(cell(entry.document, run["target"]["cellId"])["source"]))
                == run["target"]["sourceHash"])

    async def _work(self, runtime: KernelRuntime):
        while True:
            run_id = await runtime.queue.get()
            entry = self.bound_entries[run_id]
            try:
                run = self.ledger.run(run_id)
                if run["state"] != "queued":
                    continue
                if not self.authorized_run(run, runtime, entry):
                    self.ledger.update(run_id, state="failed", stage="not_sent", details={"reason": "source, owner or kernel changed before send"})
                    continue
                runtime.active_run = run_id
                runtime.idle[run_id] = asyncio.Event()

                def before_send():
                    current = self.ledger.run(run_id)
                    if current["state"] != "queued" or not self.authorized_run(current, runtime, entry):
                        raise RuntimeError("execution no longer authorized at send")
                    self.ledger.update(run_id, state="running", stage="sending")
                    return current["request_id"]

                runtime.client.session.before_execute = before_send
                # Both the queue record and request ID exist before native send.
                reply = await runtime.client.execute_interactive(
                    run["source"], allow_stdin=True, timeout=86400,
                    output_hook=lambda message: None,
                    stdin_hook=lambda message: self._input_requested(runtime, run_id, message),
                )
                await asyncio.wait_for(runtime.idle[run_id].wait(), 5)
                current = self.ledger.run(run_id)
                if current["state"] != "unknown":
                    content = reply["content"]
                    interrupted = content.get("ename") == "KeyboardInterrupt"
                    state = "cancelled" if interrupted else "completed" if content["status"] == "ok" else "failed"
                    if current["state"] == "stopping" and not interrupted:
                        state = "unknown"
                    self.ledger.update(run_id, state=state, stage="terminal", details={
                        "kernelReply": content, "kernelIdleConfirmed": True,
                        "reason": "stop did not produce KeyboardInterrupt" if state == "unknown" else "",
                    })
                    self._commit(runtime, run_id)
                    await self.documents.save(entry)
                    saved = await ensure_async(self.documents.contents.get(
                        self.documents.locate(run["target"]["notebook"])["contentPath"], content=True
                    ))
                    saved_cells = [c for c in saved["content"]["cells"] if c.get("id") == run["target"]["cellId"]]
                    confirmed = bool(len(saved_cells) == 1 and
                        saved_cells[0].get("metadata", {}).get("disclaude_execution", {}).get("runId") == run_id and
                        source_hash("".join(saved_cells[0]["source"])) == run["target"]["sourceHash"])
                    self.ledger.update(run_id, details={"persisted": confirmed})
            except asyncio.CancelledError:
                self.ledger.update(run_id, state="unknown", details={"reason": "execution observer shut down; no replay"})
                raise
            except Exception as error:
                self.ledger.update(run_id, state="unknown", details={"reason": str(error), "persisted": False})
                self.quarantine(runtime, "execution termination could not be verified: " + str(error))
            finally:
                runtime.client.session.before_execute = None
                runtime.active_run = None
                runtime.idle.pop(run_id, None)
                self.bound_entries.pop(run_id, None)
                self.documents.release(entry)
                runtime.queue.task_done()

    async def _observe(self, runtime: KernelRuntime):
        while True:
            try:
                message = await runtime.monitor.get_iopub_msg(timeout=1)
            except Empty:
                if not self.valid(runtime):
                    self.quarantine(runtime, "kernel process was lost or restarted")
                    if runtime.worker:
                        runtime.worker.cancel()
                    return
                continue
            parent = message.get("parent_header", {}).get("msg_id")
            kind = message["header"]["msg_type"]
            run = self.ledger.request(parent) if parent else None
            if kind == "execute_input" and run is None:
                self.quarantine(runtime, "execution bypassed the shared coordinator")
                continue
            if not run or run["kernel_id"] != runtime.kernel_id or run["target"]["kernelIncarnation"] != runtime.incarnation:
                continue
            if kind == "status" and message["content"].get("execution_state") == "idle":
                event = runtime.idle.get(run["run_id"])
                if event:
                    event.set()
            if kind in ("stream", "display_data", "execute_result", "error", "clear_output", "update_display_data"):
                self._output(runtime, run, message)

    def _output(self, runtime, run, message):
        details = run["details"]
        outputs = details.get("outputs", [])
        kind = message["header"]["msg_type"]
        content = message["content"]
        if kind == "clear_output":
            if content.get("wait"):
                self.ledger.update(run["run_id"], details={"clearPending": True})
                return
            outputs = []
        elif kind == "update_display_data":
            display_id = content.get("transient", {}).get("display_id")
            for output in outputs:
                if display_id and output.get("transient", {}).get("display_id") == display_id:
                    output["data"] = content["data"]
                    output["metadata"] = content.get("metadata", {})
        else:
            if details.get("clearPending"):
                outputs = []
            output = dict(nbformat.v4.output_from_msg(message))
            display_id = content.get("transient", {}).get("display_id")
            if display_id:
                output["transient"] = {"display_id": display_id}
            if kind == "stream" and outputs and outputs[-1].get("output_type") == "stream" and outputs[-1].get("name") == output["name"]:
                outputs[-1]["text"] += output["text"]
            else:
                outputs.append(output)
        size = len(json.dumps(outputs, ensure_ascii=False).encode("utf-8"))
        if size > self.max_output_bytes:
            self.ledger.update(run["run_id"], details={"outputTruncated": True, "outputBytesLimit": self.max_output_bytes})
            return
        self.ledger.update(run["run_id"], details={"outputs": outputs, "clearPending": False})
        self._commit(runtime, run["run_id"])

    def _commit(self, runtime, run_id):
        run = self.ledger.run(run_id)
        entry = self.bound_entries.get(run_id)
        if entry is None:
            # Late output remains in the ledger, never changes terminal state.
            self.ledger.update(run_id, details={"lateOutput": True})
            return
        try:
            allowed = self.authorized_run(run, runtime, entry, allow_paused=True)
        except HTTPError:
            allowed = False
        if not allowed or run["state"] == "unknown":
            self.ledger.update(run_id, details={"outputCommit": "stale"})
            return
        selected = cell(entry.document, run["target"]["cellId"])
        with entry.document.ydoc.transaction():
            selected["outputs"].clear()
            for value in run["details"].get("outputs", []):
                output = dict(value)
                output.pop("transient", None)
                if output.get("output_type") == "stream":
                    output["text"] = Text(output["text"])
                selected["outputs"].append(Map(output))
            selected["execution_count"] = run["details"].get("kernelReply", {}).get("execution_count")
            selected["execution_state"] = "idle" if run["state"] not in ACTIVE else "running"
            selected["metadata"]["disclaude_execution"] = {
                "runId": run_id, "sourceHash": run["target"]["sourceHash"],
                "kernelIncarnation": runtime.incarnation, "state": run["state"],
            }
        self.ledger.update(run_id, details={"outputCommit": "committed"})

    def quarantine(self, runtime, reason):
        runtime.quarantined = True
        for run in self.ledger.active(runtime.document_id):
            self.ledger.update(run["run_id"], state="unknown", details={"reason": reason, "outputCommit": "stale"})

    def _input_requested(self, runtime, run_id, message):
        current = self.ledger.run(run_id)
        if current["state"] in ("running", "input_required"):
            input_id = message.get("header", {}).get("msg_id")
            if (runtime.active_run != run_id or
                    message.get("parent_header", {}).get("msg_id") != current["request_id"] or
                    not isinstance(input_id, str) or not input_id or len(input_id) > 256):
                self.quarantine(runtime, "native input request identity cannot be proved")
                return
            self.ledger.update(run_id, state="input_required", details={
                "input": message["content"], "inputRequestId": input_id, "inputReply": "waiting",
            })

    def input(self, run_id, input_request_id: str, value: str, controller: dict, principal: str):
        run = self.ledger.run(run_id)
        runtime = self.runtimes.get(run["document_id"]) if run else None
        if not runtime or runtime.active_run != run_id or run["state"] != "input_required":
            raise HTTPError(409, reason="execution is not waiting for this input")
        if (not self.valid(runtime) or runtime.incarnation != run["target"]["kernelIncarnation"] or
                controller != run["target"]["controller"] or run["details"]["principal"] != principal or
                not self.ledger.owns(run["document_id"], controller, principal)):
            raise HTTPError(409, reason="execution authority changed")
        if not input_request_id or run["details"].get("inputRequestId") != input_request_id:
            raise HTTPError(409, reason="native input prompt identity changed")
        # Consume the prompt before native send. An ambiguous reply must never
        # be replayed into a later prompt or execution. Never persist the value.
        self.ledger.update(run_id, state="running", details={
            "input": None, "inputRequestId": None, "inputReply": "sending",
        })
        try:
            runtime.client.input(value)
        except Exception:
            self.ledger.update(run_id, details={"inputReply": "unknown"})
            self.quarantine(runtime, "native input reply outcome unknown; do not replay")
            raise HTTPError(503, reason="native input reply outcome unknown; do not replay") from None
        self.ledger.update(run_id, details={"inputReply": "sent"})

    async def stop_owner(self, notebook: dict, controller: dict, principal: str):
        document_id = self.documents.locate(notebook)["identity"]["documentId"]
        with self.ledger.transaction():
            if not self.ledger.owns(document_id, controller, principal, allow_paused=True):
                current = self.ledger.controller(document_id)
                return {"state": "ownership_lost", "currentGeneration": current["generation"] if current else 0}
            # This transaction fences late POSTs and the worker's before_send,
            # and cancels every queued request before yielding to interrupt.
            self.ledger.pause(document_id, controller, principal)
            owned = [run for run in self.ledger.active(document_id)
                     if run["target"]["controller"] == controller and run["details"]["principal"] == principal]
            for run in owned:
                if run["state"] == "queued":
                    self.ledger.update(run["run_id"], state="cancelled", stage="not_sent",
                                       details={"reason": "owner stopped before native send"})
        for run in owned:
            if run["state"] != "queued":
                await self.stop(self.handle(run), controller, principal)
        return {"state": "requested", "runIds": [run["run_id"] for run in owned]}

    async def stop(self, handle: dict, controller: dict, principal: str):
        run = self.ledger.run(handle["runId"])
        if not run or self.handle(run) != handle:
            return {"state": "not_found"}
        if (controller != run["target"]["controller"] or run["details"]["principal"] != principal
                or not self.ledger.owns(run["document_id"], controller, principal, allow_paused=True)):
            current = self.ledger.controller(run["document_id"])
            return {"state": "ownership_lost", "currentGeneration": current["generation"] if current else 0}
        runtime = self.runtimes.get(run["document_id"])
        if run["state"] == "queued":
            self.ledger.update(run["run_id"], state="cancelled", stage="not_sent", details={"reason": "cancelled before native send"})
            return {"state": "requested"}
        if run["state"] == "stopping":
            return {"state": "requested"}
        if run["state"] not in ("running", "input_required"):
            return {"state": "unknown", "reason": "execution is already terminal or unknown; no interrupt sent"}
        if not runtime or not self.valid(runtime) or runtime.active_run != run["run_id"]:
            return {"state": "unknown", "reason": "exact running kernel execution cannot be proved"}
        if runtime.idle.get(run["run_id"]) and runtime.idle[run["run_id"]].is_set():
            return {"state": "unknown", "reason": "kernel is already idle; no interrupt sent"}
        self.ledger.update(run["run_id"], state="stopping")
        try:
            await ensure_async(self.manager.interrupt_kernel(runtime.kernel_id))
        except Exception as error:
            self.ledger.update(run["run_id"], state="unknown", details={"reason": "interrupt failed: " + str(error)})
            self.quarantine(runtime, "interrupt failed; execution ownership cannot prove a safe next send")
            return {"state": "unknown", "reason": str(error)}
        return {"state": "requested"}

    def status(self, notebook: dict, run_id: str):
        locator = self.documents.locate(notebook)
        run = self.ledger.run(run_id)
        if run is None:
            fenced = self.ledger.submission_fence(run_id)
            if fenced and fenced["document_id"] == locator["identity"]["documentId"]:
                return self.fenced_observation(fenced["target"])
        if not run or run["document_id"] != locator["identity"]["documentId"]:
            return {"runId": run_id, "state": "unknown", "reason": "run not found for this Notebook"}
        runtime = self.runtimes.get(run["document_id"])
        if run["state"] in ACTIVE and (not runtime or not self.valid(runtime)):
            self.ledger.update(run_id, state="unknown", details={"reason": "kernel incarnation is no longer verified"})
            run = self.ledger.run(run_id)
        outputs = run["details"].get("outputs", [])
        details = {k: v for k, v in run["details"].items() if k not in ("principal", "outputs", "kernelReply")}
        details["outputCount"] = len(outputs)
        details["outputSummary"] = [{"type": o.get("output_type"),
                                     "mimeTypes": list(o.get("data", {})),
                                     "textPreview": str(o.get("text", ""))[:300]} for o in outputs[:8]]
        result = {"runId": run_id, "state": run["state"], "handle": self.handle(run), "details": details}
        if run["state"] == "unknown":
            result["reason"] = run["details"].get("reason", "execution outcome unknown")
        return result

    async def _close_runtime(self, runtime):
        for task in (runtime.observer, runtime.worker):
            if task:
                task.cancel()
        await asyncio.gather(*(t for t in (runtime.observer, runtime.worker) if t), return_exceptions=True)
        runtime.client.stop_channels()
        runtime.monitor.stop_channels()
        while not runtime.queue.empty():
            run_id = runtime.queue.get_nowait()
            entry = self.bound_entries.pop(run_id, None)
            if entry:
                self.documents.release(entry)
            runtime.queue.task_done()

    async def close(self):
        for runtime in self.runtimes.values():
            self.quarantine(runtime, "server execution observer closed; original run must not replay")
            await self._close_runtime(runtime)
        self.runtimes.clear()

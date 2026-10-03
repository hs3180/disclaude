import asyncio
import copy
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from disclaude_jupyter.executions import Executions
from disclaude_jupyter.ledger import Ledger


class SubmissionReconciliationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="disclaude-fence-test-")
        self.path = str(Path(self.directory.name) / "ledger.sqlite3")
        self.ledger = Ledger(self.path)
        self.controller = self.ledger.claim("doc", "agent", "user", 0)
        self.notebook = {"identity": {"connectionId": "host", "serverNamespace": self.ledger.namespace,
                                      "documentId": "doc"}, "contentPath": "test.ipynb"}
        self.target = {"notebook": self.notebook, "runId": str(uuid.uuid4()), "cellId": "cell",
                       "expectedRevision": "revision", "sourceHash": "hash",
                       "kernelId": "kernel", "kernelIncarnation": "incarnation",
                       "controller": self.controller}
        self.request = {"target": self.target, "source": "value += 1"}
        self.entry = SimpleNamespace(document=SimpleNamespace(ycells=[{"id": "cell", "cell_type": "code"}]))
        self.documents = SimpleNamespace(
            locate=lambda notebook: notebook,
            acquire=AsyncMock(return_value=(self.entry, self.notebook)), release=Mock(),
            snapshot=Mock(return_value={"revision": "revision", "sourceHash": "hash", "source": "value += 1"}),
        )
        self.executions = Executions(None, None, self.documents, self.ledger)
        self.runtime = SimpleNamespace(kernel_id="kernel", incarnation="incarnation",
                                       queue=asyncio.Queue(), quarantined=False)
        self.executions.runtimes["doc"] = self.runtime
        self.executions.valid = lambda runtime: not runtime.quarantined

    def tearDown(self):
        self.ledger.close()
        self.directory.cleanup()

    def test_absence_is_fenced_without_a_native_request_or_source(self):
        proof = self.executions.fence_unsubmitted(self.target, "user")
        self.assertEqual(proof, {"state": "not_started", "runId": self.target["runId"],
                                 "target": self.target, "submissionFenced": True})
        self.assertNotIn("handle", proof)
        self.assertIsNone(self.ledger.run(self.target["runId"]))
        self.assertEqual(self.ledger.submission_fence(self.target["runId"])["target"], self.target)
        self.assertTrue(self.runtime.queue.empty())
        self.documents.acquire.assert_not_called()

    async def test_later_original_post_cannot_enter_the_queue(self):
        self.executions.fence_unsubmitted(self.target, "user")
        self.assertEqual((await self.executions.submit(self.request, "user"))["state"], "not_started")
        self.assertTrue(self.runtime.queue.empty())
        self.assertEqual(self.executions.bound_entries, {})
        self.documents.acquire.assert_not_called()
        self.assertTrue(self.executions.status(self.notebook, self.target["runId"])["submissionFenced"])

    async def test_post_already_waiting_for_the_room_is_fenced_before_insert(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def acquire(notebook):
            entered.set()
            await release.wait()
            return self.entry, notebook

        self.documents.acquire.side_effect = acquire
        pending = asyncio.create_task(self.executions.submit(self.request, "user"))
        await entered.wait()
        proof = self.executions.fence_unsubmitted(self.target, "user")
        release.set()
        self.assertEqual(proof["state"], "not_started")
        self.assertEqual((await pending)["state"], "not_started")
        self.assertIsNone(self.ledger.run(self.target["runId"]))
        self.assertTrue(self.runtime.queue.empty())
        self.documents.release.assert_called_once_with(self.entry)
        self.assertEqual(self.executions.bound_entries, {})

    async def test_recorded_submission_wins_and_is_never_rewritten_as_absent(self):
        accepted = await self.executions.submit(self.request, "user")
        result = self.executions.fence_unsubmitted(self.target, "user")
        self.assertEqual(result["state"], "recorded")
        self.assertEqual(result["observation"]["state"], "queued")
        self.assertEqual(result["observation"]["handle"], accepted["handle"])
        self.assertIsNone(self.ledger.submission_fence(self.target["runId"]))
        self.assertEqual(self.runtime.queue.qsize(), 1)

    async def test_parallel_duplicate_submissions_have_one_queue_entry(self):
        both, release = asyncio.Event(), asyncio.Event()
        arrived = 0

        async def acquire(notebook):
            nonlocal arrived
            arrived += 1
            if arrived == 2:
                both.set()
            await release.wait()
            return self.entry, notebook

        self.documents.acquire.side_effect = acquire
        first = asyncio.create_task(self.executions.submit(self.request, "user"))
        second = asyncio.create_task(self.executions.submit(self.request, "user"))
        await both.wait()
        release.set()
        a, b = await asyncio.gather(first, second)
        self.assertEqual(a, b)
        self.assertEqual(a["state"], "accepted")
        self.assertEqual(self.runtime.queue.qsize(), 1)
        self.documents.release.assert_called_once_with(self.entry)

    async def test_duplicate_source_and_principal_are_not_adopted(self):
        await self.executions.submit(self.request, "user")
        changed = dict(self.request, source="different_side_effect()")
        self.assertEqual((await self.executions.submit(changed, "user"))["state"], "rejected")
        self.assertEqual((await self.executions.submit(self.request, "other"))["state"], "rejected")
        self.assertEqual(self.runtime.queue.qsize(), 1)

    def test_wrong_principal_owner_or_generation_cannot_create_a_fence(self):
        variants = [(self.target, "other")]
        for controller in [dict(self.controller, ownerId="foreign"),
                           dict(self.controller, generation=self.controller["generation"] + 1)]:
            variants.append((dict(self.target, controller=controller), "user"))
        for target, principal in variants:
            self.assertEqual(self.executions.fence_unsubmitted(target, principal)["state"], "ownership_lost")
        self.assertIsNone(self.ledger.submission_fence(self.target["runId"]))

    def test_unverified_or_different_kernel_cannot_prove_absence(self):
        for field in ["kernelId", "kernelIncarnation"]:
            target = dict(self.target, **{field: "different"})
            self.assertEqual(self.executions.fence_unsubmitted(target, "user")["state"], "unknown")
        self.runtime.quarantined = True
        self.assertEqual(self.executions.fence_unsubmitted(self.target, "user")["state"], "unknown")
        self.executions.runtimes.clear()
        self.assertEqual(self.executions.fence_unsubmitted(self.target, "user")["state"], "unknown")
        self.assertIsNone(self.ledger.submission_fence(self.target["runId"]))

    async def test_paused_owner_can_reconcile_then_explicitly_start_a_new_attempt(self):
        self.ledger.pause("doc", self.controller, "user")
        self.assertEqual(self.executions.fence_unsubmitted(self.target, "user")["state"], "not_started")
        resumed = self.ledger.claim("doc", "agent", "user", self.controller["generation"])
        new_target = dict(self.target, runId=str(uuid.uuid4()), controller=resumed)
        result = await self.executions.submit(dict(self.request, target=new_target), "user")
        self.assertEqual(result["state"], "accepted")
        self.assertEqual(result["handle"]["kernelIncarnation"], self.target["kernelIncarnation"])
        self.assertEqual(self.executions.fence_unsubmitted(self.target, "user")["state"], "not_started")
        self.assertEqual((await self.executions.submit(self.request, "user"))["state"], "not_started")
        self.assertEqual(self.runtime.queue.qsize(), 1)

    async def test_fence_survives_restart_without_claiming_kernel_memory(self):
        self.executions.fence_unsubmitted(self.target, "user")
        namespace = self.ledger.namespace
        self.ledger.close()
        self.ledger = Ledger(self.path)
        self.executions.ledger = self.ledger
        self.executions.runtimes.clear()
        self.assertEqual(self.ledger.namespace, namespace)
        proof = self.executions.fence_unsubmitted(self.target, "user")
        self.assertEqual(proof["state"], "not_started")
        self.assertNotIn("kernelIdleConfirmed", proof)
        self.assertNotIn("kernelMemory", proof)
        self.assertEqual((await self.executions.submit(self.request, "user"))["state"], "not_started")
        fresh = dict(self.target, runId=str(uuid.uuid4()))
        self.assertEqual(self.executions.fence_unsubmitted(fresh, "user")["state"], "unknown")

    def test_recorded_unknown_side_effects_remain_unknown(self):
        self.ledger.insert(self.target, self.request["source"], "request", "user")
        self.ledger.update(self.target["runId"], state="unknown", details={"reason": "native send unknown"})
        result = self.executions.fence_unsubmitted(self.target, "user")
        self.assertEqual(result["state"], "recorded")
        self.assertEqual(result["observation"]["state"], "unknown")
        self.assertIsNone(self.ledger.submission_fence(self.target["runId"]))
        self.assertEqual(self.ledger.run(self.target["runId"])["source"], self.request["source"])

    def test_existing_run_or_fence_with_different_target_is_not_adopted(self):
        self.executions.fence_unsubmitted(self.target, "user")
        for target, principal in [(dict(self.target, sourceHash="different"), "user"),
                                  (copy.deepcopy(self.target), "other")]:
            self.assertEqual(self.executions.fence_unsubmitted(target, principal)["state"], "unknown")
        self.assertEqual(self.ledger.submission_fence(self.target["runId"])["target"], self.target)

    def test_ledger_cannot_insert_a_fenced_attempt_or_fence_a_recorded_run(self):
        with self.ledger.transaction():
            self.ledger.fence_submission(self.target, "user")
        with self.assertRaisesRegex(ValueError, "permanently fenced"):
            with self.ledger.transaction():
                self.ledger.insert(self.target, self.request["source"], "request", "user")
        other = dict(self.target, runId=str(uuid.uuid4()))
        self.ledger.insert(other, self.request["source"], "request", "user")
        with self.assertRaisesRegex(ValueError, "recorded executions"):
            self.ledger.fence_submission(other, "user")

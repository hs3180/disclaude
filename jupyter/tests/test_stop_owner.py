import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from tornado.web import HTTPError

from disclaude_jupyter.executions import Executions
from disclaude_jupyter.ledger import Ledger


class OwnerStopTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="disclaude-owner-stop-")
        self.ledger = Ledger(str(Path(self.directory.name) / "ledger.sqlite3"))
        self.controller = self.ledger.claim("doc", "agent", "user", 0)
        self.notebook = {"identity": {"documentId": "doc", "connectionId": "host",
                                      "serverNamespace": self.ledger.namespace}, "contentPath": "test.ipynb"}
        self.executions = Executions(None, None, SimpleNamespace(locate=lambda notebook: notebook), self.ledger)

    def tearDown(self):
        self.ledger.close()
        self.directory.cleanup()

    def add_run(self, state="queued", principal="user"):
        target = {"notebook": self.notebook, "runId": str(uuid.uuid4()), "controller": self.controller,
                  "kernelId": "kernel", "kernelIncarnation": "incarnation", "cellId": "cell",
                  "expectedRevision": "revision", "sourceHash": "hash"}
        self.ledger.insert(target, "print(1)", str(uuid.uuid4()), principal)
        self.ledger.update(target["runId"], state=state)
        return self.ledger.run(target["runId"])

    async def test_pause_and_cancel_queue_before_first_interrupt_await(self):
        active = self.add_run("running")
        queued = [self.add_run() for _ in range(3)]
        other_principal = self.add_run(principal="other")

        async def interrupt(handle, controller, principal):
            self.assertTrue(self.ledger.paused("doc"))
            self.assertFalse(self.ledger.owns("doc", controller, principal))
            for run in queued:
                current = self.ledger.run(run["run_id"])
                self.assertEqual(current["state"], "cancelled")
                self.assertEqual(current["stage"], "not_sent")
            return {"state": "requested"}

        self.executions.stop = AsyncMock(side_effect=interrupt)
        result = await self.executions.stop_owner(self.notebook, self.controller, "user")
        self.assertEqual(set(result["runIds"]), {active["run_id"], *(r["run_id"] for r in queued)})
        self.executions.stop.assert_awaited_once()
        self.assertEqual(self.ledger.run(other_principal["run_id"])["state"], "queued")

    async def test_wrong_principal_and_generation_do_not_pause_or_cancel(self):
        queued = self.add_run()
        for controller, principal in ((self.controller, "other"), ({**self.controller, "generation": 0}, "user")):
            result = await self.executions.stop_owner(self.notebook, controller, principal)
            self.assertEqual(result["state"], "ownership_lost")
        self.assertFalse(self.ledger.paused("doc"))
        self.assertEqual(self.ledger.run(queued["run_id"])["state"], "queued")

    async def test_stop_is_idempotent_and_resume_requires_terminal_execution(self):
        active = self.add_run("stopping")
        self.executions.stop = AsyncMock(return_value={"state": "requested"})
        await self.executions.stop_owner(self.notebook, self.controller, "user")
        await self.executions.stop_owner(self.notebook, self.controller, "user")
        with self.assertRaises(HTTPError):
            self.executions.claim("doc", "agent", "user", self.controller["generation"])
        self.ledger.update(active["run_id"], state="cancelled")
        resumed = self.executions.claim("doc", "agent", "user", self.controller["generation"])
        self.assertEqual(resumed["generation"], self.controller["generation"] + 1)

    async def test_new_controller_cannot_interrupt_the_previous_owners_run(self):
        active = self.add_run("running")
        replacement = self.ledger.claim("doc", "next", "user", self.controller["generation"])
        self.executions.manager = SimpleNamespace(interrupt_kernel=AsyncMock())
        result = await self.executions.stop(self.executions.handle(active), replacement, "user")
        self.assertEqual(result["state"], "ownership_lost")
        self.executions.manager.interrupt_kernel.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()

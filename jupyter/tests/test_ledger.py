import tempfile
import sqlite3
import unittest
import uuid
from pathlib import Path
from contextlib import closing

from disclaude_jupyter.ledger import Ledger
from disclaude_jupyter.executions import ExecutionSession


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="disclaude-ledger-test-")
        self.path = str(Path(self.directory.name) / "ledger.sqlite3")
        self.ledger = Ledger(self.path)

    def tearDown(self):
        self.ledger.close()
        self.directory.cleanup()

    def target(self):
        return {"notebook": {"identity": {"documentId": "doc-1", "serverNamespace": self.ledger.namespace,
                                           "connectionId": "test"}, "contentPath": "test.ipynb"},
                "runId": str(uuid.uuid4()), "kernelId": "kernel-1", "kernelIncarnation": "incarnation-1",
                "cellId": "cell-1", "controller": {"ownerId": "agent", "generation": 1},
                "sourceHash": "hash", "expectedRevision": "revision"}

    def test_state_permissions_and_single_writer(self):
        self.assertEqual(Path(self.path).stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(RuntimeError, "server writer"):
            Ledger(self.path)

    def test_monotonic_owner_and_principal_fence(self):
        with self.ledger.transaction():
            original = self.ledger.claim("doc-1", "agent", "user-1", 0)
        self.assertTrue(self.ledger.owns("doc-1", original, "user-1"))
        self.assertFalse(self.ledger.owns("doc-1", original, "user-2"))
        with self.ledger.transaction():
            replacement = self.ledger.claim("doc-1", "human", "user-1", 1)
        self.assertEqual(replacement["generation"], 2)
        self.assertFalse(self.ledger.owns("doc-1", original, "user-1"))
        with self.assertRaisesRegex(ValueError, "generation changed"):
            with self.ledger.transaction():
                self.ledger.claim("doc-1", "old", "user-1", 1)

    def test_generation_limit(self):
        self.ledger.db.execute("INSERT INTO controllers VALUES ('doc-1','old',9007199254740991,'user')")
        with self.assertRaisesRegex(ValueError, "exhausted"):
            self.ledger.claim("doc-1", "new", "user", 9007199254740991)

    def test_pause_blocks_new_writes_and_resume_fences_the_old_generation(self):
        original = self.ledger.claim("doc-1", "agent", "user", 0)
        with self.ledger.transaction():
            self.ledger.pause("doc-1", original, "user")
        self.assertTrue(self.ledger.paused("doc-1"))
        self.assertFalse(self.ledger.owns("doc-1", original, "user"))
        self.assertTrue(self.ledger.owns("doc-1", original, "user", allow_paused=True))
        self.assertFalse(self.ledger.owns("doc-1", original, "other", allow_paused=True))
        resumed = self.ledger.claim("doc-1", "agent", "user", original["generation"])
        self.assertEqual(resumed["generation"], original["generation"] + 1)
        self.assertFalse(self.ledger.paused("doc-1"))
        self.assertFalse(self.ledger.owns("doc-1", original, "user", allow_paused=True))
        self.assertTrue(self.ledger.owns("doc-1", resumed, "user"))

    def test_pause_survives_server_restart(self):
        original = self.ledger.claim("doc-1", "agent", "user", 0)
        self.ledger.pause("doc-1", original, "user")
        self.ledger.close()
        self.ledger = Ledger(self.path)
        self.assertTrue(self.ledger.paused("doc-1"))
        self.assertFalse(self.ledger.owns("doc-1", original, "user"))

    def test_failed_transaction_rolls_back(self):
        with self.assertRaises(ValueError):
            with self.ledger.transaction():
                self.ledger.claim("doc-1", "agent", "user", 0)
                raise ValueError("injected failure")
        self.assertIsNone(self.ledger.controller("doc-1"))

    def test_failed_initialization_releases_the_owner_lock(self):
        alternate = Path(self.path).with_name("alternate.sqlite3")
        alternate.symlink_to(self.path)
        with self.assertRaises(OSError):
            Ledger(str(alternate))
        alternate.unlink()
        replacement = Ledger(str(alternate))
        replacement.close()
        replacement.close()

    def test_future_schema_is_preserved_and_rejected(self):
        self.ledger.close()
        with closing(sqlite3.connect(self.path)) as database:
            database.execute("PRAGMA user_version=4")
        with self.assertRaisesRegex(RuntimeError, "unsupported Notebook ledger schema"):
            Ledger(self.path)
        with closing(sqlite3.connect(self.path)) as database:
            self.assertEqual(database.execute("PRAGMA user_version").fetchone()[0], 4)
            database.execute("PRAGMA user_version=3")
        self.ledger = Ledger(self.path)

    def test_restart_preserves_identity_and_does_not_replay(self):
        target = self.target()
        namespace = self.ledger.namespace
        with self.ledger.transaction():
            self.ledger.insert(target, "side_effect()", "request-1", "user")
            self.ledger.update(target["runId"], state="running", details={
                "outputs": [{"output_type": "stream", "text": "partial evidence\n"}],
            })
        self.ledger.close()
        self.ledger = Ledger(self.path)
        self.assertEqual(self.ledger.namespace, namespace)
        run = self.ledger.run(target["runId"])
        self.assertEqual(run["state"], "unknown")
        self.assertEqual(run["request_id"], "request-1")
        self.assertEqual(run["source"], "side_effect()")
        self.assertEqual(run["details"]["outputs"][0]["text"], "partial evidence\n")
        self.assertEqual(run["details"]["kernelMemory"], "unknown")
        self.assertEqual(run["details"]["outputCommit"], "stale")
        self.assertEqual(self.ledger.active("doc-1"), [])

    def test_previous_schema_is_preserved_for_explicit_migration(self):
        namespace = self.ledger.namespace
        self.ledger.close()
        with closing(sqlite3.connect(self.path)) as database:
            database.execute("PRAGMA user_version=2")
        with self.assertRaisesRegex(RuntimeError, "unsupported Notebook ledger schema"):
            Ledger(self.path)
        with closing(sqlite3.connect(self.path)) as database:
            self.assertEqual(database.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertEqual(database.execute("SELECT value FROM settings WHERE name='server_namespace'").fetchone()[0], namespace)
            database.execute("PRAGMA user_version=3")
        self.ledger = Ledger(self.path)

    def test_native_message_uses_preexisting_request_id(self):
        session = ExecutionSession()
        with self.assertRaisesRegex(RuntimeError, "durable"):
            session.msg("execute_request", {"code": "print(1)"})
        session.before_execute = lambda: "persisted-request-1"
        message = session.msg("execute_request", {"code": "print(1)"})
        self.assertEqual(message["header"]["msg_id"], "persisted-request-1")
        self.assertEqual(message["msg_id"], "persisted-request-1")
        self.assertNotEqual(session.msg("kernel_info_request")["msg_id"], "persisted-request-1")


if __name__ == "__main__":
    unittest.main()

import json
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from tornado.web import HTTPError

from disclaude_jupyter.executions import Executions
from disclaude_jupyter.ledger import Ledger


class ExecutionInputTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="disclaude-input-test-")
        self.ledger = Ledger(str(Path(self.directory.name) / "ledger.sqlite3"))
        self.controller = self.ledger.claim("doc-1", "human:user", "user", 0)
        self.run_id = str(uuid.uuid4())
        self.target = {
            "notebook": {"identity": {"documentId": "doc-1", "serverNamespace": self.ledger.namespace,
                                       "connectionId": "test"}, "contentPath": "report.ipynb"},
            "cellId": "cell-1", "expectedRevision": "revision-1", "sourceHash": "hash-1",
            "kernelId": "kernel-1", "kernelIncarnation": "incarnation-1",
            "runId": self.run_id, "controller": self.controller,
        }
        self.ledger.insert(self.target, "input()", "request-1", "user")
        self.ledger.update(self.run_id, state="input_required", details={
            "input": {"prompt": "Private answer: ", "password": True}, "inputRequestId": "prompt-1",
        })
        self.runtime = SimpleNamespace(document_id="doc-1", incarnation="incarnation-1",
                                       active_run=self.run_id, client=Mock(), quarantined=False)
        self.executions = Executions(None, None, None, self.ledger)
        self.executions.runtimes["doc-1"] = self.runtime
        self.executions.valid = Mock(return_value=True)

    def tearDown(self):
        self.ledger.close()
        self.directory.cleanup()

    def send(self, prompt="prompt-1", value="private-answer", controller=None, principal="user"):
        self.executions.input(self.run_id, prompt, value, controller or self.controller, principal)

    def test_exact_prompt_is_consumed_without_persisting_answer(self):
        self.send()
        self.runtime.client.input.assert_called_once_with("private-answer")
        run = self.ledger.run(self.run_id)
        self.assertEqual(run["state"], "running")
        self.assertIsNone(run["details"]["inputRequestId"])
        self.assertNotIn("private-answer", json.dumps(run))
        with self.assertRaises(HTTPError):
            self.send()
        self.runtime.client.input.assert_called_once()

    def test_old_prompt_cannot_answer_the_next_input_in_the_same_run(self):
        self.send()
        self.executions._input_requested(self.runtime, self.run_id, {
            "header": {"msg_id": "prompt-2"}, "parent_header": {"msg_id": "request-1"},
            "content": {"prompt": "Second answer: ", "password": False},
        })
        with self.assertRaises(HTTPError) as error:
            self.send()
        self.assertEqual(error.exception.status_code, 409)
        self.send(prompt="prompt-2", value="")
        self.assertEqual(self.runtime.client.input.call_count, 2)
        self.runtime.client.input.assert_called_with("")

    def test_stale_controller_or_another_principal_cannot_answer(self):
        for controller, principal in (({**self.controller, "generation": 0}, "user"),
                                      (self.controller, "other")):
            with self.subTest(controller=controller, principal=principal), self.assertRaises(HTTPError):
                self.send(controller=controller, principal=principal)
        self.runtime.client.input.assert_not_called()

    def test_changed_live_authority_is_rejected(self):
        self.ledger.claim("doc-1", "other-owner", "other", self.controller["generation"])
        with self.assertRaises(HTTPError):
            self.send()
        self.runtime.client.input.assert_not_called()

    def test_wrong_active_run_or_kernel_incarnation_is_rejected(self):
        self.runtime.active_run = "another-run"
        with self.assertRaises(HTTPError):
            self.send()
        self.runtime.active_run = self.run_id
        self.runtime.incarnation = "another-incarnation"
        with self.assertRaises(HTTPError):
            self.send()
        self.runtime.client.input.assert_not_called()

    def test_ambiguous_native_send_consumes_prompt_and_quarantines(self):
        self.runtime.client.input.side_effect = RuntimeError("private-answer")
        with self.assertRaises(HTTPError) as error:
            self.send()
        self.assertEqual(error.exception.status_code, 503)
        self.assertNotIn("private-answer", str(error.exception))
        run = self.ledger.run(self.run_id)
        self.assertEqual(run["state"], "unknown")
        self.assertIsNone(run["details"]["inputRequestId"])
        self.assertNotIn("private-answer", json.dumps(run))
        self.assertTrue(self.runtime.quarantined)
        with self.assertRaises(HTTPError):
            self.send()
        self.runtime.client.input.assert_called_once()

    def test_input_request_with_another_parent_is_not_adopted(self):
        self.executions._input_requested(self.runtime, self.run_id, {
            "header": {"msg_id": "prompt-2"}, "parent_header": {"msg_id": "another-request"},
            "content": {"prompt": "wrong prompt"},
        })
        self.assertEqual(self.ledger.run(self.run_id)["state"], "unknown")
        self.assertTrue(self.runtime.quarantined)

    def test_input_after_stop_is_not_adopted(self):
        self.ledger.update(self.run_id, state="stopping")
        self.executions._input_requested(self.runtime, self.run_id, {
            "header": {"msg_id": "prompt-2"}, "parent_header": {"msg_id": "request-1"},
            "content": {"prompt": "late prompt"},
        })
        run = self.ledger.run(self.run_id)
        self.assertEqual(run["state"], "stopping")
        self.assertEqual(run["details"]["inputRequestId"], "prompt-1")


if __name__ == "__main__":
    unittest.main()

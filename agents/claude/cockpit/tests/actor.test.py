#!/usr/bin/env python3
"""Разделение владельца и инструмента через действительное свидетельство."""
import unittest
from support import Harness


class ActorTests(Harness):
    def setUp(self):
        super().setUp()
        self.secret = "ab" * 32  # gitleaks:allow
        request = self.request("session.attest")
        request["panelSecret"] = self.secret
        self.assertTrue(self.invoke(request)["ok"])

    def signed(self, op, args=None, actor="agent", key=None):
        return {**self.request(op, args, key=key), "panelSecret": self.secret, "actor": actor}

    def test_actor_requires_proof_and_valid_value(self):
        self.error(self.invoke({**self.request("snapshot"), "actor": "owner"}), "INVALID_REQUEST")
        self.error(self.invoke(self.signed("snapshot", actor="other")), "INVALID_REQUEST")
        self.error(self.invoke({**self.signed("snapshot"), "panelSecret": "cd" * 32}), "ATTESTATION_FAILED")  # gitleaks:allow
        self.assertTrue(self.invoke(self.signed("snapshot"))["ok"])
        self.assertTrue(self.invoke(self.signed("doctor"))["ok"])

    def test_agent_writes_are_restricted_and_do_not_change_state(self):
        task = self.task_fixture()["task"]
        inbox = self.ok("capture.prompt", {"text": "Требуется решение"})["inboxId"]
        cases = [("task.edit", {"taskId": task["taskId"], "expectedRevision": 0, "title": "Подмена"}),
                 ("task.confirm", {"taskId": task["taskId"], "expectedRevision": 0}),
                 ("config.set", {"key": "queue", "value": "paused"}),
                 ("inbox.triage", {"inboxId": inbox, "expectedRevision": 1, "status": "triaged"}),
                 ("task.action", {"taskId": task["taskId"], "expectedRevision": 0, "expectedFocusRevision": 1, "action": "delete"}),
                 ("session.attest", {})]
        before = self.rows("SELECT * FROM tasks")
        for op, args in cases:
            with self.subTest(op=op):
                response = self.invoke(self.signed(op, args))
                self.error(response, "INVALID_REQUEST")
                self.assertIn("agent", response["error"]["message"])
        self.assertEqual(self.rows("SELECT * FROM tasks"), before)
        self.assertEqual(self.ok("config.get", {"key": "queue"})["value"], "run")

    def test_checkpoint_forces_agent_source_and_tool_provenance_in_storage(self):
        task = self.task_fixture()["task"]
        request = self.signed("checkpoint.add", {"taskId": task["taskId"], "expectedRevision": task["revision"],
                             "kind": "note", "text": "Работа выполнена", "source": "user"}, key="agent-note")
        response = self.invoke(request)
        self.assertTrue(response["ok"], response)
        self.assertEqual((response["result"]["checkpoint"]["source"], response["result"]["checkpoint"]["provenance"]), ("agent", "tool"))
        self.assertEqual(self.rows("SELECT source,provenance FROM checkpoints"), [{"source": "agent", "provenance": "tool"}])
        self.assertEqual(self.invoke(request), response)
        self.error(self.invoke({**request, "actor": "owner"}), "IDEMPOTENCY_CONFLICT")
        self.assertEqual(len(self.rows("SELECT * FROM checkpoints")), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)

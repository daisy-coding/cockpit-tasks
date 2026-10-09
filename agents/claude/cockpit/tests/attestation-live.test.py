#!/usr/bin/env python3
"""Живая запись, новая эпоха и отказ: настоящий RPC на одноразовой базе."""
import json
import secrets
import unittest

from support import Harness


class LiveAttestationTests(Harness):
    base = "live-session"
    successor = "live-session.cockpit-1-1234abcd"

    def setUp(self):
        super().setUp()
        self.secret = secrets.token_hex(32)
        self.signed("session.attest", actor="owner")

    def request_signed(self, op, args=None, actor="agent", session=None, secret=None, **kwargs):
        return {**self.request(op, args, session=session or self.base, **kwargs),
                "panelSecret": secret or self.secret, "actor": actor}

    def signed(self, op, args=None, **kwargs):
        response = self.invoke(self.request_signed(op, args, **kwargs))
        self.assertTrue(response["ok"], "Подписанный RPC должен быть успешным")
        return response["result"]

    def action(self, task, action, **extra):
        return {"taskId": task["taskId"], "expectedRevision": task["revision"],
                "expectedFocusRevision": self.ok("focus.get", session=self.base)["revision"],
                "action": action, **extra}

    def register_successor(self):
        self.signed("session.attest", actor="owner", session=self.successor, secret=secrets.token_hex(32))

    def test_successful_agent_write_then_explicit_revocation_has_a_specific_cause(self):
        card = self.signed("tasks.agent.create", {"tasks": [{"title": "Проверить горячую загрузку"}]})["tasks"][0]
        card = self.signed("task.agent.action", self.action(card, "note", note="Запись работает"))["task"]
        self.register_successor()
        card = self.signed("task.agent.action", self.action(card, "note", note="Новая эпоха не отзывает ключ"))["task"]
        self.signed("session.revoke", actor="owner")
        request = self.request_signed("task.agent.action", self.action(card, "note", note="После загрузки"))
        before = self.rows("SELECT * FROM tasks")
        notes = self.rows("SELECT * FROM task_agent_notes")
        for _ in range(2):
            response = self.invoke(request)
            self.error(response, "ATTESTATION_FAILED")
            self.assertTrue(response["error"]["message"].startswith("[attestation-revoked]"))
            self.assertNotIn(self.secret, json.dumps(response))
        self.assertEqual(self.rows("SELECT * FROM tasks"), before)
        self.assertEqual(self.rows("SELECT * FROM task_agent_notes"), notes)
        self.assertEqual(self.ok("tasks.context", session=self.base)["counts"]["open"], 1)
        self.assertEqual(len(self.rows("SELECT * FROM attestation_revocations")), 1)

    def test_defer_with_valid_proof_saves_note_and_deferred_status(self):
        card = self.signed("tasks.agent.create", {"tasks": [{"title": "Проверить отложенную работу"}]})["tasks"][0]
        noted = self.signed("task.agent.action", self.action(card, "note", note="Нужен доступ"))
        deferred = self.signed("task.agent.action", self.action(noted["task"], "defer"))
        self.assertEqual(deferred["task"]["status"], "paused")
        self.assertEqual(len(self.rows("SELECT * FROM task_agent_notes")), 1)
        self.assertEqual(self.rows("SELECT * FROM attestation_revocations"), [])

    def test_revocation_between_defer_steps_keeps_note_but_does_not_defer(self):
        card = self.signed("tasks.agent.create", {"tasks": [{"title": "Проверить два шага"}]})["tasks"][0]
        noted = self.signed("task.agent.action", self.action(card, "note", note="Жду решение"))
        self.register_successor()
        self.signed("session.revoke", actor="owner")
        response = self.invoke(self.request_signed("task.agent.action", self.action(noted["task"], "defer")))
        self.error(response, "ATTESTATION_FAILED")
        self.assertTrue(response["error"]["message"].startswith("[attestation-revoked]"))
        card = self.ok("task.get", {"taskId": card["taskId"]}, session=self.base)["task"]
        self.assertEqual(card["status"], "active")
        self.assertEqual(card["revision"], noted["task"]["revision"])
        self.assertEqual(len(self.rows("SELECT * FROM task_agent_notes")), 1)

    def test_mismatch_never_revokes_the_valid_witness(self):
        response = self.invoke(self.request_signed("snapshot", secret=secrets.token_hex(32)))
        self.error(response, "ATTESTATION_FAILED")
        self.assertTrue(response["error"]["message"].startswith("[attestation-mismatch]"))
        self.assertEqual(self.rows("SELECT * FROM attestation_revocations"), [])
        self.signed("tasks.agent.create", {"tasks": [{"title": "Правильный ключ продолжает работать"}]})

    def test_unregistered_binding_is_distinct_and_failure_is_not_cached(self):
        request = self.request_signed("snapshot", session="unregistered-session")
        response = self.invoke(request)
        self.error(response, "ATTESTATION_FAILED")
        self.assertTrue(response["error"]["message"].startswith("[attestation-unregistered]"))
        self.signed("session.attest", actor="owner", session="unregistered-session")
        self.assertTrue(self.invoke(request)["ok"])

    def test_lower_epoch_registration_remains_independent(self):
        self.register_successor()
        response = self.invoke(self.request_signed("session.attest", actor="owner"))
        self.assertTrue(response["ok"])
        self.assertEqual(self.rows("SELECT * FROM attestation_revocations"), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Действия агента сохраняют права владельца и оптимистичную ревизию."""
import json
import sqlite3
import unittest
from agent_support import AgentHarness


class AgentActionTests(AgentHarness):
    def test_current_switch_returns_previous_to_active_and_completion_clears_focus(self):
        first = self.owner_task("Первая", description="Текст владельца", priority=0)
        second = self.create_agent("Вторая")[0]
        taken = self.agent_action(second, "current")
        self.assertEqual(taken["focus"]["task"]["taskId"], second["taskId"])
        previous = self.card(first["taskId"])
        self.assertEqual(previous["status"], "active")
        self.assertIsNone(previous["activeSince"])
        self.assertTrue(previous["priorityPinned"])
        args = self.action_args(taken["task"], "done", note="Тесты пройдены")
        done = self.signed("task.agent.action", args, key="done-once")
        self.assertEqual(self.signed("task.agent.action", args, key="done-once"), done)
        self.assertEqual(done["task"]["status"], "done")
        self.assertIsNone(done["focus"]["task"])
        self.assertEqual((done["note"]["text"], done["note"]["kind"], done["note"]["provenance"]), ("Тесты пройдены", "result", "tool"))
        self.assertEqual(len(self.rows("SELECT * FROM task_agent_notes")), 1)
        self.assertEqual(self.card(first["taskId"])["description"], "Текст владельца")

    def test_defer_and_note_do_not_overwrite_owner_fields_or_checkpoints(self):
        card = self.owner_task(description="Описание владельца", acceptance=["Критерий"], constraints=["Ограничение"])
        self.signed("checkpoint.add", {"taskId": card["taskId"], "expectedRevision": card["revision"], "kind": "note", "text": "Дополнение владельца"}, actor="owner")
        card = self.card(card["taskId"])
        before = self.rows("SELECT * FROM checkpoints")
        noted = self.agent_action(card, "note", note="Наблюдение агента")
        self.assertEqual(noted["task"]["status"], "active")
        self.assertEqual(noted["focus"]["task"]["taskId"], card["taskId"])
        deferred = self.agent_action(noted["task"], "defer")
        self.assertEqual(deferred["task"]["status"], "paused")
        self.assertIsNone(deferred["focus"]["task"])
        resumed = self.agent_action(deferred["task"], "current")
        self.assertEqual(resumed["task"]["status"], "active")
        self.assertEqual(resumed["task"]["revision"], deferred["task"]["revision"] + 1)
        self.assertEqual(self.rows("SELECT * FROM checkpoints"), before)
        for key in ("title", "description", "acceptance", "constraints", "priorityPinned"):
            self.assertEqual(resumed["task"][key], card[key])

    def test_forbidden_actions_owner_text_cancel_priority_and_stale_revision(self):
        card = self.owner_task(priority=0)
        before = self.rows("SELECT * FROM tasks")
        for action in ("delete", "cancel", "cancelled", "restore", "up"):
            self.error(self.signed_response("task.agent.action", self.action_args(card, action)), "INVALID_REQUEST")
        for op, args in (("task.edit", {"taskId": card["taskId"], "expectedRevision": card["revision"], "description": "Подмена"}),
                         ("task.edit", {"taskId": card["taskId"], "expectedRevision": card["revision"], "pinned": False}),
                         ("task.update", {"taskId": card["taskId"], "expectedRevision": card["revision"], "status": "cancelled"})):
            self.error(self.signed_response(op, args), "INVALID_REQUEST")
        self.error(self.signed_response("task.agent.action", {**self.action_args(card, "done"), "expectedRevision": card["revision"] + 1}), "REVISION_CONFLICT")
        self.error(self.signed_response("task.agent.action", {**self.action_args(card, "current"), "expectedFocusRevision": 999}), "REVISION_CONFLICT")
        self.assertEqual(self.rows("SELECT * FROM tasks"), before)

    def test_note_limits_secrets_and_atomic_rollback(self):
        card = self.owner_task()
        self.error(self.signed_response("task.agent.action", self.action_args(card, "done", note="я" * 501)), "INVALID_REQUEST")
        self.error(self.signed_response("task.agent.action", self.action_args(card, "note", note="я" * 1001)), "INVALID_REQUEST")
        self.error(self.signed_response("task.agent.action", self.action_args(card, "note")), "INVALID_REQUEST")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("CREATE TRIGGER fail_note BEFORE INSERT ON task_agent_notes BEGIN SELECT RAISE(ABORT,'fixture'); END")
        args = self.action_args(card, "done", note="Результат")
        self.error(self.signed_response("task.agent.action", args, key="atomic"), "DB_UNAVAILABLE")
        self.assertEqual(self.card(card["taskId"]), card)
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id='atomic'"), [])
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("DROP TRIGGER fail_note")
        secret = "sk-" + "Q" * 25  # gitleaks:allow
        done = self.agent_action(card, "done", note=f"Результат {secret}")
        self.assertNotIn(secret, json.dumps(done))
        self.assertNotIn(secret, json.dumps(self.rows("SELECT * FROM task_agent_notes")))

    def test_reopen_owner_only_at_end_of_queue_and_without_focus(self):
        first = self.owner_task("Первая")
        done = self.agent_action(first, "done")["task"]
        queued = self.create_agent("Очередь")[0]
        args = {"taskId": done["taskId"], "expectedRevision": done["revision"]}
        self.error(self.signed_response("task.reopen", args), "INVALID_REQUEST")
        reopened = self.signed("task.reopen", args, actor="owner", key="reopen")["task"]
        self.assertEqual(self.signed("task.reopen", args, actor="owner", key="reopen")["task"], reopened)
        self.assertEqual(reopened["status"], "active")
        self.assertGreater(reopened["queuePosition"], self.card(queued["taskId"])["queuePosition"])
        self.assertIsNone(self.ok("focus.get")["task"])
        self.error(self.signed_response("task.reopen", args, actor="owner"), "REVISION_CONFLICT")
        done = self.agent_action(reopened, "done")["task"]
        restored = self.signed("task.action", self.action_args(done, "restore"), actor="owner")
        self.assertEqual(restored["task"]["status"], "active")
        self.assertIsNone(restored["focus"]["task"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

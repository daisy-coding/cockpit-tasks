#!/usr/bin/env python3
"""Контекст агента: состав, границы выдачи и изменения владельца по курсору."""
import json
import sqlite3
import subprocess
import sys
import unittest
from agent_support import AgentHarness
from support import REPO


class ContextTests(AgentHarness):
    def test_composition_owner_additions_agent_notes_and_read_without_proof(self):
        card = self.owner_task(description="Полное описание\nВторая строка", acceptance=["Приёмка"], constraints=["Сохранить данные"])
        self.signed("checkpoint.add", {"taskId": card["taskId"], "expectedRevision": card["revision"], "kind": "note", "text": "Дополнение"}, actor="owner")
        self.agent_action(self.card(card["taskId"]), "note", note="Заметка агента")
        queued = self.create_agent("Очередь")[0]
        deferred = self.create_agent("Отложенная")[0]
        closed = self.create_agent("Закрытая")[0]
        self.agent_action(deferred, "defer")
        self.agent_action(closed, "done")
        context = self.ok("tasks.context")
        self.assertEqual(context["current"]["taskId"], card["taskId"])
        self.assertEqual(context["current"]["acceptance"], ["Приёмка"])
        self.assertEqual(context["current"]["constraints"], ["Сохранить данные"])
        self.assertEqual([n["text"] for n in context["current"]["ownerNotes"]], ["Дополнение"])
        self.assertEqual([n["text"] for n in context["current"]["agentNotes"]], ["Заметка агента"])
        self.assertEqual([t["taskId"] for t in context["queue"]], [queued["taskId"]])
        self.assertEqual([t["title"] for t in context["deferred"]], ["Отложенная"])
        self.assertEqual([t["title"] for t in context["closed"]], ["Закрытая"])
        self.assertEqual(context["counts"], {"total": 4, "open": 3, "active": 2, "queued": 1, "deferred": 1, "done": 1, "cancelled": 0, "closedLast24h": 1, "projectOpen": 3})
        self.assertEqual(self.signed("tasks.context")["current"], context["current"])
        self.assertEqual(set(self.ok("snapshot")) & {"current", "ownerChanges", "cursor"}, set())

    def test_limits_priority_order_first_description_line_and_old_closures(self):
        binding = self.ok("snapshot")["binding"]
        from agents.claude.cockpit import domain
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            for i in range(56):
                task_id = domain.create_task(db, binding, f"Пункт {i}", certainty="confirmed", certainty_source="user", provenance="panel")
                status = "active" if i < 32 else "paused" if i < 44 else "done"
                db.execute("UPDATE tasks SET status=?,priority=?,description=? WHERE task_id=?", (status, i % 4, "Первая строка\nВторая строка", task_id))
            old = domain.create_task(db, binding, "Давно закрытая", certainty="confirmed", certainty_source="user", provenance="panel")
            db.execute("UPDATE tasks SET status='done',updated_at='2000-01-01T00:00:00.000000Z' WHERE task_id=?", (old,))
        context = self.ok("tasks.context")
        self.assertEqual([len(context[k]) for k in ("queue", "deferred", "closed")], [30, 10, 10])
        self.assertEqual(context["counts"]["queued"], 32)
        self.assertEqual(context["counts"]["deferred"], 12)
        self.assertEqual(context["counts"]["closedLast24h"], 12)
        self.assertEqual(context["queue"][0]["alias"], "TASK-1")
        self.assertEqual(context["queue"][1]["alias"], "TASK-5")
        self.assertTrue(all(t["description"] == "Первая строка" for t in context["queue"]))
        self.assertNotIn("Давно закрытая", [t["title"] for t in context["closed"]])

    def test_owner_cursor_delivers_creation_edit_order_defer_delete_reopen_and_note(self):
        first = self.owner_task("Текущая")
        context = self.ok("tasks.context")
        self.assertEqual(context["ownerChanges"], [])
        cursor = context["cursor"]
        added = self.owner_task("Владелец добавил")
        peer = self.owner_task("Сосед")
        edited = self.signed("task.edit", {"taskId": added["taskId"], "expectedRevision": added["revision"], "description": "Дополнение"}, actor="owner")["task"]
        self.signed("task.action", self.action_args(peer, "up"), actor="owner")
        self.signed("task.action", self.action_args(self.card(added["taskId"]), "defer"), actor="owner")
        self.signed("checkpoint.add", {"taskId": first["taskId"], "expectedRevision": first["revision"], "kind": "note", "text": "Дополнение владельца"}, actor="owner")
        self.signed("task.action", self.action_args(self.card(peer["taskId"]), "delete"), actor="owner")
        closed = self.agent_action(self.card(first["taskId"]), "done")["task"]
        self.signed("task.reopen", {"taskId": closed["taskId"], "expectedRevision": closed["revision"]}, actor="owner")
        self.create_agent("Агентская задача")
        changes = self.ok("tasks.context", {"cursor": cursor})
        actions = {item["action"] for item in changes["ownerChanges"]}
        self.assertTrue({"created", "edited", "reordered", "deferred", "deleted", "reopened", "noted"} <= actions)
        self.assertTrue(all(set(item) == {"eventId", "taskId", "action", "createdAt"} for item in changes["ownerChanges"]))
        self.assertEqual([item["eventId"] for item in changes["ownerChanges"]], sorted(item["eventId"] for item in changes["ownerChanges"]))
        self.assertGreater(changes["cursor"], cursor)
        self.assertEqual(self.ok("tasks.context", {"cursor": changes["cursor"]})["ownerChanges"], [])
        for value in (-1, True, "1", 2**63, changes["cursor"] + 100):
            self.error(self.invoke(self.request("tasks.context", {"cursor": value})), "INVALID_REQUEST")

    def test_context_filters_all_text_and_cached_historical_response(self):
        secret = "sk-" + "Q" * 25  # gitleaks:allow
        card = self.owner_task(f"Текущая {secret}", description=f"Описание {secret}", acceptance=[secret], constraints=[secret])
        self.signed("checkpoint.add", {"taskId": card["taskId"], "expectedRevision": card["revision"], "kind": "note", "text": secret}, actor="owner")
        self.agent_action(self.card(card["taskId"]), "note", note=secret)
        self.create_agent(f"Очередь {secret}")
        request = self.request("tasks.context", key="safe-context")
        result = self.invoke(request)
        self.assertTrue(result["ok"], result)
        self.assertNotIn(secret, json.dumps(result))
        self.assertEqual(self.invoke(request), result)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            stored = json.loads(db.execute("SELECT response_json FROM requests WHERE request_id='safe-context'").fetchone()[0])
            stored["result"]["queue"][0]["description"] = secret
            stored["result"]["current"]["agentNotes"][0]["text"] = secret
            db.execute("UPDATE requests SET response_json=? WHERE request_id='safe-context'", (json.dumps(stored),))
        self.assertNotIn(secret, json.dumps(self.invoke(request)))

    def test_closed_window_uses_completion_time_not_later_owner_edits(self):
        card = self.owner_task()
        done = self.agent_action(card, "done")["task"]
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE task_closures SET closed_at='2000-01-01T00:00:00.000000Z' WHERE task_id=?", (card["taskId"],))
        self.signed("task.edit", {"taskId": done["taskId"], "expectedRevision": done["revision"], "description": "Уточнение после закрытия"}, actor="owner")
        self.assertEqual(self.ok("tasks.context")["closed"], [])

    def test_read_cli_and_worktree_binding(self):
        other = self.other
        self.signed("session.attest", actor="owner", cwd=other)
        self.signed("task.create", {"title": "Соседнее дерево"}, actor="owner", cwd=other)
        self.assertEqual(self.ok("tasks.context")["counts"]["total"], 0)
        self.assertEqual(self.ok("tasks.context")["counts"]["projectOpen"], 1)
        ran = subprocess.run([sys.executable, "-m", "agents.claude.cockpit", "context", "--cwd", str(self.cwd)],
                             cwd=REPO, env=self.env, capture_output=True, timeout=12)
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertEqual(json.loads(ran.stdout)["counts"]["total"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)

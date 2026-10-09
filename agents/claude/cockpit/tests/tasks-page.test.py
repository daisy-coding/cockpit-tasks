#!/usr/bin/env python3
"""Богатые строки страницы без чтения отдельных карточек и без журнала видов."""
import json
import sqlite3
import unittest

from agent_support import AgentHarness
from scale_support import seed_tasks
from agents.claude.cockpit import domain


class TasksPageTests(AgentHarness):
    def test_legacy_snapshot_and_rebind_keep_the_original_shape(self):
        binding = self.ok("snapshot")["binding"]
        seed_tasks(self.state, binding, 1000)
        snapshot = self.ok("snapshot")
        rebound = self.ok("session.rebind", {"reason": "resume"})
        self.assertNotIn("taskCounts", snapshot)
        self.assertNotIn("workingTasks", snapshot)
        self.assertEqual(rebound["tasks"], snapshot["tasks"])
        self.assertNotIn("taskCounts", rebound)
        self.assertNotIn("workingTasks", rebound)

    def test_limited_rebind_keeps_focus_and_full_counts_without_tasks(self):
        binding = self.ok("snapshot", {"limits": {"tasks": 0}})["binding"]
        seed_tasks(self.state, binding, 300)
        seed_tasks(self.state, binding, 100, status="paused", start=301)
        seed_tasks(self.state, binding, 100, status="done", start=401)
        page = self.ok("session.rebind", {"reason": "resume", "limits": {"tasks": 0, "inbox": 10}})
        self.assertEqual(page["tasks"], [])
        self.assertTrue(page["tasksTruncated"])
        self.assertEqual(page["taskCounts"], {"active": 300, "deferred": 100, "done": 100, "queued": 300})
        distant = [f"scale-{n}" for n in range(300, 270, -1)]
        ranked = self.signed("tasks.agent.rank", {"order": distant})
        self.assertEqual(ranked["order"][:30], distant)
        self.error(self.signed_response("tasks.agent.rank", {"order": [f"scale-{n}" for n in range(1, 32)]}), "INVALID_REQUEST")

    def test_row_matches_card_and_has_compact_progress_and_discussion(self):
        card = self.create_agent("Проверить страницу")[0]
        self.agent_action(card, "note", note="Результат проверки")
        card = self.card(card["taskId"])
        self.signed("task.comment.add", {"taskId": card["taskId"], "text": "Уточнение владельца"}, actor="owner")
        card = self.card(card["taskId"])
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.executemany("INSERT INTO task_steps VALUES (?,?,?,?)", [
                (card["taskId"], 0, "Готово", "done"), (card["taskId"], 1, "Сейчас", "active"),
                (card["taskId"], 2, "Далее", "pending")])
        page = self.ok("tasks.page", {"list": "queue", "offset": 0, "limit": 50})
        row = page["tasks"][0]
        for field in ("priority", "queuePosition", "revision", "needsDecision", "priorityPinned", "updatedAt"):
            self.assertEqual(row[field], card[field])
        self.assertEqual(row["stepCounts"], {"total": 3, "done": 1, "active": 1})
        self.assertEqual(row["discussionCount"], 2)
        self.assertNotIn("steps", row)
        self.assertNotIn("description", row)

    def test_thousand_rows_have_stable_pages_small_payload_and_no_journal(self):
        binding = self.ok("snapshot", {"limits": {"tasks": 0}})["binding"]
        seed_tasks(self.state, binding, 1000)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            before = db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
            db.execute("UPDATE tasks SET priority=alias_no%4,queue_position=1001-alias_no")
            expected = [row[0] for row in db.execute("SELECT task_id FROM tasks ORDER BY priority,queue_position,alias_no")]
        actual = []
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            for offset in range(0, 1000, 50):
                page = domain.tasks_page(db, binding, {"list": "queue", "offset": offset, "limit": 50})
                actual.extend(row["taskId"] for row in page["tasks"])
                self.assertEqual(page["total"], 1000)
                self.assertLessEqual(len(json.dumps({"v": 1, "ok": True, "result": page}, ensure_ascii=False).encode()), 40000)
                self.assertEqual(page["tasks"][0]["stepCounts"], {"total": 1, "done": 0, "active": 0})
        self.assertEqual(self.ok("tasks.page", {"list": "queue", "offset": 950, "limit": 50})["tasks"], page["tasks"])
        self.assertEqual(actual, expected)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM requests").fetchone()[0], before)


if __name__ == "__main__":
    unittest.main(verbosity=2)

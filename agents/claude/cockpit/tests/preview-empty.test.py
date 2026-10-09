#!/usr/bin/env python3
"""Страница с превью читается при любых описаниях: пустое, отсутствующее, из одних пробелов."""
import sqlite3
import unittest

from agent_support import AgentHarness


class PreviewEmptyTests(AgentHarness):
    def test_page_with_preview_survives_missing_and_empty_descriptions(self):
        first, second, third, fourth = self.create_agent("Без описания", "Пустое описание", "Пробелы", "Отсутствует")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET description='' WHERE task_id=?", (second["taskId"],))
            db.execute("UPDATE tasks SET description='   \n\t ' WHERE task_id=?", (third["taskId"],))
            nullable = not any(row[1] == "description" and row[3] for row in db.execute("PRAGMA table_info(tasks)"))
            if nullable:
                db.execute("UPDATE tasks SET description=NULL WHERE task_id=?", (fourth["taskId"],))
        page = self.ok("tasks.page", {"list": "queue", "offset": 0, "limit": 50, "preview": 1200})
        self.assertEqual(len(page["tasks"]), 4, f"описание может быть NULL: {nullable}")
        for row in page["tasks"]:
            self.assertIsInstance(row["description"], str)
        snapshot = self.ok("snapshot", {"limits": {"tasks": 0, "inbox": 10, "preview": 1200}})
        self.assertEqual(snapshot["taskCounts"]["active"], 4)
        # Взятая в работу задача и снимок при перепривязке читаются с тем же превью.
        self.agent_action(self.card(first["taskId"]), "current")
        rebound = self.ok("session.rebind", {"reason": "resume", "limits": {"tasks": 0, "inbox": 10, "preview": 1200}})
        self.assertIn("workingTasks", rebound)


if __name__ == "__main__":
    unittest.main(verbosity=2)

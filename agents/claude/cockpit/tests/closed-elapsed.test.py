#!/usr/bin/env python3
"""Закрытая задача хранит время работы над ней: история показывает, сколько она заняла."""
import time
import unittest

from agent_support import AgentHarness


class ClosedElapsedTests(AgentHarness):
    def closed(self, task_id):
        rows = self.ok("tasks.page", {"list": "closed", "offset": 0, "limit": 50})["tasks"]
        return next(row for row in rows if row["taskId"] == task_id)

    def test_done_task_keeps_working_time(self):
        (task,) = self.create_agent("Работа с перерывом")
        self.agent_action(self.card(task["taskId"]), "current")
        time.sleep(0.05)
        # Перерыв в бэклоге в рабочее время не входит.
        self.agent_action(self.card(task["taskId"]), "defer")
        paused = self.card(task["taskId"])["elapsedMs"]
        self.assertGreaterEqual(paused, 50)
        time.sleep(0.05)
        self.agent_action(self.card(task["taskId"]), "current")
        time.sleep(0.05)
        self.agent_action(self.card(task["taskId"]), "done", note="Сделано")
        row = self.closed(task["taskId"])
        self.assertIsNone(row["activeSince"])
        self.assertGreaterEqual(row["elapsedMs"], 100)
        self.assertLess(row["elapsedMs"], paused + 5000)
        self.assertEqual(self.card(task["taskId"])["elapsedMs"], row["elapsedMs"])

    def test_task_closed_without_work_has_no_working_time(self):
        first, second = self.create_agent("Текущая", "Закрытая из очереди")
        self.agent_action(self.card(first["taskId"]), "current")
        self.agent_action(self.card(second["taskId"]), "done", note="Не понадобилась")
        self.assertEqual(self.closed(second["taskId"])["elapsedMs"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Проверка создания более тридцати открытых задач через оба договора RPC."""

import unittest

from agent_support import AgentHarness


class TasksCapacityTests(AgentHarness):
    def test_agent_and_owner_can_each_create_forty_open_tasks(self):
        agent_ids = []
        for start in (1, 21):
            created = self.signed("tasks.agent.create", {
                "tasks": [{"title": f"Проверить агентом этап {number}"}
                          for number in range(start, start + 20)],
            })["tasks"]
            self.assertEqual(len(created), 20)
            self.assertTrue(all(not task["duplicate"] for task in created))
            agent_ids.extend(task["taskId"] for task in created)
        self.assertIsNone(self.ok("focus.get")["task"])

        owner_ids = [self.owner_task(f"Проверить владельцем этап {number}")["taskId"]
                     for number in range(1, 41)]
        expected = set(agent_ids + owner_ids)
        self.assertEqual(len(expected), 80)
        snapshot = self.ok("snapshot")
        self.assertEqual(snapshot["openTaskCount"], 80)
        self.assertFalse(snapshot["tasksTruncated"])
        self.assertEqual({task["taskId"] for task in snapshot["tasks"]}, expected)
        self.assertTrue(all(task["status"] == "active" for task in snapshot["tasks"]))
        self.assertEqual(snapshot["focus"]["task"]["taskId"], owner_ids[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Договор больших очередей, байтовый бюджет и барьеры роста."""

import json
import sqlite3
import statistics
import time
import unittest
from unittest.mock import patch

from agent_support import AgentHarness
from scale_support import seed_tasks
from agents.claude.cockpit import domain, rpc


class ScaleTests(AgentHarness):
    def seed(self, count, **kwargs):
        binding = self.ok("snapshot", {"limits": {"tasks": 1, "inbox": 1}})["binding"]
        seed_tasks(self.state, binding, count, **kwargs)
        return binding

    def test_snapshot_all_open_first_hundred_unchanged_then_compact(self):
        binding = self.seed(1000)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            expected = [{key: value for key, value in domain.task(db, f"scale-{n}", binding["projectId"]).items()
                         if key not in ("description", "acceptance", "constraints")} for n in range(1, 101)]
        result = self.ok("snapshot")
        self.assertEqual(result["tasks"][:100], expected)
        self.assertEqual(len(result["tasks"]), 1000)
        self.assertEqual(result["openTaskCount"], 1000)
        self.assertFalse(result["tasksTruncated"])
        for card in result["tasks"][100:]:
            self.assertTrue({"description", "steps", "lastCheckpoint", "sourcePhrase"}.isdisjoint(card))
        tiny = self.ok("snapshot", {"limits": {"tasks": 1, "inbox": 1}})
        self.assertEqual(len(tiny["tasks"]), 1)
        self.assertEqual(tiny["openTaskCount"], 1000)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            with patch.object(domain, "task", wraps=domain.task) as read:
                domain.snapshot(db, binding, {"tasks": 1, "inbox": 1})
                self.assertEqual(read.call_count, 1)

    def test_snapshot_worst_case_under_three_mib_and_explicit_truncation(self):
        self.seed(5000, worst=True)
        response = self.invoke(self.request("snapshot"))
        self.assertLess(len((rpc.canonical(response) + "\n").encode("utf-8")), 3 * 1024 * 1024)
        result = response["result"]
        self.assertEqual(result["openTaskCount"], 5000)
        self.assertTrue(result["tasksTruncated"])
        self.assertLess(len(result["tasks"]), 5000)
        self.assertGreaterEqual(len(result["tasks"]), 100)
        self.assertEqual([card["alias"] for card in result["tasks"]],
                         [f"TASK-{n}" for n in range(1, len(result["tasks"]) + 1)])

    def test_rebind_returns_the_same_complete_task_list(self):
        self.seed(500)
        snapshot = self.ok("snapshot")
        rebound = self.ok("session.rebind", {"reason": "resume"})
        self.assertEqual(rebound["tasks"], snapshot["tasks"])
        self.assertEqual(rebound["openTaskCount"], 500)
        self.assertFalse(rebound["tasksTruncated"])

    def test_snapshot_repeat_recomputes_compact_legacy_tasks_with_steps(self):
        self.seed(500)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET certainty='observed',certainty_source='engine',certainty_provenance='cli'")
        request = self.request("snapshot", key="legacy-scale-snapshot")
        first = self.invoke(request)
        self.assertEqual(len(first["result"]["tasks"]), 500)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET title='Актуальная задача' WHERE task_id='scale-500'")
        repeated = self.invoke(request)
        self.assertEqual(len(repeated["result"]["tasks"]), 500)
        self.assertEqual(repeated["result"]["tasks"][:100], first["result"]["tasks"][:100])
        self.assertEqual(set(repeated["result"]["tasks"][-1]), set(first["result"]["tasks"][-1]))
        self.assertEqual(repeated["result"]["tasks"][-1]["title"], "Актуальная задача")
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id=?", (request["requestId"],)), [])

    def test_closed_history_cannot_grow_snapshot(self):
        self.seed(100, status="done")
        first = self.ok("snapshot")
        self.seed(2000, status="done", start=101)
        result = self.ok("snapshot")
        self.assertEqual(len(first["tasks"]), 100)
        self.assertEqual(len(result["tasks"]), 100)
        self.assertEqual(result["openTaskCount"], 0)
        self.assertFalse(result["tasksTruncated"])
        self.assertEqual(result["tasks"][0]["alias"], "TASK-2100")

    def test_page_and_resolve_reach_beyond_context(self):
        self.seed(1000)
        page = self.signed("tasks.page", {"list": "queue", "offset": 990, "limit": 30})
        self.assertEqual((page["list"], page["offset"], page["total"]), ("queue", 990, 1000))
        self.assertEqual([card["alias"] for card in page["tasks"]], [f"TASK-{n}" for n in range(991, 1001)])
        self.assertTrue(all(set(card) == {"taskId", "alias", "title", "status", "updatedAt", "priorityPinned",
            "priority", "queuePosition", "revision", "needsDecision", "stepCounts", "discussionCount", "certaintySource",
            "createdAt", "elapsedMs", "activeSince", "returnCount"} for card in page["tasks"]))
        self.assertTrue(all(card["returnCount"] == 0 for card in page["tasks"]))
        resolved = self.signed("task.resolve", {"alias": "TASK-1000"})
        self.assertEqual(set(resolved), {"taskId", "alias", "title", "status", "revision"})
        self.assertEqual(resolved["taskId"], "scale-1000")
        self.error(self.invoke(self.request("task.resolve", {"alias": "TASK-1001"})), "NOT_FOUND")
        self.assertEqual(self.ok("tasks.page", {"list": "queue", "offset": 1000, "limit": 1})["tasks"], [])
        for args in ({"list": "bad", "offset": 0, "limit": 1}, {"list": "queue", "offset": -1, "limit": 1},
                     {"list": "queue", "offset": True, "limit": 1}, {"list": "queue", "offset": 0, "limit": 51}):
            self.error(self.invoke(self.request("tasks.page", args)), "INVALID_REQUEST")

    def test_page_priority_pins_deferred_and_all_closed_history(self):
        self.seed(90)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET priority=0,priority_pinned=1 WHERE task_id='scale-90'")
            db.execute("UPDATE tasks SET status='paused' WHERE alias_no BETWEEN 31 AND 60")
            db.execute("UPDATE tasks SET status='done',updated_at='2000-01-01T00:00:00.000000Z' WHERE alias_no BETWEEN 61 AND 89")
            db.execute("INSERT INTO task_closures VALUES ('scale-61','2026-10-07T00:00:00.000000Z')")
        queue = self.ok("tasks.page", {"list": "queue", "offset": 0, "limit": 50})
        self.assertEqual(queue["tasks"][0]["alias"], "TASK-90")
        self.assertTrue(queue["tasks"][0]["priorityPinned"])
        self.assertEqual(queue["total"], 31)
        deferred = self.ok("tasks.page", {"list": "deferred", "offset": 29, "limit": 30})
        self.assertEqual(deferred["total"], 30)
        self.assertEqual([item["alias"] for item in deferred["tasks"]], ["TASK-60"])
        closed = self.ok("tasks.page", {"list": "closed", "offset": 0, "limit": 30})
        self.assertEqual(closed["total"], 29)
        self.assertEqual(closed["tasks"][0]["alias"], "TASK-61")
        self.assertEqual(closed["tasks"][1]["alias"], "TASK-89")

    def test_read_cli_and_worktree_binding(self):
        self.seed(3)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET deleted=1 WHERE task_id='scale-2'")
            db.execute("UPDATE tasks SET stage='candidate' WHERE task_id='scale-3'")
        for alias in ("TASK-2", "TASK-3", "TASK-99999999999999999999999999"):
            self.error(self.invoke(self.request("task.resolve", {"alias": alias})), "NOT_FOUND")
        other = self.other
        self.error(self.invoke(self.request("task.resolve", {"alias": "TASK-1"}, cwd=other)), "NOT_FOUND")
        self.assertEqual(self.ok("tasks.page", {"list": "queue", "offset": 0, "limit": 30}, cwd=other)["total"], 0)

    def test_snapshot_and_context_growth_within_process(self):
        binding = self.seed(100)
        def measure():
            with sqlite3.connect(self.state / "cockpit.db") as db:
                db.row_factory = sqlite3.Row
                times = {}
                for name, call in (("snapshot", lambda: domain.snapshot(db, binding, domain.limits({}))),
                                   ("tasks.context", lambda: domain.task_context(db, binding, {}))):
                    call()
                    samples = []
                    for _ in range(7):
                        begin = time.perf_counter_ns()
                        call()
                        samples.append(time.perf_counter_ns() - begin)
                    times[name] = statistics.median(samples)
                return times
        small = measure()
        self.seed(900, start=101)
        large = measure()
        print("scale-growth: " + ", ".join(f"{name}={large[name] / small[name]:.2f}x" for name in small), flush=True)
        for name in small:
            self.assertLessEqual(large[name] / small[name], 25, f"{name}: {large[name] / small[name]:.2f}x")


if __name__ == "__main__":
    unittest.main(verbosity=2)

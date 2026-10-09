#!/usr/bin/env python3
"""Большая история контекста: свежие записи, счётчики и полный размер stdout."""

import json
import sqlite3
import unittest
from unittest.mock import patch

from agent_support import AgentHarness
from agents.claude.cockpit import domain, rpc


class ContextBudgetTests(AgentHarness):
    def history(self, notes=650, changes=1500, text=None):
        card = self.owner_task()
        context = self.ok("tasks.context")
        binding, cursor = context["binding"], context["cursor"]
        timestamp = domain.now()
        text = text if text is not None else "🐋" * 1000
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.executemany("INSERT INTO checkpoints VALUES (?,?,?,?,?,'note',?,'user',?,'panel')",
                [(f"owner-{index}", card["taskId"], binding["projectId"], binding["worktreeId"],
                  binding["sessionId"], text, timestamp) for index in range(notes)])
            db.executemany("INSERT INTO task_agent_notes VALUES (?,?,?,?,?,'note',?,?,'agent','tool')",
                [(f"agent-{index}", card["taskId"], binding["projectId"], binding["worktreeId"],
                  binding["sessionId"], text, timestamp) for index in range(notes)])
            db.executemany("""INSERT INTO events(project_id,worktree_id,session_id,kind,entity_id,created_at)
                VALUES (?,?,?,'task.owner.edited',?,?)""",
                [(binding["projectId"], binding["worktreeId"], binding["sessionId"], card["taskId"],
                  timestamp) for _ in range(changes)])
        return card, cursor

    def check_history(self, result, notes, changes):
        current = result["current"]
        for name, id_field, prefix in (("ownerNotes", "checkpointId", "owner"), ("agentNotes", "noteId", "agent")):
            items = current[name]
            self.assertLessEqual(len(items), 100)
            self.assertLessEqual(len(rpc.canonical(items).encode("utf-8")), 128 * 1024)
            self.assertIn(name + "Omitted", current)
            self.assertEqual(current[name + "Omitted"] + len(items), notes)
            self.assertEqual([note[id_field] for note in items],
                [f"{prefix}-{index}" for index in range(notes - len(items), notes)])
        items = result["ownerChanges"]
        self.assertLessEqual(len(items), 100)
        self.assertLessEqual(len(rpc.canonical(items).encode("utf-8")), 128 * 1024)
        self.assertIn("ownerChangesOmitted", result)
        self.assertEqual(result["ownerChangesOmitted"] + len(items), changes)
        self.assertEqual([item["eventId"] for item in items], sorted(item["eventId"] for item in items))
        if changes and items:
            self.assertEqual(items[-1]["eventId"], result["cursor"])

    def test_large_history_fits_stdout_and_keeps_latest_rows_with_counts(self):
        _, cursor = self.history()
        response = self.invoke(self.request("tasks.context", {"cursor": cursor}))
        self.assertTrue(response["ok"], response)
        self.assertLessEqual(len((rpc.canonical(response) + "\n").encode("utf-8")), domain.SNAPSHOT_RESPONSE_BYTES)
        self.check_history(response["result"], 650, 1500)

    def test_small_history_keeps_all_fields_and_zero_omitted(self):
        _, cursor = self.history(notes=2, changes=3, text="Короткая заметка\nВторая строка")
        response = self.invoke(self.request("tasks.context", {"cursor": cursor}))
        self.assertTrue(response["ok"], response)
        self.check_history(response["result"], 2, 3)
        self.assertEqual(response["result"]["current"]["ownerNotesOmitted"], 0)
        self.assertEqual(response["result"]["ownerChangesOmitted"], 0)

    def test_full_envelope_budget_includes_counters_and_newline(self):
        _, cursor = self.history(notes=100, changes=100)
        with patch.dict("os.environ", self.env, clear=True), patch.object(domain, "SNAPSHOT_RESPONSE_BYTES", 6000):
            response = rpc.handle(self.request("tasks.context", {"cursor": cursor}))
        self.assertTrue(response["ok"], response)
        self.assertLessEqual(len((rpc.canonical(response) + "\n").encode("utf-8")), 6000)
        self.check_history(response["result"], 100, 100)

    def test_old_cached_context_is_bounded_without_rewriting_stored_response(self):
        card, cursor = self.history(notes=650, changes=1500)
        request = self.request("tasks.context", {"cursor": cursor}, key="old-large-context")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            binding = self.ok("snapshot", {"limits": {"tasks": 0}})["binding"]
            result = domain.task_context(db, binding, {"cursor": cursor})
            result["current"]["ownerNotes"] = [domain.checkpoint_result(row) for row in
                db.execute("SELECT * FROM checkpoints WHERE task_id=? ORDER BY rowid", (card["taskId"],))]
            result["current"]["agentNotes"] = domain.agent_notes(db, card["taskId"])
            for name in ("ownerNotesOmitted", "agentNotesOmitted"):
                result["current"].pop(name, None)
            result.pop("ownerChangesOmitted", None)
            original = rpc.canonical({"v": 1, "ok": True, "result": result})
            db.execute("INSERT INTO requests VALUES (?,?,?,?)", (request["requestId"], rpc.request_digest(request), original, domain.now()))
        response = self.invoke(request)
        self.assertTrue(response["ok"], response)
        self.assertLessEqual(len((rpc.canonical(response) + "\n").encode("utf-8")), domain.SNAPSHOT_RESPONSE_BYTES)
        self.assertEqual(self.rows("SELECT response_json FROM requests WHERE request_id='old-large-context'")[0]["response_json"], original)


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Предпросмотр фильтруется как task.get, сохраняет Unicode и старый договор страниц."""
import json
import sqlite3
import unittest

from agent_support import AgentHarness
from scale_support import seed_tasks
from agents.claude.cockpit import domain, rpc


class TaskPreviewTests(AgentHarness):
    def queued_task(self, description):
        created = self.signed("tasks.agent.create", {"tasks": [{"title": f"Описание длиной {len(description)}", "description": description}]})
        return self.card(created["tasks"][0]["taskId"])

    def preview_row(self, limit=1200):
        return self.ok("tasks.page", {"list": "queue", "offset": 0, "limit": 50, "preview": limit})["tasks"][0]

    def test_short_and_empty_descriptions_are_present_without_marker(self):
        for text in ("", "Первая строка\nВторая строка 🧪"):
            with self.subTest(text=text):
                card = self.queued_task(text)
                page = self.ok("tasks.page", {"list": "queue", "offset": 0, "limit": 50, "preview": 1200})
                row = next(item for item in page["tasks"] if item["taskId"] == card["taskId"])
                self.assertEqual(row["description"], self.card(card["taskId"])["description"])
        self.assertTrue(all("description" not in row for row in self.ok("tasks.page", {"list": "queue", "offset": 0, "limit": 50})["tasks"]))

    def test_unicode_length_includes_truncation_marker(self):
        card = self.queued_task("🧪界\n" * 1000)
        full = self.card(card["taskId"])["description"]
        for limit in (1, 2, 3, 1199, 1200, 2000):
            with self.subTest(limit=limit):
                suffix = " …" if limit > 1 else "…"
                row = self.preview_row(limit)
                self.assertEqual(row["description"], full[:limit - len(suffix)] + suffix)
                self.assertEqual(len(row["description"]), limit)
        self.assertEqual(self.card(card["taskId"])["description"], full)

    def test_exact_boundary_is_not_marked(self):
        self.queued_task("🧪" * 1200)
        self.assertEqual(self.preview_row()["description"], "🧪" * 1200)

    def test_redaction_and_cleanup_match_full_card_before_truncation(self):
        secret = "gh" + "p_" + "q" * 36
        text = "<pasted_content>Начало\r\n\t" + chr(27) + chr(0x202e) + secret + "</pasted_content>\nКонец"
        card = self.queued_task("Начало")
        # Старые данные могли попасть в базу до фильтра ingress; проверяется именно выдача.
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET description=? WHERE task_id=?", (text, card["taskId"]))
        full = self.card(card["taskId"])["description"]
        self.assertIn("[REDACTED:", full)
        self.assertNotIn(secret, full)
        self.assertEqual(self.preview_row()["description"], full)
        limit = len("Начало\n ") + 5
        self.assertEqual(self.preview_row(limit)["description"], full[:limit - 2] + " …")

    def test_long_legacy_description_uses_the_same_redaction_window(self):
        card = self.queued_task("Начало")
        for text in ("界" * 5000, "Начало " + ("слово " * 1000), "Начало " + "gh" + "p_" + "q" * 4500):
            with self.subTest(length=len(text)), sqlite3.connect(self.state / "cockpit.db") as db:
                db.execute("UPDATE tasks SET description=? WHERE task_id=?", (text, card["taskId"]))
            full = self.card(card["taskId"])["description"]
            expected = full if len(full) <= 1200 else full[:1198] + " …"
            self.assertEqual(self.preview_row()["description"], expected)

    def test_invalid_preview_does_not_change_page_or_snapshot_contract(self):
        for preview in (0, -1, 2001, True, 1.5, "1200", None):
            for op, payload in (("tasks.page", {"list": "queue", "offset": 0, "limit": 50, "preview": preview}),
                                ("snapshot", {"limits": {"tasks": 0, "preview": preview}}),
                                ("session.rebind", {"reason": "resume", "limits": {"tasks": 0, "preview": preview}})):
                with self.subTest(op=op, preview=preview):
                    self.error(self.invoke(self.request(op, payload)), "INVALID_REQUEST")

    def test_fifty_maximum_unicode_descriptions_stay_within_response_budget(self):
        binding = self.ok("snapshot", {"limits": {"tasks": 0}})["binding"]
        seed_tasks(self.state, binding, 1000, worst=True)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET description=?", ("🧪" * 4000,))
        response = self.invoke(self.request("tasks.page", {"list": "queue", "offset": 0, "limit": 50, "preview": 2000}))
        self.assertTrue(response["ok"], response)
        self.assertEqual(len(response["result"]["tasks"]), 50)
        self.assertTrue(all(len(row["description"]) == 2000 and row["description"].endswith(" …") for row in response["result"]["tasks"]))
        self.assertLessEqual(len((rpc.canonical(response) + "\n").encode()), domain.SNAPSHOT_RESPONSE_BYTES)

    def test_working_tasks_use_preview_in_snapshot_and_rebind(self):
        card = self.owner_task(description="Описание работы 🧪\n" * 180)
        self.signed("task.action", self.action_args(card, "current"), actor="owner")
        self.signed("focus.detour", {"expectedRevision": self.ok("focus.get")["revision"], "title": "Подзадача"}, actor="owner")
        full = self.card(card["taskId"])["description"]
        legacy = self.ok("snapshot", {"limits": {"tasks": 0}})
        self.assertEqual(legacy["workingTasks"][0]["description"], full)
        for op, payload in (("snapshot", {}), ("session.rebind", {"reason": "resume"})):
            with self.subTest(op=op):
                result = self.ok(op, {**payload, "limits": {"tasks": 0, "inbox": 10, "preview": 1200}})
                self.assertEqual(result["tasks"], [])
                self.assertEqual(result["workingTasks"][0]["description"], full[:1198] + " …")
                self.assertEqual(self.card(card["taskId"])["description"], full)


if __name__ == "__main__":
    unittest.main(verbosity=2)

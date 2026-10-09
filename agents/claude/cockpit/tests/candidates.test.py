#!/usr/bin/env python3
"""Кандидат переживает ход только после принятия владельцем или агентом."""
import sqlite3
import unittest
from support import Harness
from agents.claude.cockpit.store import SCHEMA_VERSION


class CandidateTests(Harness):
    def setUp(self):
        super().setUp()
        self.secret = "ab" * 32  # gitleaks:allow
        self.panel("session.attest")

    def panel(self, op, args=None, actor="owner", key=None):
        response = self.invoke({**self.request(op, args, key=key), "panelSecret": self.secret, "actor": actor})
        self.assertTrue(response["ok"], response)
        return response["result"]

    def extract(self, titles, **extras):
        source = self.ok("capture.prompt", {"text": "Исправить панель и очередь"})
        return self.panel("tasks.extract", {"inboxId": source["inboxId"], "tasks": [
            {"title": title, "steps": ["Проверить"], **extras} for title in titles]})

    def test_extract_limits_and_candidates_have_no_queue_focus_or_running_step(self):
        result = self.extract(["Первый", "Второй", "Третий", "Четвёртый", "Пятый"],
                              description="Описание", acceptance=["Готово"], constraints=["Сохранить"])
        self.assertEqual((len(result["tasks"]), result["dropped"], result["duplicates"]), (3, 2, []))
        self.assertIsNone(result["focus"]["task"])
        for task in result["tasks"]:
            self.assertEqual(task["stage"], "candidate")
            self.assertIsNone(task["queuePosition"])
            self.assertIsNone(task["activeSince"])
            self.assertEqual(task["steps"][0]["status"], "pending")
            self.assertEqual(task["acceptance"], ["Готово"])
        snapshot = self.ok("snapshot")
        self.assertEqual(snapshot["storageSchemaVersion"], SCHEMA_VERSION)
        self.assertEqual(snapshot["tasks"], [])
        self.assertEqual(snapshot["candidateCount"], 3)
        self.assertEqual([item["title"] for item in snapshot["candidates"]], ["Третий", "Второй", "Первый"])
        self.assertEqual(snapshot["candidates"][0]["description"], "Описание")

    def test_duplicates_normalize_case_spaces_and_final_punctuation_across_project(self):
        task = self.panel("task.create", {"title": "Исправить   Панель"})["task"]
        first = self.extract([" исправить панель. ", "Очередь", "ОЧЕРЕДЬ!"])
        self.assertEqual(len(first["tasks"]), 1)
        self.assertEqual(first["duplicates"], [{"title": " исправить панель. ", "taskId": task["taskId"]},
                                               {"title": "ОЧЕРЕДЬ!", "taskId": first["tasks"][0]["taskId"]}])
        second = self.extract(["очередь."])
        self.assertEqual(second["tasks"], [])
        self.assertEqual(second["duplicates"][0]["taskId"], first["tasks"][0]["taskId"])

    def test_candidate_cannot_be_completed_deferred_focused_confirmed_edited_or_ranked(self):
        task = self.extract(["Кандидат"])["tasks"][0]
        for op, extra in [("focus.set", {}), ("task.update", {"status": "done"}),
                          ("task.confirm", {}), ("task.edit", {"title": "Правка"}),
                          ("task.action", {"action": "defer", "expectedFocusRevision": 0}),
                          ("task.action", {"action": "up", "expectedFocusRevision": 0})]:
            args = {"taskId": task["taskId"], "expectedRevision": 0, **extra}
            self.error(self.invoke({**self.request(op, args), "panelSecret": self.secret}), "INVALID_REQUEST")
        ranked = self.panel("tasks.rank", {"items": [{"taskId": task["taskId"], "expectedRevision": 0, "priority": 0}], "source": "model"})
        self.assertEqual(ranked, {"changed": [], "skipped": [{"taskId": task["taskId"], "reason": "candidate"}]})
        self.ok("config.set", {"key": "gate", "value": "observe"})
        gate = self.ok("gate.check", {"resourcePath": str(self.cwd / "file.py")})
        self.assertIsNone(gate["task"])
        self.assertEqual(self.ok("task.get", {"taskId": task["taskId"]})["task"]["revision"], 0)

    def test_adoption_actor_certainty_queue_end_and_compare_and_swap(self):
        first = self.panel("task.create", {"title": "Текущая"})["task"]
        queued = self.panel("task.create", {"title": "Очередь"})["task"]
        candidates = self.extract(["Владелец", "Агент"])["tasks"]
        for candidate, actor in zip(candidates, ("owner", "agent")):
            adopted = self.panel("candidate.adopt", {"taskId": candidate["taskId"], "expectedRevision": 0}, actor)["task"]
            self.assertEqual((adopted["stage"], adopted["adoptedBy"]), ("task", actor))
            self.assertGreater(adopted["queuePosition"], queued["queuePosition"])
            self.assertEqual(adopted["certainty"], "confirmed" if actor == "owner" else "inferred")
            self.assertEqual(adopted["certaintySource"], "user" if actor == "owner" else "provider")
            self.error(self.invoke({**self.request("candidate.adopt", {"taskId": candidate["taskId"], "expectedRevision": 0}), "panelSecret": self.secret}), "REVISION_CONFLICT")
        snapshot = self.ok("snapshot")
        self.assertEqual(snapshot["candidateCount"], 0)
        self.assertEqual(snapshot["focus"]["task"]["taskId"], first["taskId"])
        self.assertEqual([item["title"] for item in snapshot["tasks"]], ["Текущая", "Очередь", "Владелец", "Агент"])

    def test_dismiss_batch_skips_handled_preserves_sources_and_is_atomic(self):
        tasks = self.extract(["Один", "Два", "Три"])["tasks"]
        ids = [task["taskId"] for task in tasks]
        self.panel("candidate.adopt", {"taskId": ids[0], "expectedRevision": 0})
        sources = self.rows("SELECT * FROM task_sources")
        result = self.panel("candidate.dismiss", {"taskIds": ids, "reason": "answered"}, "agent", key="dismiss-batch")
        self.assertEqual(result, {"dismissed": ids[1:], "skipped": [ids[0]]})
        self.assertEqual(self.panel("candidate.dismiss", {"taskIds": ids, "reason": "answered"}, "agent", key="dismiss-batch"), result)
        self.assertEqual(self.panel("candidate.dismiss", {"taskIds": ids, "reason": "duplicate"})["skipped"], ids)
        self.assertEqual(self.rows("SELECT * FROM task_sources"), sources)
        self.assertEqual(self.ok("task.get", {"taskId": ids[1]})["task"]["dismissReason"], "answered")
        self.error(self.invoke({**self.request("candidate.dismiss", {"taskIds": ids, "reason": "owner"}), "panelSecret": self.secret, "actor": "agent"}), "INVALID_REQUEST")
        more = self.extract(["Четыре", "Пять"])["tasks"]
        self.error(self.invoke({**self.request("candidate.dismiss", {"taskIds": [more[0]["taskId"], "foreign-id"], "reason": "owner"}), "panelSecret": self.secret}), "NOT_FOUND")
        self.assertIsNone(self.ok("task.get", {"taskId": more[0]["taskId"]})["task"]["dismissReason"])

    def test_expiry_hidden_on_reads_and_marked_only_on_next_project_write(self):
        task = self.extract(["Истёкший"])["tasks"][0]
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET created_at='2000-01-01T00:00:00.000000Z' WHERE task_id=?", (task["taskId"],))
        snapshot = self.ok("snapshot")
        self.assertEqual((snapshot["candidateCount"], snapshot["candidates"]), (0, []))
        self.assertIsNone(self.rows("SELECT dismiss_reason FROM tasks")[0]["dismiss_reason"])
        self.ok("capture.prompt", {"text": "Следующая запись"})
        card = self.ok("task.get", {"taskId": task["taskId"]})["task"]
        self.assertEqual(card["dismissReason"], "expired")
        self.assertIsNotNone(card["dismissedAt"])

    def test_snapshot_caps_candidates_at_five_and_cli_filters(self):
        self.extract(["Один", "Два", "Три"])
        self.extract(["Четыре", "Пять", "Шесть"])
        snapshot = self.ok("snapshot")
        self.assertEqual((snapshot["candidateCount"], len(snapshot["candidates"])), (6, 5))
        self.assertNotIn("Один", self.human("tasks").stdout.decode())
        output = self.human("tasks", "--candidates")
        self.assertEqual(output.returncode, 0, output.stderr)
        self.assertIn("Шесть", output.stdout.decode())

    def test_extra_inputs_are_dropped_even_above_previous_sixteen_limit(self):
        result = self.extract([f"Предложение {index}" for index in range(17)])
        self.assertEqual((len(result["tasks"]), result["dropped"]), (3, 14))

    def test_candidate_summary_uses_first_description_line_and_cli_marks_proposal(self):
        task = self.extract(["Предложение"], description="Первый абзац\nВторой абзац")["tasks"][0]
        self.assertEqual(self.ok("snapshot")["candidates"][0]["description"], "Первый абзац")
        self.assertIn("предложено", self.human("tasks", "--candidates").stdout.decode())
        self.error(self.invoke(self.request("candidate.adopt", {"taskId": task["taskId"], "expectedRevision": 0})), "ATTESTATION_FAILED")
        self.error(self.invoke(self.request("candidate.dismiss", {"taskIds": [task["taskId"]], "reason": "owner"})), "ATTESTATION_FAILED")


if __name__ == "__main__":
    unittest.main(verbosity=2)

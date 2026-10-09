#!/usr/bin/env python3
"""Карточки задач через реальный RPC и изолированную БД внутри worktree."""
import unittest

from support import Harness
from agents.claude.cockpit.store import SCHEMA_VERSION


class TasksPanelTests(Harness):
    def setUp(self):
        super().setUp()
        self.secret = "ab" * 32  # gitleaks:allow
        request = self.request("session.attest")
        request["panelSecret"] = self.secret
        self.assertTrue(self.invoke(request)["ok"])

    def panel(self, op, args, key=None):
        request = self.request(op, args, key=key)
        request["panelSecret"] = self.secret
        response = self.invoke(request)
        self.assertTrue(response["ok"], response)
        return response["result"]

    def action(self, task_id, action, **extra):
        card = self.ok("task.get", {"taskId": task_id})["task"]
        current = self.ok("focus.get")
        return self.panel("task.action", {"taskId": task_id, "expectedRevision": card["revision"],
                          "expectedFocusRevision": current["revision"], "action": action, **extra})

    def test_snapshot_cards_have_safe_source_and_last_checkpoint(self):
        self.ok("capture.prompt", {"text": "Исправить панель задач и проверить очередь"})
        created = self.task_fixture(unstepped=True)["task"]
        self.panel("task.confirm", {"taskId": created["taskId"], "expectedRevision": created["revision"]})
        created = self.ok("task.get", {"taskId": created["taskId"]})["task"]
        note = self.ok("checkpoint.add", {"taskId": created["taskId"],
                        "expectedRevision": created["revision"], "kind": "note", "text": "Панель собрана"})
        card = self.ok("task.get", {"taskId": created["taskId"]})["task"]
        self.assertEqual(card["sourcePhrase"], "Исправить панель задач и проверить очередь")
        self.assertEqual(card["lastCheckpoint"], note["checkpoint"])
        self.assertEqual(card["steps"], [])
        self.assertEqual(card["queuePosition"], 1)
        snapshot = self.ok("snapshot")
        self.assertEqual(snapshot["storageSchemaVersion"], SCHEMA_VERSION)
        self.assertEqual(snapshot["tasks"][0], {key: value for key, value in card.items()
                                             if key not in ("description", "acceptance", "constraints")})
        self.assertEqual(snapshot["focus"]["task"], card)
        self.assertEqual(self.rows("PRAGMA foreign_key_check"), [])

    def test_card_read_cannot_cross_project(self):
        card = self.task_fixture()["task"]
        other = self.root / "other"
        other.mkdir()
        self.error(self.invoke(self.request("task.get", {"taskId": card["taskId"]}, cwd=other)), "NOT_FOUND")

    def test_only_attested_panel_can_create_or_change_cards(self):
        self.error(self.invoke(self.request("task.create", {"title": "Запрещённая запись"})), "ATTESTATION_FAILED")
        card = self.panel("task.create", {"title": "Первая"})["task"]
        args = {"taskId": card["taskId"], "expectedRevision": card["revision"], "expectedFocusRevision": 1, "action": "done"}
        self.error(self.invoke(self.request("task.action", args)), "ATTESTATION_FAILED")
        request = self.request("task.action", args)
        request["panelSecret"] = "cd" * 32  # gitleaks:allow
        self.error(self.invoke(request), "ATTESTATION_FAILED")
        self.assertEqual(self.ok("task.get", {"taskId": card["taskId"]})["task"]["status"], "active")

    def test_creation_steps_queue_reordering_and_status_actions(self):
        first = self.panel("task.create", {"title": "Первая", "steps": ["Собрать", "Проверить"]})["task"]
        second = self.panel("task.create", {"title": "Вторая"})["task"]
        third = self.panel("task.create", {"title": "Третья"})["task"]
        self.assertIsNotNone(first["activeSince"])
        self.assertEqual([step["status"] for step in first["steps"]], ["active", "pending"])
        self.action(third["taskId"], "up")
        self.assertEqual([card["title"] for card in self.ok("snapshot")["tasks"]], ["Первая", "Третья", "Вторая"])
        self.action(third["taskId"], "down")
        self.assertEqual([card["title"] for card in self.ok("snapshot")["tasks"]], ["Первая", "Вторая", "Третья"])
        stepped = self.action(first["taskId"], "step", step=0)["task"]
        self.assertEqual([step["status"] for step in stepped["steps"]], ["done", "active"])
        deferred = self.action(first["taskId"], "defer")
        self.assertEqual(deferred["task"]["status"], "paused")
        self.assertIsNone(deferred["focus"]["task"])
        self.assertIsNone(deferred["task"]["activeSince"])
        restored = self.action(first["taskId"], "restore")
        self.assertEqual(restored["task"]["status"], "active")
        self.assertIsNone(restored["focus"]["task"])
        self.action(first["taskId"], "current")
        done = self.action(first["taskId"], "done")
        self.assertIsNone(done["focus"]["task"])
        self.assertTrue(all(step["status"] == "done" for step in done["task"]["steps"]))
        self.action(first["taskId"], "delete")
        self.assertNotIn(first["taskId"], [item["taskId"] for item in self.ok("snapshot")["tasks"]])
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 3)
        self.assertEqual(self.rows("PRAGMA foreign_key_check"), [])

    def test_conflicts_and_identical_retries_never_duplicate_writes(self):
        first = self.panel("task.create", {"title": "Первая"}, key="create-once")
        self.assertEqual(self.panel("task.create", {"title": "Первая"}, key="create-once"), first)
        task = first["task"]
        self.action(task["taskId"], "defer")
        request = self.request("task.action", {"taskId": task["taskId"], "expectedRevision": 0,
                               "expectedFocusRevision": 1, "action": "done"})
        request["panelSecret"] = self.secret
        self.error(self.invoke(request), "REVISION_CONFLICT")
        self.assertEqual(self.ok("task.get", {"taskId": task["taskId"]})["task"]["status"], "paused")
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 1)

    def test_step_validation_is_atomic(self):
        request = self.request("task.create", {"title": "Первая", "steps": ["Один", ""]})
        request["panelSecret"] = self.secret
        self.error(self.invoke(request), "INVALID_REQUEST")
        self.assertEqual(self.rows("SELECT * FROM tasks"), [])

    def test_switching_focus_stops_old_step_and_resumes_paused_detour(self):
        first = self.panel("task.create", {"title": "Первая", "steps": ["Один"]})["task"]
        second = self.panel("task.create", {"title": "Вторая", "steps": ["Два"]})["task"]
        self.action(second["taskId"], "defer")
        detour = self.panel("focus.detour", {"taskId": second["taskId"], "expectedRevision": self.ok("focus.get")["revision"]})
        self.assertEqual(detour["focus"]["task"]["status"], "active")
        self.assertEqual(detour["focus"]["task"]["steps"][0]["status"], "active")
        old = self.ok("task.get", {"taskId": first["taskId"]})["task"]
        self.assertEqual(old["steps"][0]["status"], "pending")
        self.assertIsNone(old["activeSince"])
        self.action(first["taskId"], "defer")
        returned = self.panel("focus.return", {"expectedRevision": self.ok("focus.get")["revision"]})
        self.assertEqual(returned["focus"]["task"]["status"], "active")
        self.assertEqual(returned["focus"]["task"]["steps"][0]["status"], "active")

    def test_deleting_a_detour_frame_preserves_stack_and_sources(self):
        first = self.panel("task.create", {"title": "Первая"})["task"]
        second = self.panel("task.create", {"title": "Вторая"})["task"]
        third = self.panel("task.create", {"title": "Третья"})["task"]
        for task in (second, third):
            revision = self.ok("focus.get")["revision"]
            self.panel("focus.detour", {"taskId": task["taskId"], "expectedRevision": revision})
        self.action(first["taskId"], "delete")
        stack = self.ok("snapshot")["focusStack"]
        self.assertEqual([(frame["taskId"], frame["depth"]) for frame in stack], [(second["taskId"], 1)])
        returned = self.panel("focus.return", {"expectedRevision": self.ok("focus.get")["revision"]})
        self.assertEqual(returned["focus"]["task"]["taskId"], second["taskId"])
        self.assertEqual(len(self.rows("SELECT * FROM checkpoints")), 3)

    def test_extracted_tasks_have_exact_source_steps_and_stable_order(self):
        text = "Исправить панель задач. Проверить очередь и возврат."
        source = self.ok("capture.prompt", {"text": text})
        tasks = [{"title": "Панель задач", "steps": ["Собрать ряды", "Проверить тему"], "sourcePhrase": "Исправить панель задач."},
                 {"title": "Очередь и возврат", "steps": [], "sourcePhrase": "Проверить очередь и возврат."}]
        args = {"inboxId": source["inboxId"], "tasks": tasks}
        result = self.panel("tasks.extract", args, key="extract-once")
        self.assertEqual(self.panel("tasks.extract", args, key="extract-once"), result)
        retry = self.panel("tasks.extract", args, key="extract-another-delivery")
        self.assertEqual([item["taskId"] for item in retry["tasks"]], [item["taskId"] for item in result["tasks"]])
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 2)
        self.assertIsNone(result["focus"]["task"])
        self.assertEqual(self.ok("snapshot")["tasks"], [])
        self.assertEqual([step["status"] for step in result["tasks"][0]["steps"]], ["pending", "pending"])
        for card, supplied in zip(result["tasks"], tasks):
            self.assertEqual(card["certainty"], "inferred")
            self.assertEqual(card["certaintySource"], "provider")
            self.assertEqual(card["certaintyProvenance"], "panel")
            self.assertEqual(card["stage"], "candidate")
            self.assertEqual(card["sourcePhrase"], supplied["sourcePhrase"])
            self.assertEqual(text[card["source"]["start"]:card["source"]["end"]], supplied["sourcePhrase"])

    def test_extraction_preserves_untouched_gate_task_and_creates_separate_candidate(self):
        source = self.ok("capture.prompt", {"text": "Сделай задачи и очередь"})
        bound = self.task_fixture(unstepped=True)["task"]
        result = self.panel("tasks.extract", {"inboxId": source["inboxId"], "tasks": [{"title": "Задачи и очередь", "steps": ["Панель", "Действия"]}]})
        self.assertNotEqual(result["tasks"][0]["taskId"], bound["taskId"])
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 2)
        self.assertIsNone(result["focus"]["task"])
        self.assertEqual(self.rows("SELECT title FROM tasks WHERE task_id=?", (bound["taskId"],))[0]["title"], bound["title"])

    def test_extraction_never_overwrites_a_card_changed_by_person(self):
        source = self.ok("capture.prompt", {"text": "Сделай задачи и очередь"})
        bound = self.task_fixture()["task"]
        self.ok("task.update", {"taskId": bound["taskId"], "expectedRevision": bound["revision"], "title": "Название владельца"})
        result = self.panel("tasks.extract", {"inboxId": source["inboxId"], "tasks": [{"title": "Задачи и очередь", "steps": []}]})
        self.assertNotEqual(result["tasks"][0]["taskId"], bound["taskId"])
        self.assertEqual(result["focus"]["task"]["title"], "Название владельца")

    def test_empty_invalid_and_unauthorized_extraction_never_create_partial_cards(self):
        source = self.ok("capture.prompt", {"text": "Сделай задачи и очередь"})
        empty = self.panel("tasks.extract", {"inboxId": source["inboxId"], "tasks": []})
        self.assertEqual(empty["tasks"], [])
        self.assertIsNone(empty["focus"]["task"])
        args = {"inboxId": source["inboxId"], "tasks": [{"title": "Название", "steps": []}]}
        self.error(self.invoke(self.request("tasks.extract", args)), "ATTESTATION_FAILED")
        request = self.request("tasks.extract", {"inboxId": source["inboxId"], "tasks": [args["tasks"][0], {"title": "", "steps": []}]})
        request["panelSecret"] = self.secret
        self.error(self.invoke(request), "INVALID_REQUEST")
        self.assertEqual(self.rows("SELECT * FROM tasks"), [])

    def test_material_and_card_projection_filter_before_output(self):
        secret = "sk" + "-" + "Q" * 25  # gitleaks:allow
        source = self.ok("capture.prompt", {"text": f"Сделай панель задач {secret}\x1b[2J\u202e"})
        material = self.ok("inbox.material", {"inboxId": source["inboxId"]})["material"]
        self.assertNotIn(secret, material)
        self.assertNotIn("\x1b", material)
        self.assertNotIn("\u202e", material)
        result = self.panel("tasks.extract", {"inboxId": source["inboxId"], "tasks": [{"title": f"Задача {secret}", "steps": [f"Шаг {secret}"]}]})
        card = result["tasks"][0]
        self.assertNotIn(secret, card["title"])
        self.assertNotIn(secret, card["steps"][0]["title"])
        self.assertNotIn(secret, card["sourcePhrase"])

    def test_start_and_compact_restore_task_steps_and_checkpoint(self):
        card = self.panel("task.create", {"title": "Продолжить", "steps": ["Первый", "Второй"]})["task"]
        card = self.action(card["taskId"], "step", step=0)["task"]
        self.panel("checkpoint.add", {"taskId": card["taskId"], "expectedRevision": card["revision"], "kind": "note", "text": "Первый шаг готов"})
        compact = self.ok("session.rebind", {"reason": "compact"})
        self.assertEqual(compact["focus"]["task"]["lastCheckpoint"]["text"], "Первый шаг готов")
        started = self.ok("session.rebind", {"reason": "start"}, session="session-2")
        self.assertEqual(started["focus"]["task"]["taskId"], card["taskId"])
        self.assertEqual([step["status"] for step in started["focus"]["task"]["steps"]], ["done", "active"])


class TaskScopeTests(Harness):
    def test_card_read_cannot_cross_worktree(self):
        other = self.linked_worktrees()
        self.ok("capture.prompt", {"text": "Фраза только для первого checkout"})
        card = self.task_fixture()["task"]
        self.error(self.invoke(self.request("task.get", {"taskId": card["taskId"]}, cwd=other)), "NOT_FOUND")
        # Соседние операции по идентификатору проходят ту же проверку, что и чтение.
        for op, extra in (("checkpoint.list", {}), ("task.confirm", {"expectedRevision": card["revision"]}),
                          ("checkpoint.add", {"expectedRevision": card["revision"], "kind": "note", "text": "чужая отметка"})):
            self.error(self.invoke(self.request(op, {"taskId": card["taskId"], **extra}, cwd=other)), "NOT_FOUND")
        same = self.ok("task.get", {"taskId": card["taskId"]})["task"]
        self.assertEqual((same["taskId"], same["revision"], same["lastCheckpoint"]), (card["taskId"], card["revision"], None))


if __name__ == "__main__":
    unittest.main()

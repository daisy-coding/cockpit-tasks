#!/usr/bin/env python3
"""Пакетное создание поручений агентом через настоящий RPC."""
import json
import sqlite3
import unittest
from agent_support import AgentHarness
from scale_support import seed_tasks


class AgentCreateTests(AgentHarness):
    def test_batch_source_certainty_queue_and_focus_stays_empty(self):
        args = {"tasks": [{"title": f"Поручение {i}", "description": "Описание"} for i in range(20)]}
        result = self.signed("tasks.agent.create", args, key="batch")
        self.assertEqual(len(result["tasks"]), 20)
        self.assertEqual(self.signed("tasks.agent.create", args, key="batch"), result)
        self.assertEqual([t["alias"] for t in result["tasks"]], [f"TASK-{i}" for i in range(1, 21)])
        self.assertTrue(all(set(t) == {"taskId", "alias", "title", "revision", "duplicate"} and not t["duplicate"] for t in result["tasks"]))
        self.assertIsNone(self.ok("focus.get")["task"])
        for row in self.rows("SELECT * FROM tasks ORDER BY alias_no"):
            self.assertEqual((row["stage"], row["status"], row["certainty"], row["certainty_source"], row["certainty_provenance"]),
                             ("task", "active", "inferred", "agent", "tool"))
            self.assertEqual(row["description"], "Описание")
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 20)

    def test_duplicates_remove_internal_punctuation_case_and_spaces(self):
        owner = self.owner_task("Исправить:  (панель)!")
        focus = self.ok("focus.get")
        result = self.create_agent("исправить панель", "Очередь", " ОЧЕРЕДЬ!!! ")
        self.assertEqual([t["duplicate"] for t in result], [True, False, True])
        self.assertEqual(result[0]["taskId"], owner["taskId"])
        self.assertEqual(result[1]["taskId"], result[2]["taskId"])
        self.assertEqual(self.ok("focus.get"), focus)
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 2)

    def test_limit_includes_deferred_and_batch_has_no_partial_creation(self):
        binding = self.ok("snapshot")["binding"]
        seed_tasks(self.state, binding, 4999)
        self.agent_action(self.card("scale-1"), "defer")
        before = self.rows("SELECT * FROM tasks")
        events = self.rows("SELECT * FROM events")
        self.error(self.signed_response("tasks.agent.create", {"tasks": [{"title": "Пятитысячный"}, {"title": "Лишний"}]}), "TASK_LIMIT_REACHED")
        self.assertEqual(self.rows("SELECT * FROM tasks"), before)
        self.assertEqual(self.rows("SELECT * FROM events"), events)
        self.assertEqual([t["duplicate"] for t in self.create_agent(before[1]["title"], "Пятитысячный")], [True, False])
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 5000)
        response = self.signed_response("tasks.agent.create", {"tasks": [{"title": "Пять тысяч первая"}]})
        self.error(response, "TASK_LIMIT_REACHED")
        self.assertIn("техническ", response["error"]["message"])

    def test_validation_and_rights(self):
        for tasks in ([], [{"title": "x"}] * 21, [{"title": " "}], [{"title": "я" * 301}],
                      [{"title": "x", "description": "я" * 4001}], [{"title": "x", "priority": 0}],
                      [{"title": "Правильно"}, {"title": None}]):
            self.error(self.signed_response("tasks.agent.create", {"tasks": tasks}), "INVALID_REQUEST")
        self.error(self.signed_response("tasks.agent.create", {"tasks": [{"title": "x"}]}, actor="owner"), "INVALID_REQUEST")
        self.error(self.invoke(self.request("tasks.agent.create", {"tasks": [{"title": "x"}]})), "ATTESTATION_FAILED")
        self.assertEqual(self.rows("SELECT * FROM tasks"), [])

    def test_description_keeps_first_line_after_input_redaction(self):
        secret = "sk-" + "Q" * 25  # gitleaks:allow
        description = f"Первая строка {secret}\nВторая строка"
        self.signed("tasks.agent.create", {"tasks": [{"title": "Многострочное поручение", "description": description}]})
        stored = self.rows("SELECT description FROM tasks")[0]["description"]
        self.assertIn("\nВторая строка", stored)
        self.assertNotIn(secret, stored)
        first = self.ok("tasks.context")["queue"][0]["description"]
        self.assertEqual(first, "Первая строка [REDACTED:api_key]")

    def test_db_failure_rolls_back_tasks_events_and_request(self):
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("CREATE TRIGGER fail_second BEFORE INSERT ON tasks WHEN NEW.alias_no=2 BEGIN SELECT RAISE(ABORT,'fixture'); END")
        args = {"tasks": [{"title": "Первый"}, {"title": "Второй"}]}
        self.error(self.signed_response("tasks.agent.create", args, key="retry"), "DB_UNAVAILABLE")
        self.assertEqual(self.rows("SELECT * FROM tasks"), [])
        self.assertEqual(self.rows("SELECT * FROM events WHERE kind LIKE 'task.%'"), [])
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id='retry'"), [])
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("DROP TRIGGER fail_second")
        self.assertEqual(len(self.signed("tasks.agent.create", args, key="retry")["tasks"]), 2)

    def test_secret_is_filtered_on_input_output_and_replay(self):
        secret = "sk-" + "Q" * 25  # gitleaks:allow
        args = {"tasks": [{"title": f"Проверить {secret}", "description": f"Описание {secret}"}]}
        result = self.signed("tasks.agent.create", args, key="private")
        self.assertEqual(self.signed("tasks.agent.create", args, key="private"), result)
        self.assertNotIn(secret, json.dumps(result))
        self.assertIn("[REDACTED:api_key]", result["tasks"][0]["title"])
        for name in ("tasks", "events", "requests"):
            self.assertNotIn(secret, json.dumps(self.rows(f"SELECT * FROM {name}")))

    def test_project_wide_duplicates_and_limit_ignore_candidates_deleted_and_done(self):
        other = self.other
        self.signed("session.attest", actor="owner", cwd=other)
        task = self.signed("task.create", {"title": "Общее поручение"}, actor="owner", cwd=other)["task"]
        self.assertEqual(self.create_agent("ОБЩЕЕ ПОРУЧЕНИЕ!")[0]["taskId"], task["taskId"])
        local = self.owner_task("Закрытая")
        self.agent_action(local, "done")
        self.assertFalse(self.create_agent("Закрытая")[0]["duplicate"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

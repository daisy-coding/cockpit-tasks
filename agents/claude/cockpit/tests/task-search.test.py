#!/usr/bin/env python3
"""Поиск на временной базе и общие примеры договора с модом."""
import json
import sqlite3
import unittest
from unittest.mock import patch

from agent_support import AgentHarness
from scale_support import seed_tasks
from support import REPO
from agents.claude.cockpit import domain

CASES = json.loads((REPO / "agents/claude/plugins/cockpit/tests/task-search-cases.json").read_text())


class TaskSearchTests(AgentHarness):
    def search(self, query, **args):
        return self.signed("tasks.search", {"query": query, **args})

    def test_shared_examples(self):
        from agents.claude.cockpit.task_search import parse_query, matches_row
        for case in CASES["cases"]:
            with self.subTest(query=case["query"]):
                parsed = parse_query(case["query"])
                self.assertEqual(parsed, {"terms": case["terms"], "numbers": case["numbers"]})
                self.assertEqual(matches_row(parsed, case), case["matches"])
        for query in CASES["invalidQueries"]:
            self.assertIsNone(parse_query(query))

    def test_sqlite_does_not_fold_cyrillic_and_runtime_does(self):
        with sqlite3.connect(":memory:") as db:
            self.assertEqual(db.execute("SELECT lower('ПАНЕЛЬ'), 'ПАНЕЛЬ' LIKE '%пан%' ").fetchone(), ("ПАНЕЛЬ", 0))
        card = self.owner_task("ПАНЕЛЬ ЁЛКА", description="REST api")
        found = self.search("пан елка")
        self.assertEqual(set(found["lists"]), {"queue", "deferred", "closed"})
        self.assertEqual(found["lists"]["queue"]["total"], 1)
        self.assertEqual(found["lists"]["queue"]["rows"][0]["taskId"], card["taskId"])
        self.assertEqual(self.search("rest API")["lists"]["queue"]["total"], 1)
        self.assertEqual(self.search("пан чужое")["lists"]["queue"]["total"], 0)

    def test_numbers_rank_above_title_and_text(self):
        binding = self.ok("snapshot")["binding"]
        seed_tasks(self.state, binding, 190)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET title='Ошибка 190' WHERE alias_no=1")
            db.execute("UPDATE tasks SET description='Ошибка 190' WHERE alias_no=2")
        for query in ("190", "#190", "TASK-190", "task 190"):
            rows = self.search(query)["lists"]["queue"]["rows"]
            self.assertEqual([row["alias"] for row in rows[:3]], ["TASK-190", "TASK-1", "TASK-2"])
            self.assertEqual(rows[0]["match"], {"field": "number", "snippet": "TASK-190"})

    def test_ranking_fields_and_all_terms_across_fields(self):
        cards = [self.owner_task(title, description=description) for title, description in
                 (("Суперпанель", ""), ("Панели", ""), ("Описание", "панель"), ("Критерий", ""), ("Итог", ""), ("Комментарий", ""))]
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("INSERT INTO task_lists VALUES (?,'acceptance',0,'ПАНЕЛЬ')", (cards[3]["taskId"],))
        self.agent_action(cards[4], "done", note="панель готова")
        self.signed("task.comment.add", {"taskId": cards[5]["taskId"], "text": "панель готова"}, actor="owner")
        rows = self.search("пан")["lists"]["queue"]["rows"]
        self.assertEqual([row["taskId"] for row in rows], [cards[i]["taskId"] for i in (1, 0, 2, 3, 5)])
        self.assertEqual([row["match"]["field"] for row in rows], ["title", "title", "description", "acceptance", "comment"])
        self.assertEqual(self.search("пан")["lists"]["closed"]["rows"][0]["match"]["field"], "result")
        self.assertEqual(self.search("комментарий готова")["lists"]["queue"]["total"], 1)

    def test_inside_match_accompanies_title_and_number(self):
        # Ранг и поле лучшего совпадения прежние; совпадение в тексте карточки отдаётся рядом, когда лучшее — название или номер.
        both = self.owner_task("Отдельная панель задач", description="Набор ставится одной установкой. Панель управления задачами — главное.")
        title_only = self.owner_task("Панель без описания", description="Другой текст")
        body_only = self.owner_task("Описание", description="панель")
        found = {row["taskId"]: row["match"] for row in self.search("панель")["lists"]["queue"]["rows"]}
        self.assertEqual(found[both["taskId"]]["field"], "title")
        self.assertEqual(found[both["taskId"]]["inside"], {"field": "description", "snippet": "Набор ставится одной установкой. Панель управления задачами — главное."})
        self.assertEqual(found[title_only["taskId"]], {"field": "title", "snippet": "Панель без описания"})
        self.assertEqual(found[body_only["taskId"]], {"field": "description", "snippet": "панель"})
        # Слова запроса в разных полях: отрывок строится вокруг слова, которое есть в тексте.
        self.assertEqual(self.search("отдельная главное")["lists"]["queue"]["rows"][0]["match"]["inside"]["field"], "description")
        # Описание и критерии выше комментария; комментарий отдаётся, когда в описании слова нет.
        self.signed("task.comment.add", {"taskId": both["taskId"], "text": "панель в комментарии"}, actor="owner")
        self.signed("task.comment.add", {"taskId": title_only["taskId"], "text": "панель в комментарии"}, actor="owner")
        found = {row["taskId"]: row["match"] for row in self.search("панель")["lists"]["queue"]["rows"]}
        self.assertEqual(found[both["taskId"]]["inside"]["field"], "description")
        self.assertEqual(found[title_only["taskId"]]["inside"], {"field": "comment", "snippet": "панель в комментарии"})
        # Номер — лучшее совпадение, текст с тем же числом отдаётся рядом.
        numbered = self.owner_task("Числа", description="без чисел")
        number = numbered["alias"].removeprefix("TASK-")
        own = lambda: next(row for row in self.search("#" + number)["lists"]["queue"]["rows"] if row["taskId"] == numbered["taskId"])["match"]
        self.assertEqual(own(), {"field": "number", "snippet": numbered["alias"]})
        self.signed("task.comment.add", {"taskId": numbered["taskId"], "text": f"порог {number} записей"}, actor="owner")
        self.assertEqual(own(), {"field": "number", "snippet": numbered["alias"], "inside": {"field": "comment", "snippet": f"порог {number} записей"}})

    def test_inside_match_keeps_privacy_and_window(self):
        private_prefix = "sk"
        private = private_prefix + "-" + "Zq" * 14
        card = self.owner_task("Совпадение в названии", description=("Начало " * 450) + "\n\tСОВПАДЕНИЕ\x1b‮ " + private)
        inside = self.search("совпадение")["lists"]["queue"]["rows"][0]["match"]["inside"]
        self.assertEqual(inside["field"], "description")
        self.assertLessEqual(len(inside["snippet"]), 160)
        self.assertIn("СОВПАДЕНИЕ", inside["snippet"])
        self.assertNotIn(private, inside["snippet"])
        self.assertIn("[REDACTED:", inside["snippet"])
        self.assertFalse(any(ch in inside["snippet"] for ch in "\n\t\x1b‮"))
        # Слово, которое в тексте есть только внутри секрета, внутренним совпадением не считается.
        hidden = self.owner_task("Zqzqzq в названии", description="Открытая часть " + private)
        match = next(row for row in self.search("zqzqzq")["lists"]["queue"]["rows"] if row["taskId"] == hidden["taskId"])["match"]
        self.assertEqual(match["field"], "title")
        self.assertNotIn("inside", match)
        self.assertEqual(card["taskId"], self.search("совпадение")["lists"]["queue"]["rows"][0]["taskId"])

    def test_pages_scope_hidden_tasks_and_history_order(self):
        binding = self.ok("snapshot")["binding"]
        seed_tasks(self.state, binding, 6)
        seed_tasks(self.state, binding, 5, start=7, status="paused")
        seed_tasks(self.state, binding, 5, start=12, status="done")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET deleted=1 WHERE alias_no=2")
            db.execute("UPDATE tasks SET stage='candidate' WHERE alias_no=3")
            db.execute("UPDATE tasks SET certainty='observed',certainty_source='engine',certainty_provenance='cli' WHERE alias_no=4")
            db.execute("DELETE FROM task_steps WHERE task_id='scale-4'")
            db.execute("UPDATE tasks SET worktree_id='foreign' WHERE alias_no=5")
            db.execute("INSERT INTO task_closures VALUES ('scale-12','2999-01-01T00:00:00.000000Z')")
        result = self.search("проверить", offset=1, limit=2)
        self.assertEqual(result["offset"], 1)
        self.assertFalse(result["truncated"])
        self.assertEqual(result["lists"]["queue"]["total"], 2)
        self.assertEqual([row["alias"] for row in result["lists"]["queue"]["rows"]], ["TASK-6"])
        self.assertEqual(result["lists"]["deferred"]["total"], 5)
        self.assertEqual([row["alias"] for row in self.search("проверить", lists=["closed"], limit=2)["lists"]["closed"]["rows"]], ["TASK-12", "TASK-16"])
        self.assertEqual(set(self.search("проверить", lists=["deferred"])["lists"]), {"deferred"})
        self.assertEqual(self.search("проверить", offset=999)["lists"]["queue"]["rows"], [])

    def test_match_privacy_single_line_and_full_field_before_cutting(self):
        private_prefix = "sk"
        private = private_prefix + "-" + "Q" * 25
        card = self.owner_task("Безопасный поиск", description=("Начало " * 450) + "\n\tСОВПАДЕНИЕ\x1b\u202e " + private)
        row = self.search("совпадение")["lists"]["queue"]["rows"][0]
        self.assertEqual(row["taskId"], card["taskId"])
        snippet = row["match"]["snippet"]
        self.assertLessEqual(len(snippet), 160)
        self.assertIn("СОВПАДЕНИЕ", snippet)
        self.assertNotIn(private, snippet)
        self.assertIn("[REDACTED:", snippet)
        self.assertFalse(any(ch in snippet for ch in "\n\t\x1b\u202e"))
        self.assertEqual(set(row), {"taskId", "alias", "title", "status", "updatedAt", "priorityPinned", "match", "returnCount"})
        self.assertEqual(row["returnCount"], 0)
        timestamp = domain.now()
        binding = self.ok("snapshot")["binding"]
        with sqlite3.connect(self.state / "cockpit.db") as db:
            split = private_prefix + "-<pasted_content>" + "Q" * 25 + "</pasted_content>"
            db.execute("INSERT INTO task_owner_comments VALUES ('split-secret',?,?,?,?,?,?,?,0,0)",
                       (card["taskId"], binding["projectId"], binding["worktreeId"], binding["sessionId"],
                        "Маркеркомментария " + split, timestamp, timestamp))
        snippet = self.search("маркеркомментария")["lists"]["queue"]["rows"][0]["match"]["snippet"]
        self.assertNotIn(private, snippet)
        self.assertIn("[REDACTED:", snippet)

    def test_secret_text_is_not_searchable(self):
        # Слово, которое есть только внутри замаскированного секрета, совпадением не считается:
        # иначе перебором запросов секрет читается по частям, хотя отрывок его и скрывает.
        private_prefix = "sk"
        private = private_prefix + "-" + "Zq" * 14
        card = self.owner_task("Ключ доступа", description="Открытая часть " + private)
        for probe in ("zqzqzq", private, private_prefix + " zqzqzqzq"):
            found = self.search(probe)
            self.assertEqual({name: page["total"] for name, page in found["lists"].items()},
                             {"queue": 0, "deferred": 0, "closed": 0}, probe)
        row = self.search("открытая")["lists"]["queue"]["rows"][0]
        self.assertEqual(row["taskId"], card["taskId"])
        self.assertNotIn(private, row["match"]["snippet"])
        self.assertIn("[REDACTED:", row["match"]["snippet"])
        # То же слово в открытом тексте другого поля находится, и найденным считается открытое поле.
        self.signed("task.comment.add", {"taskId": card["taskId"], "text": "zqzqzq без секрета"}, actor="owner")
        found = self.search("zqzqzq")["lists"]["queue"]
        self.assertEqual(found["total"], 1)
        self.assertEqual(found["rows"][0]["match"]["field"], "comment")
        self.assertNotIn(private, found["rows"][0]["match"]["snippet"])

    def test_invalid_inputs_and_read_for_both_actors(self):
        self.owner_task("Проверить вход")
        for args in ({}, {"query": ""}, {"query": " "}, {"query": 12}, {"query": "я" * 201},
                     {"query": "пан", "lists": []}, {"query": "пан", "lists": ["queue", "queue"]},
                     {"query": "пан", "lists": ["owner"]}, {"query": "пан", "lists": "queue"},
                     {"query": "пан", "limit": 0}, {"query": "пан", "limit": 51}, {"query": "пан", "limit": True},
                     {"query": "пан", "offset": -1}, {"query": "пан", "offset": 1.1}, {"query": "пан", "offset": True}):
            self.error(self.signed_response("tasks.search", args), "INVALID_REQUEST")
        before = self.rows("SELECT task_id,revision,status FROM tasks")
        for actor in ("agent", "owner"):
            self.assertEqual(self.signed("tasks.search", {"query": "вход"}, actor=actor)["lists"]["queue"]["total"], 1)
        self.assertEqual(before, self.rows("SELECT task_id,revision,status FROM tasks"))

    def test_response_budget_and_replay(self):
        from agents.claude.cockpit.task_search import search_tasks
        binding = self.ok("snapshot")["binding"]
        seed_tasks(self.state, binding, 100, worst=True)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            with patch.object(domain, "SNAPSHOT_RESPONSE_BYTES", 1600):
                result = search_tasks(db, binding, {"query": "проверить", "limit": 50})
            self.assertTrue(result["truncated"])
            self.assertEqual(result["lists"]["queue"]["total"], 100)
            self.assertLess(len(result["lists"]["queue"]["rows"]), 50)
            self.assertLessEqual(len(json.dumps({"v": 1, "ok": True, "result": result}, ensure_ascii=False, separators=(",", ":")).encode()) + 1, 1600)
        request = {**self.request("tasks.search", {"query": "проверить", "limit": 50}), "actor": "agent", "panelSecret": self.secret}
        first = self.invoke(request)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET title='Проверить актуальную задачу' WHERE task_id='scale-1'")
        repeated = self.invoke(request)
        self.assertEqual(set(repeated["result"]), set(first["result"]))
        self.assertEqual(repeated["result"]["lists"]["queue"]["total"], 100)
        self.assertEqual(next(row for row in repeated["result"]["lists"]["queue"]["rows"]
                              if row["taskId"] == "scale-1")["title"], "Проверить актуальную задачу")
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id=?", (request["requestId"],)), [])
        self.assertLessEqual(len(json.dumps(first, ensure_ascii=False, separators=(",", ":")).encode()) + 1, domain.SNAPSHOT_RESPONSE_BYTES)
        self.assertLessEqual(len(json.dumps(repeated, ensure_ascii=False, separators=(",", ":")).encode()) + 1, domain.SNAPSHOT_RESPONSE_BYTES)


if __name__ == "__main__":
    unittest.main()

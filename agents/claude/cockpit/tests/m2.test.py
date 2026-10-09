#!/usr/bin/env python3
"""Типы Inbox, подтверждение, контрольные точки и явный отход/возврат на SQLite."""

import json
import sqlite3
import subprocess
import sys
import unittest
from unittest.mock import patch

from support import CLI, Harness
from agents.claude.cockpit import domain, rpc
from agents.claude.cockpit.store import Store


class M2Tests(Harness):
    def repeat(self, request):
        first = self.invoke(request)
        self.assertTrue(first["ok"], first)
        before = self.rows("SELECT * FROM events")
        requests = self.rows("SELECT * FROM requests")
        state = {name: self.rows(f"SELECT * FROM {name}") for name in
                 ("tasks", "focus", "inbox", "inbox_observations", "checkpoints", "focus_stack")}
        self.assertEqual(self.invoke(request), first)
        self.assertEqual(self.rows("SELECT * FROM events"), before)
        self.assertEqual(self.rows("SELECT * FROM requests"), requests)
        for name, rows in state.items():
            self.assertEqual(self.rows(f"SELECT * FROM {name}"), rows)
        return first["result"]

    def observation(self, inbox_id, kind, source="rule", mode="active", timestamp="2000-01-01T00:00:00.000000Z"):
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("""INSERT INTO inbox_observations
                (inbox_id,project_id,inbox_type,classified_by,policy_version,mode,created_at)
                SELECT inbox_id,project_id,?,?, 'fixture-1',?,? FROM inbox WHERE inbox_id=?""",
                       (kind, source, mode, timestamp, inbox_id))
        db.close()

    def test_rule_one_is_literal_and_capture_does_not_change_focus_or_create_tasks(self):
        for text, kind in (("Вопрос?", "question"), ("Вопрос? \r\n", "info"), ("", "info"),
                           ("Стоп, решение, согласование, конфликт!", "info"), ("？", "info")):
            with self.subTest(text=text):
                saved = self.repeat(self.request("capture.prompt", {"text": text}))
                record = self.ok("inbox.get", {"inboxId": saved["inboxId"]})
                self.assertEqual(record["text"], text)
                self.assertEqual(record["type"], kind)
                self.assertEqual(record["classifiedBy"], "rule")
                self.assertEqual(record["policyVersion"], "rule-1")
                self.assertEqual(record["mode"], "active")
                self.assertIsNone(record["confidence"])
                self.assertEqual(record["scope"], {"taskId": None, "resourceId": None})
                self.assertEqual(record["triageStatus"], "untriaged")
                self.assertEqual(record["triageRevision"], 1)
        self.assertEqual(self.rows("SELECT * FROM tasks"), [])
        self.assertEqual(self.rows("SELECT * FROM focus"), [])
        self.assertEqual(len(self.rows("SELECT * FROM inbox_observations")), 5)

    def test_rule_scope_is_active_focus_at_capture_not_later_bind(self):
        first = self.ok("capture.prompt", {"text": "Первый источник"})
        task = self.task_fixture()["task"]
        self.assertEqual((task["certainty"], task["certaintySource"]), ("observed", "engine"))
        self.assertIsNone(self.ok("inbox.get", {"inboxId": first["inboxId"]})["scope"]["taskId"])
        saved = self.ok("capture.prompt", {"text": "Теперь есть активная задача?"})
        self.assertEqual(self.ok("inbox.get", {"inboxId": saved["inboxId"]})["scope"]["taskId"], task["taskId"])
        self.ok("task.update", {"taskId": task["taskId"], "expectedRevision": 0, "status": "paused"})
        saved = self.ok("capture.prompt", {"text": "Пауза не активный фокус"})
        self.assertIsNone(self.ok("inbox.get", {"inboxId": saved["inboxId"]})["scope"]["taskId"])
        self.assertEqual(self.ok("focus.get")["task"]["taskId"], task["taskId"])

    def test_task_confirm_replay_revision_conflict_and_invalid_input(self):
        task = self.task_fixture()["task"]
        confirmed = self.repeat(self.request("task.confirm", {"taskId": task["taskId"], "expectedRevision": 0}))["task"]
        self.assertEqual((confirmed["certainty"], confirmed["certaintySource"], confirmed["revision"]),
                         ("confirmed", "user", 1))
        self.assertEqual(confirmed["status"], "active")
        self.error(self.invoke(self.request("task.confirm", {"taskId": task["taskId"], "expectedRevision": 0})),
                   "REVISION_CONFLICT")
        for args in ({"taskId": task["taskId"]}, {"taskId": task["taskId"], "expectedRevision": True},
                     {"taskId": task["taskId"], "expectedRevision": 1, "source": "engine"}):
            with self.subTest(args=args):
                self.error(self.invoke(self.request("task.confirm", args)), "INVALID_REQUEST")
        self.error(self.invoke(self.request("task.confirm", {"taskId": "missing", "expectedRevision": 0})), "NOT_FOUND")
        updated = self.ok("task.update", {"taskId": task["taskId"], "expectedRevision": 1, "title": "Уточнение"})
        self.assertEqual(updated["task"]["certainty"], "confirmed")
        self.assertEqual(self.ok("snapshot")["tasks"][0]["certaintySource"], "user")

    def test_triage_is_append_only_user_overrides_later_rule_and_jev(self):
        task = self.task_fixture()["task"]
        saved = self.ok("capture.prompt", {"text": "Оригинал\r\n🐋?"})
        inbox_id = saved["inboxId"]
        original = self.rows("SELECT * FROM inbox")
        result = self.repeat(self.request("inbox.triage", {
            "inboxId": inbox_id, "expectedRevision": 1, "type": "blocking",
            "taskId": task["taskId"], "resourceId": "resource-1", "status": "untriaged",
        }))
        self.assertEqual((result["type"], result["classifiedBy"], result["triageStatus"], result["triageRevision"]),
                         ("blocking", "user", "untriaged", 2))
        self.assertEqual(result["scope"], {"taskId": task["taskId"], "resourceId": "resource-1"})
        self.assertEqual(result["policyVersion"], "user-1")
        self.assertEqual(self.rows("SELECT * FROM inbox"), original)
        self.observation(inbox_id, "info")
        self.observation(inbox_id, "question", "jev", "shadow")
        record = self.ok("inbox.get", {"inboxId": inbox_id})
        self.assertEqual((record["type"], record["classifiedBy"], record["triageRevision"]), ("blocking", "user", 4))
        panel = self.ok("snapshot")
        self.assertEqual(panel["inboxTriageCounts"], {"untriaged": 1, "blocking": 1})
        self.assertEqual(panel["inbox"][0]["type"], "blocking")
        self.error(self.invoke(self.request("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 2,
                                                              "status": "triaged"})), "REVISION_CONFLICT")
        for status, expected in (("triaged", 4), ("rejected", 5)):
            self.ok("inbox.triage", {"inboxId": inbox_id, "expectedRevision": expected, "status": status})
            self.assertEqual(self.ok("snapshot")["inboxTriageCounts"], {"untriaged": 0, "blocking": 0})
        self.ok("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 6,
                                  "type": None, "taskId": None, "resourceId": None, "status": "untriaged"})
        record = self.ok("inbox.get", {"inboxId": inbox_id})
        self.assertIsNone(record["type"])
        self.assertEqual(record["classifiedBy"], "user")
        self.assertEqual(record["scope"], {"taskId": None, "resourceId": None})
        self.assertEqual(self.rows("SELECT * FROM inbox"), original)

    def test_all_inbox_types_and_invalid_triage(self):
        inbox_id = self.ok("capture.prompt", {"text": "Все виды"})["inboxId"]
        for revision, kind in enumerate(("info", "proposal", "question", "decision", "approval", "conflict", "blocking"), 1):
            result = self.ok("inbox.triage", {"inboxId": inbox_id, "expectedRevision": revision, "type": kind})
            self.assertEqual(result["type"], kind)
        bad = ({"inboxId": inbox_id, "expectedRevision": 8},
               {"inboxId": inbox_id, "expectedRevision": 8, "type": "PREEMPT"},
               {"inboxId": inbox_id, "expectedRevision": -1, "type": "info"},
               {"inboxId": inbox_id, "expectedRevision": 8, "status": "done"},
               {"inboxId": inbox_id, "expectedRevision": 8, "taskId": 42},
               {"inboxId": inbox_id, "expectedRevision": 8, "resourceId": "../file"},
               {"inboxId": inbox_id, "expectedRevision": 8, "type": "info", "classifiedBy": "jev"})
        for args in bad:
            with self.subTest(args=args):
                self.error(self.invoke(self.request("inbox.triage", args)), "INVALID_REQUEST")
        self.error(self.invoke(self.request("inbox.triage", {"inboxId": "missing", "expectedRevision": 0,
                                                              "type": "info"})), "NOT_FOUND")
        self.error(self.invoke(self.request("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 8,
                                                              "taskId": "missing"})), "NOT_FOUND")

    def test_last_observation_uses_commit_order_and_shadow_does_not_count_as_blocker(self):
        inbox_id = self.ok("capture.prompt", {"text": "Без человека"})["inboxId"]
        self.observation(inbox_id, "blocking", "jev", "shadow")
        row = self.ok("inbox.get", {"inboxId": inbox_id})
        self.assertEqual((row["type"], row["classifiedBy"], row["mode"]), ("blocking", "jev", "shadow"))
        self.assertEqual(self.ok("snapshot")["inboxTriageCounts"]["blocking"], 0)
        self.observation(inbox_id, "blocking", "rule")
        self.assertEqual(self.ok("inbox.get", {"inboxId": inbox_id})["classifiedBy"], "rule")
        self.assertEqual(self.ok("snapshot", {"limits": {"tasks": 0, "inbox": 0}})["inboxTriageCounts"]["blocking"], 1)

    def test_off_capture_rule_never_stores_text(self):
        self.assertEqual(self.human("config", "set", "capture-mode", "off").returncode, 0)
        text = "Нельзя сохранить уникальный текст?"
        saved = self.ok("capture.prompt", {"text": text})
        record = self.ok("inbox.get", {"inboxId": saved["inboxId"]})
        self.assertEqual(record["type"], "question")
        self.assertIsNone(record["text"])
        with sqlite3.connect(self.state / "cockpit.db") as db:
            dump = "\n".join(db.iterdump())
        db.close()
        self.assertNotIn(text, dump)

    def test_classifier_sql_failure_does_not_lose_original_or_retry(self):
        self.ok("snapshot")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("""CREATE TRIGGER fail_observation BEFORE INSERT ON inbox_observations
                BEGIN SELECT RAISE(ABORT,'сбой классификации в фикстуре'); END""")
        db.close()
        saved = self.repeat(self.request("capture.prompt", {"text": "Сохранить дословно\r\n🐋?"}))
        row = self.ok("inbox.get", {"inboxId": saved["inboxId"]})
        self.assertEqual(row["text"], "Сохранить дословно\r\n🐋?")
        self.assertIsNone(row["type"])
        self.assertEqual(row["triageRevision"], 0)
        self.assertEqual(len(self.rows("SELECT * FROM inbox")), 1)
        self.assertEqual(len(self.rows("SELECT * FROM events WHERE kind='prompt.captured'")), 1)

    def test_classifier_exception_after_insert_rolls_back_only_observation(self):
        request = self.request("capture.prompt", {"text": "Оригинал при сбое Python?"})
        original = domain.classify_prompt

        def broken(*args):
            original(*args)
            raise RuntimeError("Сбой нового кода после записи")

        with patch("agents.claude.cockpit.store.state_directory", return_value=str(self.state)), \
                patch("agents.claude.cockpit.domain.classify_prompt", side_effect=broken):
            response = rpc.handle(request)
        self.assertTrue(response["ok"], response)
        self.assertEqual(self.rows("SELECT raw_text FROM inbox")[0]["raw_text"], request["args"]["text"])
        self.assertEqual(self.rows("SELECT * FROM inbox_observations"), [])
        self.assertEqual(self.invoke(request), response)

    def test_checkpoint_add_list_replay_conflicts_sources_and_invalid_input(self):
        task_id = self.task_fixture()["task"]["taskId"]
        for revision, kind in enumerate(("commit", "tests-passed", "note", "detour", "return")):
            added = self.repeat(self.request("checkpoint.add", {
                "taskId": task_id, "expectedRevision": revision, "kind": kind,
                "text": f"Отметка {revision}", "source": "tool" if revision == 1 else "user",
            }))
            self.assertEqual(added["checkpoint"]["kind"], kind)
            self.assertEqual(added["taskRevision"], revision + 1)
        feed = self.repeat(self.request("checkpoint.list", {"taskId": task_id, "expectedRevision": 5, "limit": 2}))
        self.assertEqual([row["kind"] for row in feed["checkpoints"]], ["return", "detour"])
        full = self.ok("checkpoint.list", {"taskId": task_id})
        self.assertEqual(full["checkpoints"][-2]["source"], "tool")
        self.assertEqual(self.ok("focus.get")["task"]["certainty"], "observed")
        self.assertEqual(self.ok("checkpoint.list", {"taskId": task_id, "limit": 0})["checkpoints"], [])
        for op, args in (("checkpoint.add", {"taskId": task_id, "expectedRevision": 0, "kind": "note", "text": "Поздно"}),
                         ("checkpoint.list", {"taskId": task_id, "expectedRevision": 0})):
            self.error(self.invoke(self.request(op, args)), "REVISION_CONFLICT")
        for args in ({"taskId": task_id, "expectedRevision": 5, "kind": "git", "text": "Текст"},
                     {"taskId": task_id, "expectedRevision": 5, "kind": "note", "text": " "},
                     {"taskId": task_id, "expectedRevision": 5, "kind": "note", "text": "я" * 1001},
                     {"taskId": task_id, "expectedRevision": 5, "kind": "note", "text": "Текст", "source": "jev"}):
            self.error(self.invoke(self.request("checkpoint.add", args)), "INVALID_REQUEST")
        for args in ({"taskId": task_id, "limit": True}, {"taskId": task_id, "limit": 101}, {}):
            self.error(self.invoke(self.request("checkpoint.list", args)), "INVALID_REQUEST")
        self.error(self.invoke(self.request("checkpoint.list", {"taskId": "missing"})), "NOT_FOUND")
        self.error(self.invoke(self.request("checkpoint.add", {"taskId": "missing", "expectedRevision": 0,
                                                                 "kind": "note", "text": "Текст"})), "NOT_FOUND")

    def test_detour_return_replay_revision_conflicts_and_packet_is_bounded_and_redacted(self):
        secret = "sk-" + "A1b2C3d4E5" * 3
        task = self.task_fixture()["task"]
        task_id = task["taskId"]
        self.ok("task.update", {"taskId": task_id, "expectedRevision": 0, "title": "Задача " + secret})
        for revision in range(1, 8):
            self.ok("checkpoint.add", {"taskId": task_id, "expectedRevision": revision,
                                       "kind": "note", "text": f"Отметка {revision}: {secret}"})
        inbox_ids = []
        for number in range(7):
            inbox_ids.append(self.ok("capture.prompt", {"text": f"Входящий {number}: {secret}"})["inboxId"])
        self.ok("inbox.triage", {"inboxId": inbox_ids[-1], "expectedRevision": 1, "status": "triaged"})
        departed = self.repeat(self.request("focus.detour", {"expectedRevision": 1, "title": "Срочная работа"}))
        self.assertEqual(departed["stackDepth"], 1)
        target = departed["focus"]["task"]
        self.assertNotEqual(target["taskId"], task_id)
        self.assertEqual((target["certainty"], target["certaintySource"]), ("confirmed", "user"))
        self.assertEqual(departed["checkpoint"]["kind"], "detour")
        self.assertEqual(departed["checkpoint"]["source"], "user")
        self.error(self.invoke(self.request("focus.detour", {"expectedRevision": 1, "title": "Лишняя задача"})),
                   "REVISION_CONFLICT")
        self.error(self.invoke(self.request("focus.return", {"expectedRevision": 1})), "REVISION_CONFLICT")
        result = self.repeat(self.request("focus.return", {"expectedRevision": departed["focus"]["revision"]}))
        self.assertEqual(result["stackDepth"], 0)
        self.assertEqual(result["focus"]["task"]["taskId"], task_id)
        self.assertEqual(result["focus"]["revision"], 3)
        packet = result["returnPacket"]
        self.assertEqual(packet["taskId"], task_id)
        self.assertEqual(len(packet["checkpoints"]), 5)
        self.assertEqual(packet["checkpoints"][0]["kind"], "return")
        self.assertEqual(len(packet["inbox"]), 5)
        self.assertEqual(packet["inbox"][0]["inboxId"], inbox_ids[-2])
        self.assertNotIn(secret, json.dumps(result, ensure_ascii=False))
        self.assertIn("[REDACTED:api_key]", json.dumps(result, ensure_ascii=False))
        self.assertIn(secret, self.rows("SELECT text FROM checkpoints WHERE kind='note'")[0]["text"])
        self.assertEqual(self.rows("SELECT title FROM tasks WHERE task_id=?", (task_id,))[0]["title"], "Задача " + secret)
        self.assertNotIn(secret, json.dumps(self.ok("checkpoint.list", {"taskId": task_id}), ensure_ascii=False))
        self.assertNotIn(secret, json.dumps(self.ok("snapshot"), ensure_ascii=False))
        self.assertNotIn(secret, json.dumps(self.rows("SELECT * FROM requests"), ensure_ascii=False))
        self.ok("task.update", {"taskId": task_id, "expectedRevision": result["focus"]["task"]["revision"], "status": "paused"})
        self.assertEqual(self.rows("SELECT title FROM tasks WHERE task_id=?", (task_id,))[0]["title"], "Задача " + secret)

    def test_checkpoint_preserves_unicode_crlf_nul_and_uses_commit_order(self):
        task_id = self.task_fixture()["task"]["taskId"]
        text = "\x00Контрольная точка 🧑‍💻 cafe\u0301\r\n"
        added = self.ok("checkpoint.add", {"taskId": task_id, "expectedRevision": 0, "kind": "note", "text": text})
        # В базе текст дословный; наружу — без NUL, CRLF нормализуется в LF.
        expected_text = "Контрольная точка " + chr(0x1f9d1) + chr(0x200d) + chr(0x1f4bb) + " cafe" + chr(0x301) + "\n"
        self.assertEqual(added["checkpoint"]["text"], expected_text)
        self.assertEqual(self.rows("SELECT text FROM checkpoints")[0]["text"], text)
        # Поздняя запись со старым временем должна остаться первой в ленте.
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("""INSERT INTO checkpoints SELECT 'old-clock',task_id,project_id,worktree_id,session_id,
                kind,'После отката часов',source,'2000-01-01T00:00:00.000000Z',provenance FROM checkpoints""")
        db.close()
        feed = self.ok("checkpoint.list", {"taskId": task_id})["checkpoints"]
        self.assertEqual(feed[0]["checkpointId"], "old-clock")
        self.assertEqual(feed[1]["text"], expected_text)

    def test_parallel_triage_cas_commits_exactly_one_user_observation(self):
        inbox_id = self.ok("capture.prompt", {"text": "Одно решение человека"})["inboxId"]
        processes = [subprocess.Popen([sys.executable, str(CLI), "rpc"], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=self.cwd, env=self.env)
                     for _ in range(2)]
        try:
            for process, kind in zip(processes, ("proposal", "decision")):
                request = self.request("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 1, "type": kind})
                process.stdin.write(json.dumps(request).encode())
                process.stdin.close()
                process.stdin = None
            responses = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=8)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertEqual(stderr, b"")
                responses.append(json.loads(stdout))
            self.assertEqual(sum(response["ok"] for response in responses), 1)
            self.error(next(response for response in responses if not response["ok"]), "REVISION_CONFLICT")
            self.assertEqual(len(self.rows("SELECT * FROM inbox_observations WHERE classified_by='user'")), 1)
            self.assertEqual(self.ok("inbox.get", {"inboxId": inbox_id})["triageRevision"], 2)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_nested_stack_limit_and_return_to_existing_task(self):
        root = self.task_fixture()["task"]["taskId"]
        ids = [root]
        revision = 1
        for depth in range(1, 9):
            result = self.ok("focus.detour", {"expectedRevision": revision, "title": f"Отход {depth}"})
            self.assertEqual(result["stackDepth"], depth)
            revision = result["focus"]["revision"]
            ids.append(result["focus"]["task"]["taskId"])
        before = self.rows("SELECT * FROM tasks")
        self.error(self.invoke(self.request("focus.detour", {"expectedRevision": revision, "title": "Девятый"})),
                   "INVALID_REQUEST")
        self.assertEqual(self.rows("SELECT * FROM tasks"), before)
        self.assertEqual(len(self.rows("SELECT * FROM focus_stack")), 8)
        for expected in reversed(ids[:-1]):
            result = self.ok("focus.return", {"expectedRevision": revision}, session="new-session")
            self.assertEqual(result["focus"]["task"]["taskId"], expected)
            revision = result["focus"]["revision"]
        result = self.ok("focus.detour", {"expectedRevision": revision, "taskId": ids[-1]})
        self.assertEqual(result["focus"]["task"]["taskId"], ids[-1])
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 9)

    def test_empty_stack_missing_focus_terminal_targets_and_invalid_detours(self):
        self.error(self.invoke(self.request("focus.return", {"expectedRevision": 0})), "INVALID_REQUEST")
        self.error(self.invoke(self.request("focus.detour", {"expectedRevision": 0, "title": "Нет текущей задачи"})),
                   "INVALID_REQUEST")
        self.assertEqual(self.rows("SELECT * FROM tasks"), [])
        task = self.task_fixture()["task"]
        for args in ({"expectedRevision": 1}, {"expectedRevision": 1, "title": " "},
                     {"expectedRevision": 1, "title": "я" * 301},
                     {"expectedRevision": 1, "title": "Название", "taskId": task["taskId"]},
                     {"expectedRevision": 1, "taskId": task["taskId"]},
                     {"expectedRevision": True, "title": "Название"}):
            self.error(self.invoke(self.request("focus.detour", args)), "INVALID_REQUEST")
        self.error(self.invoke(self.request("focus.return", {"expectedRevision": True})), "INVALID_REQUEST")
        self.error(self.invoke(self.request("focus.detour", {"expectedRevision": 1, "taskId": "missing"})), "NOT_FOUND")
        departed = self.ok("focus.detour", {"expectedRevision": 1, "title": "Другая"})
        self.ok("task.update", {"taskId": task["taskId"], "expectedRevision": 1, "status": "done"})
        self.error(self.invoke(self.request("focus.return", {"expectedRevision": departed["focus"]["revision"]})),
                   "INVALID_REQUEST")
        self.assertEqual(len(self.rows("SELECT * FROM focus_stack")), 1)
        self.error(self.invoke(self.request("focus.detour", {"expectedRevision": departed["focus"]["revision"],
                                                              "taskId": task["taskId"]})), "INVALID_REQUEST")

    def test_return_after_departed_task_completed_and_cleared_focus(self):
        root = self.task_fixture()["task"]["taskId"]
        departed = self.ok("focus.detour", {"expectedRevision": 1, "title": "Закончить отход"})
        self.ok("task.update", {"taskId": departed["focus"]["task"]["taskId"], "expectedRevision": 0, "status": "done"})
        result = self.ok("focus.return", {"expectedRevision": 3})
        self.assertEqual(result["focus"]["task"]["taskId"], root)
        self.assertEqual(result["focus"]["revision"], 4)

    def test_new_operations_respect_project_and_worktree_boundaries(self):
        linked = self.linked_worktrees()
        task = self.task_fixture()["task"]
        inbox_id = self.ok("capture.prompt", {"text": "Наш пункт"})["inboxId"]
        other = self.root / "foreign"
        other.mkdir()
        requests = (("task.confirm", {"taskId": task["taskId"], "expectedRevision": 0}),
                    ("checkpoint.add", {"taskId": task["taskId"], "expectedRevision": 0, "kind": "note", "text": "Отметка"}),
                    ("checkpoint.list", {"taskId": task["taskId"]}),
                    ("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 1, "type": "info"}))
        for op, args in requests:
            with self.subTest(op=op):
                self.error(self.invoke(self.request(op, args, cwd=other)), "NOT_FOUND")
        self.error(self.invoke(self.request("inbox.triage", requests[-1][1], cwd=linked)), "NOT_FOUND")
        self.ok("focus.detour", {"expectedRevision": 1, "title": "Отход здесь"})
        self.error(self.invoke(self.request("focus.return", {"expectedRevision": 0}, cwd=linked)), "INVALID_REQUEST")
        self.task_fixture( cwd=other)
        self.error(self.invoke(self.request("focus.detour", {"expectedRevision": 1, "taskId": task["taskId"]}, cwd=other)),
                   "NOT_FOUND")
        self.error(self.invoke(self.request("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 1,
                                                              "taskId": self.ok("focus.get", cwd=other)["task"]["taskId"]})), "NOT_FOUND")

    def test_new_records_are_immutable_and_schema_accepts_reserved_values(self):
        task_id = self.task_fixture()["task"]["taskId"]
        self.ok("capture.prompt", {"text": "Источник"})
        self.ok("checkpoint.add", {"taskId": task_id, "expectedRevision": 0, "kind": "note", "text": "Отметка"})
        with Store(str(self.state)) as store:
            db = store.connection
            for table in ("inbox_observations", "checkpoints"):
                for statement in (f"UPDATE {table} SET created_at='замена'", f"DELETE FROM {table}"):
                    with self.subTest(sql=statement), self.assertRaises(sqlite3.IntegrityError):
                        db.execute(statement)
            for certainty in ("observed", "inferred", "confirmed", "verified"):
                for source in ("user", "claude", "agent", "engine", "tool", "provider"):
                    db.execute("UPDATE tasks SET certainty=?,certainty_source=?", (certainty, source))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE tasks SET certainty='finished'")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE tasks SET certainty_source='jev'")

    def test_detour_return_checkpoint_failures_roll_back_all_domain_changes(self):
        self.task_fixture()
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("""CREATE TRIGGER fail_checkpoint BEFORE INSERT ON checkpoints
                BEGIN SELECT RAISE(ABORT,'сбой отметки в фикстуре'); END""")
        db.close()
        request = self.request("focus.detour", {"expectedRevision": 1, "title": "Не должна остаться"})
        before = {name: self.rows(f"SELECT * FROM {name}") for name in ("tasks", "focus", "focus_stack", "events")}
        self.error(self.invoke(request), "DB_UNAVAILABLE")
        for name, rows in before.items():
            self.assertEqual(self.rows(f"SELECT * FROM {name}"), rows)
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id=?", (request["requestId"],)), [])
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("DROP TRIGGER fail_checkpoint")
        db.close()
        self.assertTrue(self.invoke(request)["ok"])
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("""CREATE TRIGGER fail_checkpoint BEFORE INSERT ON checkpoints
                BEGIN SELECT RAISE(ABORT,'сбой возврата в фикстуре'); END""")
        db.close()
        before = {name: self.rows(f"SELECT * FROM {name}") for name in ("tasks", "focus", "focus_stack", "events")}
        self.error(self.invoke(self.request("focus.return", {"expectedRevision": 2})), "DB_UNAVAILABLE")
        for name, rows in before.items():
            self.assertEqual(self.rows(f"SELECT * FROM {name}"), rows)


    def test_control_characters_never_leave_shown_text(self):
        hostile = "Норм\x1b[2J\x1b]0;подделка\x07 \u202eтекст\x9b31m\r\nвторая"
        clean = domain.shown(hostile, 300)
        self.assertEqual(clean, "Норм[2J]0;подделка текст31m вторая")
        self.assertFalse(any(ord(ch) < 32 or 127 <= ord(ch) < 160 for ch in clean))
        self.ok("capture.prompt", {"text": hostile, "kind": "prompt"})
        task = self.task_fixture( {})["task"]
        self.assertNotIn("\x1b", task["title"])
        preview = self.ok("snapshot", {})["inbox"][0]["preview"]
        self.assertNotIn("\x1b", preview)
        self.assertNotIn("\u202e", preview)

if __name__ == "__main__":
    unittest.main(verbosity=2)

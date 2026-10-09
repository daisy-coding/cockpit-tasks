#!/usr/bin/env python3
"""Контракт M1, конкурентные процессы и запасной человеческий CLI."""

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
import unittest

from support import CLI, Harness
from agents.claude.cockpit.rpc import MAX_REQUEST_BYTES
from agents.claude.cockpit.store import SCHEMA_VERSION
from agents.claude.cockpit.domain import plain


class RpcTests(Harness):
    def test_idempotency_returns_committed_response_without_writes(self):
        request = self.request("capture.prompt", {"text": "Сохранить ровно один раз"}, key="delivery-1")
        first = self.invoke(request)
        before = self.rows("SELECT * FROM requests")
        events = self.rows("SELECT * FROM events")
        self.assertEqual(self.invoke(raw=json.dumps(request, sort_keys=True, indent=2).encode()), first)
        self.assertEqual(self.rows("SELECT * FROM requests"), before)
        self.assertEqual(self.rows("SELECT * FROM events"), events)
        self.assertEqual(len(self.rows("SELECT * FROM inbox")), 1)
        request["args"]["text"] = "Другое указание"
        self.error(self.invoke(request), "IDEMPOTENCY_CONFLICT")
        self.assertEqual(len(self.rows("SELECT * FROM inbox")), 1)

    def test_identical_text_new_request_is_new_inbox_even_with_same_delivery_id(self):
        args = {"text": "да", "deliveryId": "host-delivery", "kind": "prompt"}
        first = self.ok("capture.prompt", args)
        second = self.ok("capture.prompt", args)
        self.assertNotEqual(first["inboxId"], second["inboxId"])
        self.assertEqual(len(self.rows("SELECT * FROM inbox")), 2)

    def test_code_points_crlf_digest_ranges_and_preview(self):
        text = "\r\n  Сделать 🧑‍💻 cafe\u0301 🐋\r\n" + "я" * 160 + "\r\nНе менять API."
        saved = self.ok("capture.prompt", {"text": text, "deliveryId": "unicode-1", "kind": "voice"})
        record = self.ok("inbox.get", {"inboxId": saved["inboxId"]})
        self.assertEqual(record["text"], text)
        self.assertEqual(record["length"], len(text))
        self.assertEqual(record["sha256"], hashlib.sha256(text.encode("utf-8")).hexdigest())
        self.assertEqual(record["kind"], "voice")
        self.assertEqual(record["deliveryId"], "unicode-1")
        bound = self.task_fixture()
        self.assertEqual(bound["bound"], "existing")
        self.assertEqual(bound["task"]["title"], "  Сделать 🧑‍💻 cafe\u0301 🐋")
        self.assertEqual(bound["task"]["source"], {
            "inboxId": saved["inboxId"], "start": 0, "end": len(text), "sha256": record["sha256"],
        })
        panel = self.ok("snapshot")
        # Показ идёт без управляющих символов; оригинал выше сверен дословно по длине и sha256.
        self.assertEqual(panel["inbox"][0]["preview"], plain(text)[:120])
        self.assertEqual(panel["inboxCounts"], {"total": 1, "untriaged": 1})
        self.assertNotIn("dbPath", json.dumps(panel))

    def test_secret_is_redacted_in_title_and_preview_but_kept_in_source(self):
        # Составной литерал: в файле теста нет строки, похожей на настоящий ключ.
        secret = "sk-" + "A1b2C3d4E5" * 3
        text = f"Подставь ключ {secret} в конфиг"
        captured = self.ok("capture.prompt", {"text": text})
        task = self.task_fixture()["task"]
        snapshot = self.ok("snapshot")
        self.assertNotIn(secret, task["title"])
        self.assertIn("[REDACTED:api_key]", task["title"])
        self.assertNotIn(secret, snapshot["inbox"][0]["preview"])
        self.assertNotIn(secret, json.dumps(snapshot, ensure_ascii=False))
        # Исходник остаётся дословным: гарантия full-local не ослаблена.
        self.assertEqual(self.ok("inbox.get", {"inboxId": captured["inboxId"]})["text"], text)

    def test_secret_cut_by_preview_boundary_is_still_redacted(self):
        secret = "sk-" + "Z9y8X7w6V5" * 3
        text = "x" * 110 + " " + secret
        self.ok("capture.prompt", {"text": text})
        preview = self.ok("snapshot")["inbox"][0]["preview"]
        self.assertNotIn(secret[:12], preview)

    def test_secret_cut_by_redaction_window_is_not_pulled_into_preview(self):
        # Длинный ключ сворачивается в короткий маркер, и хвост окна редактирования
        # подтягивается в начало предпросмотра. Токен, разрезанный границей окна,
        # шаблоном не узнаётся — наружу он выходить не должен даже частично.
        begin, end = "-----BEGIN " + "PRIVATE KEY-----", "-----END " + "PRIVATE KEY-----"
        secret = "sk-" + "Q1w2E3r4T5" * 3
        head = begin + "\n"
        body = "A" * (3985 - len(head) - len(end) - 1)
        text = head + body + end + " " + secret + " хвост"
        self.assertLess(text.index(secret), 4000)
        self.assertGreater(text.index(secret) + len(secret), 4000)
        self.ok("capture.prompt", {"text": text})
        task = self.task_fixture()["task"]
        snapshot = json.dumps(self.ok("snapshot"), ensure_ascii=False)
        self.assertNotIn(secret[:8], snapshot)
        self.assertNotIn(secret[:8], task["title"])

    def test_unbroken_text_longer_than_window_is_not_shown(self):
        token = "sk-" + "M5n6B7v8C9" * 500
        self.ok("capture.prompt", {"text": token})
        snapshot = json.dumps(self.ok("snapshot"), ensure_ascii=False)
        self.assertNotIn(token[:8], snapshot)

    def test_title_is_80_code_points_and_empty_prompt_still_has_source(self):
        self.ok("capture.prompt", {"text": "\r\n" + "🐋" * 95})
        title = self.task_fixture()["task"]
        self.assertEqual(title["title"], "🐋" * 80)
        self.ok("task.update", {"taskId": title["taskId"], "expectedRevision": 0, "status": "done"})
        captured = self.ok("capture.prompt", {"text": ""})
        bound = self.task_fixture()
        self.assertEqual(bound["bound"], "existing")
        self.assertEqual(bound["task"]["source"]["inboxId"], captured["inboxId"])
        self.assertEqual(bound["task"]["source"]["end"], 0)

    def test_nul_does_not_truncate_source_range(self):
        text = "\x00До\x00после 🐋"
        saved = self.ok("capture.prompt", {"text": text})
        self.assertEqual(self.ok("inbox.get", {"inboxId": saved["inboxId"]})["text"], text)
        bound = self.task_fixture()["task"]
        self.assertEqual(bound["source"]["end"], len(text))
        # NUL остаётся в оригинале (inbox.get выше), в показ названия не выходит.
        self.assertEqual(bound["title"], "Допосле 🐋")

    def test_bind_created_existing_and_latest_prompt_in_session(self):
        self.ok("capture.prompt", {"text": "Старое указание"})
        recent = self.ok("capture.prompt", {"text": "Последнее указание"})
        self.ok("capture.prompt", {"text": "Посторонняя сессия"}, session="other-session")
        first = self.task_fixture( {"reason": "первое изменение"})
        self.assertEqual(first["bound"], "existing")
        self.assertEqual(first["task"]["title"], "Последнее указание")
        self.assertEqual(first["task"]["source"]["inboxId"], recent["inboxId"])
        again = self.task_fixture()
        self.assertEqual(again["bound"], "existing")
        self.assertEqual(again["task"], first["task"])
        self.assertEqual(again["focusRevision"], first["focusRevision"])
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 1)

    def test_bind_no_source_and_other_session_does_not_supply_source(self):
        self.ok("capture.prompt", {"text": "Указание другой сессии"}, session="other-session")
        result = self.ok("task.bind")
        self.assertEqual(result["bound"], "unbound")
        self.assertIsNone(result["task"])
        self.assertEqual(self.rows("SELECT * FROM tasks"), [])
        self.assertEqual(self.rows("SELECT * FROM task_sources"), [])

    def test_latest_source_uses_commit_order_after_clock_moves_back(self):
        first = self.ok("capture.prompt", {"text": "Последний источник выбирается по порядку записи"})
        newer_id = self.request("snapshot")["requestId"]
        # Валидная immutable запись имитирует capture после отката системных часов.
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("""INSERT INTO inbox SELECT ?,project_id,worktree_id,session_id,delivery_key,
                source_kind,capture_mode,raw_text,raw_sha256,raw_length,status,
                '2000-01-01T00:00:00.000000Z' FROM inbox WHERE inbox_id=?""", (newer_id, first["inboxId"]))
        db.close()
        self.assertEqual(self.task_fixture()["task"]["source"]["inboxId"], newer_id)
        self.assertEqual(self.ok("snapshot")["inbox"][0]["inboxId"], newer_id)

    def test_parallel_cold_start_migrates_once_and_binds_once(self):
        processes = [subprocess.Popen([sys.executable, str(CLI), "rpc"], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      cwd=self.cwd, env=self.env) for _ in range(2)]
        try:
            for process in processes:
                process.stdin.write(json.dumps(self.request("task.bind")).encode())
                process.stdin.close()
                process.stdin = None
            responses = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=8)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertEqual(stderr, b"")
                response = json.loads(stdout)
                self.assertTrue(response["ok"], response)
                responses.append(response["result"])
            self.assertEqual({result["bound"] for result in responses}, {"unbound"})
            self.assertTrue(all(result["task"] is None for result in responses))
            self.assertEqual(self.rows("SELECT * FROM tasks"), [])
            self.assertEqual(self.rows("SELECT * FROM focus"), [])
            self.assertEqual(self.rows("PRAGMA user_version")[0]["user_version"], SCHEMA_VERSION)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_concurrent_first_bind_two_processes_creates_one_task(self):
        self.ok("capture.prompt", {"text": "Одна задача для двух процессов"})
        self.task_fixture(bind_result=False)
        lock = sqlite3.connect(self.state / "cockpit.db", isolation_level=None)
        lock.execute("BEGIN IMMEDIATE")
        processes = []
        try:
            for _ in range(2):
                process = subprocess.Popen([sys.executable, str(CLI), "rpc"], stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=self.cwd, env=self.env)
                processes.append(process)
                process.stdin.write(json.dumps(self.request("task.bind")).encode())
                process.stdin.close()
                process.stdin = None
            time.sleep(0.15)
            self.assertTrue(all(process.poll() is None for process in processes))
            lock.execute("COMMIT")
            responses = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=8)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertEqual(stderr, b"")
                responses.append(json.loads(stdout)["result"])
            self.assertEqual({row["bound"] for row in responses}, {"existing"})
            self.assertEqual(responses[0]["task"]["taskId"], responses[1]["task"]["taskId"])
            self.assertEqual(len(self.rows("SELECT * FROM tasks")), 1)
            self.assertEqual(len(self.rows("SELECT * FROM task_sources")), 1)
            self.assertEqual(len(self.rows("SELECT * FROM focus")), 1)
        finally:
            lock.close()
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_task_and_focus_revision_conflicts_do_not_change_state(self):
        bound = self.task_fixture()
        task_id = bound["task"]["taskId"]
        changed = self.ok("task.update", {"taskId": task_id, "expectedRevision": 0, "title": "Уточнённая задача"})
        self.assertEqual(changed["task"]["revision"], 1)
        before = self.rows("SELECT * FROM events")
        failed = self.request("task.update", {"taskId": task_id, "expectedRevision": 0, "status": "paused"})
        response = self.invoke(failed)
        self.error(response, "REVISION_CONFLICT")
        self.assertEqual(self.invoke(failed), response)
        self.assertEqual(self.rows("SELECT * FROM events"), before)
        self.assertEqual(self.ok("focus.get")["task"]["status"], "active")
        self.error(self.invoke(self.request("focus.set", {"taskId": task_id, "expectedRevision": 0})), "REVISION_CONFLICT")
        focused = self.ok("focus.set", {"taskId": task_id, "expectedRevision": bound["focusRevision"]})
        self.assertEqual(focused["revision"], bound["focusRevision"] + 1)
        self.assertEqual(focused["task"]["revision"], 1)

    def test_status_transitions_clear_focus_keep_revision_and_alias_sequence(self):
        task = self.task_fixture()["task"]
        for expected, status in enumerate(("paused", "active", "done")):
            task = self.ok("task.update", {"taskId": task["taskId"], "expectedRevision": expected, "status": status})["task"]
        empty = self.ok("focus.get")
        self.assertIsNone(empty["task"])
        self.assertEqual(empty["revision"], 2)
        self.error(self.invoke(self.request("task.update", {
            "taskId": task["taskId"], "expectedRevision": 3, "status": "active",
        })), "INVALID_REQUEST")
        self.error(self.invoke(self.request("focus.set", {
            "taskId": task["taskId"], "expectedRevision": 2,
        })), "INVALID_REQUEST")
        second = self.task_fixture()
        self.assertEqual(second["task"]["alias"], "TASK-2")
        self.assertEqual(second["focusRevision"], 3)
        self.ok("task.update", {"taskId": second["task"]["taskId"], "expectedRevision": 0, "status": "cancelled"})
        self.assertIsNone(self.ok("focus.get")["task"])

    def test_rebind_new_session_restores_focus_only_in_same_worktree(self):
        other = self.linked_worktrees()
        self.ok("capture.prompt", {"text": "Продолжить работу после clear"})
        original = self.task_fixture()
        rebound = self.ok("session.rebind", {"reason": "clear"}, session="session-2")
        self.assertEqual(rebound["focus"]["task"]["taskId"], original["task"]["taskId"])
        self.assertEqual(rebound["focus"]["revision"], original["focusRevision"] + 1)
        self.assertEqual(self.task_fixture( session="session-2")["bound"], "existing")
        foreign = self.ok("session.rebind", {"reason": "resume"}, session="session-2", cwd=other)
        self.assertIsNone(foreign["focus"]["task"])
        self.assertEqual(rebound["binding"]["projectId"], foreign["binding"]["projectId"])
        self.assertNotEqual(rebound["binding"]["worktreeId"], foreign["binding"]["worktreeId"])
        second = self.task_fixture( session="session-2", cwd=other)
        self.assertEqual(second["task"]["alias"], "TASK-2")
        self.assertEqual(len(self.rows("SELECT * FROM projects")), 1)

    def test_git_subdirectory_and_symlink_checkout_share_identity(self):
        self.linked_worktrees()
        inner = self.cwd / "subdirectory"
        inner.mkdir()
        alias = self.root / "checkout-alias"
        alias.symlink_to(self.cwd, target_is_directory=True)
        original = self.ok("snapshot")["binding"]
        self.assertEqual(self.ok("snapshot", cwd=inner)["binding"], original)
        self.assertEqual(self.ok("snapshot", cwd=alias)["binding"], original)
        self.assertEqual(len(self.rows("SELECT * FROM projects")), 1)
        self.assertEqual(len(self.rows("SELECT * FROM worktrees")), 1)

    def test_same_named_non_git_directories_are_different_projects_and_scoped(self):
        other = self.root / "other" / self.cwd.name
        other.mkdir(parents=True)
        saved = self.ok("capture.prompt", {"text": "Первый проект"})
        first = self.task_fixture()["task"]
        panel = self.ok("snapshot", cwd=other)
        self.assertNotEqual(panel["binding"]["projectId"], first["projectId"])
        self.assertIsNone(panel["focus"]["task"])
        self.error(self.invoke(self.request("inbox.get", {"inboxId": saved["inboxId"]}, cwd=other)), "NOT_FOUND")
        self.error(self.invoke(self.request("task.update", {"taskId": first["taskId"], "expectedRevision": 0,
                                                              "status": "done"}, cwd=other)), "NOT_FOUND")
        second = self.task_fixture( cwd=other)["task"]
        self.assertEqual(second["alias"], "TASK-1")

    def test_events_have_no_prompt_or_free_reason_and_are_append_only(self):
        text = "Секретный исходник 🐋: уникальный маркер для проверки журнала"
        self.ok("capture.prompt", {"text": text, "kind": text})
        self.task_fixture( {"reason": text})
        self.ok("session.rebind", {"reason": "compact"})
        rows = self.rows("SELECT * FROM events")
        dump = json.dumps(rows, ensure_ascii=False)
        self.assertNotIn(text, dump)
        self.assertNotIn("Секретный исходник", dump)
        self.assertEqual(set(rows[0]), {"event_id", "project_id", "worktree_id", "session_id", "kind", "entity_id", "created_at"})

    def test_off_stores_only_metadata_and_bind_keeps_source_range(self):
        self.assertEqual(self.human("config", "set", "capture-mode", "off").returncode, 0)
        text = "НЕ СОХРАНЯТЬ ЭТОТ ТЕКСТ 🐋 e\u0301\r\n"
        captured = self.ok("capture.prompt", {"text": text})
        self.assertEqual(captured["captureMode"], "off")
        record = self.ok("inbox.get", {"inboxId": captured["inboxId"]})
        self.assertIsNone(record["text"])
        self.assertEqual(record["length"], len(text))
        self.assertEqual(record["sha256"], hashlib.sha256(text.encode()).hexdigest())
        bound = self.task_fixture()
        self.assertEqual(bound["bound"], "existing")
        self.assertEqual(bound["task"]["title"], "Работа по сохранённому указанию")
        self.assertEqual(bound["task"]["source"]["end"], len(text))
        self.assertIsNone(self.ok("snapshot")["inbox"][0]["preview"])
        with sqlite3.connect(self.state / "cockpit.db") as db:
            dump = "\n".join(db.iterdump())
        db.close()
        self.assertNotIn(text, dump)
        self.assertNotIn("НЕ СОХРАНЯТЬ ЭТОТ ТЕКСТ", dump)

    def test_redacted_is_not_implemented_and_does_not_change_config(self):
        self.ok("snapshot")
        command = self.human("config", "set", "capture-mode", "redacted")
        self.assertEqual(command.returncode, 1)
        self.assertIn(b"NOT_IMPLEMENTED", command.stderr)
        self.assertEqual(self.ok("snapshot")["captureMode"], "full-local")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE config SET value='redacted'")
        db.close()
        self.error(self.invoke(self.request("capture.prompt", {"text": "не подделывать редактирование"})), "NOT_IMPLEMENTED")
        self.assertEqual(self.rows("SELECT * FROM inbox"), [])

    def test_transaction_failure_rolls_back_task_focus_events_and_response(self):
        self.ok("capture.prompt", {"text": "Проверить атомарность"})
        self.task_fixture()
        before = {table: self.rows(f"SELECT * FROM {table}") for table in ("tasks", "focus", "events")}
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("""CREATE TRIGGER fail_event BEFORE INSERT ON events
                BEGIN SELECT RAISE(ABORT,'ошибка фикстуры'); END""")
        db.close()
        request = self.request("task.bind", session="session-2")
        self.error(self.invoke(request), "DB_UNAVAILABLE")
        for table, rows in before.items():
            self.assertEqual(self.rows(f"SELECT * FROM {table}"), rows)
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id=?", (request["requestId"],)), [])
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("DROP TRIGGER fail_event")
        db.close()
        self.assertTrue(self.invoke(request)["ok"])

    def test_locked_database_is_bounded_unavailable_and_same_key_can_retry(self):
        self.ok("snapshot")
        lock = sqlite3.connect(self.state / "cockpit.db", isolation_level=None)
        try:
            lock.execute("BEGIN IMMEDIATE")
            request = self.request("capture.prompt", {"text": "Повтор после разблокировки"})
            started = time.monotonic()
            self.error(self.invoke(request), "DB_UNAVAILABLE")
            elapsed = time.monotonic() - started
            self.assertGreater(elapsed, 1.8)
            self.assertLess(elapsed, 5)
            lock.execute("ROLLBACK")
        finally:
            lock.close()
        self.assertTrue(self.invoke(request)["ok"])
        self.assertEqual(len(self.rows("SELECT * FROM inbox")), 1)

    def test_cached_response_can_replay_during_unrelated_write_lock(self):
        request = self.request("capture.prompt", {"text": "Идемпотентный повтор без записи"})
        original = self.invoke(request)
        lock = sqlite3.connect(self.state / "cockpit.db", isolation_level=None)
        try:
            lock.execute("BEGIN IMMEDIATE")
            self.assertEqual(self.invoke(request), original)
        finally:
            lock.close()
        self.assertEqual(len(self.rows("SELECT * FROM inbox")), 1)

    def test_unavailable_corrupt_database_and_symlink_return_json_without_traceback(self):
        self.state.write_text("это файл вместо каталога", encoding="utf-8")
        self.error(self.invoke(self.request("snapshot")), "DB_UNAVAILABLE")
        self.state.unlink()
        self.state.mkdir()
        (self.state / "cockpit.db").write_text("повреждённая база", encoding="utf-8")
        self.error(self.invoke(self.request("snapshot")), "DB_UNAVAILABLE")
        (self.state / "cockpit.db").unlink()
        self.state.rmdir()
        self.state.symlink_to(self.cwd, target_is_directory=True)
        response = self.invoke(self.request("snapshot"))
        self.error(response, "DB_UNAVAILABLE")
        self.assertIn("символической", response["error"]["message"])
        self.assertFalse((self.cwd / "cockpit.db").exists())

    def test_invalid_requests_size_fields_types_json_and_unknown_operation(self):
        base = self.request("snapshot")
        variants = [
            {**base, "extra": 1}, {**base, "v": True}, {**base, "v": 2},
            {**base, "session": {**base["session"], "extra": 1}},
            {**base, "session": {"sessionId": "session-1", "cwd": "relative"}},
            {**base, "args": []}, {**base, "args": {"limits": {"inbox": -1}}},
            {**base, "args": {"limits": {"tasks": True}}},
            self.request("capture.prompt", {"text": None}),
            self.request("focus.set", {"taskId": "missing", "expectedRevision": True}),
            self.request("task.update", {"taskId": "missing", "expectedRevision": 0}),
            self.request("capture.prompt", {"text": "данные", "extra": 1}),
            self.request("session.rebind", {"reason": "restart"}),
        ]
        for request in variants:
            request["requestId"] = self.request("snapshot")["requestId"]
            with self.subTest(request=request):
                self.error(self.invoke(request), "INVALID_REQUEST")
        for raw in (b"", b"{} {}", b"null", b'{"v":1,"v":1}', b'{"x":NaN}',
                    b'{"x":"\xff"}', b"[" * 2000 + b"]" * 2000,
                    json.dumps(self.request("capture.prompt", {"text": "\ud800"})).encode()):
            with self.subTest(raw=raw[:60]):
                self.error(self.invoke(raw=raw), "INVALID_REQUEST")
        self.error(self.invoke(raw=b" " * (MAX_REQUEST_BYTES + 1)), "INVALID_REQUEST")
        self.error(self.invoke(self.request("shell.exec", {"command": "echo не исполнять"})), "UNKNOWN_OP")

    def test_snapshot_limits_and_missing_entities(self):
        for number in range(3):
            self.ok("capture.prompt", {"text": f"Указание {number}"})
        panel = self.ok("snapshot", {"limits": {"inbox": 2, "tasks": 0}})
        self.assertEqual(len(panel["inbox"]), 2)
        self.assertEqual(panel["inbox"][0]["preview"], "Указание 2")
        self.assertEqual(panel["tasks"], [])
        self.assertEqual(panel["inboxCounts"]["total"], 3)
        self.error(self.invoke(self.request("inbox.get", {"inboxId": "missing"})), "NOT_FOUND")
        self.error(self.invoke(self.request("task.update", {"taskId": "missing", "expectedRevision": 0,
                                                             "title": "Новая задача"})), "NOT_FOUND")

    def test_human_commands_and_rpc_through_real_symlink(self):
        text = "Человеческий запасной путь\r\nПолный оригинал 🐋"
        saved = self.ok("capture.prompt", {"text": text})
        self.task_fixture()
        for args, fragment in ((["status"], "Фокус: TASK-1"), (["inbox", "--limit", "1"], saved["inboxId"]),
                               (["tasks"], "TASK-1"), (["doctor"], "Целостность: ok"),
                               (["config", "get", "capture-mode"], "full-local")):
            with self.subTest(args=args):
                command = self.human(*args)
                self.assertEqual(command.returncode, 0, command.stderr)
                self.assertIn(fragment, command.stdout.decode())
                self.assertEqual(command.stderr, b"")
        shown = self.human("show", saved["inboxId"])
        self.assertEqual(shown.returncode, 0)
        self.assertTrue(shown.stdout.endswith(text.encode()))
        link = self.root / "cockpitctl"
        link.symlink_to(CLI)
        self.assertTrue(self.invoke(self.request("snapshot"), cli=link)["ok"])
        process = subprocess.run([str(link), "status"], capture_output=True, env=self.env, cwd=self.cwd)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIn("Фокус: TASK-1", process.stdout.decode())


if __name__ == "__main__":
    unittest.main(verbosity=2)

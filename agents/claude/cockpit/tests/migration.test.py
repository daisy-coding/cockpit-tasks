#!/usr/bin/env python3
"""Переход с настоящей схемы M1 и её данных, без создания базы новым рантаймом."""

import hashlib
import sqlite3
import unittest
from unittest.mock import patch

from support import Harness
from agents.claude.cockpit import CockpitError
from agents.claude.cockpit.domain import now
from agents.claude.cockpit.rpc import canonical
from agents.claude.cockpit.store import MIGRATIONS, SCHEMA_VERSION, Store


class MigrationTests(Harness):
    def version_seven(self):
        self.version_six()
        with sqlite3.connect(self.state / "cockpit.db") as db:
            for statement in MIGRATIONS[7]:
                db.execute(statement)
            db.execute("PRAGMA user_version=7")
            db.execute("INSERT INTO checkpoints VALUES ('note-old','task-old','project-old','tree-old','session-1','note','Сохранённая отметка','user','2026-10-04T00:00:00.000000Z','panel')")
            db.execute("INSERT INTO checkpoints(rowid,checkpoint_id,task_id,project_id,worktree_id,session_id,kind,text,source,created_at,provenance) VALUES (7,'note-gap','task-old','project-old','tree-old','session-1','note','Отметка после разрыва rowid','user','2026-10-04T00:00:00.000001Z','panel')")
            columns = {row[0]: [item[1] for item in db.execute(f"PRAGMA table_info({row[0]})")]
                       for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            before = {name: list(db.execute(f"SELECT * FROM {name} ORDER BY rowid")) for name in columns}
            dump = list(db.iterdump())
        return columns, before, dump

    def test_version_seven_to_eight_preserves_all_rows_and_reopens_identically(self):
        columns, before, _ = self.version_seven()
        with Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            for name, names in columns.items():
                self.assertEqual([tuple(row) for row in db.execute(
                    f"SELECT {','.join(names)} FROM {name} ORDER BY rowid")], before[name], name)
            self.assertEqual([tuple(row) for row in db.execute(
                "SELECT stage,adopted_by,dismiss_reason,dismissed_at FROM tasks")],
                [("task", None, None, None)] * 2)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM attestation_revocations").fetchone()[0], 0)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual([tuple(row) for row in db.execute("SELECT rowid,checkpoint_id FROM checkpoints ORDER BY rowid")], [(1, "note-old"), (7, "note-gap")])
            dump = list(db.iterdump())
        with Store(str(self.state)) as store:
            self.assertEqual(list(store.connection.iterdump()), dump)

    def test_failed_migration_eight_rolls_back_everything(self):
        _, _, before = self.version_seven()
        with patch("agents.claude.cockpit.store.MIGRATIONS", {**MIGRATIONS, 8: (*MIGRATIONS.get(8, ()), "НЕКОРРЕКТНЫЙ SQL")}):
            with self.assertRaises(CockpitError):
                with Store(str(self.state)):
                    self.fail("Миграция должна откатиться.")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 7)
            self.assertEqual(list(db.iterdump()), before)

    def version_six(self):
        _, old_request, old_response, _, _, _ = self.old_database()
        request = self.request("snapshot", key="v6-snapshot")
        response = {"v": 1, "ok": True, "result": {"schemaVersion": 1, "storageSchemaVersion": 6,
                    "tasks": [{"taskId": "task-old", "title": "Старая карточка", "steps": []}]}}
        with sqlite3.connect(self.state / "cockpit.db") as db:
            for version in range(2, 7):
                for statement in MIGRATIONS[version]:
                    db.execute(statement)
            db.execute("PRAGMA user_version=6")
            db.execute("INSERT INTO task_steps VALUES ('task-old',0,'Сохранённый шаг','pending')")
            db.execute("INSERT INTO project_config VALUES ('project-old','observe','panel')")
            db.execute("INSERT INTO requests VALUES (?,?,?,?)", (request["requestId"],
                       hashlib.sha256(canonical(request).encode()).hexdigest(), canonical(response),
                       "2026-10-04T00:00:00.000000Z"))
            columns = {row[0]: [item[1] for item in db.execute(f"PRAGMA table_info({row[0]})")]
                       for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            before = {name: list(db.execute(f"SELECT * FROM {name} ORDER BY rowid")) for name in columns}
            dump = list(db.iterdump())
        return old_request, old_response, request, response, columns, before, dump

    def test_version_six_to_seven_preserves_rows_cache_and_defaults_on_reopen(self):
        old_request, old_response, request, response, columns, before, _ = self.version_six()
        with Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            for name, names in columns.items():
                self.assertEqual([tuple(row) for row in db.execute(
                    f"SELECT {','.join(names)} FROM {name} ORDER BY rowid")], before[name], name)
            self.assertEqual([tuple(row) for row in db.execute(
                "SELECT description,assignee,priority,priority_source,priority_pinned,priority_provenance FROM tasks")],
                [("", None, 2, "model", 0, "cli")] * 2)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM task_lists").fetchone()[0], 0)
            self.assertEqual(tuple(db.execute("SELECT queue_mode,queue_provenance FROM project_config").fetchone()),
                             ("run", "cli"))
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            dump = list(db.iterdump())
        with Store(str(self.state)) as store:
            self.assertEqual(list(store.connection.iterdump()), dump)
        self.assertEqual(self.invoke(old_request), old_response)
        self.assertEqual(self.invoke(request)["result"], self.ok("snapshot"))
        self.assertEqual(self.rows("SELECT response_json FROM requests WHERE request_id=?", (request["requestId"],))[0]["response_json"], canonical(response))

    def test_failed_migration_seven_rolls_back_schema_data_and_version_six(self):
        *_, before = self.version_six()
        with patch("agents.claude.cockpit.store.MIGRATIONS", {**MIGRATIONS, 7: (*MIGRATIONS[7], "НЕКОРРЕКТНЫЙ SQL")}):
            with self.assertRaises(CockpitError):
                with Store(str(self.state)):
                    self.fail("Миграция должна откатиться.")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 6)
            self.assertEqual(list(db.iterdump()), before)

    def old_database(self):
        self.state.mkdir(mode=0o700)
        text = "\r\nОригинал 🧑‍💻 cafe\u0301\x00\r\nНе терять данные?"
        digest = hashlib.sha256(text.encode()).hexdigest()
        timestamp = "2026-10-04T00:00:00.000000Z"
        response = {"v": 1, "ok": True, "result": {
            "inboxId": "inbox-old", "captured": True, "captureMode": "full-local",
        }}
        old_request = self.request("capture.prompt", {"text": text}, key="old-request")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("PRAGMA foreign_keys=ON")
            for statement in MIGRATIONS[1]:
                db.execute(statement)
            db.execute("PRAGMA user_version=1")
            db.execute("INSERT INTO projects VALUES ('project-old','directory',?,'Старый проект',?)",
                       (str(self.cwd), timestamp))
            db.execute("INSERT INTO worktrees VALUES ('tree-old','project-old',?)", (str(self.cwd),))
            db.execute("INSERT INTO sessions VALUES ('session-1','project-old','tree-old',?)", (timestamp,))
            db.execute("INSERT INTO inbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                "inbox-old", "project-old", "tree-old", "session-1", "delivery-old", "voice",
                "full-local", text, digest, len(text), "untriaged", timestamp,
            ))
            for task_id, alias, origin, status in (("task-old", 1, "ad-hoc", "active"),
                                                  ("task-no-source", 2, "no-source", "done")):
                db.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)", (
                    task_id, "project-old", "tree-old", alias, origin,
                    "Дословный заголовок 🐋", status, 3, timestamp, timestamp,
                ))
            db.execute("INSERT INTO task_sources VALUES (?,?,?,0,?,?,'origin')",
                       ("task-old", "inbox-old", "project-old", len(text), digest))
            db.execute("INSERT INTO focus VALUES ('tree-old','project-old','session-1','task-old',7)")
            db.execute("INSERT INTO events VALUES (1,'project-old','tree-old','session-1',"
                       "'prompt.captured','inbox-old',?)", (timestamp,))
            db.execute("INSERT INTO requests VALUES (?,?,?,?)", (
                old_request["requestId"], hashlib.sha256(canonical(old_request).encode()).hexdigest(),
                # Сверка миграции сохраняет ответ в пределах срока хранения,
                # иначе последующая запись закономерно удаляет старый кэш.
                canonical(response), now(),
            ))
            columns = {row[0]: [item[1] for item in db.execute(f"PRAGMA table_info({row[0]})")]
                       for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            before = {name: [tuple(row) for row in db.execute(f"SELECT * FROM {name} ORDER BY rowid")]
                      for name in columns}
            triggers = list(db.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"))
        db.close()
        return text, old_request, response, columns, before, triggers

    def test_version_four_to_five_preserves_data_cache_and_does_not_invent_authors(self):
        self.version_three()
        timestamp = "2026-10-03T00:00:00.000000Z"
        with sqlite3.connect(self.state / "cockpit.db") as db:
            for statement in MIGRATIONS[4]:
                db.execute(statement)
            db.execute("PRAGMA user_version=4")
            db.execute("INSERT INTO session_attestations VALUES ('session-1','project-old','tree-old',?,?)", ("a" * 64, timestamp))  # gitleaks:allow
            db.execute("INSERT INTO inbox_observations(inbox_id,project_id,inbox_type,task_id,classified_by,policy_version,mode,triage_status,created_at,provenance) "
                       "VALUES ('inbox-old','project-old','decision','task-old','user','user-1','active','triaged',?,'panel')", (timestamp,))
            columns = {row[0]: [item[1] for item in db.execute(f"PRAGMA table_info({row[0]})")]
                       for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            before = {name: list(db.execute(f"SELECT * FROM {name} ORDER BY rowid")) for name in columns}
        with Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            for name, names in columns.items():
                with self.subTest(table=name):
                    self.assertEqual([tuple(row) for row in db.execute(f"SELECT {','.join(names)} FROM {name} ORDER BY rowid")], before[name])
            self.assertEqual([tuple(row) for row in db.execute("SELECT author_session_id,author_worktree_id FROM inbox_observations")], [(None, None), (None, None)])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM authorized_inbox_observations").fetchone()[0], 0)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            schema = [tuple(row) for row in db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY name")]
        with Store(str(self.state)) as store:
            self.assertEqual(schema, [tuple(row) for row in store.connection.execute("SELECT type,name,sql FROM sqlite_master ORDER BY name")])
        self.assertIn("blocking-inbox", self.ok("gate.check", {"resourcePath": str(self.cwd / "file.ts")})["observation"]["reasons"])

    def test_failed_migration_five_rolls_back_columns_views_and_version_four(self):
        self.version_three()
        with sqlite3.connect(self.state / "cockpit.db") as db:
            for statement in MIGRATIONS[4]:
                db.execute(statement)
            db.execute("PRAGMA user_version=4")
            before = list(db.iterdump())
        with patch("agents.claude.cockpit.store.MIGRATIONS", {**MIGRATIONS, 5: (*MIGRATIONS[5], "НЕКОРРЕКТНЫЙ SQL")}):
            with self.assertRaises(CockpitError):
                with Store(str(self.state)):
                    self.fail("Миграция с ошибкой должна откатиться.")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 4)
            self.assertEqual(list(db.iterdump()), before)

    def test_version_one_preserves_all_old_rows_and_cached_responses(self):
        text, old_request, response, columns, before, triggers = self.old_database()
        with Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            for name, names in columns.items():
                # Счётчик AUTOINCREMENT не меняется только от создания новых таблиц.
                with self.subTest(table=name):
                    after = [tuple(row) for row in db.execute(f"SELECT {','.join(names)} FROM {name} ORDER BY rowid")]
                    self.assertEqual(after, before[name])
            for name, sql in triggers:
                self.assertEqual(db.execute("SELECT sql FROM sqlite_master WHERE name=?", (name,)).fetchone()[0], sql)
            self.assertEqual([tuple(row) for row in db.execute("SELECT certainty,certainty_source FROM tasks")],
                             [("observed", "engine"), ("observed", "engine")])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM inbox_observations").fetchone()[0], 0)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            schema = [tuple(row) for row in db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY name")]
        with Store(str(self.state)) as store:
            self.assertEqual(schema, [tuple(row) for row in store.connection.execute(
                "SELECT type,name,sql FROM sqlite_master ORDER BY name")])
        self.assertEqual(self.invoke(old_request), response)
        record = self.ok("inbox.get", {"inboxId": "inbox-old"})
        self.assertEqual(record["text"], text)
        self.assertIsNone(record["type"])
        self.assertEqual(record["triageRevision"], 0)
        self.assertEqual(record["status"], "untriaged")
        self.assertEqual(self.ok("focus.get")["revision"], 7)
        confirmed = self.ok("task.confirm", {"taskId": "task-old", "expectedRevision": 3})["task"]
        self.assertEqual((confirmed["certainty"], confirmed["certaintySource"]), ("confirmed", "user"))
        self.ok("capture.prompt", {"text": "Новая запись?"})
        self.assertEqual(self.rows("SELECT COUNT(*) AS n FROM inbox")[0]["n"], 2)

    def test_failed_new_migration_keeps_version_one_and_its_data(self):
        _, _, _, columns, before, _ = self.old_database()
        with patch("agents.claude.cockpit.store.MIGRATIONS", {**MIGRATIONS, 2: (
            "ALTER TABLE tasks ADD COLUMN partial_column TEXT", "НЕКОРРЕКТНЫЙ SQL",
        )}):
            with self.assertRaises(CockpitError) as failure:
                with Store(str(self.state)):
                    self.fail("Неудачная миграция должна откатиться целиком.")
        self.assertEqual(failure.exception.code, "DB_UNAVAILABLE")
        self.assertEqual(self.rows("PRAGMA user_version")[0]["user_version"], 1)
        for name, names in columns.items():
            self.assertEqual([list(row.values()) for row in self.rows(f"SELECT * FROM {name} ORDER BY rowid")],
                             [list(row) for row in before[name]])
            self.assertEqual([row["name"] for row in self.rows(f"PRAGMA table_info({name})")], names)
        with Store(str(self.state)) as store:
            self.assertEqual(store.connection.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_version_two_data_and_cached_snapshot_survive_migration_to_four(self):
        text, old_request, old_response, _, _, _ = self.old_database()
        timestamp = "2026-10-04T00:00:00.000000Z"
        request = self.request("snapshot", key="v2-snapshot")
        response = {"v": 1, "ok": True, "result": {"schemaVersion": 1, "storageSchemaVersion": 2}}
        with sqlite3.connect(self.state / "cockpit.db") as db:
            for sql in MIGRATIONS[2]:
                db.execute(sql)
            db.execute("PRAGMA user_version=2")
            db.execute("UPDATE tasks SET certainty='confirmed',certainty_source='user' WHERE task_id='task-old'")
            db.execute("""INSERT INTO inbox_observations
                (inbox_id,project_id,inbox_type,task_id,resource_id,classified_by,policy_version,mode,triage_status,created_at)
                VALUES ('inbox-old','project-old','blocking','task-old','resource-old','user','user-1','active','triaged',?)""", (timestamp,))
            db.execute("INSERT INTO checkpoints VALUES ('mark-old','task-old','project-old','tree-old','session-1',"
                       "'note','Отметка 🐋','user',?)", (timestamp,))
            db.execute("INSERT INTO focus_stack VALUES ('tree-old','project-old',1,'task-no-source','session-1','user',?)", (timestamp,))
            db.execute("INSERT INTO requests VALUES (?,?,?,?)", (request["requestId"],
                       hashlib.sha256(canonical(request).encode()).hexdigest(), canonical(response), timestamp))
            names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            columns = {name: [row[1] for row in db.execute(f"PRAGMA table_info({name})")] for name in names}
            before = {name: list(db.execute(f"SELECT * FROM {name} ORDER BY rowid")) for name in names}
        db.close()
        with Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            for name, rows in before.items():
                self.assertEqual([tuple(row) for row in db.execute(f"SELECT {','.join(columns[name])} FROM {name} ORDER BY rowid")], rows, name)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            for name in ("project_config", "worktree_leases", "gate_observations"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0], 0)
        self.assertEqual(self.invoke(old_request), old_response)
        self.assertEqual(self.invoke(request)["result"], self.ok("snapshot"))
        self.assertEqual(self.rows("SELECT response_json FROM requests WHERE request_id=?",
            (request["requestId"],))[0]["response_json"], canonical(response))
        current = self.ok("snapshot")
        self.assertEqual(current["gate"]["mode"], "off")
        self.assertEqual(current["focus"]["task"]["certainty"], "confirmed")
        self.assertEqual(current["inbox"][0]["triageStatus"], "triaged")
        self.assertEqual(self.ok("inbox.get", {"inboxId": "inbox-old"})["text"], text)

    def version_three(self):
        self.old_database()
        timestamp = "2026-10-04T00:00:00.000000Z"
        with sqlite3.connect(self.state / "cockpit.db") as db:
            for version in (2, 3):
                for sql in MIGRATIONS[version]:
                    db.execute(sql)
            db.execute("PRAGMA user_version=3")
            db.execute("UPDATE tasks SET certainty='confirmed',certainty_source='user' WHERE task_id='task-old'")
            db.execute("""INSERT INTO inbox_observations
                (inbox_id,project_id,inbox_type,task_id,classified_by,policy_version,mode,triage_status,created_at)
                VALUES ('inbox-old','project-old','blocking','task-old','user','user-1','active','triaged',?)""", (timestamp,))
            db.execute("INSERT INTO checkpoints VALUES ('mark-old','task-old','project-old','tree-old','session-1',"
                       "'note','Отметка 🐋','user',?)", (timestamp,))
            db.execute("INSERT INTO focus_stack VALUES ('tree-old','project-old',1,'task-no-source','session-1','user',?)", (timestamp,))
            db.execute("INSERT INTO project_config VALUES ('project-old','observe')")
            db.execute("INSERT INTO worktree_leases VALUES ('tree-old','project-old','session-1',?,?,?)", (timestamp,) * 3)
            db.execute("""INSERT INTO gate_observations VALUES
                (1,'project-old','tree-old','session-1','task-old','BLOCK','["stale-read"]',?,NULL,?)""", ("path-" + "a" * 64, timestamp))  # gitleaks:allow
            columns = {row[0]: [item[1] for item in db.execute(f"PRAGMA table_info({row[0]})")]
                       for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            before = {name: list(db.execute(f"SELECT * FROM {name} ORDER BY rowid")) for name in columns}
            dump = list(db.iterdump())
        return columns, before, dump

    def test_version_three_data_is_preserved_and_all_old_origins_are_cli(self):
        columns, before, _ = self.version_three()
        with Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            for name, names in columns.items():
                self.assertEqual([tuple(row) for row in db.execute(f"SELECT {','.join(names)} FROM {name} ORDER BY rowid")], before[name], name)
            for name, column in (("tasks", "certainty_provenance"), ("inbox_observations", "provenance"),
                                 ("checkpoints", "provenance"), ("focus_stack", "provenance"),
                                 ("project_config", "provenance"), ("config", "provenance")):
                self.assertEqual({row[0] for row in db.execute(f"SELECT {column} FROM {name}")}, {"cli"}, name)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM session_attestations").fetchone()[0], 0)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        snapshot = self.ok("snapshot")
        self.assertEqual(snapshot["inbox"][0]["triageStatus"], "triaged")
        self.assertEqual(snapshot["inbox"][0]["triageProvenance"], "cli")
        checked = self.ok("gate.check", {"resourcePath": str(self.cwd / "file.ts")})
        self.assertEqual(checked["observation"]["reasons"], ["blocking-inbox"])
        self.assertEqual(self.rows("SELECT response_json FROM requests WHERE request_id='old-request'")[0]["response_json"],
                         canonical({"v": 1, "ok": True, "result": {"inboxId": "inbox-old", "captured": True, "captureMode": "full-local"}}))

    def test_failed_migration_four_rolls_back_columns_view_and_version(self):
        _, _, before = self.version_three()
        with patch("agents.claude.cockpit.store.MIGRATIONS", {**MIGRATIONS, 4: (*MIGRATIONS[4], "НЕКОРРЕКТНЫЙ SQL")}):
            with self.assertRaises(CockpitError):
                with Store(str(self.state)):
                    self.fail("Миграция должна откатиться.")
        self.assertEqual(self.rows("PRAGMA user_version")[0]["user_version"], 3)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            self.assertEqual(list(db.iterdump()), before)

    def test_failed_migration_three_rolls_back_its_tables_and_preserves_version_two(self):
        self.old_database()
        with sqlite3.connect(self.state / "cockpit.db") as db:
            for sql in MIGRATIONS[2]:
                db.execute(sql)
            db.execute("PRAGMA user_version=2")
            before = list(db.iterdump())
        db.close()
        with patch("agents.claude.cockpit.store.MIGRATIONS", {**MIGRATIONS, 3: (
            "CREATE TABLE partial_gate(id INTEGER)", "НЕКОРРЕКТНЫЙ SQL",
        )}):
            with self.assertRaises(CockpitError):
                with Store(str(self.state)):
                    self.fail("Миграция должна откатиться.")
        self.assertEqual(self.rows("PRAGMA user_version")[0]["user_version"], 2)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            self.assertEqual(list(db.iterdump()), before)
        db.close()


    def test_legacy_cached_titles_and_previews_are_filtered_without_rewriting_cache_or_source(self):
        text, original_request, original_response, _, _, _ = self.old_database()
        secret = "sk-" + "A1b2C3d4E5" * 3  # gitleaks:allow
        request = self.request("snapshot", key="old-snapshot")
        response = {"v": 1, "ok": True, "result": {
            "schemaVersion": 1, "tasks": [{"taskId": "task-old", "title": "Задача " + secret}],
            "inbox": [{"inboxId": "inbox-old", "preview": "Предпросмотр " + secret}],
        }}
        cached = canonical(response)
        with Store(str(self.state)) as store:
            store.connection.execute("UPDATE tasks SET title=? WHERE task_id='task-old'", ("Актуальная задача " + secret,))
            store.connection.execute("INSERT INTO task_steps VALUES ('task-old',0,'Сохранённый шаг','pending')")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("INSERT INTO requests VALUES (?,?,?,?)", (
                request["requestId"], hashlib.sha256(canonical(request).encode()).hexdigest(),
                cached, "2026-10-04T00:00:00.000000Z",
            ))
        db.close()
        filtered = self.invoke(request)
        self.assertNotIn(secret, canonical(filtered))
        self.assertIn("[REDACTED:api_key]", canonical(filtered))
        self.assertEqual(self.invoke(request), filtered)
        self.assertEqual(filtered["result"], self.ok("snapshot"))
        self.assertEqual(filtered["result"]["storageSchemaVersion"], SCHEMA_VERSION)
        self.assertEqual(self.rows("SELECT response_json FROM requests WHERE request_id=?", (request["requestId"],))[0]["response_json"], cached)
        self.assertEqual(self.rows("SELECT raw_text FROM inbox")[0]["raw_text"], text)
        self.assertEqual(self.invoke(original_request), original_response)


if __name__ == "__main__":
    unittest.main(verbosity=2)

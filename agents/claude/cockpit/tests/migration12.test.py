#!/usr/bin/env python3
"""Миграция 11→12 только добавляет учёт простоя, сохраняя строки и отзывы."""
import sqlite3
import unittest
from unittest.mock import patch

from support import Harness
from agents.claude.cockpit import CockpitError
from agents.claude.cockpit.store import MIGRATIONS, SCHEMA_VERSION, Store


class MigrationTwelveTests(Harness):
    def version_eleven(self):
        self.state.mkdir(mode=0o700)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("PRAGMA foreign_keys=ON")
            for version in range(1, 12):
                for statement in MIGRATIONS[version]:
                    db.execute(statement)
            db.execute("PRAGMA user_version=11")
            timestamp = "2026-09-01T15:00:00.000000Z"
            db.execute("INSERT INTO projects VALUES ('p','directory',?,'Проект',?)", (str(self.cwd), timestamp))
            db.execute("INSERT INTO worktrees VALUES ('w','p',?)", (str(self.cwd),))
            for session in ("active", "revoked"):
                db.execute("INSERT INTO sessions VALUES (?,'p','w',?)", (session, timestamp))
                db.execute("INSERT INTO session_attestations VALUES (?,'p','w',?,?)", (session, "a" * 64, timestamp))
            db.execute("INSERT INTO attestation_revocations VALUES ('revoked','p','w','owner','active',?)", (timestamp,))
            db.execute("""INSERT INTO tasks(task_id,project_id,worktree_id,alias_no,origin,title,status,revision,created_at,updated_at)
                VALUES ('t','p','w',1,'no-source','Текст 🐋','active',7,?,?)""", (timestamp, timestamp))
            db.execute("INSERT INTO focus VALUES ('w','p','active','t',3)")
            db.execute("INSERT INTO task_owner_comments VALUES ('comment','t','p','w','active','Комментарий 🐋',?,?,2,0)", (timestamp, timestamp))
            db.execute("INSERT INTO events(project_id,worktree_id,session_id,kind,entity_id,created_at) VALUES ('p','w','active','task.created','t',?)", (timestamp,))
            db.execute("INSERT INTO requests VALUES ('cached',?,?,?)", ("b" * 64, '{"v":1,"ok":true,"result":{"storageSchemaVersion":11,"text":"🐋"}}', timestamp))
            rows = {name: list(db.execute(f'SELECT rowid,* FROM "{name}" ORDER BY rowid'))
                    for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            schema = list(db.execute("SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master ORDER BY name"))
            return rows, schema, list(db.iterdump())

    def test_preserves_every_old_row_definition_revocation_and_reopen(self):
        before, schema, _ = self.version_eleven()
        self.assertEqual(SCHEMA_VERSION, 13)
        with Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            for name, rows in before.items():
                self.assertEqual([tuple(row) for row in db.execute(f'SELECT rowid,* FROM "{name}" ORDER BY rowid')], rows, name)
            for definition in schema:
                self.assertEqual(tuple(db.execute("SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master WHERE name=?", (definition[1],)).fetchone()), definition)
            self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM attestation_usage ORDER BY session_id")],
                [(session, "p", "w", "2026-09-01T15:00:00.000000Z") for session in ("active", "revoked")])
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            after = list(db.iterdump())
        with Store(str(self.state)) as store:
            self.assertEqual(list(store.connection.iterdump()), after)
        self.assertEqual(list(self.state.glob("*.bak")), [])

    def test_failure_rolls_back_usage_rows_schema_and_version(self):
        _, _, before = self.version_eleven()
        with patch("agents.claude.cockpit.store.MIGRATIONS", {**MIGRATIONS, 12: (*MIGRATIONS[12], "НЕКОРРЕКТНЫЙ SQL")}):
            with self.assertRaises(CockpitError):
                with Store(str(self.state)):
                    self.fail("Миграция должна откатиться")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 11)
            self.assertEqual(list(db.iterdump()), before)
        with Store(str(self.state)) as store:
            self.assertEqual(store.connection.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_old_attestation_immutability_is_preserved(self):
        self.version_eleven()
        with Store(str(self.state)) as store:
            for statement in ("UPDATE session_attestations SET secret_sha256='x'", "DELETE FROM session_attestations", "DELETE FROM attestation_revocations"):
                with self.assertRaises(sqlite3.IntegrityError):
                    store.connection.execute(statement)


if __name__ == "__main__":
    unittest.main(verbosity=2)

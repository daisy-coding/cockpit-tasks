#!/usr/bin/env python3
"""Миграция 9→10 закрывает кандидатов и сохраняет прежние данные побайтно."""
import sqlite3
import unittest
from unittest.mock import patch
from support import Harness
from agents.claude.cockpit import CockpitError
from agents.claude.cockpit.store import MIGRATIONS, SCHEMA_VERSION, Store


class MigrationTenTests(Harness):
    def version_nine(self):
        self.state.mkdir(mode=0o700)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("PRAGMA foreign_keys=ON")
            for version in range(1, 10):
                for statement in MIGRATIONS[version]:
                    db.execute(statement)
            db.execute("PRAGMA user_version=9")
            timestamp = "2026-10-05T15:00:00.000000Z"
            db.execute("INSERT INTO projects VALUES ('p','directory',?,'Проект',?)", (str(self.cwd), timestamp))
            db.execute("INSERT INTO worktrees VALUES ('w','p',?)", (str(self.cwd),))
            db.execute("INSERT INTO sessions VALUES ('s','p','w',?)", (timestamp,))
            for i, (task_id, stage, status, reason) in enumerate((
                ("active", "candidate", "active", None), ("paused", "candidate", "paused", None),
                ("dismissed", "candidate", "active", "owner"), ("done", "candidate", "done", None),
                ("task", "task", "active", None)), 1):
                db.execute("""INSERT INTO tasks(task_id,project_id,worktree_id,alias_no,origin,title,status,revision,
                    created_at,updated_at,certainty,certainty_source,certainty_provenance,stage,dismiss_reason,description)
                    VALUES (?,'p','w',?,'no-source',?,?,7,?,?,'inferred','provider','panel',?,?,?)""",
                           (task_id, i, f"Название {task_id} 🐋", status, timestamp, timestamp, stage, reason, "Текст\r\n\x00 🐋"))
            db.execute("INSERT INTO inbox VALUES ('inbox','p','w','s','delivery','prompt','full-local',? ,?,10,'untriaged',?)", ("Исходник 🐋", "a" * 64, timestamp))
            db.execute("INSERT INTO task_sources VALUES ('active','inbox','p',0,10,?,'origin')", ("a" * 64,))
            db.execute("INSERT INTO task_steps VALUES ('task',0,'Шаг','pending')")
            db.execute("INSERT INTO task_lists VALUES ('task','acceptance',0,'Критерий')")
            db.execute("INSERT INTO focus VALUES ('w','p','s','task',4)")
            db.execute("INSERT INTO checkpoints VALUES ('cp','task','p','w','s','note','Отметка','agent',?,'tool')", (timestamp,))
            db.execute("INSERT INTO events(project_id,worktree_id,session_id,kind,entity_id,created_at) VALUES ('p','w','s','task.created','task',?)", (timestamp,))
            db.execute("INSERT INTO requests VALUES ('cached',?, ?,?)", ("b" * 64, '{"v":1,"ok":true,"result":{"storageSchemaVersion":9,"title":"🐋"}}', timestamp))
            before = {name: list(db.execute(f"SELECT rowid,* FROM {name} ORDER BY rowid"))
                      for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            return before, list(db.iterdump())

    def test_expiry_only_new_columns_preserve_all_other_bytes_and_reopen(self):
        before, _ = self.version_nine()
        # Измеряем отдельно переход 9→10; схема 11 проверяется своим набором.
        with patch("agents.claude.cockpit.store.SCHEMA_VERSION", 10), Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 10)
            names = ["rowid", *[row[1] for row in db.execute("PRAGMA table_info(tasks)")]]
            reason, dismissed_at = names.index("dismiss_reason"), names.index("dismissed_at")
            for name, rows in before.items():
                current = [tuple(row) for row in db.execute(f"SELECT rowid,* FROM {name} ORDER BY rowid")]
                if name == "tasks":
                    for old, new in zip(rows, current, strict=True):
                        if old[1] in ("active", "paused"):
                            self.assertEqual(new[reason], "expired")
                            self.assertIsNotNone(new[dismissed_at])
                            new = tuple(old[i] if i in (reason, dismissed_at) else v for i, v in enumerate(new))
                        self.assertEqual(new, old)
                else:
                    self.assertEqual(current, rows, name)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM tasks WHERE stage='candidate' AND dismiss_reason IS NULL AND status IN ('active','paused')").fetchone()[0], 0)
            dump = list(db.iterdump())
        with patch("agents.claude.cockpit.store.SCHEMA_VERSION", 10), Store(str(self.state)) as store:
            self.assertEqual(list(store.connection.iterdump()), dump)

    def test_snapshot_of_version_nine_is_kept_beside_the_database(self):
        _, before = self.version_nine()
        backup = self.state / "cockpit.v9.bak"
        with Store(str(self.state)):
            pass
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 9)
            # VACUUM переставляет объекты схемы; строки и определения те же.
            self.assertEqual(sorted(db.iterdump()), sorted(before))
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        stamp = backup.stat().st_mtime_ns
        with Store(str(self.state)):
            pass
        self.assertEqual(backup.stat().st_mtime_ns, stamp)

    def test_new_database_needs_no_snapshot(self):
        with Store(str(self.state)):
            pass
        self.assertEqual(sorted(path.name for path in self.state.glob("*.bak")), [])

    def test_failure_rolls_back_schema_rows_and_candidate_closure(self):
        _, before = self.version_nine()
        with patch("agents.claude.cockpit.store.SCHEMA_VERSION", 10), patch("agents.claude.cockpit.store.MIGRATIONS", {
            **MIGRATIONS, 10: (*MIGRATIONS.get(10, ()), "НЕКОРРЕКТНЫЙ SQL")}):
            with self.assertRaises(CockpitError):
                with Store(str(self.state)):
                    self.fail("Миграция должна откатиться")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 9)
            self.assertEqual(list(db.iterdump()), before)
        with Store(str(self.state)) as store:
            self.assertEqual(store.connection.execute("PRAGMA foreign_key_check").fetchall(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

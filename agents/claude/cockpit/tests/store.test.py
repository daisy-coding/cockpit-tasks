#!/usr/bin/env python3
"""Миграции, durability, права и неизменяемость на настоящем SQLite."""

import os
import sqlite3
import stat
import subprocess
import sys
import unittest
from unittest.mock import patch

from support import Harness
from agents.claude.cockpit import CockpitError
from agents.claude.cockpit.store import SCHEMA_VERSION, Store, state_directory


class StoreTests(Harness):
    def test_sqlite_shared_memory_lock_is_not_released_by_permissions_check(self):
        # Дескриптор, открытый вне SQLite и затем закрытый, снимает fcntl-locks процесса.
        # Проверяем владение настоящей блокировкой другим процессом, без мока SQLite.
        probe = """import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOFOLLOW)
try:
    try:
        fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(1)
    else:
        print(0)
        fcntl.lockf(fd, fcntl.LOCK_UN)
finally:
    os.close(fd)
"""
        with Store(str(self.state)):
            process = subprocess.run([sys.executable, "-c", probe, str(self.state / "cockpit.db-shm")],
                                     capture_output=True, env=self.env, timeout=5)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(process.stdout, b"1\n", "SQLite должен удерживать shared-memory lock до close.")

    def test_migration_is_idempotent_and_tables_are_m1_and_m2(self):
        with Store(str(self.state)) as store:
            db = store.connection
            before = [tuple(row) for row in db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY name")]
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(db.execute("PRAGMA busy_timeout").fetchone()[0], 2000)
            self.assertEqual(db.execute("PRAGMA synchronous").fetchone()[0], 2)
        with Store(str(self.state)) as store:
            after = [tuple(row) for row in store.connection.execute("SELECT type,name,sql FROM sqlite_master ORDER BY name")]
            self.assertEqual(before, after)
            tables = {row[1] for row in after if row[0] == "table"}
            self.assertEqual(tables - {"sqlite_sequence"}, {
                "projects", "worktrees", "sessions", "inbox", "tasks", "task_sources",
                "focus", "events", "requests", "config", "inbox_observations", "checkpoints", "focus_stack",
                "project_config", "worktree_leases", "gate_observations", "session_attestations", "task_steps", "task_lists",
                "attestation_revocations", "attestation_usage", "task_agent_notes", "task_closures", "task_owner_comments", "task_description_summaries",
            })
            self.assertEqual(store.connection.execute("SELECT COUNT(*) FROM config").fetchone()[0], 1)

    def test_newer_database_is_refused_without_migration(self):
        with Store(str(self.state)) as store:
            store.connection.execute(f"PRAGMA user_version={SCHEMA_VERSION + 1}")
        with self.assertRaises(CockpitError) as failure:
            with Store(str(self.state)):
                self.fail("База будущей версии должна быть отклонена.")
        self.assertEqual(failure.exception.code, "DB_UNAVAILABLE")
        self.assertIn("новее", failure.exception.message)
        self.assertEqual(self.rows("PRAGMA user_version")[0]["user_version"], SCHEMA_VERSION + 1)

    def test_migration_failure_rolls_back_schema_and_version(self):
        with patch("agents.claude.cockpit.store.MIGRATIONS", {1: (
            "CREATE TABLE partial_table(id INTEGER)", "НЕКОРРЕКТНЫЙ SQL",
        )}):
            with self.assertRaises(CockpitError):
                with Store(str(self.state)):
                    self.fail("Некорректная миграция должна прерваться.")
        self.assertEqual(self.rows("PRAGMA user_version")[0]["user_version"], 0)
        self.assertEqual(self.rows("SELECT name FROM sqlite_master WHERE type='table'"), [])
        with Store(str(self.state)) as store:
            self.assertEqual(store.connection.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_directory_database_wal_and_shm_permissions(self):
        previous = os.umask(0)
        try:
            with Store(str(self.state)) as store:
                self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
                for filename in ("cockpit.db", "cockpit.db-wal", "cockpit.db-shm"):
                    file = self.state / filename
                    self.assertTrue(file.is_file(), filename)
                    self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600, filename)
                self.assertTrue(store.permissions()["directory"]["ok"])
        finally:
            os.umask(previous)
        self.state.chmod(0o777)
        (self.state / "cockpit.db").chmod(0o666)
        with Store(str(self.state)):
            self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((self.state / "cockpit.db").stat().st_mode), 0o600)

    def test_symlink_directory_is_refused(self):
        target = self.root / "target"
        target.mkdir()
        self.state.symlink_to(target, target_is_directory=True)
        with self.assertRaises(CockpitError) as failure:
            with Store(str(self.state)):
                self.fail("Символическая ссылка не должна открываться.")
        self.assertEqual(failure.exception.code, "DB_UNAVAILABLE")
        self.assertIn("символической", failure.exception.message)
        self.assertEqual(list(target.iterdir()), [])

    def test_database_and_sidecar_symlinks_are_refused(self):
        self.state.mkdir()
        target = self.root / "target.db"
        original = "не изменять".encode("utf-8")
        target.write_bytes(original)
        (self.state / "cockpit.db").symlink_to(target)
        with self.assertRaises(CockpitError):
            with Store(str(self.state)):
                self.fail("Ссылка на файл базы должна быть отклонена.")
        self.assertEqual(target.read_bytes(), original)
        (self.state / "cockpit.db").unlink()
        with Store(str(self.state)):
            pass
        (self.state / "cockpit.db-wal").symlink_to(target)
        with self.assertRaises(CockpitError):
            with Store(str(self.state)):
                self.fail("Ссылка на WAL должна быть отклонена.")
        self.assertEqual(target.read_bytes(), original)

    def test_state_directory_precedence(self):
        with patch.dict(os.environ, {"COCKPIT_STATE_DIR": str(self.state), "XDG_STATE_HOME": str(self.root)}, clear=True):
            self.assertEqual(state_directory(), str(self.state))
        with patch.dict(os.environ, {"XDG_STATE_HOME": str(self.root)}, clear=True):
            self.assertEqual(state_directory(), str(self.root / "agent-config" / "cockpit"))
        with patch.dict(os.environ, {"HOME": str(self.root)}, clear=True):
            self.assertEqual(state_directory(), str(self.root / ".local" / "state" / "agent-config" / "cockpit"))

    def test_inbox_sources_and_events_are_immutable(self):
        captured = self.ok("capture.prompt", {"text": "Неизменяемый оригинал 🐋"})
        bound = self.task_fixture()
        statements = (
            ("UPDATE inbox SET raw_text='замена' WHERE inbox_id=?", (captured["inboxId"],)),
            ("UPDATE inbox SET raw_length=0 WHERE inbox_id=?", (captured["inboxId"],)),
            ("DELETE FROM inbox WHERE inbox_id=?", (captured["inboxId"],)),
            ("UPDATE task_sources SET start_pos=1 WHERE task_id=?", (bound["task"]["taskId"],)),
            ("DELETE FROM task_sources WHERE task_id=?", (bound["task"]["taskId"],)),
            ("UPDATE events SET kind='замена'", ()),
            ("DELETE FROM events", ()),
        )
        with Store(str(self.state)) as store:
            for sql, args in statements:
                with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                    store.connection.execute(sql, args)
            with self.assertRaises(sqlite3.IntegrityError):
                store.connection.execute("INSERT INTO task_sources VALUES (?,?,?,0,999,?,'origin')",
                                         (bound["task"]["taskId"], captured["inboxId"], bound["task"]["projectId"],
                                          bound["task"]["source"]["sha256"]))

    def test_doctor_reports_permissions_without_fixing_them(self):
        self.ok("snapshot")
        self.state.chmod(0o755)
        (self.state / "cockpit.db").chmod(0o644)
        report = self.ok("doctor")
        self.assertEqual(report["integrityCheck"], ["ok"])
        self.assertEqual(report["foreignKeyCheck"], [])
        self.assertEqual(report["schemaVersion"], 1)
        self.assertEqual(report["storageSchemaVersion"], SCHEMA_VERSION)
        self.assertFalse(report["permissions"]["directory"]["ok"])
        self.assertEqual(report["permissions"]["files"]["cockpit.db"]["mode"], "0644")
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.state / "cockpit.db").stat().st_mode), 0o644)


if __name__ == "__main__":
    unittest.main(verbosity=2)

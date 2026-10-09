#!/usr/bin/env python3
"""Миграция 12→13 добавляет только кеш, с атомарным откатом и сохранением базы."""
import sqlite3
import unittest
from unittest.mock import patch
from support import Harness
from agents.claude.cockpit import CockpitError
from agents.claude.cockpit.store import MIGRATIONS, SCHEMA_VERSION, Store


class MigrationThirteenTests(Harness):
    def version_twelve(self):
        self.state.mkdir(mode=0o700)
        with sqlite3.connect(self.state / 'cockpit.db') as db:
            for version in range(1, 13):
                for statement in MIGRATIONS[version]:
                    db.execute(statement)
            db.execute('PRAGMA user_version=12')
            timestamp = '2026-10-08T12:00:00.000000Z'
            db.execute("INSERT INTO projects VALUES ('p','directory',?,'Проект',?)", (str(self.cwd), timestamp))
            db.execute("INSERT INTO worktrees VALUES ('w','p',?)", (str(self.cwd),))
            db.execute("INSERT INTO sessions VALUES ('s','p','w',?)", (timestamp,))
            db.execute("INSERT INTO tasks(task_id,project_id,worktree_id,alias_no,origin,title,status,revision,description,created_at,updated_at) VALUES ('t','p','w',1,'no-source','Задача','active',7,?,?,?)", ('Описание\n🧪', timestamp, timestamp))
            rows = {name: list(db.execute(f'SELECT rowid,* FROM "{name}" ORDER BY rowid')) for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            schema = list(db.execute('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master ORDER BY name'))
            return rows, schema, list(db.iterdump())

    def test_only_cache_added_every_old_row_and_schema_preserved_on_reopen(self):
        before, schema, _ = self.version_twelve()
        self.assertEqual(SCHEMA_VERSION, 13)
        with Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 13)
            for name, rows in before.items():
                self.assertEqual([tuple(row) for row in db.execute(f'SELECT rowid,* FROM "{name}" ORDER BY rowid')], rows, name)
            for definition in schema:
                self.assertEqual(tuple(db.execute('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master WHERE name=?', (definition[1],)).fetchone()), definition)
            self.assertEqual(db.execute('SELECT * FROM task_description_summaries').fetchall(), [])
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            after = list(db.iterdump())
        with Store(str(self.state)) as store:
            self.assertEqual(list(store.connection.iterdump()), after)
        self.assertEqual(list(self.state.glob('*.bak')), [])

    def test_failure_rolls_back_table_and_schema_version(self):
        _, _, before = self.version_twelve()
        with patch('agents.claude.cockpit.store.MIGRATIONS', {**MIGRATIONS, 13: (*MIGRATIONS[13], 'НЕКОРРЕКТНЫЙ SQL')}):
            with self.assertRaises(CockpitError), Store(str(self.state)):
                self.fail('Миграция должна откатиться')
        with sqlite3.connect(self.state / 'cockpit.db') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 12)
            self.assertEqual(list(db.iterdump()), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)

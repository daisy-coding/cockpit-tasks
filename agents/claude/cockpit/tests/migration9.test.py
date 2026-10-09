#!/usr/bin/env python3
"""Одноразовый перевод неподтверждённых старых задач из схемы 8."""

import sqlite3
import unittest
from unittest.mock import patch

from support import Harness
from agents.claude.cockpit import CockpitError
from agents.claude.cockpit.store import MIGRATIONS, Store


class MigrationNineTests(Harness):
    def version_eight(self):
        self.state.mkdir(mode=0o700)
        timestamp = '2026-10-01T00:00:00.000000Z'
        kinds = {
            'eligible': {}, 'with-steps': {}, 'with-description': {'description': 'Текст модели'},
            'candidate': {'stage': 'candidate'}, 'confirmed': {'certainty': 'confirmed'},
            'verified': {'certainty': 'verified'}, 'engine': {'certainty_source': 'engine'},
            'user': {'certainty_source': 'user'}, 'paused': {'status': 'paused'},
            'done': {'status': 'done'}, 'cancelled': {'status': 'cancelled'},
            'edited': {}, 'confirmed-before': {}, 'checkpoint': {}, 'focus-other': {}, 'stack-other': {},
            'adopted-owner': {'adopted_by': 'owner'}, 'reordered': {},
        }
        with sqlite3.connect(self.state / 'cockpit.db') as db:
            db.execute('PRAGMA foreign_keys=ON')
            for version in range(1, 9):
                for statement in MIGRATIONS[version]:
                    db.execute(statement)
            db.execute('PRAGMA user_version=8')
            db.execute('INSERT INTO projects VALUES (?,?,?,?,?)', ('p', 'directory', str(self.cwd), 'Проект', timestamp))
            for tree in ['w', 'other']:
                db.execute('INSERT INTO worktrees VALUES (?,?,?)', (tree, 'p', str(self.cwd / tree)))
                db.execute('INSERT INTO sessions VALUES (?,?,?,?)', ('s', 'p', tree, timestamp))
            for index, (task_id, changes) in enumerate(kinds.items(), 1):
                fields = dict(task_id=task_id, project_id='p', worktree_id='w', alias_no=index, origin='no-source',
                              title=task_id, status='active', revision=2, created_at=timestamp, updated_at=timestamp,
                              certainty='inferred', certainty_source='provider', certainty_provenance='panel', queue_position=index)
                fields.update(changes)
                db.execute(f"INSERT INTO tasks ({','.join(fields)}) VALUES ({','.join('?' for _ in fields)})", tuple(fields.values()))
            for task_id, kind in [('edited', 'task.edited'), ('confirmed-before', 'task.confirmed'), ('reordered', 'task.panel.up')]:
                db.execute('INSERT INTO events(project_id,worktree_id,session_id,kind,entity_id,created_at) VALUES (?,?,?,?,?,?)',
                           ('p', 'w', 's', kind, task_id, timestamp))
            db.execute('INSERT INTO task_steps VALUES (?,?,?,?)', ('with-steps', 0, 'Шаг модели', 'pending'))
            db.execute('INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?,?,?,?)', ('cp', 'checkpoint', 'p', 'w', 's', 'note', 'Отметка', 'agent', timestamp, 'tool'))
            db.execute('INSERT INTO focus VALUES (?,?,?,?,?)', ('other', 'p', 's', 'focus-other', 1))
            db.execute('INSERT INTO focus_stack VALUES (?,?,?,?,?,?,?,?)', ('other', 'p', 1, 'stack-other', 's', 'user', timestamp, 'panel'))
            db.execute('INSERT INTO requests VALUES (?,?,?,?)', ('cached', 'a' * 64, '{"v":1,"ok":true,"result":{"storageSchemaVersion":8}}', timestamp))
            before = {row[0]: list(db.execute(f'SELECT * FROM {row[0]} ORDER BY rowid'))
                      for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            return before, list(db.iterdump())

    def test_only_eligible_stage_changes_and_reopen_is_identical(self):
        before, _ = self.version_eight()
        eligible = {'eligible', 'with-steps', 'with-description'}
        # Этот набор измеряет именно переход 8→9, следующий переход проверяется отдельно.
        with patch('agents.claude.cockpit.store.SCHEMA_VERSION', 9), Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 9)
            names = [row[1] for row in db.execute('PRAGMA table_info(tasks)')]
            stage = names.index('stage')
            for name, rows in before.items():
                expected = [tuple('candidate' if index == stage and row[0] in eligible else value
                                  for index, value in enumerate(row)) for row in rows] if name == 'tasks' else rows
                self.assertEqual([tuple(row) for row in db.execute(f'SELECT * FROM {name} ORDER BY rowid')], expected, name)
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
            dump = list(db.iterdump())
        with patch('agents.claude.cockpit.store.SCHEMA_VERSION', 9), Store(str(self.state)) as store:
            self.assertEqual(list(store.connection.iterdump()), dump)

    def test_failure_rolls_back_stage_and_schema_version(self):
        _, before = self.version_eight()
        with patch('agents.claude.cockpit.store.MIGRATIONS', {**MIGRATIONS, 9: (*MIGRATIONS.get(9, ()), 'НЕКОРРЕКТНЫЙ SQL')}):
            with self.assertRaises(CockpitError):
                with Store(str(self.state)):
                    self.fail('Миграция должна откатиться')
        with sqlite3.connect(self.state / 'cockpit.db') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 8)
            self.assertEqual(list(db.iterdump()), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)

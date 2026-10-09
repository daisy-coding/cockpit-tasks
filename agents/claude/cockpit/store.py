"""Соединение SQLite, миграции и закрытые права локального хранилища."""

import fcntl
import os
import sqlite3
import stat

from . import CockpitError

SCHEMA_VERSION = 13
BUSY_TIMEOUT_MS = 2000
TABLES = (
    "projects", "worktrees", "sessions", "inbox", "tasks", "task_sources",
    "focus", "events", "requests", "config", "inbox_observations", "checkpoints", "focus_stack",
    "project_config", "worktree_leases", "gate_observations", "session_attestations", "task_steps", "task_lists",
    "attestation_revocations", "attestation_usage", "task_agent_notes", "task_closures", "task_owner_comments", "task_description_summaries",
)

# Миграции выполняются отдельными statements: executescript разрывает транзакцию.
MIGRATIONS = {1: (
    """CREATE TABLE config (
        key TEXT PRIMARY KEY CHECK(key='capture_mode'),
        value TEXT NOT NULL CHECK(value IN ('full-local','redacted','off'))
    )""",
    "INSERT INTO config VALUES ('capture_mode','full-local')",
    """CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        identity_kind TEXT NOT NULL CHECK(identity_kind IN ('git','directory')),
        canonical_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(identity_kind,canonical_path)
    )""",
    """CREATE TABLE worktrees (
        worktree_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        local_path TEXT NOT NULL UNIQUE,
        UNIQUE(worktree_id,project_id)
    )""",
    """CREATE TABLE sessions (
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(session_id,project_id,worktree_id),
        FOREIGN KEY(worktree_id,project_id) REFERENCES worktrees(worktree_id,project_id)
    )""",
    """CREATE TABLE inbox (
        inbox_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        delivery_key TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        capture_mode TEXT NOT NULL CHECK(capture_mode IN ('full-local','off')),
        raw_text TEXT,
        raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64),
        raw_length INTEGER NOT NULL CHECK(raw_length>=0),
        status TEXT NOT NULL DEFAULT 'untriaged' CHECK(status='untriaged'),
        captured_at TEXT NOT NULL,
        UNIQUE(inbox_id,project_id),
        FOREIGN KEY(session_id,project_id,worktree_id)
            REFERENCES sessions(session_id,project_id,worktree_id),
        CHECK((capture_mode='off' AND raw_text IS NULL) OR
              (capture_mode='full-local' AND raw_text IS NOT NULL))
    )""",
    """CREATE TRIGGER inbox_immutable_update BEFORE UPDATE ON inbox
        BEGIN SELECT RAISE(ABORT,'исходное указание неизменяемо'); END""",
    """CREATE TRIGGER inbox_immutable_delete BEFORE DELETE ON inbox
        BEGIN SELECT RAISE(ABORT,'удаление указаний не реализовано в M1'); END""",
    """CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        alias_no INTEGER NOT NULL CHECK(alias_no>0),
        origin TEXT NOT NULL CHECK(origin IN ('ad-hoc','no-source')),
        title TEXT NOT NULL CHECK(title!=''),
        status TEXT NOT NULL CHECK(status IN ('active','paused','done','cancelled')),
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id,project_id),
        UNIQUE(project_id,alias_no),
        FOREIGN KEY(worktree_id,project_id) REFERENCES worktrees(worktree_id,project_id)
    )""",
    """CREATE TABLE task_sources (
        task_id TEXT NOT NULL,
        inbox_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        start_pos INTEGER NOT NULL CHECK(start_pos>=0),
        end_pos INTEGER NOT NULL CHECK(end_pos>=start_pos),
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
        relation TEXT NOT NULL CHECK(relation='origin'),
        PRIMARY KEY(task_id,inbox_id,start_pos,end_pos,relation),
        FOREIGN KEY(task_id,project_id) REFERENCES tasks(task_id,project_id),
        FOREIGN KEY(inbox_id,project_id) REFERENCES inbox(inbox_id,project_id)
    )""",
    """CREATE TRIGGER task_source_range BEFORE INSERT ON task_sources BEGIN
        SELECT RAISE(ABORT,'диапазон или хеш источника не совпадает') WHERE NOT EXISTS (
            SELECT 1 FROM inbox i WHERE i.inbox_id=NEW.inbox_id
            AND i.project_id=NEW.project_id AND i.raw_sha256=NEW.source_sha256
            AND NEW.end_pos<=i.raw_length
        ); END""",
    """CREATE TRIGGER task_source_immutable_update BEFORE UPDATE ON task_sources
        BEGIN SELECT RAISE(ABORT,'связь с источником неизменяема'); END""",
    """CREATE TRIGGER task_source_immutable_delete BEFORE DELETE ON task_sources
        BEGIN SELECT RAISE(ABORT,'связь с источником неизменяема'); END""",
    """CREATE TABLE focus (
        worktree_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT,
        revision INTEGER NOT NULL CHECK(revision>0),
        FOREIGN KEY(session_id,project_id,worktree_id)
            REFERENCES sessions(session_id,project_id,worktree_id),
        FOREIGN KEY(task_id,project_id) REFERENCES tasks(task_id,project_id)
    )""",
    """CREATE TABLE events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id,project_id,worktree_id)
            REFERENCES sessions(session_id,project_id,worktree_id)
    )""",
    """CREATE TRIGGER event_immutable_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT,'событие неизменяемо'); END""",
    """CREATE TRIGGER event_immutable_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT,'событие неизменяемо'); END""",
    """CREATE TABLE requests (
        request_id TEXT PRIMARY KEY,
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        response_json TEXT NOT NULL CHECK(json_valid(response_json)),
        committed_at TEXT NOT NULL
    )""",
    # rowid внутри этих индексов сохраняет порядок записей при откате часов.
    "CREATE INDEX inbox_recent ON inbox(worktree_id)",
    "CREATE INDEX inbox_session ON inbox(worktree_id,session_id)",
    "CREATE INDEX tasks_recent ON tasks(project_id)",
), 2: (
    """ALTER TABLE tasks ADD COLUMN certainty TEXT NOT NULL DEFAULT 'observed'
        CHECK(certainty IN ('observed','inferred','confirmed','verified'))""",
    """ALTER TABLE tasks ADD COLUMN certainty_source TEXT NOT NULL DEFAULT 'engine'
        CHECK(certainty_source IN ('user','claude','agent','engine','tool','provider'))""",
    """CREATE TABLE inbox_observations (
        observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        inbox_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        inbox_type TEXT CHECK(inbox_type IN ('info','proposal','question','decision','approval','conflict','blocking')),
        task_id TEXT,
        resource_id TEXT CHECK(resource_id IS NULL OR length(resource_id) BETWEEN 1 AND 100),
        classified_by TEXT NOT NULL CHECK(classified_by IN ('rule','user','jev')),
        policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 100),
        confidence REAL CHECK(confidence IS NULL OR (confidence>=0 AND confidence<=1)),
        mode TEXT NOT NULL CHECK(mode IN ('shadow','active')),
        triage_status TEXT CHECK(triage_status IN ('untriaged','triaged','rejected')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(inbox_id,project_id) REFERENCES inbox(inbox_id,project_id),
        FOREIGN KEY(task_id,project_id) REFERENCES tasks(task_id,project_id),
        CHECK(classified_by='user' OR triage_status IS NULL)
    )""",
    "CREATE INDEX inbox_observation_recent ON inbox_observations(inbox_id,classified_by,observation_id)",
    """CREATE TRIGGER inbox_observation_immutable_update BEFORE UPDATE ON inbox_observations
        BEGIN SELECT RAISE(ABORT,'наблюдение Inbox неизменяемо'); END""",
    """CREATE TRIGGER inbox_observation_immutable_delete BEFORE DELETE ON inbox_observations
        BEGIN SELECT RAISE(ABORT,'наблюдение Inbox неизменяемо'); END""",
    # Исходный status остаётся untriaged; вид и разбор — проекция журнала наблюдений.
    # Порядок записи важнее часов, а последнее решение человека важнее классификатора.
    """CREATE VIEW inbox_state AS SELECT i.*, i.rowid AS capture_order,
        o.inbox_type, o.task_id, o.resource_id, o.classified_by, o.policy_version,
        o.confidence, o.mode, o.created_at AS observed_at,
        (SELECT COUNT(*) FROM inbox_observations r WHERE r.inbox_id=i.inbox_id) AS triage_revision,
        COALESCE((SELECT r.triage_status FROM inbox_observations r
            WHERE r.inbox_id=i.inbox_id AND r.classified_by='user' AND r.triage_status IS NOT NULL
            ORDER BY r.observation_id DESC LIMIT 1),'untriaged') AS triage_status
        FROM inbox i LEFT JOIN inbox_observations o ON o.observation_id=(
            SELECT r.observation_id FROM inbox_observations r WHERE r.inbox_id=i.inbox_id
            ORDER BY (r.classified_by='user') DESC,r.observation_id DESC LIMIT 1
        )""",
    # Вход ограничен 1000 code points; в SQLite длина TEXT обрывается на NUL,
    # поэтому дополнительный предел хранилища — 4000 байт корректного UTF-8.
    """CREATE TABLE checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('commit','tests-passed','note','detour','return')),
        text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 4000),
        source TEXT NOT NULL CHECK(source IN ('user','claude','agent','engine','tool','provider')),
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id,project_id) REFERENCES tasks(task_id,project_id),
        FOREIGN KEY(session_id,project_id,worktree_id) REFERENCES sessions(session_id,project_id,worktree_id)
    )""",
    "CREATE INDEX checkpoint_recent ON checkpoints(task_id)",
    """CREATE TRIGGER checkpoint_immutable_update BEFORE UPDATE ON checkpoints
        BEGIN SELECT RAISE(ABORT,'контрольная точка неизменяема'); END""",
    """CREATE TRIGGER checkpoint_immutable_delete BEFORE DELETE ON checkpoints
        BEGIN SELECT RAISE(ABORT,'контрольная точка неизменяема'); END""",
    """CREATE TABLE focus_stack (
        worktree_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 8),
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source='user'),
        created_at TEXT NOT NULL,
        PRIMARY KEY(worktree_id,depth),
        FOREIGN KEY(task_id,project_id) REFERENCES tasks(task_id,project_id),
        FOREIGN KEY(session_id,project_id,worktree_id) REFERENCES sessions(session_id,project_id,worktree_id)
    )""",
), 3: (
    """CREATE TABLE project_config (
        project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
        gate_mode TEXT NOT NULL CHECK(gate_mode IN ('off','observe'))
    )""",
    """CREATE TABLE worktree_leases (
        worktree_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        renewed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(session_id,project_id,worktree_id)
            REFERENCES sessions(session_id,project_id,worktree_id)
    )""",
    """CREATE TABLE gate_observations (
        observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('ALLOW','BIND','BLOCK')),
        reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json) AND json_type(reasons_json)='array'),
        resource_id TEXT NOT NULL CHECK(length(resource_id)=69),
        resource_path TEXT,
        observed_at TEXT NOT NULL,
        FOREIGN KEY(session_id,project_id,worktree_id)
            REFERENCES sessions(session_id,project_id,worktree_id),
        FOREIGN KEY(task_id,project_id) REFERENCES tasks(task_id,project_id),
        CHECK((outcome='BLOCK' AND json_array_length(reasons_json)>0) OR
              (outcome IN ('ALLOW','BIND') AND json_array_length(reasons_json)=0))
    )""",
    "CREATE INDEX gate_project_recent ON gate_observations(project_id,observed_at)",
    "CREATE INDEX gate_session_recent ON gate_observations(project_id,session_id,worktree_id)",
    """CREATE TRIGGER gate_reason_closed BEFORE INSERT ON gate_observations BEGIN
        SELECT RAISE(ABORT,'недопустимые причины стража') WHERE EXISTS (
            SELECT 1 FROM json_each(NEW.reasons_json)
            WHERE value NOT IN ('foreign-lease','stale-read','blocking-inbox','pending-decision')
                OR type<>'text'
        ) OR json_array_length(NEW.reasons_json)<>
            (SELECT COUNT(DISTINCT value) FROM json_each(NEW.reasons_json)); END""",
    """CREATE TRIGGER gate_immutable_update BEFORE UPDATE ON gate_observations
        BEGIN SELECT RAISE(ABORT,'наблюдение стража неизменяемо'); END""",
    """CREATE TRIGGER gate_immutable_delete BEFORE DELETE ON gate_observations
        BEGIN SELECT RAISE(ABORT,'наблюдение стража неизменяемо'); END""",
), 4: (
    """ALTER TABLE inbox_observations ADD COLUMN provenance TEXT NOT NULL DEFAULT 'cli'
        CHECK(provenance IN ('panel','cli'))""",
    """ALTER TABLE tasks ADD COLUMN certainty_provenance TEXT NOT NULL DEFAULT 'cli'
        CHECK(certainty_provenance IN ('panel','cli'))""",
    """ALTER TABLE checkpoints ADD COLUMN provenance TEXT NOT NULL DEFAULT 'cli'
        CHECK(provenance IN ('panel','cli'))""",
    """ALTER TABLE focus_stack ADD COLUMN provenance TEXT NOT NULL DEFAULT 'cli'
        CHECK(provenance IN ('panel','cli'))""",
    """ALTER TABLE project_config ADD COLUMN provenance TEXT NOT NULL DEFAULT 'cli'
        CHECK(provenance IN ('panel','cli'))""",
    """ALTER TABLE config ADD COLUMN provenance TEXT NOT NULL DEFAULT 'cli'
        CHECK(provenance IN ('panel','cli'))""",
    """CREATE TABLE session_attestations (
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        secret_sha256 TEXT NOT NULL CHECK(length(secret_sha256)=64),
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id,project_id,worktree_id),
        FOREIGN KEY(session_id,project_id,worktree_id)
            REFERENCES sessions(session_id,project_id,worktree_id)
    )""",
    """CREATE TRIGGER attestation_immutable_update BEFORE UPDATE ON session_attestations
        BEGIN SELECT RAISE(ABORT,'свидетельство сессии неизменяемо'); END""",
    """CREATE TRIGGER attestation_immutable_delete BEFORE DELETE ON session_attestations
        BEGIN SELECT RAISE(ABORT,'свидетельство сессии неизменяемо'); END""",
    "DROP VIEW inbox_state",
    """CREATE VIEW inbox_state AS SELECT i.*, i.rowid AS capture_order,
        o.inbox_type, o.task_id, o.resource_id, o.classified_by, o.policy_version,
        o.confidence, o.mode, o.created_at AS observed_at, COALESCE(o.provenance,'cli') AS provenance,
        (SELECT COUNT(*) FROM inbox_observations r WHERE r.inbox_id=i.inbox_id) AS triage_revision,
        COALESCE((SELECT r.triage_status FROM inbox_observations r
            WHERE r.inbox_id=i.inbox_id AND r.classified_by='user' AND r.triage_status IS NOT NULL
            ORDER BY r.observation_id DESC LIMIT 1),'untriaged') AS triage_status,
        COALESCE((SELECT r.provenance FROM inbox_observations r
            WHERE r.inbox_id=i.inbox_id AND r.classified_by='user' AND r.triage_status IS NOT NULL
            ORDER BY r.observation_id DESC LIMIT 1),'cli') AS triage_provenance
        FROM inbox i LEFT JOIN inbox_observations o ON o.observation_id=(
            SELECT r.observation_id FROM inbox_observations r WHERE r.inbox_id=i.inbox_id
            ORDER BY (r.classified_by='user') DESC,r.observation_id DESC LIMIT 1
        )""",
), 5: (
    # Старые наблюдения остаются дословными; без автора они не снимают причины стража.
    "ALTER TABLE inbox_observations ADD COLUMN author_session_id TEXT",
    "ALTER TABLE inbox_observations ADD COLUMN author_worktree_id TEXT",
    """CREATE VIEW authorized_inbox_observations AS SELECT o.* FROM inbox_observations o
        JOIN inbox i ON i.inbox_id=o.inbox_id AND i.project_id=o.project_id
        JOIN session_attestations a ON a.session_id=i.session_id AND a.project_id=i.project_id
            AND a.worktree_id=i.worktree_id
        WHERE o.classified_by='user' AND o.provenance='panel'
            AND o.author_session_id=i.session_id AND o.author_worktree_id=i.worktree_id
            AND a.created_at < (SELECT first.captured_at FROM inbox first
                WHERE first.session_id=i.session_id AND first.project_id=i.project_id
                    AND first.worktree_id=i.worktree_id ORDER BY first.rowid LIMIT 1)""",
    "DROP VIEW inbox_state",
    """CREATE VIEW inbox_state AS SELECT i.*, i.rowid AS capture_order,
        o.inbox_type,o.task_id,o.resource_id,o.classified_by,o.policy_version,
        o.confidence,o.mode,o.created_at AS observed_at,COALESCE(o.provenance,'cli') AS provenance,
        (SELECT COUNT(*) FROM inbox_observations r WHERE r.inbox_id=i.inbox_id) AS triage_revision,
        COALESCE(o.triage_status,'untriaged') AS triage_status,
        COALESCE(o.provenance,'cli') AS triage_provenance
        FROM inbox i LEFT JOIN inbox_observations o ON o.observation_id=(
            SELECT r.observation_id FROM inbox_observations r WHERE r.inbox_id=i.inbox_id
                AND (r.provenance<>'panel' OR EXISTS (SELECT 1 FROM authorized_inbox_observations a
                    WHERE a.observation_id=r.observation_id))
            ORDER BY (r.provenance='panel') DESC,(r.classified_by='user') DESC,r.observation_id DESC LIMIT 1
        )""",
), 6: (
    # Порядок и шаги добавляются отдельно от старых состояний задач и стража.
    "ALTER TABLE tasks ADD COLUMN queue_position INTEGER NOT NULL DEFAULT 0 CHECK(queue_position>=0)",
    "UPDATE tasks SET queue_position=alias_no",
    "ALTER TABLE tasks ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(elapsed_ms>=0)",
    "ALTER TABLE tasks ADD COLUMN active_since TEXT",
    "ALTER TABLE tasks ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))",
    """CREATE TABLE task_steps (
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        position INTEGER NOT NULL CHECK(position>=0),
        title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 1200),
        status TEXT NOT NULL CHECK(status IN ('pending','active','done','blocked')),
        PRIMARY KEY(task_id,position)
    )""",
    "CREATE INDEX tasks_queue ON tasks(worktree_id,deleted,queue_position)",
), 7: (
    "ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK(length(CAST(description AS BLOB))<=16000)",
    "ALTER TABLE tasks ADD COLUMN assignee TEXT CHECK(assignee IN ('claude','codex','antigravity','human'))",
    "ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 3)",
    "ALTER TABLE tasks ADD COLUMN priority_source TEXT NOT NULL DEFAULT 'model' CHECK(priority_source IN ('user','model','jev'))",
    "ALTER TABLE tasks ADD COLUMN priority_pinned INTEGER NOT NULL DEFAULT 0 CHECK(priority_pinned IN (0,1))",
    "ALTER TABLE tasks ADD COLUMN priority_provenance TEXT NOT NULL DEFAULT 'cli' CHECK(priority_provenance IN ('panel','cli'))",
    """CREATE TABLE task_lists (
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        kind TEXT NOT NULL CHECK(kind IN ('acceptance','constraints')),
        position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 9),
        text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=1200),
        PRIMARY KEY(task_id,kind,position)
    )""",
    "ALTER TABLE project_config ADD COLUMN queue_mode TEXT NOT NULL DEFAULT 'run' CHECK(queue_mode IN ('run','paused'))",
    "ALTER TABLE project_config ADD COLUMN queue_provenance TEXT NOT NULL DEFAULT 'cli' CHECK(queue_provenance IN ('panel','cli'))",
    "CREATE INDEX tasks_priority_queue ON tasks(worktree_id,deleted,priority,queue_position,alias_no)",
), 8: (
    "ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'task' CHECK(stage IN ('candidate','task'))",
    "ALTER TABLE tasks ADD COLUMN adopted_by TEXT CHECK(adopted_by IN ('owner','agent'))",
    "ALTER TABLE tasks ADD COLUMN dismiss_reason TEXT CHECK(dismiss_reason IN ('answered','owner','expired','duplicate'))",
    "ALTER TABLE tasks ADD COLUMN dismissed_at TEXT",
    "CREATE INDEX candidates_recent ON tasks(project_id,worktree_id,stage,dismiss_reason,created_at)",
    # Отзыв хранится отдельно: неизменяемые отпечатки прежних сессий сохраняются.
    """CREATE TABLE attestation_revocations (
        session_id TEXT NOT NULL, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL,
        revoked_by TEXT NOT NULL CHECK(revoked_by='owner'),
        revoking_session_id TEXT NOT NULL, revoked_at TEXT NOT NULL,
        PRIMARY KEY(session_id,project_id,worktree_id),
        FOREIGN KEY(session_id,project_id,worktree_id)
            REFERENCES session_attestations(session_id,project_id,worktree_id),
        FOREIGN KEY(revoking_session_id,project_id,worktree_id)
            REFERENCES sessions(session_id,project_id,worktree_id)
    )""",
    """CREATE TRIGGER revocation_immutable_update BEFORE UPDATE ON attestation_revocations
        BEGIN SELECT RAISE(ABORT,'отзыв свидетельства неизменяем'); END""",
    """CREATE TRIGGER revocation_immutable_delete BEFORE DELETE ON attestation_revocations
        BEGIN SELECT RAISE(ABORT,'отзыв свидетельства неизменяем'); END""",
    # Перестройка листовой таблицы сохраняет rowid, данные и прежние триггеры.
    """CREATE TABLE checkpoints_v8 (
        checkpoint_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL, session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('commit','tests-passed','note','detour','return')),
        text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 4000),
        source TEXT NOT NULL CHECK(source IN ('user','claude','agent','engine','tool','provider')),
        created_at TEXT NOT NULL,
        provenance TEXT NOT NULL DEFAULT 'cli' CHECK(provenance IN ('panel','cli','tool')),
        FOREIGN KEY(task_id,project_id) REFERENCES tasks(task_id,project_id),
        FOREIGN KEY(session_id,project_id,worktree_id) REFERENCES sessions(session_id,project_id,worktree_id)
    )""",
    """INSERT INTO checkpoints_v8(rowid,checkpoint_id,task_id,project_id,worktree_id,session_id,kind,text,source,created_at,provenance)
        SELECT rowid,* FROM checkpoints ORDER BY rowid""",
    "DROP TABLE checkpoints",
    "ALTER TABLE checkpoints_v8 RENAME TO checkpoints",
    "CREATE INDEX checkpoint_recent ON checkpoints(task_id)",
    """CREATE TRIGGER checkpoint_immutable_update BEFORE UPDATE ON checkpoints
        BEGIN SELECT RAISE(ABORT,'контрольная точка неизменяема'); END""",
    """CREATE TRIGGER checkpoint_immutable_delete BEFORE DELETE ON checkpoints
        BEGIN SELECT RAISE(ABORT,'контрольная точка неизменяема'); END""",
), 9: (
    # Только стадия: исходные даты, порядок, поля, события и кэш ответов сохраняются.
    """UPDATE tasks SET stage='candidate'
        WHERE stage='task' AND status='active'
            AND certainty='inferred' AND certainty_source='provider'
            AND COALESCE(adopted_by,'')<>'owner'
            AND NOT EXISTS (SELECT 1 FROM checkpoints c WHERE c.task_id=tasks.task_id)
            AND NOT EXISTS (SELECT 1 FROM focus f WHERE f.task_id=tasks.task_id)
            AND NOT EXISTS (SELECT 1 FROM focus_stack f WHERE f.task_id=tasks.task_id)
            AND NOT EXISTS (SELECT 1 FROM events e WHERE e.entity_id=tasks.task_id
                AND (e.kind IN ('task.edited','task.confirmed') OR e.kind LIKE 'task.panel.%'))""",
), 10: (
    # Расширяем происхождение задач, сохраняя прежние столбцы, значения и rowid.
    """CREATE TABLE tasks_v10 (
        task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL,
        alias_no INTEGER NOT NULL CHECK(alias_no>0),
        origin TEXT NOT NULL CHECK(origin IN ('ad-hoc','no-source')),
        title TEXT NOT NULL CHECK(title!=''),
        status TEXT NOT NULL CHECK(status IN ('active','paused','done','cancelled')),
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        certainty TEXT NOT NULL DEFAULT 'observed' CHECK(certainty IN ('observed','inferred','confirmed','verified')),
        certainty_source TEXT NOT NULL DEFAULT 'engine' CHECK(certainty_source IN ('user','claude','agent','engine','tool','provider')),
        certainty_provenance TEXT NOT NULL DEFAULT 'cli' CHECK(certainty_provenance IN ('panel','cli','tool')),
        queue_position INTEGER NOT NULL DEFAULT 0 CHECK(queue_position>=0),
        elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(elapsed_ms>=0), active_since TEXT,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
        description TEXT NOT NULL DEFAULT '' CHECK(length(CAST(description AS BLOB))<=16000),
        assignee TEXT CHECK(assignee IN ('claude','codex','antigravity','human')),
        priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 3),
        priority_source TEXT NOT NULL DEFAULT 'model' CHECK(priority_source IN ('user','model','jev')),
        priority_pinned INTEGER NOT NULL DEFAULT 0 CHECK(priority_pinned IN (0,1)),
        priority_provenance TEXT NOT NULL DEFAULT 'cli' CHECK(priority_provenance IN ('panel','cli','tool')),
        stage TEXT NOT NULL DEFAULT 'task' CHECK(stage IN ('candidate','task')),
        adopted_by TEXT CHECK(adopted_by IN ('owner','agent')),
        dismiss_reason TEXT CHECK(dismiss_reason IN ('answered','owner','expired','duplicate')),
        dismissed_at TEXT,
        UNIQUE(task_id,project_id), UNIQUE(project_id,alias_no),
        FOREIGN KEY(worktree_id,project_id) REFERENCES worktrees(worktree_id,project_id)
    )""",
    """INSERT INTO tasks_v10(rowid,task_id,project_id,worktree_id,alias_no,origin,title,status,revision,
        created_at,updated_at,certainty,certainty_source,certainty_provenance,queue_position,elapsed_ms,
        active_since,deleted,description,assignee,priority,priority_source,priority_pinned,priority_provenance,
        stage,adopted_by,dismiss_reason,dismissed_at) SELECT rowid,* FROM tasks ORDER BY rowid""",
    "DROP TABLE tasks",
    "ALTER TABLE tasks_v10 RENAME TO tasks",
    "CREATE INDEX tasks_recent ON tasks(project_id)",
    "CREATE INDEX tasks_queue ON tasks(worktree_id,deleted,queue_position)",
    "CREATE INDEX tasks_priority_queue ON tasks(worktree_id,deleted,priority,queue_position,alias_no)",
    "CREATE INDEX candidates_recent ON tasks(project_id,worktree_id,stage,dismiss_reason,created_at)",
    """UPDATE tasks SET dismiss_reason='expired',dismissed_at=strftime('%Y-%m-%dT%H:%M:%f000Z','now')
        WHERE stage='candidate' AND dismiss_reason IS NULL AND status IN ('active','paused')""",
    """CREATE TABLE task_agent_notes (
        note_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL, session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('note','result')),
        text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 1000 AND (kind<>'result' OR length(text)<=500)),
        created_at TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source='agent'), provenance TEXT NOT NULL CHECK(provenance='tool'),
        FOREIGN KEY(task_id,project_id) REFERENCES tasks(task_id,project_id),
        FOREIGN KEY(session_id,project_id,worktree_id) REFERENCES sessions(session_id,project_id,worktree_id)
    )""",
    "CREATE INDEX task_agent_notes_recent ON task_agent_notes(task_id)",
    """CREATE TRIGGER task_agent_note_immutable_update BEFORE UPDATE ON task_agent_notes
        BEGIN SELECT RAISE(ABORT,'заметка агента неизменяема'); END""",
    """CREATE TRIGGER task_agent_note_immutable_delete BEFORE DELETE ON task_agent_notes
        BEGIN SELECT RAISE(ABORT,'заметка агента неизменяема'); END""",
    """CREATE TABLE task_closures (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), closed_at TEXT NOT NULL
    )""",
    "INSERT INTO task_closures SELECT task_id,updated_at FROM tasks WHERE stage='task' AND status='done'",
), 11: (
    # Комментарии отделены от неизменяемого журнала; прежние таблицы не перестраиваются.
    # length(TEXT) обрывается на NUL; старые отметки с NUL ограничены 4000 байтами.
    """CREATE TABLE task_owner_comments (
        comment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL, session_id TEXT NOT NULL,
        text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 16000 AND length(text)<=4000
            AND (instr(text,char(0))=0 OR length(CAST(text AS BLOB))<=4000)),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
        deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
        FOREIGN KEY(task_id,project_id) REFERENCES tasks(task_id,project_id),
        FOREIGN KEY(session_id,project_id,worktree_id) REFERENCES sessions(session_id,project_id,worktree_id)
    )""",
    "CREATE INDEX task_owner_comments_order ON task_owner_comments(task_id,project_id,worktree_id,deleted,created_at)",
    # Идентификатор копии связывает старую отметку с текущим комментарием при чтении.
    """INSERT INTO task_owner_comments(comment_id,task_id,project_id,worktree_id,session_id,text,created_at,updated_at)
        SELECT checkpoint_id,task_id,project_id,worktree_id,session_id,text,created_at,created_at
        FROM checkpoints WHERE kind='note' AND source='user' AND provenance='panel' ORDER BY rowid""",
), 12: (
    # Учёт использования отделён от неизменяемых отпечатков; прежние таблицы не перестраиваются.
    """CREATE TABLE attestation_usage (
        session_id TEXT NOT NULL, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY(session_id,project_id,worktree_id),
        FOREIGN KEY(session_id,project_id,worktree_id)
            REFERENCES session_attestations(session_id,project_id,worktree_id)
    )""",
    # Прежнее время успешного использования неизвестно: не продлеваем старые ключи задним числом.
    "INSERT INTO attestation_usage SELECT session_id,project_id,worktree_id,created_at FROM session_attestations",
), 13: (
    # Отдельный кеш не меняет старые строки задач и не повышает их ревизии.
    """CREATE TABLE task_description_summaries (
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        description_hash TEXT NOT NULL CHECK(length(description_hash)=64),
        session_id TEXT NOT NULL,
        summary TEXT CHECK(summary IS NULL OR (length(summary) BETWEEN 1 AND 300
            AND length(CAST(summary AS BLOB))<=1200)),
        reported INTEGER NOT NULL DEFAULT 0 CHECK(reported IN (0,1)),
        duration_ms INTEGER CHECK(duration_ms BETWEEN 0 AND 60000),
        input_tokens INTEGER CHECK(input_tokens BETWEEN 0 AND 1000000),
        output_tokens INTEGER CHECK(output_tokens BETWEEN 0 AND 1000000),
        cache_read_tokens INTEGER CHECK(cache_read_tokens BETWEEN 0 AND 1000000),
        cache_creation_tokens INTEGER CHECK(cache_creation_tokens BETWEEN 0 AND 1000000),
        PRIMARY KEY(task_id,description_hash)
    )""",
)}


def state_directory() -> str:
    explicit = os.getenv("COCKPIT_STATE_DIR")
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    base = os.getenv("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.path.abspath(os.path.join(base, "agent-config", "cockpit"))


def unavailable(message: str = "База Cockpit недоступна или занята; повторите вызов позже."):
    return CockpitError("DB_UNAVAILABLE", message)


class Store:
    """Одно соединение на вызов; doctor открывает хранилище без ремонта."""

    def __init__(self, directory: str | None = None, diagnostic: bool = False):
        self.directory = os.path.abspath(directory or state_directory())
        self.path = os.path.join(self.directory, "cockpit.db")
        self.diagnostic = diagnostic
        self.connection = None
        self._directory_fd = None
        self._umask = None

    def _files(self, create: bool = False, repair: bool = True):
        # Только ДО sqlite3.connect: close стороннего FD снимает fcntl-locks процесса.
        # При живом SQLite нельзя открывать/закрывать даже отдельный FD для chmod.
        for name in ("cockpit.db", "cockpit.db-wal", "cockpit.db-shm"):
            filename = os.path.join(self.directory, name)
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if create and name == "cockpit.db":
                flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
            try:
                fd = os.open(filename, flags, 0o600)
            except FileNotFoundError:
                if name == "cockpit.db":
                    # Отсутствие файла — не сбой: до первого указания базы просто нет.
                    raise unavailable("База Cockpit ещё не создана; она появится при первом сохранённом указании.")
                continue
            except OSError as exc:
                raise unavailable("Файл базы Cockpit недоступен или является символической ссылкой.") from exc
            try:
                info = os.fstat(fd)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                        or info.st_nlink > 1 or (name == "cockpit.db" and info.st_nlink != 1)):
                    raise unavailable("Файл базы Cockpit должен быть обычным файлом текущего пользователя без жёстких ссылок.")
                # Последнее чужое соединение могло уже удалить открытый нами sidecar.
                if repair and info.st_nlink:
                    os.fchmod(fd, 0o600)
            finally:
                os.close(fd)

    def __enter__(self):
        self._umask = os.umask(0o077)
        try:
            if os.path.islink(self.directory):
                raise unavailable("Каталог данных Cockpit не может быть символической ссылкой.")
            if not self.diagnostic:
                os.makedirs(self.directory, mode=0o700, exist_ok=True)
            self._directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            if os.fstat(self._directory_fd).st_uid != os.getuid():
                raise unavailable("Каталог данных Cockpit должен принадлежать текущему пользователю.")
            if not self.diagnostic:
                os.fchmod(self._directory_fd, 0o700)
            self._files(create=not self.diagnostic, repair=not self.diagnostic)
            db = sqlite3.connect(self.path, timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None)
            self.connection = db
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            db.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise unavailable(f"Версия базы {version} новее поддерживаемой {SCHEMA_VERSION}.")
            if self.diagnostic:
                if version != SCHEMA_VERSION:
                    raise unavailable("База Cockpit требует миграции; doctor ничего не исправляет.")
            else:
                # Переход в WAL требует исключительной блокировки, и SQLite не ждёт её
                # по busy_timeout: параллельный холодный старт получал «database is locked».
                # Инициализация сериализуется блокировкой на каталоге данных.
                fcntl.flock(self._directory_fd, fcntl.LOCK_EX)
                version = db.execute("PRAGMA user_version").fetchone()[0]
                if db.execute("PRAGMA journal_mode=WAL").fetchone()[0] != "wal":
                    raise unavailable("Для базы Cockpit недоступен режим WAL.")
            db.execute("PRAGMA synchronous=FULL")
            if not self.diagnostic and version < SCHEMA_VERSION:
                # SQLite перестраивает родительскую таблицу только с выключенными FK.
                # Отключение действует лишь на этом соединении и только до завершения DDL;
                # перед commit проверяем ВСЕ ссылки, затем возвращаем принуждение.
                rebuild_tasks = version < 10 <= SCHEMA_VERSION
                if rebuild_tasks:
                    # Перестройка главной таблицы: рядом остаётся снимок базы до миграции.
                    # Каталог заблокирован, umask 077 даёт снимку права 0600; готовый снимок не трогаем.
                    backup = os.path.join(self.directory, f"cockpit.v{version}.bak")
                    if version > 0 and not os.path.lexists(backup):
                        db.execute("VACUUM INTO ?", (backup,))
                    db.execute("PRAGMA foreign_keys=OFF")
                db.execute("BEGIN IMMEDIATE")
                try:
                    # Другой процесс мог завершить миграцию, пока мы ждали блокировку.
                    version = db.execute("PRAGMA user_version").fetchone()[0]
                    if version > SCHEMA_VERSION:
                        raise unavailable(f"Версия базы {version} новее поддерживаемой {SCHEMA_VERSION}.")
                    for target in range(version + 1, SCHEMA_VERSION + 1):
                        for statement in MIGRATIONS[target]:
                            db.execute(statement)
                        db.execute(f"PRAGMA user_version={target}")
                    if rebuild_tasks and db.execute("PRAGMA foreign_key_check").fetchone() is not None:
                        raise unavailable("Миграция нарушила связи базы Cockpit; изменения отменены.")
                    db.execute("COMMIT")
                except BaseException:
                    if db.in_transaction:
                        db.execute("ROLLBACK")
                    raise
                finally:
                    if rebuild_tasks:
                        db.execute("PRAGMA foreign_keys=ON")
            if not self.diagnostic:
                fcntl.flock(self._directory_fd, fcntl.LOCK_UN)
            return self
        except (OSError, sqlite3.Error) as exc:
            self.__exit__(None, None, None)
            raise unavailable() from exc
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        try:
            if self.connection is not None:
                self.connection.close()
                self.connection = None
        finally:
            if self._directory_fd is not None:
                os.close(self._directory_fd)
                self._directory_fd = None
            if self._umask is not None:
                os.umask(self._umask)
                self._umask = None

    def permissions(self) -> dict:
        def inspect(filename, expected):
            try:
                info = os.lstat(filename)
            except FileNotFoundError:
                return {"present": False, "mode": None, "ok": True}
            mode = stat.S_IMODE(info.st_mode)
            return {"present": True, "mode": f"{mode:04o}", "ok": mode == expected}

        return {
            "directory": inspect(self.directory, 0o700),
            "files": {name: inspect(os.path.join(self.directory, name), 0o600)
                      for name in ("cockpit.db", "cockpit.db-wal", "cockpit.db-shm")},
        }


def capture_mode(db) -> str:
    row = db.execute("SELECT value FROM config WHERE key='capture_mode'").fetchone()
    if row is None:
        raise unavailable("В базе Cockpit отсутствует настройка захвата.")
    return row[0]


def configure_capture_mode(mode: str | None = None) -> dict:
    if mode == "redacted":
        raise CockpitError("NOT_IMPLEMENTED", "Режим redacted не реализован в M1.")
    if mode is not None and mode not in ("full-local", "off"):
        raise CockpitError("INVALID_REQUEST", "Допустимые режимы: full-local, redacted, off.")
    try:
        with Store() as store:
            db = store.connection
            if mode is not None:
                db.execute("BEGIN IMMEDIATE")
                db.execute("UPDATE config SET value=?,provenance='cli' WHERE key='capture_mode'", (mode,))
                db.execute("COMMIT")
            return {"captureMode": capture_mode(db),
                    "provenance": db.execute("SELECT provenance FROM config WHERE key='capture_mode'").fetchone()[0]}
    except (OSError, sqlite3.Error) as exc:
        raise unavailable() from exc

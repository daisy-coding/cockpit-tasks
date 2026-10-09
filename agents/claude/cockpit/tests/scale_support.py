"""Большие наборы задач только в одноразовом хранилище теста."""

import sqlite3
from agents.claude.cockpit import domain


def seed_tasks(state, binding, count, *, worst=False, status="active", start=1):
    timestamp = domain.now()
    rows = []
    for number in range(start, start + count):
        prefix = f"Проверить обмен данными и восстановление очереди проекта, этап {number}: "
        length = 300 if worst else 60 + number % 61
        title = (prefix + "согласовать результат проверки с владельцем " * 8)[:length]
        description = ("Проверить сохранение поручений, порядок очереди и повторное чтение после перезагрузки. " * 60)[:4000 if worst else 300 + number % 301]
        rows.append((f"scale-{number}", binding["projectId"], binding["worktreeId"], number,
                     title, status, timestamp, timestamp, description, number))
    with sqlite3.connect(state / "cockpit.db") as db:
        db.executemany("""INSERT INTO tasks(task_id,project_id,worktree_id,alias_no,origin,title,status,
            created_at,updated_at,description,queue_position,certainty,certainty_source,certainty_provenance)
            VALUES (?,?,?,?,'no-source',?,?,?,?,?,?,'inferred','agent','tool')""", rows)
        db.executemany("INSERT INTO task_steps VALUES (?,0,'Проверить сохранение и повторное чтение','pending')",
                       [(row[0],) for row in rows])
    return [row[0] for row in rows]

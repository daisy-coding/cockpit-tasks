#!/usr/bin/env python3
"""Приоритет нужных строк под пределом: настоящий RPC и одноразовая БД."""

from datetime import datetime, timedelta, timezone
import sqlite3
import unittest
from unittest.mock import patch

from support import Harness
from agents.claude.cockpit import domain


class LimitedListTests(Harness):
    def setUp(self):
        super().setUp()
        self.binding = self.ok("snapshot")["binding"]
        self.base = datetime.now(timezone.utc) - timedelta(hours=4)

    def timestamp(self, minutes):
        return (self.base + timedelta(minutes=minutes)).isoformat(timespec="microseconds").replace("+00:00", "Z")

    def create(self, db, title, status="active", priority=2, position=0, stage="task"):
        task_id = domain.create_task(db, self.binding, title, certainty="confirmed",
                                     certainty_source="user", provenance="panel", stage=stage)
        db.execute("UPDATE tasks SET status=?,priority=?,queue_position=? WHERE task_id=?",
                   (status, priority, position, task_id))
        return task_id

    def history(self, db):
        ids = []
        for index in range(105):
            task_id = self.create(db, f"Закрытая {index}", "done", priority=0)
            # Поздние правки описания не меняют дату закрытия.
            db.execute("UPDATE tasks SET updated_at=? WHERE task_id=?", (self.timestamp(210 - index), task_id))
            db.execute("INSERT INTO task_closures VALUES (?,?)", (task_id, self.timestamp(index)))
            ids.append(task_id)
        cancelled = self.create(db, "Недавно отменённая", "cancelled", priority=0)
        db.execute("UPDATE tasks SET updated_at=? WHERE task_id=?", (self.timestamp(103.5), cancelled))
        return [ids[-1], cancelled, *reversed(ids[:-1])]

    def overflowing_tasks(self):
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            closed = self.history(db)
            waiting = self.create(db, "Ждущая решения", priority=0, position=1)
            detour = self.create(db, "Приостановленный отход", priority=0, position=2)
            paused = self.create(db, "Приостановленная", "paused", priority=1, position=3)
            backlog = self.create(db, "Бэклог", "paused", priority=2, position=4)
            later = self.create(db, "Позднее в очереди", priority=0, position=30)
            first = self.create(db, "Первая в очереди", priority=0, position=10)
            second = self.create(db, "Вторая в очереди", priority=1, position=1)
            current = self.create(db, "Текущая", priority=3, position=999)
            domain.set_focus(db, self.binding, current)
            db.execute("INSERT INTO focus_stack VALUES (?,?,?,?,?,'user',?,'panel')",
                       (self.binding["worktreeId"], self.binding["projectId"], 1, detour,
                        self.binding["sessionId"], self.timestamp(0)))
            hidden = self.create(db, "Удалённая", priority=0)
            db.execute("UPDATE tasks SET deleted=1 WHERE task_id=?", (hidden,))
            self.create(db, "Предложение", priority=0, stage="candidate")
            domain.create_task(db, self.binding, "Служебная заглушка")
        source = self.ok("capture.prompt", {"text": "Нужен выбор варианта"})["inboxId"]
        revision = self.ok("inbox.get", {"inboxId": source})["triageRevision"]
        self.ok("inbox.triage", {"inboxId": source, "expectedRevision": revision,
                                  "type": "decision", "taskId": waiting, "status": "untriaged"})
        return [current, first, later, second, waiting, detour, paused, backlog], closed

    def task_ids(self, limit):
        return [row["taskId"] for row in self.ok("snapshot", {"limits": {"tasks": limit, "inbox": 0}})["tasks"]]

    def test_snapshot_preserves_every_open_task_before_recent_history(self):
        opened, closed = self.overflowing_tasks()
        snapshot = self.ok("snapshot", {"limits": {"tasks": 100, "inbox": 0}})
        self.assertEqual(sum(row["status"] in ("active", "paused") for row in snapshot["tasks"]), len(opened),
                         "Закрытая история не должна вытеснять открытые задачи")
        self.assertEqual([row["taskId"] for row in snapshot["tasks"]], opened + closed[:100 - len(opened)])
        self.assertTrue(next(row for row in snapshot["tasks"] if row["taskId"] == opened[4])["needsDecision"])
        card = self.ok("task.get", {"taskId": opened[0]})["task"]
        self.assertEqual(snapshot["tasks"][0], {key: value for key, value in card.items()
                                              if key not in ("description", "acceptance", "constraints")})
        self.assertEqual(self.rows("PRAGMA foreign_key_check"), [])

    def test_cli_tasks_uses_the_same_order_under_the_limit(self):
        opened, closed = self.overflowing_tasks()
        result = self.human("tasks", "--limit", "100")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertEqual([line.split()[1] for line in result.stdout.decode().splitlines()],
                         opened + closed[:100 - len(opened)])

    def test_small_and_zero_limits_take_a_prefix_of_the_same_task_order(self):
        opened, _ = self.overflowing_tasks()
        for limit in (0, 1, 3, len(opened) - 1, len(opened)):
            with self.subTest(limit=limit):
                self.assertEqual(self.task_ids(limit), opened[:limit])

    def test_all_thirty_open_tasks_fit_before_a_long_history(self):
        with sqlite3.connect(self.state / "cockpit.db") as db:
            closed = self.history(db)
            opened = [self.create(db, f"Открытая {index}", priority=3, position=index) for index in range(30)]
        self.assertEqual(self.task_ids(100), opened + closed[:70])

    def test_inbox_preserves_untriaged_before_newer_processed_captures(self):
        pending = [self.ok("capture.prompt", {"text": f"Неразобранная {index}"})["inboxId"] for index in range(3)]
        processed = []
        for index in range(5):
            source = self.ok("capture.prompt", {"text": f"Разобранная {index}"})["inboxId"]
            revision = self.ok("inbox.get", {"inboxId": source})["triageRevision"]
            self.ok("inbox.triage", {"inboxId": source, "expectedRevision": revision,
                                      "status": "triaged" if index % 2 else "rejected"})
            processed.append(source)
        ordered = [*reversed(pending), *reversed(processed)]
        for limit in (0, 1, 3, 5, 100):
            with self.subTest(limit=limit):
                snapshot = self.ok("snapshot", {"limits": {"tasks": 0, "inbox": limit}})
                self.assertEqual([row["inboxId"] for row in snapshot["inbox"]], ordered[:limit])
                self.assertEqual(snapshot["inboxCounts"], {"total": 8, "untriaged": 3})
        result = self.human("inbox", "--limit", "5")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([line.split()[0] for line in result.stdout.decode().splitlines()[1:]], ordered[:5])

    def test_candidates_filter_handled_and_expired_before_the_limit(self):
        with sqlite3.connect(self.state / "cockpit.db") as db:
            eligible = [self.create(db, f"Кандидат {index}", stage="candidate") for index in range(7)]
            for index in range(6):
                task_id = self.create(db, f"Отклонённый {index}", stage="candidate")
                db.execute("UPDATE tasks SET dismiss_reason='answered',dismissed_at=? WHERE task_id=?",
                           (self.timestamp(0), task_id))
            expired = self.create(db, "Истёкший кандидат", stage="candidate")
            db.execute("UPDATE tasks SET created_at='2000-01-01T00:00:00.000000Z' WHERE task_id=?", (expired,))
        snapshot = self.ok("snapshot", {"limits": {"tasks": 0, "inbox": 0}})
        self.assertEqual([row["taskId"] for row in snapshot["candidates"]], list(reversed(eligible))[:5])
        self.assertEqual(snapshot["candidateCount"], len(eligible))

    def test_context_limits_each_category_after_filtering_and_orders_recent_closures(self):
        with sqlite3.connect(self.state / "cockpit.db") as db:
            closed = self.history(db)
            # Поздняя правка давно закрытой задачи не возвращает её в окно суток.
            stale = self.create(db, "Давно закрытая", "done")
            db.execute("INSERT INTO task_closures VALUES (?,'2000-01-01T00:00:00.000000Z')", (stale,))
            paused = [self.create(db, f"Отложенная {index}", "paused", priority=0, position=index) for index in range(12)]
            queued = [self.create(db, f"Очередь {index}", priority=1, position=index) for index in range(17)]
            current = self.create(db, "Текущая", priority=3)
            db.row_factory = sqlite3.Row
            domain.set_focus(db, self.binding, current)
        context = self.ok("tasks.context")
        self.assertEqual(context["current"]["taskId"], current)
        self.assertEqual([row["taskId"] for row in context["queue"]], queued)
        self.assertEqual([row["taskId"] for row in context["deferred"]], paused[:10])
        self.assertEqual([row["taskId"] for row in context["closed"]], [item for item in closed if item != closed[1]][:10])
        self.assertEqual((context["counts"]["open"], context["counts"]["closedLast24h"]), (30, 105))

    def test_checkpoint_list_selects_latest_writes_even_if_the_clock_moves_back(self):
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            task_id = self.create(db, "Поручение")
            # Порядок durable-записи сохраняется при откате часов.
            ids = []
            for index in range(7):
                with patch.object(domain, "now", return_value=self.timestamp(7 - index)):
                    ids.append(domain.add_checkpoint(db, self.binding, task_id, "note", f"Отметка {index}")["checkpointId"])
        for limit in (0, 1, 3):
            with self.subTest(limit=limit):
                result = self.ok("checkpoint.list", {"taskId": task_id, "limit": limit})
                self.assertEqual([row["checkpointId"] for row in result["checkpoints"]], list(reversed(ids))[:limit])

    def test_owner_comments_keep_recent_hundred_in_chronological_display_order(self):
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            task_id = self.create(db, "Поручение с обсуждением")
            domain.set_focus(db, self.binding, task_id)
            for index in range(105):
                db.execute("INSERT INTO task_owner_comments VALUES (?,?,?,?,?,?,?,?,0,0)",
                           (f"comment-{index}", task_id, self.binding["projectId"], self.binding["worktreeId"],
                            self.binding["sessionId"], f"Дополнение {index}", self.timestamp(index), self.timestamp(index)))
            # Удалённый комментарий не занимает место в окне.
            db.execute("UPDATE task_owner_comments SET deleted=1 WHERE comment_id='comment-103'")
        expected = [f"comment-{index}" for index in range(4, 105) if index != 103]
        card = self.ok("task.get", {"taskId": task_id})
        context = self.ok("tasks.context")
        self.assertEqual([row["commentId"] for row in card["comments"]], expected)
        self.assertEqual([row["commentId"] for row in context["current"]["ownerComments"]], expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)

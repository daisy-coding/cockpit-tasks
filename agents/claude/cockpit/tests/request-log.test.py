#!/usr/bin/env python3
"""Повторы ответов и ограниченная уборка только в одноразовой базе."""

import json
import sqlite3
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from agent_support import AgentHarness
from agents.claude.cockpit import domain, rpc


class RequestLogTests(AgentHarness):
    def seed_requests(self, count, timestamp, prefix="expired"):
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.executemany("INSERT INTO requests VALUES (?,?,?,?)",
                [(f"{prefix}-{index}", "a" * 64, json.dumps({"v": 1, "ok": True, "result": {}}),
                  timestamp) for index in range(count)])

    def test_pure_doctor_is_recomputed_without_request_row_or_cleanup(self):
        self.seed_requests(3, "2000-01-01T00:00:00.000000Z")
        request = self.request("doctor", key="pure-doctor")
        before = self.rows("SELECT * FROM requests")
        first = self.invoke(request)
        self.assertTrue(first["ok"], first)
        self.assertEqual(self.rows("SELECT * FROM requests"), before)
        self.ok("capture.prompt", {"text": "Новое указание"})
        second = self.invoke(request)
        self.assertGreater(second["result"]["counts"]["inbox"], first["result"]["counts"]["inbox"])
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id='pure-doctor'"), [])

    def test_write_replay_within_day_is_identical_and_does_not_cleanup(self):
        request = self.request("capture.prompt", {"text": "Записать один раз"}, key="write-replay")
        first = self.invoke(request)
        self.seed_requests(201, "2000-01-01T00:00:00.000000Z")
        before = self.rows("SELECT * FROM requests")
        self.assertEqual(self.invoke(request), first)
        self.assertEqual(self.rows("SELECT * FROM requests"), before)
        self.assertEqual(len(self.rows("SELECT * FROM inbox")), 1)

    def test_cleanup_is_at_most_two_hundred_and_keeps_fresh_rows(self):
        self.seed_requests(405, "2000-01-01T00:00:00.000000Z")
        self.seed_requests(3, domain.now(), "fresh")
        fresh = self.rows("SELECT * FROM requests WHERE request_id LIKE 'fresh-%'")
        for remaining in (205, 5, 0):
            self.ok("capture.prompt", {"text": "Уборка порцией"})
            self.assertEqual(len(self.rows("SELECT * FROM requests WHERE request_id LIKE 'expired-%'")), remaining)
            self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id LIKE 'fresh-%'"), fresh)

    def test_cleanup_walks_the_head_of_the_log_and_stops_at_fresh_rows(self):
        # Несколько свежих строк в голове (записаны при переведённых часах) уборку не останавливают.
        self.seed_requests(5, domain.now(), "head")
        self.seed_requests(10, "2000-01-01T00:00:00.000000Z")
        self.ok("capture.prompt", {"text": "Уборка за свежей головой"})
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id LIKE 'expired-%'"), [])
        self.assertEqual(len(self.rows("SELECT * FROM requests WHERE request_id LIKE 'head-%'")), 5)
        # Дальше восьми свежих строк подряд уборка журнал не читает: иначе каждая запись проходила бы его целиком.
        self.seed_requests(20, domain.now(), "wall")
        self.seed_requests(10, "2000-01-01T00:00:00.000000Z", "behind")
        self.ok("capture.prompt", {"text": "Свежая стена"})
        self.assertEqual(len(self.rows("SELECT * FROM requests WHERE request_id LIKE 'behind-%'")), 10)

    def test_cleanup_cutoff_is_strictly_older_than_one_day(self):
        timestamp = "2026-10-07T12:00:00.000000Z"
        cutoff = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
        self.seed_requests(1, (cutoff - timedelta(microseconds=1)).isoformat().replace("+00:00", "Z"), "older")
        self.seed_requests(1, cutoff.isoformat(timespec="microseconds").replace("+00:00", "Z"), "boundary")
        self.seed_requests(1, (cutoff + timedelta(microseconds=1)).isoformat().replace("+00:00", "Z"), "newer")
        from agents.claude.cockpit import rpc
        with patch.object(rpc.domain, "now", return_value=timestamp), patch.dict("os.environ", self.env, clear=True):
            response = rpc.handle(self.request("capture.prompt", {"text": "Проверить сутки"}))
        self.assertTrue(response["ok"], response)
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id='older-0'"), [])
        self.assertEqual(len(self.rows("SELECT * FROM requests WHERE request_id IN ('boundary-0','newer-0')")), 2)

    def test_attested_doctor_keeps_replay_and_usage_write(self):
        request = {**self.request("doctor", key="signed-doctor"), "panelSecret": self.secret, "actor": "owner"}
        first = self.invoke(request)
        self.assertTrue(first["ok"], first)
        self.assertEqual(self.invoke(request), first)
        self.assertEqual(len(self.rows("SELECT * FROM requests WHERE request_id='signed-doctor'")), 1)

    def view_operations(self):
        card = self.owner_task()
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET active_since=NULL")
        inbox = self.ok("capture.prompt", {"text": "Исходник для чтений"})
        return (("focus.get", {}), ("task.get", {"taskId": card["taskId"]}),
            ("snapshot", {}), ("inbox.get", {"inboxId": inbox["inboxId"]}),
            ("inbox.material", {"inboxId": inbox["inboxId"]}),
            ("checkpoint.list", {"taskId": card["taskId"]}), ("gate.stats", {}),
            ("gate.recent", {}), ("config.get", {"key": "gate"}),
            ("tasks.page", {"list": "queue", "offset": 0, "limit": 20}),
            ("task.resolve", {"alias": card["alias"]}), ("tasks.search", {"query": "поручение"}))

    def test_views_register_and_refresh_sessions_without_request_rows_or_domain_writes(self):
        operations = self.view_operations()
        self.seed_requests(3, "2000-01-01T00:00:00.000000Z")
        tables = [row["name"] for row in self.rows("SELECT name FROM sqlite_master WHERE type='table'")
                  if row["name"] not in ("sessions", "attestation_usage")]
        before = {name: self.rows(f'SELECT * FROM "{name}"') for name in tables}
        for op, args in operations:
            with self.subTest(op=op):
                request = self.request(op, args, session=f"reading-{op}")
                first = self.invoke(request)
                self.assertTrue(first["ok"], first)
                self.assertEqual(len(self.rows("SELECT * FROM sessions WHERE session_id=?", (request["session"]["sessionId"],))), 1)
                self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id=?", (request["requestId"],)), [])
                with sqlite3.connect(self.state / "cockpit.db") as db:
                    db.execute("UPDATE sessions SET last_seen_at='2000-01-01T00:00:00.000000Z' WHERE session_id=?",
                               (request["session"]["sessionId"],))
                self.assertEqual(self.invoke(request), first)
                self.assertNotEqual(self.rows("SELECT last_seen_at FROM sessions WHERE session_id=?",
                    (request["session"]["sessionId"],))[0]["last_seen_at"], "2000-01-01T00:00:00.000000Z")
                for name in tables:
                    self.assertEqual(self.rows(f'SELECT * FROM "{name}"'), before[name], name)

    def test_attested_views_recheck_proof_and_refresh_usage_on_each_repeat(self):
        for op, args in self.view_operations():
            with self.subTest(op=op):
                request = {**self.request(op, args), "panelSecret": self.secret, "actor": "owner"}
                first = self.invoke(request)
                self.assertTrue(first["ok"], first)
                previous_usage = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(
                    timespec="microseconds").replace("+00:00", "Z")
                with sqlite3.connect(self.state / "cockpit.db") as db:
                    db.execute("UPDATE attestation_usage SET last_used_at=?", (previous_usage,))
                self.assertEqual(self.invoke(request), first)
                self.assertTrue(all(row["last_used_at"] != previous_usage
                                    for row in self.rows("SELECT last_used_at FROM attestation_usage")))
                self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id=?", (request["requestId"],)), [])
                self.error(self.invoke({**request, "panelSecret": "0" * 64}), "ATTESTATION_FAILED")

    def test_legacy_view_rows_are_ignored_but_preserved(self):
        for op, args in self.view_operations():
            with self.subTest(op=op):
                for signed in (False, True):
                    request = self.request(op, args)
                    if signed:
                        request.update(panelSecret=self.secret, actor="owner")
                    expected = self.invoke(request)
                    self.assertTrue(expected["ok"], expected)
                    with sqlite3.connect(self.state / "cockpit.db") as db:
                        db.execute("INSERT OR REPLACE INTO requests VALUES (?,?,?,?)", (request["requestId"],
                            rpc.request_digest(request), '{"v":1,"ok":true,"result":{"stale":true}}', domain.now()))
                    before = self.rows("SELECT * FROM requests")
                    self.assertEqual(self.invoke(request), expected)
                    self.assertEqual(self.rows("SELECT * FROM requests"), before)

    def test_saved_write_key_conflicts_with_every_view_body(self):
        for op, args in self.view_operations():
            with self.subTest(op=op):
                for signed in (False, True):
                    written = self.request("capture.prompt", {"text": "Сохранённая запись"})
                    if signed:
                        written.update(panelSecret=self.secret, actor="owner")
                    self.assertTrue(self.invoke(written)["ok"])
                    before = self.rows("SELECT * FROM requests")
                    view = {**written, "op": op, "args": args}
                    self.error(self.invoke(view), "IDEMPOTENCY_CONFLICT")
                    self.assertEqual(self.rows("SELECT * FROM requests"), before)

    def test_view_failure_and_key_reuse_do_not_reserve_request_id(self):
        request = self.request("task.resolve", {"alias": "TASK-1"}, key="retry-view")
        self.error(self.invoke(request), "NOT_FOUND")
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id='retry-view'"), [])
        card = self.owner_task()
        self.assertEqual(self.invoke(request)["result"]["taskId"], card["taskId"])
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id='retry-view'"), [])
        written = self.request("capture.prompt", {"text": "Ключ теперь занят записью"}, key="retry-view")
        first = self.invoke(written)
        self.assertEqual(self.invoke(written), first)
        self.error(self.invoke(request), "IDEMPOTENCY_CONFLICT")

    def test_context_repeat_keeps_prior_state_and_cursor_in_the_log(self):
        self.owner_task()
        request = self.request("tasks.context", session="reading-context")
        first = self.invoke(request)
        self.assertTrue(first["ok"], first)
        self.owner_task("Новая задача владельца")
        before = self.rows("SELECT * FROM sessions WHERE session_id='reading-context'")
        self.assertEqual(self.invoke(request), first)
        self.assertEqual(self.rows("SELECT * FROM sessions WHERE session_id='reading-context'"), before)
        self.assertEqual(len(self.rows("SELECT * FROM requests WHERE request_id=?", (request["requestId"],))), 1)
        current = self.ok("tasks.context", session="reading-context")
        self.assertGreater(current["counts"]["open"], first["result"]["counts"]["open"])
        self.assertGreater(current["cursor"], first["result"]["cursor"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

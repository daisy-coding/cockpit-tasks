#!/usr/bin/env python3
"""Наблюдающий страж, аренды, приватность и атомарность на настоящем рантайме."""

import hashlib
import json
import os
import secrets
import sqlite3
import subprocess
import sys
import unittest
from unittest.mock import patch

from support import CLI, Harness
from agents.claude.cockpit import domain, rpc
from agents.claude.cockpit.identity import Identity
from agents.claude.cockpit.store import Store


class GateTests(Harness):
    def test_task_bind_uses_the_same_observation_lease_and_replay_path(self):
        self.observe()
        request = self.request("task.bind", {"resourcePath": str(self.cwd / "file.ts"), "staleRead": True})
        first = self.invoke(request)
        self.assertTrue(first["ok"], first)
        result = first["result"]
        self.assertEqual(result["observation"]["reasons"], ["stale-read"])
        before = self.rows("SELECT * FROM worktree_leases")
        self.assertEqual(len(before), 1)
        self.assertEqual(self.invoke(request), first)
        self.assertEqual(self.rows("SELECT * FROM worktree_leases"), before)
        self.assertEqual(len(self.rows("SELECT * FROM gate_observations")), 1)
        foreign = self.ok("task.bind", {"resourcePath": str(self.cwd / "file.ts")}, session="foreign")
        self.assertEqual(foreign["observation"]["reasons"], ["foreign-lease"])
        self.assertEqual(self.rows("SELECT * FROM worktree_leases"), before)
        self.assertEqual(len(self.rows("SELECT * FROM gate_observations")), 2)

    def test_session_end_is_scoped_to_the_registered_worktree(self):
        linked = self.linked_worktrees()
        self.observe()
        self.check()
        self.check(cwd=linked, path=linked / "file.ts")
        self.assertEqual(self.ok("session.end")["released"], 1)
        self.assertEqual(len(self.rows("SELECT * FROM worktree_leases")), 1)
        self.assertEqual(self.ok("session.end", cwd=linked)["released"], 1)

    def test_legacy_bind_without_a_path_cannot_hide_a_resource_only_blocker(self):
        self.observe()
        self.ok("task.bind")
        resource_id = "path-" + hashlib.sha256(os.path.realpath(self.cwd / "file.ts").encode()).hexdigest()
        self.item("blocking", resource_id=resource_id)
        self.assertEqual(self.ok("task.bind")["observation"]["reasons"], ["blocking-inbox"])
        self.assertEqual(self.check()["observation"]["reasons"], ["blocking-inbox"])
        self.assertEqual(self.check(path=self.cwd / "unrelated.ts")["observation"]["outcome"], "ALLOW")

    def resolve(self, entry, status):
        if not hasattr(self, "panel_secret"):
            self.panel_secret = secrets.token_hex(32)
            registration = self.request("session.attest")
            registration["panelSecret"] = self.panel_secret
            self.assertTrue(self.invoke(registration)["ok"])
        request = self.request("inbox.triage", {"inboxId": entry["inboxId"],
                               "expectedRevision": entry["triageRevision"], "status": status})
        request["panelSecret"] = self.panel_secret
        response = self.invoke(request)
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"]["triageProvenance"], "panel")

    def observe(self, cwd=None, seed=True):
        if seed:
            self.task_fixture(cwd=cwd, bind_result=False)
        result = self.human("--cwd", str(cwd or self.cwd), "config", "set", "gate", "observe")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("observe", result.stdout.decode())
        if not hasattr(self, "panel_secret"):
            self.panel_secret = secrets.token_hex(32)
            registration = self.request("session.attest", cwd=cwd)
            registration["panelSecret"] = self.panel_secret
            self.assertTrue(self.invoke(registration)["ok"])

    def check(self, session="session-1", path=None, stale=False, **kwargs):
        return self.ok("gate.check", {"resourcePath": str(path or self.cwd / "file.ts"), "staleRead": stale},
                       session=session, **kwargs)

    def at(self, timestamp, session="session-1"):
        project = self.rows("""SELECT p.identity_kind,p.canonical_path FROM projects p
            JOIN worktrees w ON w.project_id=p.project_id WHERE w.local_path=?""", (str(self.cwd),))[0]
        resolved = Identity(project["identity_kind"], project["canonical_path"], str(self.cwd))
        with patch("agents.claude.cockpit.store.state_directory", return_value=str(self.state)), \
                patch("agents.claude.cockpit.domain.now", return_value=timestamp), \
                patch("agents.claude.cockpit.rpc.identity.resolve", return_value=resolved):
            response = rpc.handle(self.request("gate.check", {"resourcePath": str(self.cwd / "file.ts")}, session=session))
        self.assertTrue(response["ok"], response)
        return response["result"]

    def item(self, kind, task_id=None, resource_id=None, status="untriaged"):
        inbox_id = self.ok("capture.prompt", {"text": "Указание без влияния на фокус"})["inboxId"]
        return self.ok("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 1, "type": kind,
                                       "taskId": task_id, "resourceId": resource_id, "status": status})

    def test_default_off_keeps_bind_contract_and_has_no_observations_or_leases(self):
        self.assertEqual(self.ok("snapshot")["gate"]["mode"], "off")
        self.ok("capture.prompt", {"text": "Прежняя автозадача"})
        bound = self.ok("task.bind")
        self.assertEqual(set(bound), {"bound", "task", "focusRevision"})
        self.assertEqual(bound["bound"], "unbound")
        self.assertIsNone(bound["task"])
        self.assertEqual(self.ok("task.bind"), bound)
        checked = self.check(stale=True)
        self.assertIsNone(checked["observation"])
        self.assertEqual(checked["gate"]["mode"], "off")
        self.assertEqual({key: checked[key] for key in bound}, bound)
        self.assertEqual(self.rows("SELECT * FROM tasks"), [])
        self.assertEqual(self.rows("SELECT * FROM gate_observations"), [])
        self.assertEqual(self.rows("SELECT * FROM worktree_leases"), [])

    def test_bind_allow_and_legacy_bind_do_not_change_certainty_or_source(self):
        self.observe(seed=False)
        source = self.ok("capture.prompt", {"text": "Причина правки 🐋"})
        self.task_fixture(bind_result=False)
        first = self.check()
        self.assertEqual(first["bound"], "existing")
        self.assertEqual(first["observation"]["outcome"], "BIND")
        self.assertEqual(first["observation"]["reasons"], [])
        self.assertEqual(first["task"]["source"]["inboxId"], source["inboxId"])
        self.assertEqual((first["task"]["certainty"], first["task"]["certaintySource"]), ("observed", "engine"))
        second = self.check()
        self.assertEqual(second["observation"]["outcome"], "ALLOW")
        self.assertEqual(second["gate"]["counts"], {"ALLOW": 1, "BIND": 1, "BLOCK": 0})
        self.assertEqual(second["task"], first["task"])
        legacy = self.ok("task.bind")
        self.assertEqual({key: legacy[key] for key in ("bound", "task", "focusRevision")},
                         {"bound": "existing", "task": first["task"], "focusRevision": first["focusRevision"]})
        self.assertEqual(legacy["observation"]["outcome"], "ALLOW")
        self.assertEqual(len(self.rows("SELECT * FROM gate_observations")), 3)
        self.assertEqual(self.ok("snapshot")["gate"], legacy["gate"])

    def test_stale_read_is_explicit_and_absent_without_prior_read(self):
        self.observe()
        self.assertEqual(self.check(stale=True)["observation"]["reasons"], ["stale-read"])
        self.assertEqual(self.check()["observation"]["outcome"], "ALLOW")
        self.assertEqual(self.ok("gate.stats")["blockReasons"]["stale-read"], 1)

    def test_lease_acquisition_renewal_foreign_owner_and_idle_expiry(self):
        self.observe()
        first = self.at("2026-10-04T00:00:00.000000Z")
        self.assertEqual(first["observation"]["outcome"], "BIND")
        lease = self.rows("SELECT * FROM worktree_leases")[0]
        self.assertEqual(domain.LEASE_IDLE_SECONDS, 900)
        self.assertEqual(lease["expires_at"], "2026-10-04T00:15:00.000000Z")
        self.at("2026-10-04T00:07:00.000000Z")
        renewed = self.rows("SELECT * FROM worktree_leases")[0]
        self.assertEqual(renewed["acquired_at"], lease["acquired_at"])
        self.assertEqual(renewed["renewed_at"], "2026-10-04T00:07:00.000000Z")
        self.assertEqual(renewed["expires_at"], "2026-10-04T00:22:00.000000Z")
        foreign = self.at("2026-10-04T00:20:00.000000Z", "session-2")
        self.assertEqual(foreign["observation"]["reasons"], ["foreign-lease"])
        self.assertEqual(self.rows("SELECT * FROM worktree_leases"), [renewed])
        self.assertEqual(foreign["gate"]["counts"], {"ALLOW": 0, "BIND": 0, "BLOCK": 1})
        expired = self.at("2026-10-04T00:22:00.000000Z", "session-2")
        self.assertEqual(expired["observation"]["outcome"], "ALLOW")
        self.assertEqual(self.rows("SELECT * FROM worktree_leases")[0]["session_id"], "session-2")

    def test_session_end_releases_only_own_leases_and_is_idempotent(self):
        linked = self.linked_worktrees()
        self.observe()
        self.check()
        self.check(cwd=linked, path=linked / "other", session="session-2")
        request = self.request("session.end")
        first = self.invoke(request)
        self.assertEqual(first["result"], {"released": 1})
        self.assertEqual(self.invoke(request), first)
        leases = self.rows("SELECT * FROM worktree_leases")
        self.assertEqual(len(leases), 1)
        self.assertEqual(leases[0]["session_id"], "session-2")
        self.assertEqual(self.check(session="session-3")["observation"]["outcome"], "ALLOW")

    def test_parallel_sessions_acquire_exactly_one_lease(self):
        self.observe()
        processes = [subprocess.Popen([sys.executable, str(CLI), "rpc"], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=self.cwd, env=self.env)
                     for _ in range(2)]
        try:
            for index, process in enumerate(processes):
                request = self.request("gate.check", {"resourcePath": str(self.cwd / "file")}, session=f"parallel-{index}")
                process.stdin.write(json.dumps(request).encode())
                process.stdin.close()
                process.stdin = None
            results = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=8)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertEqual(stderr, b"")
                response = json.loads(stdout)
                self.assertTrue(response["ok"], response)
                results.append(response["result"])
            self.assertEqual(sorted(row["observation"]["outcome"] for row in results), ["BIND", "BLOCK"])
            winner = next(row["observation"]["sessionId"] for row in results if row["observation"]["outcome"] == "BIND")
            self.assertEqual(self.rows("SELECT session_id FROM worktree_leases"), [{"session_id": winner}])
            self.assertEqual(len(self.rows("SELECT * FROM tasks")), 1)
            self.assertEqual(len(self.rows("SELECT * FROM gate_observations")), 2)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_blocking_inbox_is_scoped_to_focus_or_canonical_resource(self):
        self.observe()
        task = self.check()["task"]
        resource_id = "path-" + hashlib.sha256(os.path.realpath(self.cwd / "file.ts").encode()).hexdigest()
        unrelated = self.item("blocking")
        self.assertEqual(self.check()["observation"]["outcome"], "ALLOW")
        resource = self.item("blocking", resource_id=resource_id)
        self.assertEqual(self.check()["observation"]["reasons"], ["blocking-inbox"])
        self.assertEqual(self.check(path=self.cwd / "different.ts")["observation"]["outcome"], "ALLOW")
        focused = self.item("blocking", task_id=task["taskId"])
        self.assertEqual(self.check(path=self.cwd / "different.ts")["observation"]["reasons"], ["blocking-inbox"])
        for entry in (unrelated, resource, focused):
            self.resolve(entry, "triaged")
        self.assertEqual(self.check()["observation"]["outcome"], "ALLOW")

    def test_pending_decision_requires_focus_and_untriaged_active_item(self):
        self.observe()
        task = self.check()["task"]
        for kind in ("decision", "approval"):
            with self.subTest(kind=kind):
                self.item(kind)
                self.assertEqual(self.check()["observation"]["outcome"], "ALLOW")
                item = self.item(kind, task_id=task["taskId"])
                self.assertEqual(self.check()["observation"]["reasons"], ["pending-decision"])
                self.resolve(item, "rejected")
                self.assertEqual(self.check()["observation"]["outcome"], "ALLOW")

    def test_foreign_task_items_other_kinds_and_shadow_do_not_block(self):
        self.observe()
        root = self.check()["task"]
        other = self.ok("focus.detour", {"expectedRevision": 1, "title": "Другая задача"})
        resource_id = "path-" + hashlib.sha256(os.path.realpath(self.cwd / "file.ts").encode()).hexdigest()
        for kind in ("blocking", "decision", "approval"):
            self.item(kind, task_id=other["focus"]["task"]["taskId"], resource_id=resource_id)
        self.ok("focus.return", {"expectedRevision": 2})
        for kind in ("info", "proposal", "question", "conflict"):
            self.item(kind, task_id=root["taskId"])
        inbox_id = self.ok("capture.prompt", {"text": "Классификация в shadow"})["inboxId"]
        with Store(str(self.state)) as store:
            store.connection.execute("""INSERT INTO inbox_observations
                (inbox_id,project_id,inbox_type,task_id,classified_by,policy_version,mode,created_at)
                VALUES (?,?,'blocking',?,'rule','fixture','shadow',?)""",
                                     (inbox_id, root["projectId"], root["taskId"], domain.now()))
        self.assertEqual(self.check()["observation"]["outcome"], "ALLOW")
        self.assertGreater(self.ok("snapshot")["inboxTriageCounts"]["blocking"], 0)

    def test_all_reasons_are_deduplicated_and_block_overrides_bind(self):
        self.observe()
        self.check()
        task = self.ok("focus.get")["task"]
        for _ in range(2):
            self.item("blocking", task_id=task["taskId"])
            self.item("decision", task_id=task["taskId"])
        checked = self.check(session="other", stale=True)
        self.assertEqual(checked["observation"]["reasons"], list(domain.GATE_REASONS))
        self.assertEqual(checked["gate"]["counts"]["BLOCK"], 1)
        self.assertEqual(checked["gate"]["blockReasons"], dict.fromkeys(domain.GATE_REASONS, 1))
        self.ok("task.update", {"taskId": task["taskId"], "expectedRevision": 0, "status": "done"})
        checked = self.check(session="other")
        self.assertEqual(checked["bound"], "unbound")
        self.assertIsNone(checked["task"])
        self.assertEqual(checked["observation"]["outcome"], "BLOCK")
        self.assertEqual(checked["observation"]["reasons"], ["foreign-lease"])

    def test_replay_does_not_renew_lease_or_append_observation(self):
        self.observe()
        request = self.request("gate.check", {"resourcePath": str(self.cwd / "file"), "staleRead": True})
        first = self.invoke(request)
        before = {name: self.rows(f"SELECT * FROM {name}") for name in
                  ("tasks", "focus", "worktree_leases", "gate_observations", "events", "requests")}
        self.assertEqual(self.invoke(request), first)
        for name, rows in before.items():
            self.assertEqual(self.rows(f"SELECT * FROM {name}"), rows)
        request["args"]["resourcePath"] = str(self.cwd / "another")
        self.error(self.invoke(request), "IDEMPOTENCY_CONFLICT")

    def test_gate_failure_rolls_back_bind_lease_journal_and_request(self):
        self.observe()
        before = {table: self.rows(f"SELECT * FROM {table}") for table in
                  ("tasks", "focus", "worktree_leases", "gate_observations", "events")}
        with Store(str(self.state)) as store:
            store.connection.execute("""CREATE TRIGGER fail_gate BEFORE INSERT ON gate_observations
                BEGIN SELECT RAISE(ABORT,'сбой журнала в фикстуре'); END""")
        request = self.request("gate.check", {"resourcePath": str(self.cwd / "file")})
        self.error(self.invoke(request), "DB_UNAVAILABLE")
        for table in ("tasks", "focus", "worktree_leases", "gate_observations", "events"):
            self.assertEqual(self.rows(f"SELECT * FROM {table}"), before[table])
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id=?", (request["requestId"],)), [])
        with Store(str(self.state)) as store:
            store.connection.execute("DROP TRIGGER fail_gate")
        self.assertTrue(self.invoke(request)["ok"])

    def test_paths_are_filtered_and_external_paths_are_hashes_only(self):
        self.observe()
        secret = "sk-" + "Q1w2E3r4T5" * 3
        path = self.cwd / ("имя\x1b[2J\u202e " + secret + ".ts")
        checked = self.check(path=path)
        output = json.dumps(checked, ensure_ascii=False)
        self.assertNotIn(secret, output)
        self.assertNotIn("\u202e", output)
        self.assertNotIn("\x1b", checked["observation"]["resource"]["path"])
        outside = self.root / "private" / "never-persist-absolute.ts"
        external = self.check(path=outside)["observation"]
        self.assertIsNone(external["resource"]["path"])
        self.assertEqual(external["resource"]["resourceId"], "path-" + hashlib.sha256(os.path.realpath(outside).encode()).hexdigest())
        recent = self.ok("gate.recent")["observations"]
        self.assertEqual(recent[0], external)
        self.assertNotIn(secret, json.dumps(recent))
        with sqlite3.connect(self.state / "cockpit.db") as db:
            dump = "\n".join(db.iterdump())
        db.close()
        self.assertNotIn(str(outside), dump)
        self.assertNotIn("never-persist-absolute", dump)

    def test_journal_is_immutable_and_reasons_form_a_closed_set(self):
        self.observe()
        self.check(stale=True)
        with Store(str(self.state)) as store:
            db = store.connection
            for sql in ("UPDATE gate_observations SET outcome='ALLOW'", "DELETE FROM gate_observations"):
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute(sql)
            for reasons in ('["unknown"]', '["stale-read","stale-read"]', '[null]', '[]'):
                with self.subTest(reasons=reasons), self.assertRaises(sqlite3.IntegrityError):
                    db.execute("""INSERT INTO gate_observations
                        (project_id,worktree_id,session_id,task_id,outcome,reasons_json,resource_id,resource_path,observed_at)
                        SELECT project_id,worktree_id,session_id,task_id,outcome,?,resource_id,resource_path,observed_at
                        FROM gate_observations LIMIT 1""", (reasons,))

    def test_project_flag_stats_recent_and_validation(self):
        linked = self.linked_worktrees()
        self.observe()
        self.assertEqual(self.ok("config.get", {"key": "gate"}, cwd=linked)["value"], "observe")
        foreign = self.root / "foreign"
        foreign.mkdir()
        self.assertEqual(self.ok("config.get", {"key": "gate"}, cwd=foreign)["value"], "off")
        self.at("2000-01-01T00:00:00.000000Z")
        self.check(cwd=linked, path=linked / "file", stale=True)
        self.assertEqual(self.ok("gate.stats")["counts"], {"ALLOW": 0, "BIND": 1, "BLOCK": 1})
        for checkout in (self.cwd, linked):
            self.assertEqual(self.ok("snapshot", cwd=checkout)["gate"]["counts"],
                             {"ALLOW": 0, "BIND": 1, "BLOCK": 1})
        self.assertEqual(self.ok("gate.stats", {"days": 1})["counts"], {"ALLOW": 0, "BIND": 0, "BLOCK": 1})
        self.assertEqual(len(self.ok("gate.recent", {"limit": 1})["observations"]), 1)
        self.assertEqual(self.ok("gate.recent", {"limit": 0})["observations"], [])
        self.assertEqual(self.ok("gate.stats", cwd=foreign)["counts"], dict.fromkeys(domain.GATE_OUTCOMES, 0))
        self.assertEqual(self.ok("snapshot", session="unused")["gate"]["counts"], dict.fromkeys(domain.GATE_OUTCOMES, 0))
        for op, args in (("config.set", {"key": "gate", "value": "enforce"}),
                         ("config.set", {"key": "gate", "value": True}), ("config.get", {"key": "unknown"}),
                         ("gate.check", {"resourcePath": "relative"}), ("gate.check", {"resourcePath": "/bad\x00"}),
                         ("gate.check", {"resourcePath": "/ok", "staleRead": 1}),
                         ("gate.stats", {"days": True}), ("gate.stats", {"days": 0}),
                         ("gate.recent", {"limit": -1}), ("gate.recent", {"limit": True})):
            with self.subTest(op=op, args=args):
                self.error(self.invoke(self.request(op, args)), "INVALID_REQUEST")
        self.assertEqual(self.human("config", "set", "gate", "enforce").returncode, 2)
        self.assertEqual(self.ok("config.get", {"key": "gate"})["value"], "observe")
        self.assertIn(b"BIND=1", self.human("gate", "stats").stdout)
        self.assertIn(b"BLOCK=1", self.human("gate", "stats", "--days", "1").stdout)
        self.assertIn(b"stale-read", self.human("gate", "recent", "--limit", "1").stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)

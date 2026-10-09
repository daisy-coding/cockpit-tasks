#!/usr/bin/env python3
"""Происхождение панели, повторы и отсутствие свидетельства в выводе и кэше."""

import hashlib
import json
import secrets
import sqlite3
import subprocess
import sys
import unittest
from unittest.mock import patch

from support import CLI, Harness
from agents.claude.cockpit import rpc


class AttestationTests(Harness):
    def test_registration_conflict_is_a_security_event_without_cached_denial(self):
        self.attest()
        before = self.rows("SELECT * FROM session_attestations")
        request = self.panel_request("session.attest", secret=secrets.token_hex(32))
        self.error(self.invoke(request), "ATTESTATION_CONFLICT")
        self.error(self.invoke(request), "ATTESTATION_CONFLICT")
        self.assertEqual(self.rows("SELECT * FROM session_attestations"), before)
        events = self.rows("SELECT * FROM events WHERE kind='security.attestation-conflict'")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["session_id"], "session-1")
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id=?", (request["requestId"],)), [])
        self.assertTrue(self.invoke({**request, "panelSecret": self.secret})["ok"])

    def test_invented_second_session_cannot_resolve_first_sessions_blockers(self):
        self.attest()
        self.panel("config.set", {"key": "gate", "value": "observe"})
        task = self.task_fixture()["task"]
        attacker_secret = secrets.token_hex(32)
        self.panel("session.attest", secret=attacker_secret, session="invented-session")
        for kind, reason in (("blocking", "blocking-inbox"), ("decision", "pending-decision"), ("approval", "pending-decision")):
            with self.subTest(kind=kind):
                inbox_id = self.ok("capture.prompt", {"text": "Требуется решение"})["inboxId"]
                item = self.panel("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 1,
                                                  "type": kind, "taskId": task["taskId"]})
                self.panel("inbox.triage", {"inboxId": inbox_id, "expectedRevision": item["triageRevision"],
                                            "status": "triaged"}, secret=attacker_secret, session="invented-session")
                result = self.ok("gate.check", {"resourcePath": str(self.cwd / "file.ts")})
                self.assertIn(reason, result["observation"]["reasons"])
                sibling = self.task_fixture( {"resourcePath": str(self.cwd / "file.ts")})
                self.assertIn(reason, sibling["observation"]["reasons"])
                self.assertEqual(self.ok("snapshot")["inbox"][0]["triageStatus"], "untriaged")
                self.panel("inbox.triage", {"inboxId": inbox_id, "expectedRevision": item["triageRevision"] + 1,
                                            "status": "triaged"})

    def test_registration_after_first_prompt_cannot_resolve_blocker(self):
        inbox_id = self.ok("capture.prompt", {"text": "Первая запись до регистрации"})["inboxId"]
        self.attest()
        self.panel("config.set", {"key": "gate", "value": "observe"})
        task = self.task_fixture()["task"]
        item = self.ok("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 1,
                                       "type": "blocking", "taskId": task["taskId"]})
        self.panel("inbox.triage", {"inboxId": inbox_id, "expectedRevision": item["triageRevision"], "status": "triaged"})
        self.assertIn("blocking-inbox", self.ok("gate.check", {"resourcePath": str(self.cwd / "file.ts")})["observation"]["reasons"])

    def test_partial_panel_triage_does_not_launder_cli_resolution(self):
        self.attest()
        self.panel("config.set", {"key": "gate", "value": "observe"})
        task = self.task_fixture()["task"]
        inbox_id = self.ok("capture.prompt", {"text": "Нужно решение"})["inboxId"]
        cli = self.ok("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 1,
                                      "type": "blocking", "taskId": task["taskId"], "status": "triaged"})
        panel = self.panel("inbox.triage", {"inboxId": inbox_id, "expectedRevision": cli["triageRevision"], "type": "blocking"})
        self.assertEqual(panel["triageStatus"], "untriaged")
        self.assertEqual(self.ok("gate.check", {"resourcePath": str(self.cwd / "file.ts")})["observation"]["reasons"], ["blocking-inbox"])

    def test_later_cli_row_cannot_replace_panel_or_inherit_its_resolution(self):
        self.attest()
        self.panel("config.set", {"key": "gate", "value": "observe"})
        task = self.task_fixture()["task"]
        inbox_id = self.ok("capture.prompt", {"text": "Проверить"})["inboxId"]
        panel = self.panel("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 1,
                                          "type": "blocking", "taskId": task["taskId"], "status": "triaged"})
        cli = self.ok("inbox.triage", {"inboxId": inbox_id, "expectedRevision": panel["triageRevision"], "type": "decision"})
        self.assertEqual((cli["provenance"], cli["triageStatus"]), ("cli", "untriaged"))
        current = self.ok("snapshot")["inbox"][0]
        self.assertEqual((current["type"], current["provenance"], current["triageStatus"]), ("blocking", "panel", "triaged"))
        self.assertEqual(current["triageRevision"], cli["triageRevision"])
        self.assertEqual(self.ok("gate.check", {"resourcePath": str(self.cwd / "file.ts")})["observation"]["outcome"], "ALLOW")

    def test_cli_cannot_switch_off_a_panel_attested_gate(self):
        self.attest()
        self.panel("config.set", {"key": "gate", "value": "observe"})
        request = self.request("config.set", {"key": "gate", "value": "off"})
        self.error(self.invoke(request), "ATTESTATION_FAILED")
        self.assertEqual(self.ok("config.get", {"key": "gate"})["value"], "observe")

    def panel_request(self, op, args=None, secret=None, **kwargs):
        request = self.request(op, args, **kwargs)
        request["panelSecret"] = secret or self.secret
        return request

    def attest(self, **kwargs):
        self.secret = secrets.token_hex(32)
        response = self.invoke(self.panel_request("session.attest", **kwargs))
        self.assertTrue(response["ok"], response)
        return response

    def panel(self, op, args=None, **kwargs):
        response = self.invoke(self.panel_request(op, args, **kwargs))
        self.assertTrue(response["ok"], response)
        return response["result"]

    def test_registration_same_secret_is_idempotent_and_other_secret_is_rejected(self):
        first = self.attest()
        self.assertEqual(self.panel("session.attest"), first["result"])
        rows = self.rows("SELECT * FROM session_attestations")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["secret_sha256"], hashlib.sha256(self.secret.encode()).hexdigest())
        self.assertTrue(rows[0]["created_at"])
        self.error(self.invoke(self.panel_request("session.attest", secret=secrets.token_hex(32))), "ATTESTATION_CONFLICT")
        self.assertEqual(self.rows("SELECT * FROM session_attestations"), rows)

    def test_parallel_first_registration_commits_exactly_one_witness(self):
        self.ok("snapshot")
        requests = [self.panel_request("session.attest", secret=secrets.token_hex(32)) for _ in range(2)]
        processes = [subprocess.Popen([sys.executable, str(CLI), "rpc"], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=self.cwd, env=self.env)
                     for _ in requests]
        try:
            for process, request in zip(processes, requests, strict=True):
                process.stdin.write(json.dumps(request).encode())
                process.stdin.close()
                process.stdin = None
            responses = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=8)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertEqual(stderr, b"")
                responses.append(json.loads(stdout))
            self.assertEqual(sum(response["ok"] for response in responses), 1)
            winner = next(request for request, response in zip(requests, responses, strict=True) if response["ok"])
            self.error(next(response for response in responses if not response["ok"]), "ATTESTATION_CONFLICT")
            self.assertEqual(self.rows("SELECT secret_sha256 FROM session_attestations"),
                             [{"secret_sha256": hashlib.sha256(winner["panelSecret"].encode()).hexdigest()}])
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

    def test_linked_worktree_does_not_inherit_witness_from_same_project(self):
        other = self.linked_worktrees()
        self.attest()
        task = self.task_fixture( cwd=other)["task"]
        request = self.panel_request("task.confirm", {"taskId": task["taskId"], "expectedRevision": 0}, cwd=other)
        self.error(self.invoke(request), "ATTESTATION_FAILED")
        self.panel("session.attest", cwd=other)
        self.assertTrue(self.invoke(request)["ok"])
        rows = self.rows("SELECT project_id,worktree_id FROM session_attestations")
        self.assertEqual(rows[0]["project_id"], rows[1]["project_id"])
        self.assertNotEqual(rows[0]["worktree_id"], rows[1]["worktree_id"])

    def test_absent_secret_is_cli_correct_is_panel_wrong_and_foreign_are_errors(self):
        self.attest()
        task = self.task_fixture()["task"]
        cli = self.ok("task.confirm", {"taskId": task["taskId"], "expectedRevision": 0})["task"]
        self.assertEqual(cli["certaintyProvenance"], "cli")
        args = {"taskId": task["taskId"], "expectedRevision": 1}
        for secret, session in ((secrets.token_hex(32), "session-1"), (self.secret, "foreign")):
            self.error(self.invoke(self.panel_request("task.confirm", args, secret=secret, session=session)), "ATTESTATION_FAILED")
        self.assertEqual(self.ok("focus.get")["task"], cli)
        panel = self.panel("task.confirm", args)["task"]
        self.assertEqual(panel["certaintyProvenance"], "panel")
        self.assertEqual(self.ok("snapshot")["tasks"][0]["certaintyProvenance"], "panel")

    def test_binding_cannot_be_rotated_by_rebind_reasons_or_end(self):
        self.attest()
        before = self.rows("SELECT * FROM session_attestations")
        other = secrets.token_hex(32)
        for reason in ("start", "resume", "clear", "compact"):
            self.ok("session.rebind", {"reason": reason})
            self.error(self.invoke(self.panel_request("session.attest", secret=other)), "ATTESTATION_CONFLICT")
        self.ok("session.end")
        self.error(self.invoke(self.panel_request("session.attest", secret=other)), "ATTESTATION_CONFLICT")
        self.assertEqual(self.rows("SELECT * FROM session_attestations"), before)
        self.ok("session.rebind", {"reason": "start"}, session="new-session")
        self.panel("session.attest", secret=other, session="new-session")
        other_cwd = self.root / "other-checkout"
        other_cwd.mkdir()
        self.ok("session.rebind", {"reason": "resume"}, cwd=other_cwd)
        self.panel("session.attest", secret=other, cwd=other_cwd)
        self.assertEqual(len(self.rows("SELECT * FROM session_attestations")), 3)
        self.error(self.invoke(self.panel_request("snapshot", cwd=other_cwd)), "ATTESTATION_FAILED")

    def test_authenticated_replay_checks_secret_before_cache_and_separates_cli(self):
        self.attest()
        task = self.task_fixture()["task"]
        request = self.panel_request("checkpoint.add", {
            "taskId": task["taskId"], "expectedRevision": 0, "kind": "note", "text": "Проверено",
        })
        first = self.invoke(request)
        self.assertTrue(first["ok"], first)
        before = self.rows("SELECT * FROM requests")
        self.assertEqual(self.invoke(request), first)
        self.assertEqual(self.rows("SELECT * FROM requests"), before)
        self.assertEqual(len(self.rows("SELECT * FROM checkpoints")), 1)
        self.error(self.invoke({**request, "panelSecret": secrets.token_hex(32)}), "ATTESTATION_FAILED")
        plain = {key: value for key, value in request.items() if key != "panelSecret"}
        self.error(self.invoke(plain), "IDEMPOTENCY_CONFLICT")
        plain["panelProof"] = True
        saved = next(row for row in before if row["request_id"] == request["requestId"])
        self.assertEqual(saved["request_sha256"], hashlib.sha256(rpc.canonical(plain).encode()).hexdigest())
        self.assertNotIn(self.secret, saved["response_json"])
        request["args"]["text"] = "Другой текст"
        self.error(self.invoke(request), "IDEMPOTENCY_CONFLICT")

    def test_invalid_proof_is_not_cached_and_cannot_poison_correct_retry(self):
        self.attest()
        task = self.task_fixture()["task"]
        request = self.panel_request("task.confirm", {"taskId": task["taskId"], "expectedRevision": 0})
        self.error(self.invoke({**request, "panelSecret": secrets.token_hex(32)}), "ATTESTATION_FAILED")
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id=?", (request["requestId"],)), [])
        self.assertTrue(self.invoke(request)["ok"])
        for secret in (None, "", "a" * 32, "g" * 64, 123, "a" * 65):
            request = self.request("session.attest")
            if secret is not None:
                request["panelSecret"] = secret
            self.error(self.invoke(request), "INVALID_REQUEST")

    def test_gate_resolves_blocking_decision_and_approval_only_with_panel(self):
        self.attest()
        self.panel("config.set", {"key": "gate", "value": "observe"})
        task = self.task_fixture()["task"]
        args = {"resourcePath": str(self.cwd / "file.ts")}
        for kind, reason in (("blocking", "blocking-inbox"), ("decision", "pending-decision"), ("approval", "pending-decision")):
            inbox_id = self.ok("capture.prompt", {"text": "Нужно решение"})["inboxId"]
            item = self.panel("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 1, "type": kind, "taskId": task["taskId"]})
            for status in ("triaged", "rejected"):
                item = self.ok("inbox.triage", {"inboxId": inbox_id, "expectedRevision": item["triageRevision"], "status": status})
                self.assertEqual(item["triageStatus"], status)
                self.assertEqual(item["triageProvenance"], "cli")
                self.assertEqual(self.ok("snapshot")["inboxCounts"]["untriaged"], 1)
                self.assertEqual(self.ok("gate.check", args)["observation"]["reasons"], [reason])
            item = self.panel("inbox.triage", {"inboxId": inbox_id, "expectedRevision": item["triageRevision"], "status": "triaged"})
            self.assertEqual(item["provenance"], "panel")
            self.assertEqual(self.ok("gate.check", args)["observation"]["outcome"], "ALLOW")

    def test_cli_triage_does_not_resolve_observed_blocker(self):
        self.ok("config.set", {"key": "gate", "value": "observe"})
        task = self.task_fixture()["task"]
        saved = self.ok("capture.prompt", {"text": "Блокирующий пункт"})
        self.ok("inbox.triage", {"inboxId": saved["inboxId"], "expectedRevision": 1,
                                 "type": "blocking", "taskId": task["taskId"]})
        args = {"resourcePath": str(self.cwd / "file.ts")}
        self.assertEqual(self.ok("gate.check", args)["observation"]["reasons"], ["blocking-inbox"])
        self.ok("inbox.triage", {"inboxId": saved["inboxId"], "expectedRevision": 2, "status": "triaged"})
        self.assertEqual(self.ok("snapshot")["inbox"][0]["triageStatus"], "triaged")
        self.assertEqual(self.ok("gate.check", args)["observation"]["reasons"], ["blocking-inbox"])

    def test_cli_cannot_hide_blocker_by_reclassification_or_scope(self):
        self.attest()
        self.ok("config.set", {"key": "gate", "value": "observe"})
        task = self.task_fixture()["task"]
        args = {"resourcePath": str(self.cwd / "file.ts")}
        for kind, reason in (("blocking", "blocking-inbox"), ("decision", "pending-decision"), ("approval", "pending-decision")):
            with self.subTest(kind=kind):
                inbox_id = self.ok("capture.prompt", {"text": "Нужно решение"})["inboxId"]
                item = self.ok("inbox.triage", {"inboxId": inbox_id, "expectedRevision": 1,
                                               "type": kind, "taskId": task["taskId"]})
                self.assertEqual(self.ok("gate.check", args)["observation"]["reasons"], [reason])
                for change in ({"taskId": None, "resourceId": None}, {"type": "info", "status": "triaged"}):
                    item = self.ok("inbox.triage", {"inboxId": inbox_id, "expectedRevision": item["triageRevision"], **change})
                    self.assertEqual(self.ok("gate.check", args)["observation"]["reasons"], [reason])
                self.assertEqual(self.ok("snapshot")["inbox"][0]["type"], "info")
                self.panel("inbox.triage", {"inboxId": inbox_id, "expectedRevision": item["triageRevision"], "status": "triaged"})
                self.assertEqual(self.ok("gate.check", args)["observation"]["outcome"], "ALLOW")

    def test_full_cycle_does_not_leak_secret_in_any_table_file_or_output(self):
        outputs = []
        requests = []
        run = subprocess.run

        def collect(*args, **kwargs):
            result = run(*args, **kwargs)
            outputs.extend((result.stdout, result.stderr))
            if kwargs.get("input") is not None:
                requests.append(json.loads(kwargs["input"]))
            return result

        with patch("subprocess.run", side_effect=collect):
            self.attest()
            task = self.task_fixture()["task"]
            self.panel("task.confirm", {"taskId": task["taskId"], "expectedRevision": 0})
            saved = self.ok("capture.prompt", {"text": "Входящее"})
            self.panel("inbox.triage", {"inboxId": saved["inboxId"], "expectedRevision": 1, "status": "triaged"})
            note = self.panel("checkpoint.add", {"taskId": task["taskId"], "expectedRevision": 1, "kind": "note", "text": "Отметка"})
            self.assertEqual(note["checkpoint"]["provenance"], "panel")
            detour = self.panel("focus.detour", {"expectedRevision": 1, "title": "Отход"})
            self.assertEqual(detour["focus"]["task"]["certaintyProvenance"], "panel")
            self.assertEqual(self.rows("SELECT provenance FROM focus_stack"), [{"provenance": "panel"}])
            self.assertEqual(self.ok("snapshot")["focusStack"][0]["provenance"], "panel")
            self.panel("focus.return", {"expectedRevision": 2})
            self.panel("config.set", {"key": "gate", "value": "observe"})
            for args in (("status",), ("tasks",), ("inbox",), ("checkpoint", "list", task["taskId"])):
                self.assertEqual(self.human(*args).returncode, 0)
        for output in outputs:
            self.assertNotIn(self.secret.encode(), output)
            self.assertNotIn(hashlib.sha256(self.secret.encode()).hexdigest().encode(), output)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            self.assertNotIn(self.secret, "\n".join(db.iterdump()))
            for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                self.assertNotIn(self.secret, json.dumps(list(db.execute(f'SELECT * FROM "{name}"')), ensure_ascii=False))
            witness_digest = hashlib.sha256(self.secret.encode()).hexdigest()
            for request in requests:
                saved = db.execute(
                    "SELECT request_sha256,response_json FROM requests WHERE request_id=?",
                    (request["requestId"],),
                ).fetchone()
                if request["op"] in ("snapshot", "tasks.search", "tasks.page", "task.get", "task.resolve",
                                     "focus.get", "inbox.get", "inbox.material", "checkpoint.list",
                                     "gate.stats", "gate.recent", "config.get"):
                    self.assertIsNone(saved, request["op"])
                    continue
                self.assertIsNotNone(saved, request["op"])
                saved_digest, saved_response = saved
                safe = {key: value for key, value in request.items() if key != "panelSecret"}
                if "panelSecret" in request:
                    safe["panelProof"] = True
                    self.assertNotEqual(saved_digest, hashlib.sha256(rpc.canonical(request).encode()).hexdigest())
                self.assertEqual(saved_digest, hashlib.sha256(rpc.canonical(safe).encode()).hexdigest())
                self.assertNotIn(witness_digest, saved_response)
        for path in self.state.iterdir():
            if path.is_file():
                self.assertNotIn(self.secret.encode(), path.read_bytes())


if __name__ == "__main__":
    unittest.main(verbosity=2)

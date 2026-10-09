#!/usr/bin/env python3
"""Выделение задач: воспроизведения через реальный рантайм и одноразовую БД."""
import unittest
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from support import Harness


class ExtractionTests(Harness):
    def test_resumed_session_cannot_recover_lost_witness(self):
        first = self.request("session.attest")
        first["panelSecret"] = "ab" * 32  # gitleaks:allow
        self.assertTrue(self.invoke(first)["ok"])
        self.ok("session.end")
        self.ok("session.rebind", {"reason": "resume"})
        resumed = self.request("session.attest")
        resumed["panelSecret"] = "cd" * 32  # gitleaks:allow
        response = self.invoke(resumed)
        # Отказ корректен для безопасности, но блокирует восстановление мода.
        self.error(response, "ATTESTATION_CONFLICT")
        self.assertEqual(len(self.rows("SELECT * FROM session_attestations")), 1)

    def test_two_mod_copies_cannot_register_independent_witnesses(self):
        self.ok("snapshot")
        first = self.request("session.attest")
        first["panelSecret"] = "ab" * 32  # gitleaks:allow
        second = self.request("session.attest")
        second["panelSecret"] = "cd" * 32  # gitleaks:allow
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(self.invoke, (first, second)))
        self.assertCountEqual([response["ok"] for response in responses], [True, False])
        self.error(next(response for response in responses if not response["ok"]), "ATTESTATION_CONFLICT")
        self.assertEqual(len(self.rows("SELECT * FROM session_attestations")), 1)

    def test_material_keeps_owner_request_after_2000_chars(self):
        tail = "Перестроить панель задач в карточки"
        text = "Смотри, " + "рассказ об увиденном. " * 140 + tail
        saved = self.ok("capture.prompt", {"text": text})
        material = self.ok("inbox.material", {"inboxId": saved["inboxId"]})["material"]
        self.assertIn(tail, material)

    def test_missing_proof_cannot_extract_tasks(self):
        saved = self.ok("capture.prompt", {"text": "Смотри, нужно добавить выбор файла"})
        self.error(self.invoke(self.request("tasks.extract", {"inboxId": saved["inboxId"],
                   "tasks": [{"title": "Добавить выбор файла владельцем", "steps": []}]})), "ATTESTATION_FAILED")
        self.assertEqual(self.rows("SELECT * FROM tasks"), [])

    def test_binding_does_not_turn_confirmation_into_task(self):
        self.ok("capture.prompt", {"text": "ок, остаёмся на CLI, продолжай"})
        self.assertIsNone(self.ok("task.bind")["task"])
        self.assertIsNone(self.ok("snapshot")["focus"]["task"])
        self.assertEqual(self.rows("SELECT * FROM tasks"), [])

    def test_epoch_rebind_keeps_tasks_queue_and_focus_on_real_rpc(self):
        first_session = "claude-session.cockpit-1-1234abcd"
        second_session = "claude-session.cockpit-2-5678abcd"
        def signed(op, args=None, session=first_session, secret="ab" * 32):  # gitleaks:allow
            request = self.request(op, args, session=session)
            request["panelSecret"] = secret
            response = self.invoke(request)
            self.assertTrue(response["ok"], response)
            return response["result"]
        signed("session.attest")
        saved = self.ok("capture.prompt", {"text": "Смотри, перестрой панель и добавь выбор файла"}, session=first_session)
        extracted = signed("tasks.extract", {"inboxId": saved["inboxId"], "tasks": [
            {"title": "Перестроить панель задач в карточки", "steps": []},
            {"title": "Добавить выбор файла владельцем", "steps": []}]})
        self.assertEqual(self.ok("snapshot", session=first_session)["tasks"], [])
        for card in extracted["tasks"]:
            signed("candidate.adopt", {"taskId": card["taskId"], "expectedRevision": card["revision"]})
        signed("focus.set", {"taskId": extracted["tasks"][0]["taskId"], "expectedRevision": 0})
        before = self.ok("snapshot", session=first_session)
        rebound = self.ok("session.rebind", {"reason": "resume"}, session=second_session)
        signed("session.attest", session=second_session, secret="cd" * 32)  # gitleaks:allow
        after = self.ok("snapshot", session=second_session)
        self.assertEqual(after["tasks"], before["tasks"])
        self.assertEqual(after["focus"]["task"], before["focus"]["task"])
        self.assertEqual(after["focus"], rebound["focus"])
        self.assertEqual(after["focus"]["revision"], before["focus"]["revision"] + 1)
        self.assertEqual(self.rows("SELECT session_id FROM focus")[0]["session_id"], second_session)
        self.assertEqual([card["queuePosition"] for card in after["tasks"]], [1, 2])
        self.assertEqual(len(self.rows("SELECT * FROM session_attestations")), 2)

    def test_old_service_task_is_hidden_until_human_confirmation_without_deletion(self):
        self.ok("capture.prompt", {"text": "ок, остаёмся на CLI, продолжай"})
        legacy = self.task_fixture(unstepped=True)["task"]
        snapshot = self.ok("snapshot")
        self.assertIsNone(snapshot["focus"]["task"])
        self.assertEqual(snapshot["tasks"], [])
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 1)
        self.ok("task.confirm", {"taskId": legacy["taskId"], "expectedRevision": 0})
        self.assertEqual(self.ok("focus.get")["task"]["taskId"], legacy["taskId"])

    def test_unbound_gate_still_checks_lease_stale_read_and_reports_codes(self):
        self.ok("config.set", {"key": "gate", "value": "observe"})
        first = self.ok("gate.check", {"resourcePath": str(self.cwd / "file.ts"), "staleRead": True})
        foreign = self.ok("gate.check", {"resourcePath": str(self.cwd / "file.ts")}, session="foreign")
        self.assertIsNone(first["task"])
        self.assertIsNone(first["observation"]["taskId"])
        self.assertEqual(first["observation"]["reasons"], ["stale-read"])
        self.assertEqual(foreign["observation"]["reasons"], ["foreign-lease"])
        self.assertEqual(self.ok("gate.stats")["counts"]["BLOCK"], 2)
        self.assertEqual(len(self.ok("gate.recent")["observations"]), 2)
        self.assertEqual(self.rows("SELECT * FROM tasks"), [])

    def test_cached_service_focus_is_filtered_without_rewriting_cache(self):
        from agents.claude.cockpit.rpc import request_digest
        self.ok("capture.prompt", {"text": "ок, остаёмся на CLI, продолжай"})
        legacy = self.task_fixture(unstepped=True)["task"]
        for op, result in (("task.bind", {"bound": "created", "task": legacy, "focusRevision": 1}),
                           ("snapshot", {"focus": {"task": legacy, "revision": 1}, "tasks": [legacy]})):
            request = self.request(op)
            original = json.dumps({"v": 1, "ok": True, "result": result}, ensure_ascii=False)
            with sqlite3.connect(self.state / "cockpit.db") as db:
                db.execute("INSERT INTO requests VALUES (?,?,?,?)", (request["requestId"], request_digest(request), original,
                                                                     "2026-10-05T00:00:00Z"))
            response = self.invoke(request)["result"]
            if op == "task.bind":
                self.assertEqual(response["bound"], "unbound")
                self.assertIsNone(response["task"])
            else:
                self.assertIsNone(response["focus"]["task"])
                self.assertEqual(response["tasks"], [])
            self.assertEqual(self.rows("SELECT response_json FROM requests WHERE request_id=?", (request["requestId"],))[0]["response_json"], original)

    def test_material_masks_before_head_tail_and_strips_pasted_markers(self):
        secret = "sk-" + "A1b2C3d4E5" * 3  # gitleaks:allow
        text = '<pasted_content id="6b10">Начало ' + secret + " речь " * 1500 + " Перестроить панель задач в карточки " + secret + '</pasted_content id="6b10">'
        saved = self.ok("capture.prompt", {"text": text})
        material = self.ok("inbox.material", {"inboxId": saved["inboxId"]})["material"]
        self.assertTrue(material.startswith("Начало [REDACTED:api_key]"))
        self.assertIn("Перестроить панель задач в карточки", material)
        self.assertIn("середина реплики пропущена", material)
        self.assertNotIn(secret, material)
        self.assertNotIn("pasted_content", material)
        self.assertLessEqual(len(material), 6030)
        self.assertEqual(self.ok("inbox.get", {"inboxId": saved["inboxId"]})["text"], text)

    def test_extraction_counters_are_durable_private_and_reset_failure_streak(self):
        text = "Супер, да, ты сделал. Смотри, теперь нужно добавить выбор файла"
        codes = ("no-attestation", "model-timeout", "runtime-rejected", "no-tasks", "skipped-gate", "model-unparsable", "error")
        for index, code in enumerate(codes):
            saved = self.ok("capture.prompt", {"text": text})
            args = {"inboxId": saved["inboxId"], "code": code}
            self.ok("extraction.report", args)
            self.ok("extraction.report", args)
            if index == 2:
                self.assertEqual(self.ok("snapshot")["extraction"]["consecutiveFailures"], 3)
            if index == 3:
                self.assertEqual(self.ok("snapshot")["extraction"]["consecutiveFailures"], 0)
        registration = self.request("session.attest")
        registration["panelSecret"] = "ab" * 32  # gitleaks:allow
        self.assertTrue(self.invoke(registration)["ok"])
        saved = self.ok("capture.prompt", {"text": text})
        extracted = self.request("tasks.extract", {"inboxId": saved["inboxId"], "tasks": [{"title": "Добавить выбор файла владельцем", "steps": []}]})
        extracted["panelSecret"] = "ab" * 32  # gitleaks:allow
        self.assertTrue(self.invoke(extracted)["ok"])
        doctor = self.ok("doctor")
        self.assertEqual(doctor["extraction"]["counts"], dict.fromkeys((*codes, "extracted"), 1))
        self.assertIsNotNone(doctor["extraction"]["lastSuccessAt"])
        self.assertEqual(doctor["extraction"]["consecutiveFailures"], 0)
        output = self.human("doctor").stdout.decode()
        for code in (*codes, "extracted"):
            self.assertIn("extraction." + code + "=1", output)
        self.assertIn("extraction.last-success-at=", output)
        self.assertNotIn(text, str(self.rows("SELECT * FROM events")))


if __name__ == "__main__":
    unittest.main(verbosity=2)

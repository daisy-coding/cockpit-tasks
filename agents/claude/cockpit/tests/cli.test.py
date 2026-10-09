#!/usr/bin/env python3
"""Человеческие команды M2 через настоящий процесс CLI."""

import unittest

from support import Harness


class CliTests(Harness):
    def successful(self, *args):
        process = self.human(*args)
        self.assertEqual(process.returncode, 0, process.stderr.decode())
        self.assertEqual(process.stderr, b"")
        return process.stdout.decode()

    def test_triage_confirm_and_counters(self):
        task = self.task_fixture()["task"]
        inbox_id = self.ok("capture.prompt", {"text": "Пункт?"})["inboxId"]
        output = self.successful("triage", inbox_id, "--expected-revision", "1", "--type", "blocking",
                                 "--task", task["taskId"], "--resource", "resource-1")
        self.assertIn("blocking", output)
        self.assertIn("user", output)
        self.assertIn("неразобрано 1, блокирующих 1", self.successful("status"))
        inbox = self.successful("inbox")
        self.assertIn("blocking", inbox)
        self.assertIn("неразобрано 1, блокирующих 1", inbox)
        self.assertIn("Ревизия фокуса: 1", self.successful("status"))
        self.assertIn("confirmed", self.successful("confirm", task["taskId"], "--expected-revision", "0"))
        self.successful("triage", inbox_id, "--expected-revision", "2", "--status", "triaged")
        self.assertIn("неразобрано 0, блокирующих 0", self.successful("status"))
        self.successful("triage", inbox_id, "--expected-revision", "3", "--type", "unknown",
                        "--clear-task", "--clear-resource", "--status", "rejected")
        record = self.ok("inbox.get", {"inboxId": inbox_id})
        self.assertIsNone(record["type"])
        self.assertEqual(record["scope"], {"taskId": None, "resourceId": None})
        self.assertEqual(record["triageStatus"], "rejected")

    def test_checkpoint_commands_and_redaction(self):
        secret = "sk-" + "A1b2C3d4E5" * 3
        task_id = self.task_fixture()["task"]["taskId"]
        output = self.successful("checkpoint", "add", task_id, "Отметка " + secret,
                                 "--expected-revision", "0", "--kind", "tests-passed", "--source", "tool")
        self.assertIn("tests-passed", output)
        self.assertNotIn(secret, output)
        output = self.successful("checkpoint", "list", task_id, "--limit", "1", "--expected-revision", "1")
        self.assertIn("[REDACTED:api_key]", output)
        self.assertNotIn(secret, output)

    def test_multiline_text_cannot_start_a_line_at_first_column(self):
        # Абзацы отметки сохраняются, но строка её текста не изображает соседнюю строку вывода.
        task_id = self.task_fixture()["task"]["taskId"]
        forged = "Отметка\nTASK-999  поддельная  done"
        self.successful("checkpoint", "add", task_id, forged, "--expected-revision", "0")
        output = self.successful("checkpoint", "list", task_id, "--limit", "1")
        self.assertIn("\n    TASK-999  поддельная  done", output)
        self.assertFalse(any(line.startswith("TASK-999") for line in output.splitlines()))

    def test_detour_and_return_commands(self):
        task = self.task_fixture()["task"]
        inbox_id = self.ok("capture.prompt", {"text": "Неразобранный пункт возврата"})["inboxId"]
        output = self.successful("detour", "--title", "Срочная работа", "--expected-revision", "1")
        self.assertIn("Срочная работа", output)
        target_id = self.ok("focus.get")["task"]["taskId"]
        output = self.successful("return", "--expected-revision", "2")
        self.assertIn(task["title"], output)
        self.assertIn(inbox_id, output)
        self.assertIn("return", output)
        self.successful("detour", "--task", target_id, "--expected-revision", "3")
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 2)

    def test_cli_conflicts_and_syntax_errors(self):
        task = self.task_fixture()["task"]
        for args in (("confirm", task["taskId"], "--expected-revision", "99"),
                     ("detour", "--title", "Другая", "--expected-revision", "0"),
                     ("return", "--expected-revision", "0")):
            with self.subTest(args=args):
                process = self.human(*args)
                self.assertEqual(process.returncode, 1)
                self.assertIn(b"REVISION_CONFLICT", process.stderr)
        for args in (("confirm", task["taskId"]), ("detour", "--expected-revision", "1"),
                     ("detour", "--title", "Название", "--task", task["taskId"], "--expected-revision", "1"),
                     ("checkpoint", "add", task["taskId"], "Текст", "--kind", "unknown", "--expected-revision", "0")):
            with self.subTest(args=args):
                self.assertEqual(self.human(*args).returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)

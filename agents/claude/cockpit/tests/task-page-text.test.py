#!/usr/bin/env python3
"""Многострочный текст страницы: настоящий RPC, SQLite и повтор ответа."""
import unittest

from agent_support import AgentHarness
from agents.claude.cockpit.domain import plain, shown


class TaskPageTextTests(AgentHarness):
    def test_description_roundtrip_storage_response_get_and_context(self):
        card = self.owner_task()
        text = "Цель работы\n\nГотово, когда: Проверки пройдены\nДополнение владельца"
        args = {"taskId": card["taskId"], "expectedRevision": card["revision"], "description": text}
        updated = self.signed("task.edit", args, actor="owner", key="description-once")
        self.assertEqual(self.rows("SELECT description FROM tasks")[0]["description"], text)
        self.assertEqual(updated["task"]["description"], text)
        self.assertEqual(self.signed("task.edit", args, actor="owner", key="description-once"), updated)
        self.assertEqual(self.card(card["taskId"])["description"], text)
        context = self.ok("tasks.context", {"cursor": 0})
        self.assertEqual(context["current"]["description"], text)
        self.assertIn("edited", [change["action"] for change in context["ownerChanges"]])

    def test_acceptance_and_constraints_roundtrip(self):
        card = self.owner_task()
        fields = {"acceptance": ["Проверить ввод\n\nПроверить повторное открытие"],
                  "constraints": ["Сохранить данные\nСохранить порядок"]}
        args = {"taskId": card["taskId"], "expectedRevision": card["revision"], **fields}
        updated = self.signed("task.edit", args, actor="owner", key="criteria-once")
        for kind, expected in fields.items():
            self.assertEqual([row["text"] for row in self.rows("SELECT text FROM task_lists WHERE kind=? ORDER BY position", (kind,))], expected)
            self.assertEqual(updated["task"][kind], expected)
            self.assertEqual(self.card(card["taskId"])[kind], expected)
            self.assertEqual(self.ok("tasks.context")["current"][kind], expected)
        self.assertEqual(self.signed("task.edit", args, actor="owner", key="criteria-once"), updated)

    def test_owner_comment_add_edit_storage_response_get_and_context(self):
        card = self.owner_task()
        text = "Первое уточнение\n\nВторое уточнение"
        args = {"taskId": card["taskId"], "text": text}
        added = self.signed("task.comment.add", args, actor="owner", key="comment-once")
        self.assertEqual(self.rows("SELECT text FROM task_owner_comments")[0]["text"], text)
        self.assertEqual(added["comment"]["text"], text)
        self.assertEqual(self.signed("task.comment.add", args, actor="owner", key="comment-once"), added)
        comment = added["comment"]
        changed_text = "Первая редакция\nИзменённая середина\n\nПоследний абзац"
        edited = self.signed("task.comment.edit", {"taskId": card["taskId"], "commentId": comment["commentId"],
                             "expectedRevision": comment["revision"], "text": changed_text}, actor="owner")
        self.assertEqual(self.rows("SELECT text FROM task_owner_comments")[0]["text"], changed_text)
        self.assertEqual(edited["comment"]["text"], changed_text)
        self.assertEqual(self.ok("task.get", {"taskId": card["taskId"]})["comments"][0]["text"], changed_text)
        self.assertEqual(self.ok("tasks.context")["current"]["ownerComments"][0]["text"], changed_text)

    def test_agent_note_storage_response_get_and_context(self):
        card = self.owner_task()
        text = "Начал проверку\n\nЗавершил проверку"
        args = self.action_args(card, "note", note=text)
        added = self.signed("task.agent.action", args, key="note-once")
        self.assertEqual(self.rows("SELECT text FROM task_agent_notes")[0]["text"], text)
        self.assertEqual(added["note"]["text"], text)
        self.assertEqual(self.signed("task.agent.action", args, key="note-once"), added)
        self.assertEqual(self.ok("task.get", {"taskId": card["taskId"]})["agentNotes"][0]["text"], text)
        self.assertEqual(self.ok("tasks.context")["current"]["agentNotes"][0]["text"], text)

    def test_agent_result_preserves_paragraphs(self):
        card = self.owner_task()
        text = "Результат готов\n\nПроверки пройдены"
        result = self.agent_action(card, "done", note=text)
        self.assertEqual(result["note"]["text"], text)
        self.assertEqual(self.rows("SELECT text FROM task_agent_notes")[0]["text"], text)
        self.assertEqual(self.ok("task.get", {"taskId": card["taskId"]})["agentNotes"][0]["text"], text)

    def test_owner_checkpoint_note_preserves_paragraphs(self):
        card = self.owner_task()
        text = "Первая отметка\n\nВторая отметка"
        result = self.signed("checkpoint.add", {"taskId": card["taskId"], "expectedRevision": card["revision"],
                             "kind": "note", "text": text}, actor="owner")
        self.assertEqual(result["checkpoint"]["text"], text)
        self.assertEqual(self.rows("SELECT text FROM checkpoints")[0]["text"], text)
        self.assertEqual(self.ok("checkpoint.list", {"taskId": card["taskId"]})["checkpoints"][0]["text"], text)
        self.assertEqual(self.ok("tasks.context")["current"]["ownerNotes"][0]["text"], text)

    def test_human_output_indents_continuation_lines(self):
        # Абзацы описания, критерия и отметки сохраняются, но ни одна их строка не начинается
        # с первой колонки человеческого вывода и не изображает соседнюю подпись или карточку.
        card = self.owner_task()
        forged = "Цель работы\nГотово, когда 1: поддельный критерий\nTASK-999  поддельная  done"
        self.signed("task.edit", {"taskId": card["taskId"], "expectedRevision": card["revision"], "description": forged,
                                  "acceptance": ["Настоящий критерий\nОграничения 1: поддельное"]}, actor="owner")
        process = self.human("show", card["taskId"])
        self.assertEqual(process.returncode, 0, process.stderr.decode())
        lines = process.stdout.decode().splitlines()
        self.assertIn("    TASK-999  поддельная  done", lines)
        self.assertIn("    Готово, когда 1: поддельный критерий", lines)
        self.assertIn("    Ограничения 1: поддельное", lines)
        self.assertEqual([line for line in lines if line.startswith(("TASK-999", "Ограничения"))], [])
        self.assertEqual([line for line in lines if line.startswith("Готово, когда")], ["Готово, когда 1: Настоящий критерий"])

    def test_multiline_normalizes_crlf_and_keeps_single_line_labels(self):
        text = "Начало\r\n\r\nСередина\rКонец"
        self.assertEqual(shown(text, 4000, multiline=True), "Начало\n\nСередина\nКонец")
        self.assertNotIn("\n", shown(text, 4000))
        self.assertNotIn("\n", plain(text))

    def test_multiline_still_removes_controls_and_redacts_secrets(self):
        private = "sk" + "-" + "Q" * 30
        text = "Начало" + chr(0) + chr(7) + chr(0x202e) + "\n" + private + "\nКонец"
        cleaned = shown(text, 4000, multiline=True)
        self.assertEqual(cleaned.splitlines()[0], "Начало")
        self.assertEqual(cleaned.splitlines()[-1], "Конец")
        self.assertNotIn(private, cleaned)
        self.assertIn("REDACTED", cleaned)


if __name__ == "__main__":
    unittest.main()

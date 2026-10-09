#!/usr/bin/env python3
"""Возвраты одной задачи: журнал, атомарная приёмка и контекст следующего захода."""
import json
import sqlite3
import unittest

from agent_support import AgentHarness


class TaskReturnsTests(AgentHarness):
    def page(self, name="queue"):
        return self.ok("tasks.page", {"list": name, "offset": 0, "limit": 50})["tasks"]

    def reopen(self, task_id, **extra):
        return self.signed("task.reopen", {"taskId": task_id,
            "expectedRevision": self.card(task_id)["revision"], **extra}, actor="owner")

    def test_count_one_two_returns_in_card_page_context_and_history(self):
        first, other = self.create_agent("Возвращаемая", "Другая")
        task_id = first["taskId"]
        self.assertEqual(self.card(task_id)["returnCount"], 0)
        self.assertEqual(self.page()[0]["returnCount"], 0)
        self.assertNotIn("returnContext", self.card(task_id))
        self.agent_action(self.card(task_id), "current")
        self.agent_action(self.card(task_id), "done", note="Итог 1")
        for count in (1, 2):
            request = {**self.request("task.reopen", {"taskId": task_id,
                "expectedRevision": self.card(task_id)["revision"], "place": "top", "comment": f"Замечание {count}"}),
                "actor": "owner", "panelSecret": self.secret}
            response = self.invoke(request)
            self.assertTrue(response["ok"], response)
            self.assertEqual(self.invoke(request), response)
            card = response["result"]["task"]
            self.assertEqual(card["returnCount"], count)
            self.assertEqual(card["returnContext"], {"result": f"Итог {count}", "ownerComment": f"Замечание {count}"})
            self.assertEqual(self.page()[0]["taskId"], task_id)
            self.assertEqual(self.page()[0]["returnCount"], count)
            self.assertEqual(self.ok("tasks.context")["queue"][0]["returnCount"], count)
            self.assertEqual(self.ok("tasks.search", {"query": "Возвращаемая"})["lists"]["queue"]["rows"][0]["returnCount"], count)
            self.agent_action(self.card(task_id), "current")
            context = self.ok("tasks.context")["current"]
            self.assertEqual(context["returnCount"], count)
            self.assertEqual(context["returnContext"], card["returnContext"])
            self.agent_action(self.card(task_id), "done", note=f"Итог {count + 1}")
            self.assertEqual(self.page("closed")[0]["returnCount"], count)
        detail = self.ok("task.get", {"taskId": task_id})
        self.assertEqual(len(detail["agentNotes"]), 3)
        self.assertEqual([c["text"] for c in detail["comments"]], ["Замечание 1", "Замечание 2"])
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 2)

    def test_cached_read_refreshes_return_count_with_comment_and_context(self):
        (first,) = self.create_agent("Кэш возвращённой задачи")
        task_id = first["taskId"]
        request = self.request("task.get", {"taskId": task_id})
        self.assertEqual(self.invoke(request)["result"]["task"]["returnCount"], 0)
        self.agent_action(self.card(task_id), "done", note="Прежний итог")
        self.reopen(task_id, place="top", comment="Исправить ширину")
        detail = self.invoke(request)["result"]
        self.assertEqual(detail["task"]["returnCount"], 1)
        self.assertEqual(detail["task"]["returnContext"], {"result": "Прежний итог", "ownerComment": "Исправить ширину"})
        comment = detail["comments"][0]
        self.signed("task.comment.delete", {"taskId": task_id, "commentId": comment["commentId"],
            "expectedRevision": comment["revision"]}, actor="owner")
        self.assertIsNone(self.invoke(request)["result"]["task"]["returnContext"]["ownerComment"])

    def test_empty_comment_top_priority_and_time_are_preserved(self):
        (first,) = self.create_agent("Вернуть")
        task_id = first["taskId"]
        other = self.owner_task("Срочная", priority=0)
        self.agent_action(self.card(task_id), "done", note="Первый итог")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET elapsed_ms=12345 WHERE task_id=?", (task_id,))
        card = self.reopen(task_id, place="top", comment="")["task"]
        self.assertEqual(card["elapsedMs"], 12345)
        self.assertEqual(card["returnContext"], {"result": "Первый итог", "ownerComment": None})
        self.assertEqual(self.page()[0]["taskId"], task_id)
        self.assertEqual(self.card(other["taskId"])["priority"], 0)
        self.assertEqual(self.ok("task.get", {"taskId": task_id})["comments"], [])

    def test_failed_or_agent_reopen_does_not_write_comment_or_event(self):
        (first,) = self.create_agent("Проверить атомарность")
        task_id = first["taskId"]
        args = {"taskId": task_id, "expectedRevision": self.card(task_id)["revision"], "place": "top", "comment": "Не сохранить"}
        self.error(self.signed_response("task.reopen", args, actor="owner"), "INVALID_REQUEST")
        self.agent_action(self.card(task_id), "done")
        self.error(self.signed_response("task.reopen", args, actor="owner"), "REVISION_CONFLICT")
        args["expectedRevision"] = self.card(task_id)["revision"]
        self.error(self.signed_response("task.reopen", args), "INVALID_REQUEST")
        self.signed("task.action", self.action_args(self.card(task_id), "delete"), actor="owner")
        self.error(self.signed_response("task.reopen", args, actor="owner"), "NOT_FOUND")
        self.assertEqual(self.rows("SELECT * FROM task_owner_comments"), [])
        self.assertEqual(self.rows("SELECT * FROM events WHERE kind='task.owner.reopened'"), [])

    def test_manual_return_uses_existing_events_and_masks_context(self):
        (first,) = self.create_agent("Ручной возврат")
        task_id = first["taskId"]
        secret = "sk" + "-" + "Q" * 25
        self.agent_action(self.card(task_id), "done", note="Итог " + secret)
        self.reopen(task_id)
        detail = self.ok("task.get", {"taskId": task_id})
        self.assertEqual(detail["task"]["returnCount"], 1)
        self.assertNotIn(secret, json.dumps(detail))
        self.assertIsNone(detail["task"]["returnContext"]["ownerComment"])
        self.agent_action(self.card(task_id), "current")
        self.assertNotIn(secret, json.dumps(self.ok("tasks.context")))


if __name__ == "__main__":
    unittest.main(verbosity=2)

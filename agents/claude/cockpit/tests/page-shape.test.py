#!/usr/bin/env python3
"""Строки страницы после обычной работы агента проходят проверку мода: формы полей те же, что у карточки."""
import re
import unittest

from agent_support import AgentHarness

TIMESTAMP = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$")


def whole(value):
    # Мод принимает только неотрицательные целые: `integer` в hooks/domain/rpc.ts.
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def defects(row):
    checks = {
        "priority": whole(row["priority"]) and row["priority"] <= 3,
        "queuePosition": whole(row["queuePosition"]),
        "revision": whole(row["revision"]),
        "needsDecision": isinstance(row["needsDecision"], bool),
        "discussionCount": whole(row["discussionCount"]),
        "stepCounts": all(whole(row["stepCounts"][key]) for key in ("total", "done", "active"))
                      and row["stepCounts"]["done"] + row["stepCounts"]["active"] <= row["stepCounts"]["total"],
        "createdAt": isinstance(row["createdAt"], str) and bool(TIMESTAMP.match(row["createdAt"])),
        "updatedAt": isinstance(row["updatedAt"], str) and bool(TIMESTAMP.match(row["updatedAt"])),
        "elapsedMs": whole(row["elapsedMs"]),
        "activeSince": row["activeSince"] is None or bool(TIMESTAMP.match(row["activeSince"])),
        "certaintySource": row["certaintySource"] in ("user", "claude", "agent", "engine", "tool", "provider"),
        "closedAt": "closedAt" not in row or bool(TIMESTAMP.match(row["closedAt"])),
        "description": "description" not in row or isinstance(row["description"], str) and len(row["description"]) <= 2000,
    }
    return {name: row[name] for name, good in checks.items() if not good}


class PageShapeTests(AgentHarness):
    def test_preview_rows_match_the_optional_description_shape(self):
        first, second, third = self.signed("tasks.agent.create", {"tasks": [
            {"title": f"Превью {number}", "description": "Описание 🧪\n" * 180} for number in range(3)]})["tasks"]
        self.agent_action(self.card(second["taskId"]), "defer")
        self.agent_action(self.card(third["taskId"]), "done")
        for name in ("queue", "deferred", "closed"):
            page = self.ok("tasks.page", {"list": name, "offset": 0, "limit": 50, "preview": 1200})
            self.assertEqual(len(page["tasks"]), 1)
            row = page["tasks"][0]
            self.assertEqual(defects(row), {})
            full = self.card(row["taskId"])["description"]
            self.assertEqual(row["description"], full[:1198] + " …")

    def pages(self):
        return {name: self.ok("tasks.page", {"list": name, "offset": 0, "limit": 50}) for name in ("queue", "deferred", "closed")}

    def assert_pages_valid(self, label):
        for name, page in self.pages().items():
            for row in page["tasks"]:
                self.assertEqual(defects(row), {}, f"{label}: {name} {row['alias']}")

    def test_rows_stay_valid_through_agent_work(self):
        first, second, third = self.create_agent("Первая", "Вторая", "Третья")
        self.assert_pages_valid("после создания")
        # Новые задачи в начало очереди — обычный приём агента на срочную просьбу владельца.
        for number in range(6):
            self.signed("tasks.agent.create", {"tasks": [{"title": f"Срочная {number}", "place": "top"}]})
            self.assert_pages_valid(f"после задачи в начало №{number}")
        self.agent_action(self.card(first["taskId"]), "current")
        self.assert_pages_valid("после взятия в работу")
        self.agent_action(self.card(first["taskId"]), "note", note="Ход работы")
        # Смена текущей возвращает прежнюю в очередь с накопленным временем.
        self.agent_action(self.card(second["taskId"]), "current")
        self.assert_pages_valid("после смены текущей")
        queue = [row["taskId"] for row in self.pages()["queue"]["tasks"]]
        self.signed("tasks.agent.rank", {"order": list(reversed(queue))})
        self.assert_pages_valid("после перестановки")
        self.agent_action(self.card(third["taskId"]), "defer")
        self.assert_pages_valid("после отправки в бэклог")
        self.agent_action(self.card(second["taskId"]), "done", note="Сделано")
        self.assert_pages_valid("после закрытия")
        top = self.pages()["queue"]["tasks"][0]
        self.signed("task.action", self.action_args(self.card(top["taskId"]), "down"), actor="owner")
        self.assert_pages_valid("после перестановки владельцем")
        self.assertEqual(self.pages()["queue"]["tasks"][1]["taskId"], top["taskId"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

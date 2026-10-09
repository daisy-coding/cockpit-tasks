#!/usr/bin/env python3
"""Ранжирование очереди агентом через настоящий аттестованный RPC."""
import sqlite3
import secrets
import unittest

from agent_support import AgentHarness
from support import Harness


class AgentRankTests(AgentHarness):
    def setUp(self):
        Harness.setUp(self)
        self.other = self.linked_worktrees()
        self.secret = secrets.token_hex(32)
        self.signed("session.attest", actor="owner")

    def queue(self):
        return [item["taskId"] for item in self.ok("tasks.context")["queue"]]

    def rank(self, *cards, **kwargs):
        return self.signed("tasks.agent.rank", {"order": [card["taskId"] for card in cards]}, **kwargs)

    def test_partial_order_and_cross_priority_slots(self):
        cards = self.create_agent("Косметика", "Блокер", "Документация", "Проверка")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET priority=0 WHERE task_id=?", (cards[0]["taskId"],))
            db.execute("UPDATE tasks SET priority=3 WHERE task_id=?", (cards[3]["taskId"],))
        result = self.rank(cards[3], cards[1])
        expected = [cards[i]["taskId"] for i in (3, 1, 0, 2)]
        self.assertEqual(result, {"order": expected, "pinned": []})
        self.assertEqual(self.queue(), expected)
        self.assertEqual([t["taskId"] for t in self.ok("snapshot")["tasks"]], expected)
        self.assertEqual(self.card(cards[3]["taskId"])["prioritySource"], "model")

    def test_pinned_slots_and_revisions_stay_put(self):
        cards = self.create_agent("Первое", "Закрепить", "Третье", "Четвёртое", "Последнее")
        for i in (1, 4):
            self.signed("task.edit", {"taskId": cards[i]["taskId"], "expectedRevision": 0, "pinned": True}, actor="owner")
        anchors = [self.card(cards[i]["taskId"]) for i in (1, 4)]
        result = self.rank(cards[4], cards[3], cards[1], cards[2], cards[0])
        self.assertEqual(result, {"order": [cards[i]["taskId"] for i in (3, 1, 2, 0, 4)],
                                  "pinned": [cards[i]["taskId"] for i in (1, 4)]})
        self.assertEqual(self.queue(), result["order"])
        self.assertEqual([self.card(card["taskId"]) for card in anchors], anchors)
        self.assertTrue(all(item["priorityPinned"] for item in self.ok("tasks.context")["queue"] if item["taskId"] in result["pinned"]))

    def test_owner_rank_and_manual_move_pin_but_agent_cannot_use_owner_operations(self):
        cards = self.create_agent("Первое", "Второе", "Третье")
        self.signed("tasks.rank", {"items": [{"taskId": cards[0]["taskId"], "expectedRevision": 0, "priority": 1}], "source": "model"}, actor="owner")
        self.assertTrue(self.card(cards[0]["taskId"])["priorityPinned"])
        self.signed("task.action", self.action_args(self.card(cards[2]["taskId"]), "up"), actor="owner")
        self.assertTrue(self.card(cards[2]["taskId"])["priorityPinned"])
        before = self.queue()
        self.rank(*reversed(cards))
        self.assertEqual(self.queue(), before)
        self.error(self.signed_response("tasks.rank", {"items": [], "source": "model"}), "INVALID_REQUEST")

    def test_invalid_ids_and_states_reject_atomically(self):
        cards = self.create_agent("Текущая", "Отложенная", "Закрытая", "Удалённая", "Очередь")
        self.agent_action(self.card(cards[0]["taskId"]), "current")
        self.agent_action(self.card(cards[1]["taskId"]), "defer")
        self.agent_action(self.card(cards[2]["taskId"]), "done")
        self.signed("task.action", self.action_args(self.card(cards[3]["taskId"]), "delete"), actor="owner")
        before, events = self.rows("SELECT * FROM tasks"), self.rows("SELECT * FROM events")
        for card in (*cards[:4], {"taskId": "missing"}):
            response = self.signed_response("tasks.agent.rank", {"order": [cards[4]["taskId"], card["taskId"]]})
            self.error(response, "INVALID_REQUEST")
            self.assertIn("очеред", response["error"]["message"])
            self.assertEqual(self.rows("SELECT * FROM tasks"), before)
            self.assertEqual(self.rows("SELECT * FROM events"), events)
        for order in (None, "task", [], [1], [cards[4]["taskId"]] * 2, ["x"] * 31):
            self.error(self.signed_response("tasks.agent.rank", {"order": order}), "INVALID_REQUEST")

    def test_foreign_worktree_project_and_candidate_are_rejected(self):
        other = self.other
        self.signed("session.attest", actor="owner", cwd=other)
        remote = self.signed("tasks.agent.create", {"tasks": [{"title": "Чужое дерево"}]}, cwd=other)["tasks"][0]
        self.signed("session.attest", actor="owner", cwd=self.root)
        foreign = self.signed("tasks.agent.create", {"tasks": [{"title": "Чужой проект"}]}, cwd=self.root)["tasks"][0]
        from agents.claude.cockpit import domain
        binding = self.ok("snapshot")["binding"]
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            candidate = domain.create_task(db, binding, "Кандидат", stage="candidate")
        self.error(self.signed_response("tasks.agent.rank", {"order": [remote["taskId"]]}), "INVALID_REQUEST")
        self.error(self.signed_response("tasks.agent.rank", {"order": [foreign["taskId"]]}), "INVALID_REQUEST")
        self.error(self.signed_response("tasks.agent.rank", {"order": [candidate]}), "INVALID_REQUEST")

    def test_proof_actor_idempotency_event_and_revisions(self):
        cards = self.create_agent("Первое", "Второе")
        args = {"order": [cards[1]["taskId"]]}
        self.error(self.invoke(self.request("tasks.agent.rank", args)), "ATTESTATION_FAILED")
        self.error(self.signed_response("tasks.agent.rank", args, actor="owner"), "INVALID_REQUEST")
        request = {**self.request("tasks.agent.rank", args), "actor": "agent", "panelSecret": "cd" * 32}
        self.error(self.invoke(request), "ATTESTATION_FAILED")
        result = self.signed("tasks.agent.rank", args, key="rank-once")
        before, events = self.rows("SELECT * FROM tasks"), self.rows("SELECT * FROM events")
        self.assertEqual(self.signed("tasks.agent.rank", args, key="rank-once"), result)
        self.assertEqual(self.rows("SELECT * FROM tasks"), before)
        self.assertEqual(self.rows("SELECT * FROM events"), events)
        self.assertEqual([self.card(card["taskId"])["revision"] for card in cards], [1, 1])
        self.assertEqual(len([event for event in events if event["kind"] == "tasks.agent.ranked"]), 1)
        self.error(self.signed_response("tasks.agent.rank", {"order": [cards[0]["taskId"]]}, key="rank-once"), "IDEMPOTENCY_CONFLICT")

    def test_storage_failure_rolls_back_order_revisions_events_and_request(self):
        cards = self.create_agent("Первое", "Второе", "Третье")
        before, events = self.rows("SELECT * FROM tasks"), self.rows("SELECT * FROM events")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("CREATE TRIGGER fail_agent_rank BEFORE UPDATE OF queue_position ON tasks WHEN OLD.task_id='" + cards[0]["taskId"] + "' BEGIN SELECT RAISE(ABORT,'fixture'); END")
        args = {"order": [cards[2]["taskId"], cards[1]["taskId"]]}
        self.error(self.signed_response("tasks.agent.rank", args, key="retry-rank"), "DB_UNAVAILABLE")
        self.assertEqual(self.rows("SELECT * FROM tasks"), before)
        self.assertEqual(self.rows("SELECT * FROM events"), events)
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id='retry-rank'"), [])
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("DROP TRIGGER fail_agent_rank")
        self.assertEqual(self.signed("tasks.agent.rank", args, key="retry-rank")["order"], [cards[i]["taskId"] for i in (2, 1, 0)])

    def test_colliding_old_coordinates_preserve_pinned_slots_and_noop_keeps_revisions(self):
        cards = self.create_agent("Первое", "Якорь", "Третье")
        self.signed("task.edit", {"taskId": cards[1]["taskId"], "expectedRevision": 0, "pinned": True}, actor="owner")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET queue_position=0")
        self.assertEqual(self.rank(cards[2])["order"], [cards[i]["taskId"] for i in (2, 1, 0)])
        self.assertEqual(self.queue(), [cards[i]["taskId"] for i in (2, 1, 0)])
        anchor = self.card(cards[1]["taskId"])
        self.assertEqual((anchor["priority"], anchor["prioritySource"], anchor["priorityPinned"]), (2, "user", True))
        before = self.rows("SELECT * FROM tasks")
        self.rank(cards[2])
        self.assertEqual(self.rows("SELECT * FROM tasks"), before)

    def test_place_batch_top_bottom_default_duplicates_and_anchors(self):
        cards = self.create_agent("Первое", "Закрепить", "Последнее")
        self.signed("task.edit", {"taskId": cards[1]["taskId"], "expectedRevision": 0, "pinned": True}, actor="owner")
        anchor = self.card(cards[1]["taskId"])
        args = {"tasks": [{"title": "Срочно", "place": "top"}, {"title": "Далее", "place": "top"},
                          {"title": "Внизу", "place": "bottom"}, {"title": "Обычно"}]}
        added = self.signed("tasks.agent.create", args, key="place-once")["tasks"]
        expected = [added[0]["taskId"], cards[1]["taskId"], added[1]["taskId"], cards[0]["taskId"], cards[2]["taskId"], added[2]["taskId"], added[3]["taskId"]]
        self.assertEqual(self.queue(), expected)
        self.assertEqual(self.card(anchor["taskId"]), anchor)
        self.assertEqual(self.signed("tasks.agent.create", args, key="place-once")["tasks"], added)
        duplicate = self.signed("tasks.agent.create", {"tasks": [{"title": "Первое", "place": "top"}]})["tasks"][0]
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(self.queue(), expected)
        for place in (None, "middle", 1, True, []):
            self.error(self.signed_response("tasks.agent.create", {"tasks": [{"title": "Лишнее", "place": place}]}), "INVALID_REQUEST")


if __name__ == "__main__":
    unittest.main(verbosity=2)

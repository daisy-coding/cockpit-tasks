#!/usr/bin/env python3
"""Поля поручения, закрепление и очередь через реальный RPC и человеческий CLI."""

import json
import sqlite3
import unittest

from support import Harness


class PriorityTests(Harness):
    def setUp(self):
        super().setUp()
        if self._testMethodName == "test_edit_is_worktree_scoped_but_rank_is_project_scoped":
            self.other = self.linked_worktrees()
        self.secret = "ab" * 32
        self.panel("session.attest", {})

    def panel_response(self, op, args, **kwargs):
        request = self.request(op, args, **kwargs)
        request["panelSecret"] = self.secret
        return self.invoke(raw=json.dumps(request).encode("utf-8"))

    def panel(self, op, args, **kwargs):
        response = self.panel_response(op, args, **kwargs)
        self.assertTrue(response["ok"], response)
        return response["result"]

    def create(self, title="Поручение", **extra):
        return self.panel("task.create", {"title": title, **extra})["task"]

    def card(self, task_id):
        return self.ok("task.get", {"taskId": task_id})["task"]

    def edit(self, card, **extra):
        return self.panel("task.edit", {"taskId": card["taskId"], "expectedRevision": card["revision"], **extra})["task"]

    def item(self, card, priority):
        return {"taskId": card["taskId"], "expectedRevision": card["revision"], "priority": priority}

    def action_response(self, card, action):
        return self.panel_response("task.action", {"taskId": card["taskId"], "expectedRevision": card["revision"],
                                   "expectedFocusRevision": self.ok("focus.get")["revision"], "action": action})

    def test_create_defaults_all_fields_and_edit_clears_without_touching_source_steps(self):
        default = self.create()
        self.assertEqual([default[k] for k in ("description", "acceptance", "constraints", "assignee", "priority", "prioritySource", "priorityPinned")],
                         ["", [], [], None, 2, "model", False])
        card = self.create("Точное поручение", description="Описание 🐋", acceptance=["Собрано", "Проверено"],
                           constraints=["Не менять карточки"], assignee="codex", priority=0, steps=["Первый шаг"])
        self.assertEqual([card[k] for k in ("description", "acceptance", "constraints", "assignee", "priority", "prioritySource", "priorityPinned")],
                         ["Описание 🐋", ["Собрано", "Проверено"], ["Не менять карточки"], "codex", 0, "user", True])
        edited = self.edit(card, title="Новое название", description="Новый текст", acceptance=["Один"],
                           constraints=["Два", "Три"], assignee="human", priority=1)
        self.assertEqual(edited["revision"], card["revision"] + 1)
        self.assertEqual([edited[k] for k in ("title", "description", "acceptance", "constraints", "assignee", "priority")],
                         ["Новое название", "Новый текст", ["Один"], ["Два", "Три"], "human", 1])
        cleared = self.edit(edited, description="", acceptance=[], constraints=[], assignee=None)
        self.assertEqual([cleared[k] for k in ("description", "acceptance", "constraints", "assignee")], ["", [], [], None])
        self.assertEqual(cleared["steps"], card["steps"])
        self.assertEqual(cleared["source"], card["source"])
        summary = next(t for t in self.ok("snapshot")["tasks"] if t["taskId"] == card["taskId"])
        self.assertFalse(set(summary) & {"description", "acceptance", "constraints"})
        self.assertEqual((summary["assignee"], summary["priority"], summary["priorityPinned"]), (None, 1, True))

    def test_exact_unicode_limits_for_create_and_edit_and_invalid_requests_are_atomic(self):
        fields = {"description": "🐋" * 4000, "acceptance": ["🐋" * 300] * 10,
                  "constraints": ["я" * 300] * 10}
        card = self.create(**fields)
        self.assertEqual({k: card[k] for k in fields}, fields)
        card = self.edit(card, **fields)
        invalid = [{"description": "x" * 4001}, {"acceptance": ["x"] * 11}, {"constraints": ["x"] * 11},
                   {"acceptance": ["x" * 301]}, {"constraints": ["x" * 301]}, {"acceptance": "x"},
                   {"constraints": [None]}, {"description": None}, {"assignee": "other"}, {"assignee": []},
                   {"priority": -1}, {"priority": 4}, {"priority": True}, {"priority": 1.5},
                   {"title": ""}, {"title": "я" * 301}, {"description": "\ud800"}]
        for extra in invalid:
            with self.subTest(extra=list(extra)):
                self.error(self.panel_response("task.create", {"title": "Новая", **extra}), "INVALID_REQUEST")
                self.error(self.panel_response("task.edit", {"taskId": card["taskId"], "expectedRevision": card["revision"], **extra}), "INVALID_REQUEST")
        for extra in ({}, {"pinned": 1}, {"steps": []}):
            self.error(self.panel_response("task.edit", {"taskId": card["taskId"], "expectedRevision": card["revision"], **extra}), "INVALID_REQUEST")
        self.assertEqual(self.card(card["taskId"]), card)
        self.assertEqual(len(self.rows("SELECT * FROM tasks")), 1)

    def test_edit_requires_registered_proof_cas_and_replays_exactly_once(self):
        card = self.create()
        args = {"taskId": card["taskId"], "expectedRevision": card["revision"], "description": "Уточнение"}
        self.error(self.invoke(self.request("task.edit", args)), "ATTESTATION_FAILED")
        request = self.request("task.edit", args)
        request["panelSecret"] = "cd" * 32
        self.error(self.invoke(request), "ATTESTATION_FAILED")
        result = self.panel("task.edit", args, key="edit-once")
        self.assertEqual(self.panel("task.edit", args, key="edit-once"), result)
        self.error(self.panel_response("task.edit", args), "REVISION_CONFLICT")
        self.assertEqual(self.card(card["taskId"])["revision"], card["revision"] + 1)
        self.assertEqual(self.rows("SELECT priority_provenance FROM tasks")[0]["priority_provenance"], "panel")

    def test_rank_skips_pinned_stale_terminal_missing_and_unpin_allows_models(self):
        pinned = self.create(priority=0)
        stale = self.create()
        terminal = self.create()
        self.ok("task.update", {"taskId": terminal["taskId"], "expectedRevision": terminal["revision"], "status": "done"})
        terminal = self.card(terminal["taskId"])
        changed = self.create(assignee="claude")
        items = [self.item(pinned, 3), {**self.item(stale, 0), "expectedRevision": stale["revision"] + 1},
                 self.item(terminal, 0), {"taskId": "missing", "expectedRevision": 0, "priority": 0}, self.item(changed, 1)]
        ranked = self.panel("tasks.rank", {"items": items, "source": "model"}, key="rank-once")
        self.assertEqual(ranked, {"changed": [{"taskId": changed["taskId"], "priority": 1}], "skipped": [
            {"taskId": pinned["taskId"], "reason": "pinned"}, {"taskId": stale["taskId"], "reason": "stale"},
            {"taskId": terminal["taskId"], "reason": "terminal"}, {"taskId": "missing", "reason": "not-found"}]})
        self.assertEqual(self.panel("tasks.rank", {"items": items, "source": "model"}, key="rank-once"), ranked)
        for original in (pinned, stale, terminal):
            self.assertEqual(self.card(original["taskId"]), original)
        unpinned = self.edit(pinned, pinned=False)
        self.assertEqual((unpinned["prioritySource"], unpinned["priorityPinned"]), ("user", False))
        self.panel("tasks.rank", {"items": [self.item(unpinned, 2)], "source": "jev"})
        after = self.card(pinned["taskId"])
        self.assertEqual((after["priority"], after["prioritySource"], after["priorityPinned"], after["revision"]),
                         (2, "jev", False, unpinned["revision"] + 1))
        explicit_unpin = self.edit(after, priority=3, pinned=False)
        self.assertEqual((explicit_unpin["prioritySource"], explicit_unpin["priorityPinned"]), ("user", False))
        repinned = self.edit(explicit_unpin, pinned=True)
        self.assertTrue(repinned["priorityPinned"])

    def test_rank_validation_proof_duplicates_and_batch_limit(self):
        card = self.create()
        item = self.item(card, 0)
        self.error(self.invoke(self.request("tasks.rank", {"items": [item], "source": "model"})), "ATTESTATION_FAILED")
        cases = [{"items": [item, item], "source": "model"}, {"items": [item], "source": "user"},
                 {"items": [{**item, "priority": True}], "source": "jev"},
                 {"items": [{**item, "expectedRevision": -1}], "source": "model"},
                 {"items": [{**item, "unexpected": 1}], "source": "model"},
                 {"items": [{"taskId": f"absent-{i}", "expectedRevision": 0, "priority": 1} for i in range(51)], "source": "model"}]
        for args in cases:
            self.error(self.panel_response("tasks.rank", args), "INVALID_REQUEST")
        args = {"items": [{"taskId": f"absent-{i}", "expectedRevision": 0, "priority": 1} for i in range(50)], "source": "model"}
        self.assertEqual(len(self.panel("tasks.rank", args)["skipped"]), 50)
        self.assertEqual(self.panel("tasks.rank", {"items": [], "source": "jev"}), {"changed": [], "skipped": []})
        self.assertEqual(self.card(card["taskId"]), card)

    def test_rank_and_edit_failures_roll_back_partial_writes(self):
        first = self.create(description="До", acceptance=["До"])
        second = self.create()
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("CREATE TRIGGER fail_rank BEFORE UPDATE OF priority ON tasks WHEN OLD.task_id='" + second["taskId"] + "' BEGIN SELECT RAISE(ABORT,'fixture'); END")
        args = {"items": [self.item(first, 0), self.item(second, 1)], "source": "model"}
        self.error(self.panel_response("tasks.rank", args, key="rank-retry"), "DB_UNAVAILABLE")
        self.assertEqual(self.card(first["taskId"]), first)
        self.assertEqual(self.card(second["taskId"]), second)
        self.assertEqual(self.rows("SELECT * FROM requests WHERE request_id='rank-retry'"), [])
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("DROP TRIGGER fail_rank")
            db.execute("CREATE TRIGGER fail_list BEFORE INSERT ON task_lists BEGIN SELECT RAISE(ABORT,'fixture'); END")
        self.error(self.panel_response("task.edit", {"taskId": first["taskId"], "expectedRevision": first["revision"],
                   "description": "После", "acceptance": ["После"]}), "DB_UNAVAILABLE")
        self.assertEqual(self.card(first["taskId"]), first)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("DROP TRIGGER fail_list")
        self.assertEqual(len(self.panel("tasks.rank", args, key="rank-retry")["changed"]), 2)

    def test_queue_orders_by_priority_and_moves_only_within_group(self):
        first = self.create("Фокус", priority=2)
        urgent = self.create("Срочно", priority=0)
        middle = self.create("Средняя", priority=1)
        peer = self.create("Срочно второе", priority=0)
        self.assertEqual([t["taskId"] for t in self.ok("snapshot")["tasks"]],
                         [urgent["taskId"], peer["taskId"], middle["taskId"], first["taskId"]])
        self.assertTrue(self.action_response(peer, "up")["ok"])
        self.assertEqual([t["taskId"] for t in self.ok("snapshot")["tasks"]],
                         [peer["taskId"], urgent["taskId"], middle["taskId"], first["taskId"]])
        peer = self.card(peer["taskId"])
        self.assertTrue(self.action_response(peer, "down")["ok"])
        for card, action in ((self.card(urgent["taskId"]), "up"), (self.card(peer["taskId"]), "down"), (middle, "up")):
            response = self.action_response(card, action)
            self.error(response, "INVALID_REQUEST")
            self.assertIn("приоритет", response["error"]["message"])
            self.assertEqual(self.card(card["taskId"]), card)

    def test_queue_config_defaults_panel_provenance_cli_and_gate_are_independent(self):
        self.assertEqual(self.ok("snapshot")["queue"], "run")
        self.assertEqual(self.ok("config.get", {"key": "queue"}), {"key": "queue", "value": "run", "provenance": "cli"})
        self.panel("config.set", {"key": "gate", "value": "observe"})
        cli = self.human("config", "set", "queue", "paused")
        self.assertEqual(cli.returncode, 0, cli.stderr)
        self.assertIn("paused", cli.stdout.decode())
        self.assertEqual(self.ok("config.get", {"key": "gate"})["provenance"], "panel")
        self.panel("config.set", {"key": "queue", "value": "paused"})
        self.assertEqual(self.ok("snapshot")["queue"], "paused")
        denied = self.human("config", "set", "queue", "run")
        self.assertEqual(denied.returncode, 1)
        self.assertIn(b"ATTESTATION_FAILED", denied.stderr)
        self.assertEqual(self.ok("config.get", {"key": "queue"})["value"], "paused")
        self.assertEqual(self.human("config", "get", "queue").returncode, 0)
        for key, value in (("queue", "off"), ("gate", "run")):
            self.error(self.panel_response("config.set", {"key": key, "value": value}), "INVALID_REQUEST")

    def test_new_text_projections_and_replays_mask_secrets_and_events_have_only_ids(self):
        secret = "sk-" + "Q" * 25
        text = f"<pasted_content>Проверить {secret}</pasted_content>\x1b\u202e"
        args = {"title": "Поручение", "description": text, "acceptance": [text], "constraints": [text]}
        result = self.panel("task.create", args, key="private-create")
        self.assertEqual(self.panel("task.create", args, key="private-create"), result)
        card = result["task"]
        self.assertNotIn(secret, json.dumps(card))
        self.assertIn("[REDACTED:api_key]", card["description"])
        for text in [card["description"], *card["acceptance"], *card["constraints"]]:
            self.assertNotIn("pasted_content", text)
            self.assertNotIn("\x1b", text)
            self.assertNotIn("\u202e", text)
        raw = self.rows("SELECT description FROM tasks")[0]["description"]
        self.assertEqual(raw, args["description"])
        self.assertNotIn(secret, json.dumps(self.rows("SELECT * FROM events")))
        self.assertNotIn("Проверить", json.dumps(self.rows("SELECT * FROM events")))
        self.edit(card, description="Новый приватный текст")
        self.assertNotIn("Новый приватный текст", json.dumps(self.rows("SELECT * FROM events")))

    def test_human_tasks_and_show_print_priority_pin_and_assignee(self):
        card = self.create(priority=0, assignee="antigravity", description="Описание для показа")
        for command in (("tasks",), ("show", card["taskId"])):
            result = self.human(*command)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("P0*", result.stdout.decode())
            self.assertIn("antigravity", result.stdout.decode())
        card = self.edit(card, pinned=False)
        self.assertIn("P0 ", self.human("tasks").stdout.decode())

    def test_edit_is_worktree_scoped_but_rank_is_project_scoped(self):
        other = self.other
        local = self.create()
        self.panel("session.attest", {}, cwd=other)
        remote = self.panel("task.create", {"title": "Соседнее дерево"}, cwd=other)["task"]
        self.error(self.panel_response("task.edit", {"taskId": remote["taskId"], "expectedRevision": remote["revision"],
                   "description": "Чужое"}), "NOT_FOUND")
        result = self.panel("tasks.rank", {"items": [self.item(remote, 0)], "source": "model"})
        self.assertEqual(result["changed"], [{"taskId": remote["taskId"], "priority": 0}])
        unrelated = self.root / "unrelated"
        unrelated.mkdir()
        self.panel("session.attest", {}, cwd=unrelated)
        foreign = self.panel("task.create", {"title": "Другой проект"}, cwd=unrelated)["task"]
        self.assertEqual(self.panel("tasks.rank", {"items": [self.item(foreign, 0)], "source": "jev"})["skipped"],
                         [{"taskId": foreign["taskId"], "reason": "not-found"}])
        self.assertEqual(self.card(local["taskId"]), local)


if __name__ == "__main__":
    unittest.main(verbosity=2)

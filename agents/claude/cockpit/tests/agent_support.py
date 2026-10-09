"""Общий вызов аттестованных операций владельца и агента."""
import secrets
from support import Harness


class AgentHarness(Harness):
    def setUp(self):
        super().setUp()
        if self._testMethodName in ("test_project_wide_duplicates_and_limit_ignore_candidates_deleted_and_done", "test_read_cli_and_worktree_binding"):
            self.other = self.linked_worktrees()
        self.secret = secrets.token_hex(32)
        self.signed("session.attest", actor="owner")

    def signed_response(self, op, args=None, actor="agent", **kwargs):
        return self.invoke({**self.request(op, args, **kwargs), "actor": actor, "panelSecret": self.secret})

    def signed(self, op, args=None, actor="agent", **kwargs):
        response = self.signed_response(op, args, actor, **kwargs)
        self.assertTrue(response["ok"], response)
        return response["result"]

    def create_agent(self, *titles, **kwargs):
        return self.signed("tasks.agent.create", {"tasks": [{"title": title} for title in titles]}, **kwargs)["tasks"]

    def owner_task(self, title="Поручение владельца", **fields):
        return self.signed("task.create", {"title": title, **fields}, actor="owner")["task"]

    def card(self, task_id):
        return self.ok("task.get", {"taskId": task_id})["task"]

    def action_args(self, card, action, **extra):
        return {"taskId": card["taskId"], "expectedRevision": card["revision"],
                "expectedFocusRevision": self.ok("focus.get")["revision"], "action": action, **extra}

    def agent_action(self, card, action, **extra):
        return self.signed("task.agent.action", self.action_args(card, action, **extra))

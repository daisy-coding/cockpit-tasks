#!/usr/bin/env python3
"""Каталоги внутри дерева сохраняют свидетельство; соседние деревья изолированы."""
import secrets
import unittest
from unittest.mock import patch

from support import Harness
from agents.claude.cockpit import rpc


class AttestationCwdTests(Harness):
    def signed(self, op, args=None, cwd=None, actor="owner", key=None):
        return {**self.request(op, args, cwd=cwd, key=key), "panelSecret": self.secret, "actor": actor}

    def test_subdirectory_uses_same_binding_and_key_including_cached_owner_read(self):
        self.linked_worktrees()
        nested = self.cwd / "agents" / "claude" / "plugins" / "cockpit"
        nested.mkdir(parents=True)
        self.secret = secrets.token_hex(32)
        self.assertTrue(self.invoke(self.signed("session.attest"))["ok"])
        root_binding = self.ok("tasks.context")["binding"]
        self.assertEqual(self.ok("tasks.context", cwd=nested)["binding"], root_binding)
        created = self.invoke(self.signed("tasks.agent.create", {"tasks": [{"title": "Проверить каталог"}]}, nested, "agent"))
        self.assertTrue(created["ok"])
        card = created["result"]["tasks"][0]
        self.assertTrue(self.invoke(self.signed("task.comment.add", {"taskId": card["taskId"], "text": "Комментарий владельца"}))["ok"])
        request = self.signed("task.get", {"taskId": card["taskId"]}, nested)
        first = self.invoke(request)
        self.assertTrue(first["ok"])
        self.assertEqual(self.invoke(request), first)
        self.assertEqual(first["result"]["comments"][0]["text"], "Комментарий владельца")
        focus = self.ok("focus.get", cwd=nested)
        response = self.invoke(self.signed("task.agent.action", {"taskId": card["taskId"], "expectedRevision": card["revision"],
            "expectedFocusRevision": focus["revision"], "action": "note", "note": "Запись из подкаталога"}, nested, "agent"))
        self.assertTrue(response["ok"])
        self.assertEqual(len(self.rows("SELECT * FROM session_attestations")), 1)

    def test_registered_subdirectory_does_not_launch_git_again(self):
        self.linked_worktrees()
        self.secret = secrets.token_hex(32)
        self.assertTrue(self.invoke(self.signed("session.attest"))["ok"])
        nested = self.cwd / "nested"
        nested.mkdir()
        with patch("agents.claude.cockpit.store.state_directory", return_value=str(self.state)), patch(
                "agents.claude.cockpit.identity.subprocess.run", side_effect=AssertionError("Git не нужен для зарегистрированного дерева")):
            response = rpc.handle(self.signed("snapshot", cwd=nested))
        self.assertTrue(response["ok"])

    def test_other_worktree_and_nested_repository_cannot_borrow_key(self):
        other = self.linked_worktrees()
        self.secret = secrets.token_hex(32)
        self.assertTrue(self.invoke(self.signed("session.attest"))["ok"])
        other_subdir = other / "nested"
        other_subdir.mkdir()
        self.ok("tasks.context", cwd=other)
        self.error(self.invoke(self.signed("tasks.agent.create", {"tasks": [{"title": "Чужая запись"}]}, other_subdir, "agent")), "ATTESTATION_FAILED")
        foreign = self.cwd / "nested-repository"
        foreign.mkdir()
        self.git(foreign, "init", "-b", "main")
        self.error(self.invoke(self.signed("snapshot", cwd=foreign)), "ATTESTATION_FAILED")
        self.assertNotEqual(self.ok("tasks.context", cwd=foreign)["binding"]["projectId"], self.ok("tasks.context")["binding"]["projectId"])

    def test_longest_registered_ancestor_and_path_boundary(self):
        self.ok("tasks.context")
        nested = self.cwd / "separate"
        nested.mkdir()
        # Существующая более глубокая привязка должна побеждать внешний каталог.
        import sqlite3
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("INSERT INTO projects VALUES ('nested-project','directory',?,'Отдельный проект','2026-10-05T00:00:00Z')", (str(nested),))
            db.execute("INSERT INTO worktrees VALUES ('nested-tree','nested-project',?)", (str(nested),))
        child = nested / "child"
        child.mkdir()
        self.assertEqual(self.ok("tasks.context", cwd=child)["binding"]["worktreeId"], "nested-tree")
        sibling = self.root / "checkout-extra"
        sibling.mkdir()
        self.assertNotEqual(self.ok("tasks.context", cwd=sibling)["binding"]["projectId"], self.ok("tasks.context")["binding"]["projectId"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

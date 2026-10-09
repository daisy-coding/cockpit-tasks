"""Изолированные фикстуры и вызовы реального CLI, без Claude и пользовательской БД."""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
CLI = REPO / "tools" / "cockpitctl.py"
sys.path.insert(0, str(REPO))


class Harness(unittest.TestCase):
    def setUp(self):
        # В peer worktree временные данные тоже остаются внутри разрешённого корня.
        self.temporary = tempfile.TemporaryDirectory(prefix=".cockpit-test-", dir=REPO)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cwd = self.root / "checkout"
        self.cwd.mkdir()
        self.state = self.root / "state"
        self.env = {
            "PATH": os.defpath,
            "COCKPIT_STATE_DIR": str(self.state),
            "GIT_CEILING_DIRECTORIES": str(REPO),
            "PYTHONDONTWRITEBYTECODE": "1",
        }

    def request(self, op, args=None, key=None, session="session-1", cwd=None):
        return {"v": 1, "op": op, "requestId": key or str(uuid.uuid4()),
                "session": {"sessionId": session, "cwd": str(cwd or self.cwd)},
                "args": args if args is not None else {}}

    def invoke(self, request=None, raw=None, cli=CLI):
        payload = raw if raw is not None else json.dumps(request, ensure_ascii=False).encode("utf-8")
        process = subprocess.run([sys.executable, str(cli), "rpc"], input=payload,
                                 capture_output=True, cwd=self.cwd, env=self.env, timeout=12)
        self.assertEqual(process.returncode, 0, process.stderr.decode("utf-8"))
        self.assertEqual(process.stderr, b"")
        self.assertEqual(len(process.stdout.splitlines()), 1, process.stdout)
        response = json.loads(process.stdout)
        self.assertEqual(response["v"], 1)
        self.assertEqual(set(response), {"v", "ok", "result"} if response["ok"] else {"v", "ok", "error"})
        return response

    def ok(self, op, args=None, **kwargs):
        response = self.invoke(self.request(op, args, **kwargs))
        self.assertTrue(response["ok"], response)
        return response["result"]

    def task_fixture(self, args=None, *, unstepped=False, bind_result=True, **kwargs):
        """Явная карточка для тестов M1: bind больше не создаёт её из реплики.

        Старые источники и исходная уверенность нужны проверкам приватности и
        происхождения; шаг отличает такую фикстуру поручения от заглушки.
        unstepped создаёт именно старую служебную запись для проверки совместимости.
        """
        from agents.claude.cockpit import domain
        snapshot = self.ok("snapshot", **kwargs)
        if snapshot["focus"]["task"] is not None:
            return self.ok("task.bind", args, **kwargs)
        binding = snapshot["binding"]
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            source = db.execute("""SELECT * FROM inbox WHERE session_id=? AND project_id=? AND worktree_id=?
                ORDER BY rowid DESC LIMIT 1""", (binding["sessionId"], binding["projectId"], binding["worktreeId"])).fetchone()
            title = "Работа без сохранённого указания"
            if source is not None:
                title = next((domain.shown(line, 80) for line in (source["raw_text"] or "").splitlines()
                              if line.strip()), "Работа по сохранённому указанию")
            task_id = domain.create_task(db, binding, title, "ad-hoc" if source else "no-source")
            if source:
                db.execute("INSERT INTO task_sources VALUES (?,?,?,0,?,?,'origin')",
                           (task_id, source["inbox_id"], binding["projectId"], source["raw_length"], source["raw_sha256"]))
            if not unstepped:
                db.execute("INSERT INTO task_steps VALUES (?,0,'Проверить поручение','pending')", (task_id,))
            domain.set_focus(db, binding, task_id)
            card = domain.task(db, task_id, binding["projectId"])
            revision = domain.focus(db, binding)["revision"]
        if unstepped or not bind_result:
            return {"task": card, "focusRevision": revision, "bound": "unbound"}
        return self.ok("task.bind", args, **kwargs)

    def error(self, response, code):
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], code)
        self.assertEqual(set(response["error"]), {"code", "message"})
        self.assertTrue(response["error"]["message"])

    def rows(self, sql, parameters=()):
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            result = [dict(row) for row in db.execute(sql, parameters)]
        db.close()
        return result

    def human(self, *args):
        return subprocess.run([sys.executable, str(CLI), *args], cwd=self.cwd, env=self.env,
                              capture_output=True, timeout=12)

    def git(self, directory, *args, payload=None):
        process = subprocess.run(["git", "-C", str(directory), *args], input=payload,
                                 capture_output=True, env=self.env, timeout=5)
        self.assertEqual(process.returncode, 0, process.stderr.decode("utf-8"))
        return process.stdout.decode("utf-8").strip()

    def linked_worktrees(self):
        self.git(self.cwd, "init", "-b", "main")
        tree = self.git(self.cwd, "mktree", payload=b"")
        # Только объекты одноразовой фикстуры; HEAD рабочего репозитория не меняется.
        commit = self.git(self.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                          "commit-tree", tree, payload="Начальная фикстура\n".encode("utf-8"))
        self.git(self.cwd, "update-ref", "refs/heads/main", commit)
        other = self.root / "second" / self.cwd.name
        other.parent.mkdir()
        self.git(self.cwd, "worktree", "add", "--detach", str(other), commit)
        return other


if __name__ == "__main__":
    raise SystemExit("Это вспомогательный модуль; запускайте *.test.py.")

#!/usr/bin/env python3
"""Комментарии владельца: настоящий RPC, границы чтения и переход 10→11."""
import ast
from concurrent.futures import ThreadPoolExecutor
import json
import secrets
import sqlite3
import subprocess
import unittest
from unittest.mock import patch

from agent_support import AgentHarness
from support import Harness, REPO
from agents.claude.cockpit import CockpitError
from agents.claude.cockpit.store import MIGRATIONS, SCHEMA_VERSION, Store


class OwnerCommentTests(AgentHarness):
    def setUp(self):
        Harness.setUp(self)
        if self._testMethodName == "test_foreign_task_worktree_project_and_deleted_task":
            self.other = self.linked_worktrees()
        self.secret = secrets.token_hex(32)
        self.signed("session.attest", actor="owner")

    def add(self, card, text="Первое дополнение", **kwargs):
        return self.signed("task.comment.add", {"taskId": card["taskId"], "text": text}, actor="owner", **kwargs)["comment"]

    def change(self, card, comment, op="edit", **kwargs):
        args = {"taskId": card["taskId"], "commentId": comment["commentId"], "expectedRevision": comment["revision"], **kwargs}
        return self.signed("task.comment." + op, args, actor="owner")

    def test_add_edit_delete_revisions_idempotency_and_events(self):
        card = self.owner_task()
        cursor = self.ok("tasks.context")["cursor"]
        request = {**self.request("task.comment.add", {"taskId": card["taskId"], "text": "Первая редакция"}),
                   "actor": "owner", "panelSecret": self.secret}
        added = self.invoke(request)
        self.assertTrue(added["ok"], added)
        self.assertEqual(self.invoke(request), added)
        comment = added["result"]["comment"]
        self.assertEqual(set(added["result"]), {"taskId", "comment"})
        self.assertEqual(set(comment), {"commentId", "text", "createdAt", "updatedAt", "revision"})
        self.assertEqual((comment["revision"], comment["createdAt"]), (0, comment["updatedAt"]))
        self.assertEqual(len(self.rows("SELECT * FROM task_owner_comments")), 1)
        edited = self.change(card, comment, text="Актуальная редакция")["comment"]
        self.assertEqual((edited["text"], edited["revision"], edited["createdAt"]), ("Актуальная редакция", 1, comment["createdAt"]))
        self.assertGreaterEqual(edited["updatedAt"], edited["createdAt"])
        context = self.ok("tasks.context", {"cursor": cursor})
        self.assertEqual(context["current"]["ownerComments"], [edited])
        self.assertEqual(self.ok("task.get", {"taskId": card["taskId"]})["comments"], [edited])
        deleted = self.change(card, edited, "delete")
        self.assertEqual(deleted, {"taskId": card["taskId"], "commentId": edited["commentId"], "revision": 2, "deleted": True})
        self.assertEqual(self.rows("SELECT deleted,revision FROM task_owner_comments"), [{"deleted": 1, "revision": 2}])
        self.assertEqual(self.card(card["taskId"])["revision"], card["revision"])
        context = self.ok("tasks.context", {"cursor": cursor})
        self.assertEqual(context["current"]["ownerComments"], [])
        self.assertEqual([c["action"] for c in context["ownerChanges"]], ["commented", "comment-edited", "comment-deleted"])
        self.assertTrue(all(c["taskId"] == card["taskId"] for c in context["ownerChanges"]))
        self.assertEqual([r["kind"] for r in self.rows("SELECT kind FROM events WHERE kind LIKE 'task.owner.comment%' ORDER BY event_id")],
                         ["task.owner.commented", "task.owner.comment-edited", "task.owner.comment-deleted"])
        self.assertEqual(self.ok("task.get", {"taskId": card["taskId"]})["comments"], [])

    def test_edit_delete_repeat_and_request_id_conflict(self):
        card = self.owner_task()
        comment = self.add(card)
        for op, extra in (("edit", {"text": "Новый текст"}), ("delete", {})):
            request = {**self.request("task.comment." + op, {"taskId": card["taskId"], "commentId": comment["commentId"],
                       "expectedRevision": comment["revision"], **extra}), "actor": "owner", "panelSecret": self.secret}
            response = self.invoke(request)
            self.assertTrue(response["ok"], response)
            self.assertEqual(self.invoke(request), response)
            self.error(self.invoke({**request, "args": {**request["args"], "expectedRevision": 99}}), "IDEMPOTENCY_CONFLICT")
            if op == "edit":
                comment = response["result"]["comment"]
        self.assertEqual(len(self.rows("SELECT * FROM events WHERE kind LIKE 'task.owner.comment%'")), 3)

    def test_stale_revision_and_deleted_comment_do_not_write(self):
        card = self.owner_task()
        comment = self.add(card)
        edited = self.change(card, comment, text="Последняя версия")["comment"]
        before = self.rows("SELECT * FROM task_owner_comments")
        for op in ("edit", "delete"):
            args = {"taskId": card["taskId"], "commentId": comment["commentId"], "expectedRevision": 0}
            if op == "edit":
                args["text"] = "Устаревшая версия"
            self.error(self.signed_response("task.comment." + op, args, actor="owner"), "REVISION_CONFLICT")
        self.assertEqual(self.rows("SELECT * FROM task_owner_comments"), before)
        self.change(card, edited, "delete")
        for op in ("edit", "delete"):
            args = {"taskId": card["taskId"], "commentId": edited["commentId"], "expectedRevision": 2}
            if op == "edit":
                args["text"] = "Восстановление"
            self.error(self.signed_response("task.comment." + op, args, actor="owner"), "NOT_FOUND")

    def test_agent_cli_missing_actor_forged_and_revoked_proof(self):
        card = self.owner_task()
        comment = self.add(card)
        cases = [("add", {"taskId": card["taskId"], "text": "Запрещено"}),
                 ("edit", {"taskId": card["taskId"], "commentId": comment["commentId"], "expectedRevision": 0, "text": "Запрещено"}),
                 ("delete", {"taskId": card["taskId"], "commentId": comment["commentId"], "expectedRevision": 0})]
        before = self.rows("SELECT * FROM task_owner_comments")
        for op, args in cases:
            with self.subTest(op=op):
                self.error(self.signed_response("task.comment." + op, args), "INVALID_REQUEST")
                self.error(self.invoke(self.request("task.comment." + op, args)), "ATTESTATION_FAILED")
                self.error(self.invoke({**self.request("task.comment." + op, args), "panelSecret": self.secret}), "INVALID_REQUEST")
                self.error(self.invoke({**self.request("task.comment." + op, args), "panelSecret": "de" * 32, "actor": "owner"}), "ATTESTATION_FAILED")  # gitleaks:allow
        self.assertEqual(self.rows("SELECT * FROM task_owner_comments"), before)
        binding = self.ok("snapshot")["binding"]
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("INSERT INTO attestation_revocations VALUES (?,?,?,'owner',?,?)",
                       (binding["sessionId"], binding["projectId"], binding["worktreeId"], binding["sessionId"], "2026-10-05T18:00:00.000000Z"))
        self.error(self.signed_response("task.comment.add", cases[0][1], actor="owner"), "ATTESTATION_FAILED")
        self.assertEqual(self.rows("SELECT * FROM task_owner_comments"), before)

    def test_foreign_task_worktree_project_and_deleted_task(self):
        other_tree = self.other
        self.signed("session.attest", actor="owner", cwd=other_tree)
        card = self.owner_task()
        comment = self.add(card)
        second = self.owner_task("Другая задача")
        foreign = self.signed("task.create", {"title": "Чужое дерево"}, actor="owner", cwd=other_tree)["task"]
        for task_id in (second["taskId"], foreign["taskId"], "missing"):
            for op in ("edit", "delete"):
                args = {"taskId": task_id, "commentId": comment["commentId"], "expectedRevision": 0}
                if op == "edit":
                    args["text"] = "Подмена"
                self.error(self.signed_response("task.comment." + op, args, actor="owner"), "NOT_FOUND")
        self.error(self.signed_response("task.comment.add", {"taskId": foreign["taskId"], "text": "Подмена"}, actor="owner"), "NOT_FOUND")
        other_project = self.root / "unrelated"
        other_project.mkdir()
        self.signed("session.attest", actor="owner", cwd=other_project)
        self.error(self.signed_response("task.comment.add", {"taskId": card["taskId"], "text": "Подмена"}, actor="owner", cwd=other_project), "NOT_FOUND")
        self.signed("task.action", self.action_args(card, "delete"), actor="owner")
        for op, extra in (("add", {"text": "Удалённая задача"}), ("edit", {"commentId": comment["commentId"], "expectedRevision": 0, "text": "Подмена"}),
                          ("delete", {"commentId": comment["commentId"], "expectedRevision": 0})):
            self.error(self.signed_response("task.comment." + op, {"taskId": card["taskId"], **extra}, actor="owner"), "NOT_FOUND")
        self.assertEqual(self.ok("task.get", {"taskId": card["taskId"]})["comments"], [])

    def test_all_task_statuses_can_be_commented(self):
        for status in ("active", "paused", "done", "cancelled"):
            with self.subTest(status=status):
                card = self.owner_task(status)
                with sqlite3.connect(self.state / "cockpit.db") as db:
                    db.execute("UPDATE tasks SET status=? WHERE task_id=?", (status, card["taskId"]))
                comment = self.add(card, status)
                edited = self.change(card, comment, text=status + " обновлён")["comment"]
                self.change(card, edited, "delete")

    def test_candidate_comments_do_not_change_task_stage_or_revision(self):
        card = self.owner_task()
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE tasks SET stage='candidate' WHERE task_id=?", (card["taskId"],))
        comment = self.add(card, "Уточнение предложения")
        edited = self.change(card, comment, text="Актуальное уточнение")["comment"]
        self.assertEqual(self.ok("task.get", {"taskId": card["taskId"]})["comments"], [edited])
        self.change(card, edited, "delete")
        self.assertEqual((self.card(card["taskId"])["stage"], self.card(card["taskId"])["revision"]), ("candidate", card["revision"]))

    def test_text_shape_limit_unicode_and_secret_filters(self):
        card = self.owner_task()
        for text in ("", "   \n", "\x00", "\x1b", "x" * 4001, None, 42):
            self.error(self.signed_response("task.comment.add", {"taskId": card["taskId"], "text": text}, actor="owner"), "INVALID_REQUEST")
        malformed = {**self.request("task.comment.add", {"taskId": card["taskId"], "text": "\ud800"}), "actor": "owner", "panelSecret": self.secret}
        self.error(self.invoke(raw=json.dumps(malformed).encode()), "INVALID_REQUEST")
        comment = self.add(card, "🐋" * 4000)
        self.assertEqual(len(comment["text"]), 4000)
        for value in (-1, True, "0", 2**63):
            self.error(self.signed_response("task.comment.delete", {"taskId": card["taskId"], "commentId": comment["commentId"], "expectedRevision": value}, actor="owner"), "INVALID_REQUEST")
        secret = "sk-" + "Q" * 25  # gitleaks:allow
        comment = self.add(card, f"Дополнение {secret}")
        self.assertNotIn(secret, json.dumps(comment))
        self.assertNotIn(secret, self.rows("SELECT text FROM task_owner_comments WHERE comment_id=?", (comment["commentId"],))[0]["text"])
        self.change(card, comment, text=f"Обновление {secret}")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("UPDATE task_owner_comments SET text=? WHERE comment_id=?", (secret, comment["commentId"]))
        for op, args in (("task.get", {"taskId": card["taskId"]}), ("tasks.context", {})):
            request = self.request(op, args)
            self.assertNotIn(secret, json.dumps(self.invoke(request)))
            self.assertNotIn(secret, json.dumps(self.invoke(request)))

    def test_creation_order_and_limit_survive_edits_and_deletes(self):
        card = self.owner_task()
        binding = self.ok("snapshot")["binding"]
        with sqlite3.connect(self.state / "cockpit.db") as db:
            for i in range(105):
                timestamp = f"2026-10-05T18:{i // 60:02}:{i % 60:02}.000000Z"
                db.execute("INSERT INTO task_owner_comments VALUES (?,?,?,?,?,?,?,?,0,0)",
                           (f"comment-{i}", card["taskId"], binding["projectId"], binding["worktreeId"], binding["sessionId"], str(i), timestamp, timestamp))
        comments = self.ok("task.get", {"taskId": card["taskId"]})["comments"]
        # Под пределом остаются свежие дополнения: давние не вытесняют то, что владелец написал последним.
        self.assertEqual([c["text"] for c in comments], [str(i) for i in range(5, 105)])
        self.change(card, comments[0], text="Первый исправлен")
        self.change(card, comments[1], "delete")
        comments = self.ok("tasks.context")["current"]["ownerComments"]
        self.assertEqual(len(comments), 100)
        self.assertEqual([c["commentId"] for c in comments], ["comment-4", "comment-5", *[f"comment-{i}" for i in range(7, 105)]])

    def test_cached_reads_never_return_previous_editions_or_deleted_text(self):
        card = self.owner_task()
        comment = self.add(card, "OLD-COMMENT-EDITION")
        requests = [self.request("task.get", {"taskId": card["taskId"]}), self.request("tasks.context")]
        requests += [{**self.request(op, args), "actor": "agent", "panelSecret": self.secret}
                     for op, args in (("task.get", {"taskId": card["taskId"]}), ("tasks.context", {}))]
        for request in requests:
            self.assertIn("OLD-COMMENT-EDITION", json.dumps(self.invoke(request)))
        edited = self.change(card, comment, text="CURRENT-COMMENT-EDITION")["comment"]
        for request in requests:
            output = json.dumps(self.invoke(request))
            self.assertNotIn("OLD-COMMENT-EDITION", output)
            self.assertIn("CURRENT-COMMENT-EDITION", output)
        self.change(card, edited, "delete")
        for request in requests:
            output = json.dumps(self.invoke(request))
            self.assertNotIn("OLD-COMMENT-EDITION", output)
            self.assertNotIn("CURRENT-COMMENT-EDITION", output)
        for op, args in (("task.get", {"taskId": card["taskId"]}), ("tasks.context", {}), ("snapshot", {}), ("focus.get", {}),
                         ("checkpoint.list", {"taskId": card["taskId"]}), ("doctor", {})):
            self.assertNotIn("CURRENT-COMMENT-EDITION", json.dumps(self.ok(op, args)))

    def test_event_failure_rolls_back_each_mutation_and_saved_response(self):
        card = self.owner_task()
        comment = self.add(card)
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("""CREATE TRIGGER owner_comment_failure BEFORE INSERT ON events
                WHEN NEW.kind LIKE 'task.owner.comment%'
                BEGIN SELECT RAISE(ABORT,'Сбой записи события'); END""")
        tables = ("task_owner_comments", "tasks", "events", "requests")
        before = {table: self.rows(f"SELECT * FROM {table} ORDER BY rowid") for table in tables}
        for op, extra in (("add", {"text": "Новая заметка"}), ("edit", {"text": "Изменение"}), ("delete", {})):
            args = {"taskId": card["taskId"], **extra}
            if op != "add":
                args.update(commentId=comment["commentId"], expectedRevision=0)
            self.error(self.signed_response("task.comment." + op, args, actor="owner"), "DB_UNAVAILABLE")
            for table in tables:
                self.assertEqual(self.rows(f"SELECT * FROM {table} ORDER BY rowid"), before[table], (op, table))

    def test_concurrent_edit_compare_and_swap_commits_exactly_one(self):
        card = self.owner_task()
        comment = self.add(card)
        def edit(text):
            return self.signed_response("task.comment.edit", {"taskId": card["taskId"], "commentId": comment["commentId"],
                                         "expectedRevision": 0, "text": text}, actor="owner")
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(edit, ("Первая вкладка", "Вторая вкладка")))
        successful = [response["result"]["comment"] for response in responses if response["ok"]]
        self.assertEqual(len(successful), 1)
        self.error(next(response for response in responses if not response["ok"]), "REVISION_CONFLICT")
        self.assertEqual(successful[0]["revision"], 1)
        self.assertEqual(self.ok("task.get", {"taskId": card["taskId"]})["comments"], successful)
        self.assertEqual(len(self.rows("SELECT * FROM events WHERE kind='task.owner.comment-edited'")), 1)


class MigrationElevenTests(Harness):
    def version_ten(self):
        self.state.mkdir(mode=0o700)
        timestamp = "2026-10-05T15:00:00.000000Z"
        with sqlite3.connect(self.state / "cockpit.db") as db:
            for version in range(1, 11):
                for statement in MIGRATIONS[version]:
                    db.execute(statement)
            db.execute("PRAGMA user_version=10")
            db.execute("INSERT INTO projects VALUES ('p','directory',?,'Проект',?)", (str(self.cwd), timestamp))
            db.execute("INSERT INTO worktrees VALUES ('w','p',?)", (str(self.cwd),))
            db.execute("INSERT INTO sessions VALUES ('s','p','w',?)", (timestamp,))
            db.execute("INSERT INTO tasks(task_id,project_id,worktree_id,alias_no,origin,title,status,revision,created_at,updated_at,description) VALUES ('t','p','w',1,'no-source','Задача 🐋','active',7,?,?,?)", (timestamp, timestamp, "Описание\r\n\x00🐋"))
            db.execute("INSERT INTO task_steps VALUES ('t',0,'Шаг','pending')")
            db.execute("INSERT INTO task_lists VALUES ('t','acceptance',0,'Критерий')")
            db.execute("INSERT INTO focus VALUES ('w','p','s','t',4)")
            for i, (kind, source, provenance) in enumerate((("note", "user", "panel"), ("note", "user", "panel"),
                        ("note", "user", "cli"), ("note", "agent", "tool"), ("commit", "user", "panel"))):
                db.execute("INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?,?,?,?)", (f"cp-{i}", "t", "p", "w", "s", kind, f"OLD-OWNER-{i}\r\n\x00🐋", source, timestamp, provenance))
            db.execute("INSERT INTO events(project_id,worktree_id,session_id,kind,entity_id,created_at) VALUES ('p','w','s','task.created','t',?)", (timestamp,))
            db.execute("INSERT INTO requests VALUES ('cached',?,?,?)", ("b" * 64, '{"v":1,"ok":true,"result":{"storageSchemaVersion":10,"title":"🐋"}}', timestamp))
            rows = {name: list(db.execute(f'SELECT rowid,* FROM "{name}" ORDER BY rowid'))
                    for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            schema = list(db.execute("SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master ORDER BY name"))
            return rows, schema, list(db.iterdump())

    def test_copy_only_panel_owner_notes_preserve_every_old_row_and_schema(self):
        before, schema, _ = self.version_ten()
        self.assertEqual(SCHEMA_VERSION, 13)
        with Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            for name, rows in before.items():
                self.assertEqual([tuple(row) for row in db.execute(f'SELECT rowid,* FROM "{name}" ORDER BY rowid')], rows, name)
            for definition in schema:
                self.assertEqual(tuple(db.execute("SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master WHERE name=?", (definition[1],)).fetchone()), definition)
            comments = [tuple(row) for row in db.execute("SELECT comment_id,text,created_at,updated_at,revision,deleted FROM task_owner_comments ORDER BY rowid")]
            self.assertEqual(comments, [(f"cp-{i}", f"OLD-OWNER-{i}\r\n\x00🐋", "2026-10-05T15:00:00.000000Z", "2026-10-05T15:00:00.000000Z", 0, 0) for i in range(2)])
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            after = list(db.iterdump())
        with Store(str(self.state)) as store:
            self.assertEqual(list(store.connection.iterdump()), after)
        self.assertEqual(list(self.state.glob("*.bak")), [])

    def test_failure_rolls_back_table_copy_and_schema_version(self):
        _, _, before = self.version_ten()
        with patch("agents.claude.cockpit.store.MIGRATIONS", {**MIGRATIONS, 11: (*MIGRATIONS.get(11, ()), "НЕКОРРЕКТНЫЙ SQL")}):
            with self.assertRaises(CockpitError):
                with Store(str(self.state)):
                    self.fail("Сбой миграции должен откатиться")
        with sqlite3.connect(self.state / "cockpit.db") as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 10)
            self.assertEqual(list(db.iterdump()), before)
        with Store(str(self.state)) as store:
            self.assertEqual(store.connection.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)

    def test_copy_preserves_leading_nul_and_storage_enforces_character_limit(self):
        self.version_ten()
        text = "\x00Прежняя заметка 🐋"
        with sqlite3.connect(self.state / "cockpit.db") as db:
            db.execute("INSERT INTO checkpoints VALUES ('nul','t','p','w','s','note',?,'user',?,'panel')",
                       (text, "2026-10-05T16:00:00.000000Z"))
        with Store(str(self.state)) as store:
            db = store.connection
            self.assertEqual(db.execute("SELECT text FROM task_owner_comments WHERE comment_id='nul'").fetchone()[0], text)
            self.assertEqual(db.execute("SELECT text FROM checkpoints WHERE checkpoint_id='nul'").fetchone()[0], text)
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO task_owner_comments VALUES ('too-long','t','p','w','s',?,'date','date',0,0)", ("\x00" + "x" * 4000,))

    def test_migrations_one_to_ten_remain_verbatim(self):
        path = "agents/claude/cockpit/store.py"
        original = subprocess.run(["git", "show", f"HEAD:{path}"], cwd=REPO, text=True, capture_output=True, check=True).stdout
        current = (REPO / path).read_text()
        def segments(source):
            assignment = next(node for node in ast.parse(source).body if isinstance(node, ast.Assign)
                              and any(isinstance(target, ast.Name) and target.id == "MIGRATIONS" for target in node.targets))
            return {key.value: ast.get_source_segment(source, value) for key, value in zip(assignment.value.keys, assignment.value.values)}
        old, new = segments(original), segments(current)
        self.assertEqual({i: new[i] for i in range(1, 11)}, {i: old[i] for i in range(1, 11)})

    def test_migrated_note_never_reappears_in_any_fresh_or_cached_read(self):
        self.version_ten()
        with patch("agents.claude.cockpit.store.SCHEMA_VERSION", 10), Store(str(self.state)) as store:
            from agents.claude.cockpit import domain, rpc
            old_note = {"checkpointId": "cp-0", "taskId": "t", "kind": "note", "source": "user", "provenance": "panel",
                        "text": "OLD-OWNER-0", "createdAt": "2026-10-05T15:00:00.000000Z"}
            card = {"taskId": "t", "projectId": "p", "worktreeId": "w", "lastCheckpoint": old_note}
            held = {"task": card, "revision": 4}
            old_results = {"task.get": {"task": card}, "tasks.context": {"current": {"taskId": "t", "ownerNotes": [old_note]}},
                           "snapshot": {"tasks": [card], "focus": held}, "focus.get": held,
                           "checkpoint.list": {"taskId": "t", "taskRevision": 7, "checkpoints": [old_note]}}
            requests = [self.request(op, args, session="s") for op, args in (("task.get", {"taskId": "t"}),
                        ("tasks.context", {}), ("snapshot", {}), ("focus.get", {}), ("checkpoint.list", {"taskId": "t"}))]
            for request in requests:
                result = old_results[request["op"]]
                store.connection.execute("INSERT INTO requests VALUES (?,?,?,?)", (request["requestId"], rpc.request_digest(request), json.dumps({"v": 1, "ok": True, "result": result}), domain.now()))
        secret = "ab" * 32  # gitleaks:allow
        self.assertTrue(self.invoke({**self.request("session.attest", session="s"), "panelSecret": secret})["ok"])
        for op, extra in (("edit", {"text": "CURRENT-OWNER-0"}), ("delete", {})):
            args = {"taskId": "t", "commentId": "cp-0", "expectedRevision": 0 if op == "edit" else 1, **extra}
            response = self.invoke({**self.request("task.comment." + op, args, session="s"), "panelSecret": secret, "actor": "owner"})
            self.assertTrue(response["ok"], response)
            for request in requests:
                for read in (request, {**request, "requestId": request["requestId"] + op}):
                    output = json.dumps(self.invoke(read))
                    self.assertNotIn("OLD-OWNER-0", output)
                    if op == "delete":
                        self.assertNotIn("CURRENT-OWNER-0", output)
        self.assertEqual(self.rows("SELECT text FROM checkpoints WHERE checkpoint_id='cp-0'")[0]["text"], "OLD-OWNER-0\r\n\x00🐋")


if __name__ == "__main__":
    unittest.main(verbosity=2)

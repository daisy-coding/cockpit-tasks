#!/usr/bin/env python3
"""Сквозная проверка доменного envelope и парсера против Cockpit M1/M2 без Claude."""
import json
import hashlib
import os
from pathlib import Path
import sqlite3
import secrets
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT))
from agents.claude.cockpit.store import SCHEMA_VERSION
from agents.claude.cockpit.domain import create_task
BUILDER = Path(__file__).with_name("runtime-requests.mjs")
REQUEST_COUNT = 0
PANEL_SECRET = None


def node(*args, stdin=None):
    return subprocess.run(
        ["node", "--experimental-strip-types", str(BUILDER), *args],
        cwd=ROOT, input=stdin, text=True, capture_output=True, check=True, timeout=10,
    ).stdout


def run_request(request, expected_kind):
    global REQUEST_COUNT
    wire = json.dumps(request, ensure_ascii=False, separators=(",", ":"))
    ran = subprocess.run(
        ["python3", str(ROOT / "tools/cockpitctl.py"), "rpc"],
        cwd=ROOT, input=wire, text=True, capture_output=True, check=True, timeout=5,
    )
    response = json.loads(ran.stdout)
    if PANEL_SECRET is not None:
        assert PANEL_SECRET not in ran.stdout and PANEL_SECRET not in ran.stderr
    assert not ran.stderr
    assert response["v"] == 1 and response["ok"] is (expected_kind != "error"), request["op"]
    parsed = json.loads(node("parse", stdin=json.dumps({"op": request["op"], "response": ran.stdout})))
    assert parsed["kind"] == expected_kind, request["op"]
    REQUEST_COUNT += 1
    print(f"{request['op']}: runtime ok:{str(response['ok']).lower()}; domain {expected_kind}; exit 0")
    return response.get("result", response.get("error"))


def check_description_summaries(session, panel_secret):
    def rpc(op, key, args, kind):
        request = json.loads(node('request', stdin=json.dumps({
            'op': op, 'requestId': f'cockpit-summary-{key}', 'session': session, 'args': args,
            'panelSecret': panel_secret, 'actor': 'owner',
        }, ensure_ascii=False)))
        return run_request(request, kind)

    description = 'Исправить перенос строк в карточке задачи. ' * 12
    card = rpc('task.create', 'create', {'title': 'Проверить сводку описания', 'description': description}, 'task-changed')['task']
    args = {'taskId': card['taskId'], 'expectedRevision': card['revision']}
    claim = rpc('task.summary.claim', 'claim', args, 'summary-claimed')
    assert claim['claimed'] and claim['description'] == description
    assert rpc('task.summary.claim', 'repeat', args, 'summary-claimed') == {'claimed': False}
    summary = 'Исправить перенос строк в карточке задачи.'
    assert rpc('task.summary.report', 'report', {'taskId': card['taskId'], 'descriptionHash': claim['descriptionHash'], 'summary': summary}, 'summary-reported')['summary'] == summary
    full = rpc('task.get', 'get', {'taskId': card['taskId']}, 'task')['task']
    assert full['description'] == description and full['summary'] == summary and full['revision'] == card['revision']
    page = rpc('tasks.page', 'page', {'list': 'queue', 'offset': 0, 'limit': 50, 'preview': 300}, 'page')
    assert next(row for row in page['tasks'] if row['taskId'] == card['taskId'])['summary'] == summary
    print('runtime-check summary: захват, повтор, отчёт, полный текст, ревизия и поле очереди сверены через TypeScript RPC')


def check_m2(session, task, focus_revision, inbox, state, panel_secret):
    def request(op, key, args):
        return json.loads(node("request", stdin=json.dumps({
            "op": op, "requestId": f"cockpit-m2-{key}", "session": session, "args": args,
            **({"panelSecret": panel_secret} if op in ("inbox.triage", "task.confirm", "checkpoint.add", "focus.detour", "focus.return") else {}),
        }, ensure_ascii=False)))

    def rpc(op, key, args, kind):
        return run_request(request(op, key, args), kind)

    selected = rpc("inbox.triage", "blocking", {
        "inboxId": inbox["inboxId"], "expectedRevision": inbox["triageRevision"],
        "type": "blocking", "taskId": task["taskId"],
    }, "triaged")
    assert selected["classifiedBy"] == "user" and selected["type"] == "blocking"
    assert selected["provenance"] == selected["triageProvenance"] == "panel"
    assert selected["scope"]["taskId"] == task["taskId"]
    counts = rpc("snapshot", "blocking-counts", {}, "snapshot")
    assert counts["inboxTriageCounts"] == {"untriaged": 1, "blocking": 1}
    conflict = rpc("inbox.triage", "triage-conflict", {
        "inboxId": inbox["inboxId"], "expectedRevision": inbox["triageRevision"], "status": "triaged",
    }, "error")
    assert conflict["code"] == "REVISION_CONFLICT"
    selected = rpc("inbox.triage", "triaged", {
        "inboxId": inbox["inboxId"], "expectedRevision": selected["triageRevision"], "status": "triaged",
    }, "triaged")
    counts = rpc("snapshot", "triaged-counts", {}, "snapshot")
    assert counts["inboxTriageCounts"] == {"untriaged": 0, "blocking": 0}

    confirmed = rpc("task.confirm", "confirm", {"taskId": task["taskId"], "expectedRevision": task["revision"]}, "confirmed")["task"]
    assert confirmed["certainty"] == "confirmed" and confirmed["certaintySource"] == "user"
    assert confirmed["certaintyProvenance"] == "panel"
    assert confirmed["source"] == task["source"] and confirmed["status"] == task["status"]
    secret = "sk" + "-" + "Q" * 24  # gitleaks:allow
    note_text = f"  Проверка RPC\r\n👩\x00 {secret} "
    note_request = request("checkpoint.add", "note", {
        "taskId": task["taskId"], "expectedRevision": confirmed["revision"], "kind": "note", "text": note_text, "source": "user",
    })
    assert note_request["args"]["text"] == note_text
    noted = run_request(note_request, "noted")
    assert secret not in noted["checkpoint"]["text"] and "[REDACTED:" in noted["checkpoint"]["text"]
    assert noted["checkpoint"]["kind"] == "note" and noted["checkpoint"]["source"] == "user"
    assert noted["checkpoint"]["provenance"] == "panel"
    assert run_request(note_request, "noted") == noted
    listed = rpc("checkpoint.list", "list", {"taskId": task["taskId"], "expectedRevision": noted["taskRevision"], "limit": 5}, "timeline")
    assert listed["taskRevision"] == noted["taskRevision"] and listed["checkpoints"] == [noted["checkpoint"]]

    detour_title = f"  Срочное исправление {secret} "
    detour_request = request("focus.detour", "detour", {"expectedRevision": focus_revision, "title": detour_title})
    assert detour_request["args"]["title"] == detour_title
    detoured = run_request(detour_request, "detoured")
    assert detoured["stackDepth"] == 1 and detoured["focus"]["task"]["certainty"] == "confirmed"
    assert secret not in detoured["focus"]["task"]["title"]
    assert run_request(detour_request, "detoured") == detoured
    stack = rpc("snapshot", "stack", {}, "snapshot")["focusStack"]
    assert len(stack) == 1 and stack[0]["provenance"] == "panel"
    selected = rpc("inbox.triage", "reopen", {
        "inboxId": inbox["inboxId"], "expectedRevision": selected["triageRevision"], "status": "untriaged",
    }, "triaged")
    returned_request = request("focus.return", "return", {"expectedRevision": detoured["focus"]["revision"]})
    returned = run_request(returned_request, "returned")
    assert returned["stackDepth"] == 0 and returned["focus"]["task"]["taskId"] == task["taskId"]
    packet = returned["returnPacket"]
    assert packet["taskId"] == task["taskId"] and packet["inbox"] == [selected]
    assert [entry["kind"] for entry in packet["checkpoints"]] == ["return", "detour", "note"]
    assert secret not in json.dumps(packet, ensure_ascii=False)
    assert run_request(returned_request, "returned") == returned
    empty = rpc("focus.return", "empty-stack", {"expectedRevision": returned["focus"]["revision"]}, "error")
    assert empty["code"] == "INVALID_REQUEST"
    invalid = rpc("checkpoint.add", "note-conflict", {
        "taskId": task["taskId"], "expectedRevision": confirmed["revision"], "kind": "note", "text": "Устаревшая отметка", "source": "user",
    }, "error")
    assert invalid["code"] == "REVISION_CONFLICT"
    invalid = rpc("task.confirm", "confirm-conflict", {"taskId": task["taskId"], "expectedRevision": confirmed["revision"]}, "error")
    assert invalid["code"] == "REVISION_CONFLICT"
    invalid = rpc("focus.detour", "detour-conflict", {"expectedRevision": focus_revision, "title": "Устаревший отход"}, "error")
    assert invalid["code"] == "REVISION_CONFLICT"
    invalid = rpc("focus.return", "return-conflict", {"expectedRevision": detoured["focus"]["revision"]}, "error")
    assert invalid["code"] == "REVISION_CONFLICT"
    invalid = rpc("checkpoint.list", "list-conflict", {"taskId": task["taskId"], "expectedRevision": confirmed["revision"], "limit": 5}, "error")
    assert invalid["code"] == "REVISION_CONFLICT"
    final = rpc("snapshot", "final", {}, "snapshot")
    assert final["focus"] == returned["focus"]
    with sqlite3.connect(state / "cockpit.db") as connection:
        assert connection.execute("SELECT text FROM checkpoints WHERE kind='note'").fetchone()[0] == note_text
        assert connection.execute("SELECT title FROM tasks WHERE task_id=?", (detoured["focus"]["task"]["taskId"],)).fetchone()[0] == detour_title
        assert connection.execute("SELECT count(*) FROM focus_stack").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM checkpoints WHERE kind='note'").fetchone()[0] == 1
    print("runtime-check M2: все 6 операций приняты; triageCounts и ревизии сверены; note/detour дословны в БД и фильтруются на выходе; повторы идемпотентны; пустой стек не меняет фокус")


def check_gate(session, state, panel_secret):
    def request(op, key, args, current=session, proof=None):
        return json.loads(node("request", stdin=json.dumps({
            "op": op, "requestId": f"cockpit-gate-{key}", "session": current, "args": args,
            **({"panelSecret": proof} if proof is not None else {}),
        }, ensure_ascii=False)))

    def change_mode(mode):
        ran = subprocess.run(["python3", str(ROOT / "tools/cockpitctl.py"), "--cwd", session["cwd"],
                              "config", "set", "gate", mode], text=True, capture_output=True, check=True, timeout=5)
        assert mode in ran.stdout

    path = str(Path(session["cwd"]) / "gate-file.ts")
    args = {"resourcePath": path, "staleRead": False}
    off = run_request(request("gate.check", "off-default", args), "gated")
    assert off["gate"]["mode"] == "off" and off["observation"] is None
    change_mode("observe")
    blocked_request = request("gate.check", "blocking-inbox", args)
    blocked = run_request(blocked_request, "gated")
    assert blocked["observation"]["outcome"] == "BLOCK" and blocked["observation"]["reasons"] == ["blocking-inbox"]
    assert blocked["bound"] == "existing" and blocked["observation"]["resource"]["path"].endswith("gate-file.ts")
    assert run_request(blocked_request, "gated") == blocked
    fresh = run_request(request("snapshot", "pending", {}), "snapshot")
    entry = next(row for row in fresh["inbox"] if row["type"] == "blocking")
    cli = run_request(request("inbox.triage", "cli-resolve", {
        "inboxId": entry["inboxId"], "expectedRevision": entry["triageRevision"], "status": "triaged",
    }), "triaged")
    assert cli["triageProvenance"] == "cli" and cli["triageStatus"] == "triaged"
    cli_blocked = run_request(request("gate.check", "cli-still-blocks", args), "gated")
    assert cli_blocked["observation"]["reasons"] == ["blocking-inbox"]
    cli = run_request(request("inbox.triage", "cli-hide", {
        "inboxId": entry["inboxId"], "expectedRevision": cli["triageRevision"],
        "type": "info", "taskId": None, "resourceId": None, "status": "triaged",
    }), "triaged")
    assert cli["type"] == "info" and cli["triageProvenance"] == "cli"
    hidden_blocked = run_request(request("gate.check", "cli-hide-still-blocks", args), "gated")
    assert hidden_blocked["observation"]["reasons"] == ["blocking-inbox"]
    wrong = run_request(request("inbox.triage", "forged-resolve", {
        "inboxId": entry["inboxId"], "expectedRevision": cli["triageRevision"], "status": "triaged",
    }, proof=secrets.token_hex(32)), "error")
    assert wrong["code"] == "ATTESTATION_FAILED"
    run_request(request("inbox.triage", "resolve", {
        "inboxId": entry["inboxId"], "expectedRevision": cli["triageRevision"], "status": "triaged",
    }, proof=panel_secret), "triaged")
    allowed = run_request(request("gate.check", "allow", args), "gated")
    assert allowed["observation"]["outcome"] == "ALLOW"
    foreign_session = {**session, "sessionId": "cockpit-gate-other"}
    foreign = run_request(request("gate.check", "foreign-stale", {**args, "staleRead": True}, foreign_session), "gated")
    assert foreign["observation"]["reasons"] == ["foreign-lease", "stale-read"]
    assert run_request(request("session.end", "foreign-end", {}, foreign_session), "released")["released"] == 0
    assert run_request(request("session.end", "owner-end", {}), "released")["released"] == 1
    after_end = run_request(request("gate.check", "after-end", args, foreign_session), "gated")
    assert after_end["observation"]["outcome"] == "ALLOW"
    run_request(request("task.update", "done", {"taskId": after_end["task"]["taskId"],
        "expectedRevision": after_end["task"]["revision"], "status": "done"}, foreign_session), "updated")
    bound = run_request(request("gate.check", "bind", args, foreign_session), "gated")
    assert bound["bound"] == "unbound" and bound["task"] is None and bound["observation"]["outcome"] == "ALLOW"
    change_mode("off")
    disabled = run_request(request("gate.check", "off-again", {**args, "staleRead": True}, foreign_session), "gated")
    assert disabled["gate"]["mode"] == "off" and disabled["observation"] is None
    for command in (["gate", "stats", "--days", "1"], ["gate", "recent", "--limit", "2"]):
        ran = subprocess.run(["python3", str(ROOT / "tools/cockpitctl.py"), "--cwd", session["cwd"], *command],
                              capture_output=True, text=True, check=True, timeout=5)
        assert ("BLOCK=4" if command[1] == "stats" else "ALLOW") in ran.stdout
    with sqlite3.connect(state / "cockpit.db") as db:
        # Пять прежних наблюдений и два новых BLOCK после разбора через CLI.
        expected = [
            (blocked, "BLOCK", ["blocking-inbox"]),
            (cli_blocked, "BLOCK", ["blocking-inbox"]),
            (hidden_blocked, "BLOCK", ["blocking-inbox"]),
            (allowed, "ALLOW", []),
            (foreign, "BLOCK", ["foreign-lease", "stale-read"]),
            (after_end, "ALLOW", []),
        ]
        observations = list(db.execute("SELECT observation_id,outcome,reasons_json FROM gate_observations ORDER BY observation_id"))
        assert len(observations) == len(expected), observations
        for row, (response, outcome, reasons) in zip(observations, expected, strict=True):
            assert (row[0], row[1], json.loads(row[2])) == (response["observation"]["observationId"], outcome, reasons), row
        assert db.execute("SELECT COUNT(*) FROM gate_observations").fetchone()[0] == 6
        unbound = json.loads(db.execute("SELECT entity_id FROM events WHERE kind='gate.unbound'").fetchone()[0])
        assert unbound == {"outcome": "ALLOW", "reasons": [], "resourceId": bound["observation"]["resource"]["resourceId"]}
        assert db.execute("SELECT COUNT(*) FROM gate_observations WHERE outcome='BLOCK'").fetchone()[0] == 4
        assert db.execute("SELECT session_id FROM worktree_leases").fetchone()[0] == foreign_session["sessionId"]
    print("runtime-check gate: 7 наблюдений (ALLOW=3, BIND=0, BLOCK=4) сверены с ответами и причинами; последнее без задачи в events; off без наблюдений; bind, аренда, scoped Inbox, stale-read, session.end и идемпотентность проверены")


def seed_candidate(state, session, inbox_id, title, steps=()):
    # Фикстура прежнего кандидата в изолированной БД: модельный путь мода удалён,
    # но чтение snapshot, принятие и связь с оригиналом проверяются по-прежнему.
    with sqlite3.connect(state / "cockpit.db") as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        source = db.execute("SELECT * FROM inbox WHERE inbox_id=?", (inbox_id,)).fetchone()
        assert source is not None and source["session_id"] == session["sessionId"]
        binding = {"projectId": source["project_id"], "worktreeId": source["worktree_id"], "sessionId": source["session_id"]}
        task_id = create_task(db, binding, title, origin="ad-hoc", certainty="inferred",
                              certainty_source="provider", provenance="panel", stage="candidate")
        db.execute("INSERT INTO task_sources VALUES (?,?,?,?,?,?,'origin')",
                   (task_id, inbox_id, source["project_id"], 0, source["raw_length"], source["raw_sha256"]))
        for position, step in enumerate(steps):
            db.execute("INSERT INTO task_steps VALUES (?,?,?,'pending')", (task_id, position, step))
        assert not db.execute("PRAGMA foreign_key_check").fetchall()
    return task_id


def check_tasks(session, state, panel_secret):
    def rpc(op, key, args, kind, signed=False):
        request = json.loads(node("request", stdin=json.dumps({
            "op": op, "requestId": "cockpit-tasks-" + key, "session": session, "args": args,
            **({"panelSecret": panel_secret} if signed else {}),
        }, ensure_ascii=False)))
        return run_request(request, kind)

    secret_like = "sk-" + "Q" * 25  # gitleaks:allow
    card = rpc("task.create", "create", {"title": "Карточка панели", "steps": ["Собрать", "Проверить"],
               "description": "Описание " + secret_like, "acceptance": ["Проверено"],
               "constraints": ["Не менять UI"], "assignee": "codex", "priority": 1}, "task-changed", True)
    actual = rpc("task.get", "get", {"taskId": card["task"]["taskId"]}, "task")["task"]
    assert actual["steps"][0]["title"] == "Собрать"
    changed = rpc("task.action", "current", {"taskId": actual["taskId"], "expectedRevision": actual["revision"],
                  "expectedFocusRevision": card["focus"]["revision"], "action": "current"}, "task-changed", True)
    assert changed["focus"]["task"]["taskId"] == actual["taskId"]
    assert changed["task"]["steps"][0]["status"] == "active"
    assert actual["assignee"] == "codex" and actual["priorityPinned"] is True
    assert secret_like not in actual["description"] and "[REDACTED:" in actual["description"]
    assert actual["acceptance"] == ["Проверено"] and actual["constraints"] == ["Не менять UI"]
    item = {"taskId": actual["taskId"], "expectedRevision": changed["task"]["revision"], "priority": 0}
    ranked = rpc("tasks.rank", "pinned", {"items": [item], "source": "model"}, "ranked", True)
    assert ranked == {"changed": [], "skipped": [{"taskId": actual["taskId"], "reason": "pinned"}]}
    edited = rpc("task.edit", "unpin", {"taskId": actual["taskId"], "expectedRevision": changed["task"]["revision"],
                 "pinned": False, "description": "Уточнённое описание"}, "updated", True)["task"]
    assert edited["priorityPinned"] is False and edited["prioritySource"] == "user"
    ranked = rpc("tasks.rank", "rank", {"items": [{**item, "expectedRevision": edited["revision"]}], "source": "jev"}, "ranked", True)
    assert ranked == {"changed": [{"taskId": actual["taskId"], "priority": 0}], "skipped": []}
    rpc("config.set", "pause", {"key": "queue", "value": "paused"}, "configured", True)
    assert rpc("config.get", "queue", {"key": "queue"}, "configured")["value"] == "paused"
    queue = rpc("snapshot", "paused-snapshot", {}, "snapshot")
    assert queue["queue"] == "paused" and queue["tasks"][0]["taskId"] == actual["taskId"]
    assert not set(queue["tasks"][0]) & {"description", "acceptance", "constraints"}
    captured = rpc("capture.prompt", "source", {"text": "Исправить очередь и проверить возврат"}, "captured")
    material = rpc("inbox.material", "material", {"inboxId": captured["inboxId"]}, "material")
    assert material["material"] == "Исправить очередь и проверить возврат"
    candidate_id = seed_candidate(state, session, captured["inboxId"], "Очередь", ["Возврат"])
    candidate = rpc("task.get", "candidate", {"taskId": candidate_id}, "task")["task"]
    assert candidate["sourcePhrase"] == material["material"]
    assert candidate["certaintyProvenance"] == "panel"
    snap = rpc("snapshot", "snapshot", {"limits": {"tasks": 100, "inbox": 10}}, "snapshot")
    assert not any(item["taskId"] == candidate_id for item in snap["tasks"])
    assert any(item["taskId"] == candidate_id for item in snap["candidates"])
    assert snap["candidateCount"] == 1
    # Запросы панели со страницами: снимок без списка задач и три страницы — на той же базе, где есть текущая
    # задача с шагами, закреплённый приоритет, кандидат и входящие. Разбор мода обязан принять каждый ответ.
    paged = rpc("snapshot", "paged-snapshot", {"limits": {"tasks": 0, "inbox": 10}}, "snapshot")
    assert paged["tasks"] == [] and paged["focus"]["task"]["taskId"] == actual["taskId"]
    assert paged["taskCounts"]["active"] >= 1
    for name in ("queue", "deferred", "closed"):
        rpc("tasks.page", "paged-" + name, {"list": name, "offset": 0, "limit": 50}, "page")
    previewed = rpc("snapshot", "preview-snapshot", {"limits": {"tasks": 0, "inbox": 10, "preview": 1200}}, "snapshot")
    assert previewed["tasks"] == [] and previewed["focus"]["task"]["description"] == edited["description"]
    queued_card = rpc("task.create", "preview-create", {"title": "Превью очереди", "description": "Проверить 🧪\n" * 180}, "task-changed", True)["task"]
    page_preview = rpc("tasks.page", "preview-page", {"list": "queue", "offset": 0, "limit": 50, "preview": 1200}, "page")
    row = next(item for item in page_preview["tasks"] if item["taskId"] == queued_card["taskId"])
    assert row["description"] == queued_card["description"][:1198] + " …"
    assert all(len(item["description"]) <= 1200 for item in page_preview["tasks"])
    rpc("focus.detour", "preview-detour", {"expectedRevision": previewed["focus"]["revision"], "taskId": queued_card["taskId"]}, "detoured", True)
    working_preview = rpc("snapshot", "preview-working", {"limits": {"tasks": 0, "preview": 1200}}, "snapshot")
    assert working_preview["workingTasks"][0]["description"] == edited["description"]
    print("runtime-check tasks: поля поручения, закрепление, task.edit, tasks.rank, queue, карточка, шаги, аттестованное действие, безопасный материал, превью очереди и workingTasks, прежние кандидаты проверены парсером TypeScript против Python RPC")


def check_agent(session, panel_secret):
    def request(op, args, actor=None):
        wire = {"op": op, "requestId": secrets.token_hex(16), "session": session, "args": args}
        if actor is not None:
            wire.update(panelSecret=panel_secret, actor=actor)
        # Старый помощник не передаёт actor; вызываем тот же настоящий builder
        # напрямую, не меняя файлы помощника или панели другого исполнителя.
        script = """import { buildRequest } from './agents/claude/plugins/cockpit/hooks/domain/rpc.ts';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const value = JSON.parse(input);
process.stdout.write(JSON.stringify(buildRequest(value.op, value.requestId, value.session, value.args, value.panelSecret, value.actor)));"""
        ran = subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "-e", script],
                             cwd=ROOT, input=json.dumps(wire, ensure_ascii=False), text=True, capture_output=True, timeout=10)
        assert ran.returncode == 0, ran.stderr
        return json.loads(ran.stdout)

    context = run_request(request("tasks.context", {}), "context")
    assert context["current"] is None and context["ownerChanges"] == []
    assert context["ownerChangesOmitted"] == 0
    private = "sk-" + "Q" * 25  # gitleaks:allow
    batch = request("tasks.agent.create", {"tasks": [{"title": "Агент: проверка", "description": private}, {"title": "АГЕНТ ПРОВЕРКА!"}]}, "agent")
    created = run_request(batch, "agent-created")
    assert [task["duplicate"] for task in created["tasks"]] == [False, True]
    assert created["tasks"][0]["taskId"] == created["tasks"][1]["taskId"]
    assert run_request(batch, "agent-created") == created
    card = created["tasks"][0]
    page = run_request(request("tasks.page", {"list": "queue", "offset": 0, "limit": 30}, "agent"), "page")
    assert page["total"] == 1 and page["tasks"][0]["taskId"] == card["taskId"]
    assert set(page["tasks"][0]) == {"taskId", "alias", "title", "status", "updatedAt", "priorityPinned",
        "priority", "queuePosition", "revision", "needsDecision", "stepCounts", "discussionCount", "certaintySource",
        "createdAt", "elapsedMs", "activeSince", "returnCount"}
    assert page["tasks"][0]["stepCounts"] == {"total": 0, "done": 0, "active": 0}
    assert page["tasks"][0]["discussionCount"] == 0
    for actor in ("agent", "owner"):
        found = run_request(request("tasks.search", {"query": "АГЕНТ провер"}, actor), "search")
        assert found["lists"]["queue"]["total"] == 1
        assert found["lists"]["queue"]["rows"][0]["taskId"] == card["taskId"]
        assert found["lists"]["queue"]["rows"][0]["match"]["field"] == "title"
        assert not found["truncated"]
    assert run_request(request("tasks.search", {"query": " "}), "error")["code"] == "INVALID_REQUEST"
    resolved = run_request(request("task.resolve", {"alias": card["alias"]}, "agent"), "resolved")
    assert resolved == {**{key: card[key] for key in ("taskId", "alias", "title", "revision")}, "status": "active"}
    assert run_request(request("task.resolve", {"alias": "TASK-999999"}), "error")["code"] == "NOT_FOUND"
    args = {"taskId": card["taskId"], "expectedRevision": card["revision"], "expectedFocusRevision": 0, "action": "current"}
    taken = run_request(request("task.agent.action", args, "agent"), "agent-acted")
    assert taken["task"]["certaintySource"] == "agent" and taken["task"]["certaintyProvenance"] == "tool"
    assert taken["focus"]["task"]["taskId"] == card["taskId"]
    context = run_request(request("tasks.context", {}), "context")
    assert private not in json.dumps(context)
    assert context["current"]["ownerNotesOmitted"] == context["current"]["agentNotesOmitted"] == 0
    owner = run_request(request("task.edit", {"taskId": card["taskId"], "expectedRevision": taken["task"]["revision"],
                                                "description": "Дополнение владельца"}, "owner"), "updated")
    changes = run_request(request("tasks.context", {"cursor": context["cursor"]}), "context")
    assert [change["action"] for change in changes["ownerChanges"]] == ["edited"]
    args.update(expectedRevision=owner["task"]["revision"], expectedFocusRevision=taken["focus"]["revision"], action="note", note="Заметка агента")
    noted = run_request(request("task.agent.action", args, "agent"), "agent-acted")
    assert noted["note"]["provenance"] == "tool" and noted["note"]["source"] == "agent"
    args.update(expectedRevision=noted["task"]["revision"], action="defer")
    args.pop("note")
    deferred = run_request(request("task.agent.action", args, "agent"), "agent-acted")
    assert deferred["task"]["status"] == "paused" and deferred["focus"]["task"] is None
    args.update(expectedRevision=deferred["task"]["revision"], expectedFocusRevision=deferred["focus"]["revision"], action="current")
    taken = run_request(request("task.agent.action", args, "agent"), "agent-acted")
    args.update(expectedRevision=taken["task"]["revision"], expectedFocusRevision=taken["focus"]["revision"], action="done", note="Проверено")
    done = run_request(request("task.agent.action", args, "agent"), "agent-acted")
    assert done["task"]["status"] == "done" and done["focus"]["task"] is None
    reopened = run_request(request("task.reopen", {"taskId": card["taskId"], "expectedRevision": done["task"]["revision"]}, "owner"), "task-changed")
    assert reopened["task"]["status"] == "active" and reopened["focus"]["task"] is None
    print("runtime-check agent: пакет, дубли, actor/tool, фокус, заметка, отсрочка, завершение, возврат владельцем, курсор и фильтр сводки сверены")


def check_owner_comments(session, panel_secret):
    def request(op, args, actor=None):
        wire = {"op": op, "requestId": secrets.token_hex(16), "session": session, "args": args}
        if actor is not None:
            wire.update(panelSecret=panel_secret, actor=actor)
        script = """import { buildRequest } from './agents/claude/plugins/cockpit/hooks/domain/rpc.ts';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const value = JSON.parse(input);
process.stdout.write(JSON.stringify(buildRequest(value.op, value.requestId, value.session, value.args, value.panelSecret, value.actor)));"""
        ran = subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "-e", script],
                             cwd=ROOT, input=json.dumps(wire, ensure_ascii=False), text=True, capture_output=True, timeout=10)
        assert ran.returncode == 0, ran.stderr
        return json.loads(ran.stdout)

    def parsed(op, result):
        return json.loads(node("parse", stdin=json.dumps({"op": op, "response": json.dumps({"v": 1, "ok": True, "result": result})})))

    card = run_request(request("task.create", {"title": "Комментарии владельца"}, "owner"), "task-changed")["task"]
    run_request(request("task.action", {"taskId": card["taskId"], "expectedRevision": card["revision"],
                "expectedFocusRevision": run_request(request("focus.get", {}), "focused")["revision"], "action": "current"}, "owner"), "task-changed")
    cursor = run_request(request("tasks.context", {}), "context")["cursor"]
    secret_like = "sk-" + "Q" * 25  # gitleaks:allow
    add_request = request("task.comment.add", {"taskId": card["taskId"], "text": "Первая редакция " + secret_like}, "owner")
    added = run_request(add_request, "owner-commented")
    assert run_request(add_request, "owner-commented") == added
    comment = added["comment"]
    assert secret_like not in comment["text"] and comment["revision"] == 0
    get_request, context_request = request("task.get", {"taskId": card["taskId"]}), request("tasks.context", {"cursor": cursor})
    assert run_request(get_request, "task")["comments"] == [comment]
    context = run_request(context_request, "context")
    assert context["current"]["ownerComments"] == [comment]
    assert parsed("task.get", {"task": card, "comments": [comment]})["comments"] == [comment]
    edit_request = request("task.comment.edit", {"taskId": card["taskId"], "commentId": comment["commentId"], "expectedRevision": 0, "text": "Актуальная редакция"}, "owner")
    edited = run_request(edit_request, "owner-comment-edited")
    assert run_request(edit_request, "owner-comment-edited") == edited
    assert run_request(get_request, "task")["comments"] == [edited["comment"]]
    assert run_request(context_request, "context")["current"]["ownerComments"] == [edited["comment"]]
    stale = run_request(request("task.comment.delete", {"taskId": card["taskId"], "commentId": comment["commentId"], "expectedRevision": 0}, "owner"), "error")
    assert stale["code"] == "REVISION_CONFLICT"
    delete_request = request("task.comment.delete", {"taskId": card["taskId"], "commentId": comment["commentId"], "expectedRevision": 1}, "owner")
    deleted = run_request(delete_request, "owner-comment-deleted")
    assert deleted == {"taskId": card["taskId"], "commentId": comment["commentId"], "revision": 2, "deleted": True}
    assert run_request(delete_request, "owner-comment-deleted") == deleted
    assert run_request(get_request, "task")["comments"] == []
    assert run_request(context_request, "context")["current"]["ownerComments"] == []
    context = run_request(request("tasks.context", {"cursor": cursor}), "context")
    assert [item["action"] for item in context["ownerChanges"]] == ["commented", "comment-edited", "comment-deleted"]
    assert all(item["taskId"] == card["taskId"] for item in context["ownerChanges"])
    for dirty in ({**comment, "revision": True}, {**comment, "text": "x" * 4001}, {**comment, "deleted": True},
                  {**comment, "updatedAt": "2000-01-01T00:00:00.000000Z"}, {**comment, "commentId": "../foreign"}):
        assert parsed("task.comment.add", {"taskId": card["taskId"], "comment": dirty})["kind"] == "unknown"
        assert parsed("task.get", {"task": card, "comments": [dirty]})["kind"] == "unknown"
        bad_context = {**context, "current": {**context["current"], "ownerComments": [dirty]}}
        assert parsed("tasks.context", bad_context)["kind"] == "unknown"
    for comments in ([comment, comment], [comment] * 101):
        assert parsed("task.get", {"task": card, "comments": comments})["kind"] == "unknown"
    clean = parsed("task.comment.edit", {"taskId": card["taskId"], "comment": {**comment, "text": secret_like, "history": ["Прежний текст"]}})
    assert secret_like not in json.dumps(clean) and "history" not in json.dumps(clean)
    for result in ({**deleted, "deleted": False}, {**deleted, "revision": 0}, {**deleted, "commentId": "../foreign"}):
        assert parsed("task.comment.delete", result)["kind"] == "unknown"
    print("runtime-check owner-comments: три операции, идемпотентность, ревизия комментария, task.get, сводка и её кэш, ownerChanges, секреты и отказы парсера сверены")


def main():
    global PANEL_SECRET
    # Все временные файлы остаются внутри worktree и удаляются после проверки.
    with tempfile.TemporaryDirectory(prefix="cockpit-e2e-", dir=ROOT) as directory:
        scratch = Path(directory)
        cwd = scratch / "project"
        cwd.mkdir()
        state = scratch / "state"
        os.putenv("COCKPIT_STATE_DIR", str(state))
        os.putenv("PYTHONDONTWRITEBYTECODE", "1")
        os.putenv("GIT_CEILING_DIRECTORIES", str(ROOT))
        requests = json.loads(node("build", str(cwd)))
        PANEL_SECRET = secrets.token_hex(32)
        registration = json.loads(node("request", stdin=json.dumps({
            "op": "session.attest", "requestId": "cockpit-e2e-attest", "session": requests[0]["session"], "args": {}, "panelSecret": PANEL_SECRET,
        })))
        assert run_request(registration, "attested") == {"attested": True}
        results = []
        for request, expected_kind in zip(requests, ("captured", "bound", "snapshot"), strict=True):
            if request["op"] == "task.bind":
                candidate_id = seed_candidate(state, request["session"], results[0]["inboxId"], "Проверить RPC мода")
                candidate = run_request({"v": 1, "op": "task.get", "requestId": "cockpit-e2e-candidate", "session": request["session"],
                                         "args": {"taskId": candidate_id}}, "task")["task"]
                before = run_request({"v": 1, "op": "snapshot", "requestId": "cockpit-e2e-before-adopt", "session": request["session"],
                                      "args": {}}, "snapshot")
                assert before["focus"]["task"] is None
                assert candidate["stage"] == "candidate"
                assert candidate["queuePosition"] is None
                adoption = json.loads(node("request", stdin=json.dumps({
                    "op": "candidate.adopt", "requestId": "cockpit-e2e-adopt", "session": request["session"],
                    "args": {"taskId": candidate_id, "expectedRevision": candidate["revision"]}, "panelSecret": PANEL_SECRET,
                })))
                adopted = run_request(adoption, "adopted")["task"]
                assert adopted["stage"] == "task" and adopted["adoptedBy"] == "owner"
                run_request({"v": 1, "op": "focus.set", "requestId": "cockpit-e2e-focus", "session": request["session"],
                             "args": {"taskId": adopted["taskId"], "expectedRevision": 0}}, "focused")
            results.append(run_request(request, expected_kind))

        captured, bound, snapshot = results
        assert bound["task"]["source"]["inboxId"] == captured["inboxId"]
        source = bound["task"]["source"]
        text = requests[0]["args"]["text"]
        assert (source["start"], source["end"]) == (0, len(text))
        assert source["sha256"] == hashlib.sha256(text.encode("utf-8")).hexdigest()
        assert snapshot["focus"]["task"]["taskId"] == bound["task"]["taskId"]
        assert snapshot["inboxCounts"] == {"total": 1, "untriaged": 1}
        assert snapshot["inbox"][0]["length"] == len(requests[0]["args"]["text"])
        assert snapshot["storageSchemaVersion"] == SCHEMA_VERSION
        assert snapshot["queue"] == "run"
        assert snapshot["inboxTriageCounts"] == {"untriaged": 1, "blocking": 0}
        assert snapshot["inbox"][0]["type"] == "info" and snapshot["inbox"][0]["classifiedBy"] == "rule"
        assert bound["task"]["certainty"] == "confirmed" and bound["task"]["certaintySource"] == "user"
        assert run_request(registration, "attested") == {"attested": True}
        assert run_request(registration, "attested") == {"attested": True}
        other = {**registration, "panelSecret": secrets.token_hex(32)}
        assert run_request(other, "error")["code"] == "ATTESTATION_CONFLICT"
        title_requests = json.loads(node("title", stdin=json.dumps({"session": requests[0]["session"], "task": bound["task"]})))
        assert all("panelSecret" not in request for request in title_requests)
        title_results = [run_request(request, kind) for request, kind in zip(
            title_requests, ("inbox", "updated", "snapshot", "error"), strict=True)]
        original, updated, refreshed, conflict = title_results
        assert original["text"] == text
        assert updated["task"]["title"] == "Осмысленные заголовки Cockpit"
        assert updated["task"]["revision"] == bound["task"]["revision"] + 1
        assert refreshed["focus"]["task"] == updated["task"]
        assert conflict["code"] == "REVISION_CONFLICT"
        # Повтор того же неизвестного клиенту результата не создаёт вторую запись.
        repeated = subprocess.run(
            ["python3", str(ROOT / "tools/cockpitctl.py"), "rpc"],
            cwd=ROOT, input=json.dumps(requests[0], ensure_ascii=False), text=True,
            capture_output=True, check=True, timeout=5,
        )
        assert json.loads(repeated.stdout)["result"] == captured
        with sqlite3.connect(state / "cockpit.db") as connection:
            assert connection.execute("SELECT count(*) FROM inbox").fetchone()[0] == 1
            assert connection.execute("SELECT count(*) FROM tasks").fetchone()[0] == 1
            assert connection.execute("SELECT raw_text FROM inbox").fetchone()[0] == text
            assert connection.execute("SELECT revision FROM tasks").fetchone()[0] == updated["task"]["revision"]
        check_m2(requests[0]["session"], updated["task"], refreshed["focus"]["revision"], snapshot["inbox"][0], state, PANEL_SECRET)
        check_gate(requests[0]["session"], state, PANEL_SECRET)
        check_tasks(requests[0]["session"], state, PANEL_SECRET)
        check_description_summaries(requests[0]['session'], PANEL_SECRET)
        with sqlite3.connect(state / "cockpit.db") as db:
            assert PANEL_SECRET not in "\n".join(db.iterdump())
            digest = db.execute("SELECT secret_sha256 FROM session_attestations").fetchone()[0]
            assert digest == hashlib.sha256(PANEL_SECRET.encode()).hexdigest()
            for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                assert PANEL_SECRET not in json.dumps(list(db.execute(f'SELECT * FROM "{name}"')), ensure_ascii=False)
            safe = {key: value for key, value in registration.items() if key != "panelSecret"}
            safe["panelProof"] = True
            safe_digest = hashlib.sha256(json.dumps(safe, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
            saved = db.execute("SELECT request_sha256,response_json FROM requests WHERE request_id=?", (registration["requestId"],)).fetchone()
            assert saved[0] == safe_digest and digest not in saved[1]
        for command in (["status"], ["inbox"], ["tasks"], ["checkpoint", "list", updated["task"]["taskId"]]):
            ran = subprocess.run(["python3", str(ROOT / "tools/cockpitctl.py"), "--cwd", str(cwd), *command],
                                 capture_output=True, text=True, check=True, timeout=5)
            assert PANEL_SECRET not in ran.stdout and PANEL_SECRET not in ran.stderr
            assert "панель" in ran.stdout or "командная строка" in ran.stdout
        print("runtime-check provenance: свидетельство 32 байта, повтор, подделка, panel/cli, разбор стража, смена вида/области через CLI, кэш без секрета и вывод CLI проверены; прежний task.update без свидетельства")
        agent_cwd = scratch / "agent-project"
        agent_cwd.mkdir()
        agent_session = {"sessionId": "cockpit-e2e-agent", "cwd": str(agent_cwd)}
        run_request({"v": 1, "op": "session.attest", "requestId": "cockpit-agent-attest", "session": agent_session,
                     "args": {}, "panelSecret": PANEL_SECRET}, "attested")
        check_agent(agent_session, PANEL_SECRET)
        check_owner_comments(agent_session, PANEL_SECRET)
        print(f"runtime-check: {REQUEST_COUNT} запросов domain проверены; Unicode/CRLF/NUL сохранены; title обновлён; конфликты не повторены; capture идемпотентен")


if __name__ == "__main__":
    main()

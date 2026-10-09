#!/usr/bin/env python3
"""Замер простого поиска на 5000 открытых и 20000 закрытых задачах."""
import argparse
import json
import math
import platform
import re
import sqlite3
import statistics
import subprocess
import sys
import time
from pathlib import Path

from agent_support import AgentHarness
from scale_support import seed_tasks
from support import CLI, REPO
from agents.claude.cockpit import domain


def distribution(samples):
    return {"p50Ms": round(statistics.median(samples), 3), "p95Ms": round(sorted(samples)[math.ceil(len(samples) * .95) - 1], 3),
            "samplesMs": [round(value, 3) for value in samples]}


def baseline(db, binding, query, regex=False):
    terms = query.lower().replace("ё", "е").split()
    patterns = [re.compile("".join("[еЕёЁ]" if char == "е" else "[" + re.escape(char + char.upper()) + "]" for char in term)) for term in terms]
    totals = {"queue": 0, "deferred": 0, "closed": 0}
    for row in db.execute(f"SELECT t.alias_no,t.title,t.description,t.status FROM tasks t WHERE {domain.VISIBLE_TASK_SQL}",
                          (binding["projectId"], binding["worktreeId"])):
        text = str(row["alias_no"]) + " " + row["title"] + " " + row["description"]
        if regex:
            matched = all(pattern.search(text) for pattern in patterns)
        else:
            text = text.lower().replace("ё", "е")
            matched = all(term in text for term in terms)
        if matched:
            totals[{"active": "queue", "paused": "deferred", "done": "closed"}[row["status"]]] += 1
    return totals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--runtime", action="store_true")
    parser.add_argument("--regex", action="store_true")
    parser.add_argument("--query", help="Один запрос вместо четырёх сценариев")
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(REPO) or args.runs < 20:
        parser.error("Отчёт должен быть в worktree; нужно не меньше 20 повторов")
    fixture = AgentHarness("runTest")
    fixture.setUp()
    try:
        binding = fixture.ok("snapshot", {"limits": {"tasks": 0}})["binding"]
        seed_tasks(fixture.state, binding, 4000)
        seed_tasks(fixture.state, binding, 1000, start=4001, status="paused")
        seed_tasks(fixture.state, binding, 20000, start=5001, status="done")
        with sqlite3.connect(fixture.state / "cockpit.db") as db:
            db.row_factory = sqlite3.Row
            for number in range(1, 25001):
                size = 300 + (number * 137) % 1701
                body = ("Сохранить контекст рабочего дерева, ограничения проекта, журнал выполнения и критерии результата. " * 24)[:size]
                if number % 31 == 0:
                    marker = " Поиск ПАНЕЛИ и ЁЛКА."
                    body = body[:-len(marker)] + marker
                db.execute("UPDATE tasks SET description=? WHERE task_id=?", (body, f"scale-{number}"))
            db.executemany("INSERT INTO task_lists VALUES (?,'acceptance',0,'Сохранить результат проверки и подтвердить критерий')",
                           [(f"scale-{number}",) for number in range(1, 25001)])
            timestamp = domain.now()
            db.executemany("INSERT INTO task_agent_notes VALUES (?,?,?,?,?,'result',?,?,'agent','tool')",
                           [(f"result-{number}", f"scale-{number}", binding["projectId"], binding["worktreeId"], binding["sessionId"],
                             "Сохранён итог выполнения и проверено чтение истории", timestamp) for number in range(5001, 25001)])
            db.executemany("INSERT INTO task_owner_comments VALUES (?,?,?,?,?,?,?,?,0,0)",
                           [(f"comment-{number}", f"scale-{number}", binding["projectId"], binding["worktreeId"], binding["sessionId"],
                             "Проверить комментарии владельца и порядок просмотра истории", timestamp, timestamp) for number in range(1, 25001, 5)])
            db.commit()
            lengths = db.execute("SELECT min(length(description)),max(length(description)),avg(length(description)) FROM tasks").fetchone()
            report = {"environment": {"os": platform.platform(), "machine": platform.machine(), "python": platform.python_version(),
                                      "sqlite": sqlite3.sqlite_version, "runs": args.runs},
                      "dataset": {"open": 5000, "closed": 20000, "queue": 4000, "deferred": 1000,
                                  "descriptionMin": lengths[0], "descriptionMax": lengths[1], "descriptionMean": lengths[2],
                                  "criteria": 25000, "results": 20000, "comments": 5000}, "measurements": []}
            queries = [args.query] if args.query else ["пан елка", "сохранить контекст", "комментарии владельца", "несуществующий запрос"]
            for query in queries:
                samples = []
                for _ in range(args.runs):
                    begin = time.perf_counter_ns()
                    if args.runtime:
                        from agents.claude.cockpit.task_search import search_tasks
                        result = search_tasks(db, binding, {"query": query})
                        totals = {name: value["total"] for name, value in result["lists"].items()}
                    else:
                        totals = baseline(db, binding, query, regex=args.regex)
                    samples.append((time.perf_counter_ns() - begin) / 1_000_000)
                row = {"mode": "runtime" if args.runtime else "regex-scan" if args.regex else "baseline", "query": query, "totals": totals, **distribution(samples)}
                if args.runtime:
                    wire_samples = []
                    for _ in range(args.runs):
                        request = fixture.request("tasks.search", {"query": query})
                        begin = time.perf_counter_ns()
                        ran = subprocess.run([sys.executable, str(CLI), "rpc"], input=json.dumps(request).encode(),
                                             capture_output=True, cwd=fixture.cwd, env=fixture.env, check=True, timeout=12)
                        wire_samples.append((time.perf_counter_ns() - begin) / 1_000_000)
                        response = json.loads(ran.stdout)
                        assert response["ok"] and not ran.stderr, response
                        assert {name: page["total"] for name, page in response["result"]["lists"].items()} == totals
                    row["rpc"] = distribution(wire_samples)
                    row["responseBytes"] = len(ran.stdout)
                report["measurements"].append(row)
                print(json.dumps(row, ensure_ascii=False), flush=True)
            output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    finally:
        fixture.doCleanups()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Журнал ответов: одинаковая нагрузка в отдельных процессах на временной базе."""

import argparse
import json
import platform
import sqlite3
import statistics
import time
from pathlib import Path

from agent_support import AgentHarness
from scale_support import seed_tasks
from support import REPO


def measure(state):
    with sqlite3.connect(state / "cockpit.db") as db:
        count, response_bytes, row_bytes = db.execute("""SELECT COUNT(*),
            COALESCE(SUM(length(CAST(response_json AS BLOB))),0),
            COALESCE(SUM(length(CAST(request_id AS BLOB))+length(CAST(request_sha256 AS BLOB))
                +length(CAST(response_json AS BLOB))+length(CAST(committed_at AS BLOB))),0)
            FROM requests""").fetchone()
    return {"requests": count, "responseBytes": response_bytes, "rowBytes": row_bytes,
            "databaseBytes": (state / "cockpit.db").stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=2)
    args = parser.parse_args()
    output = args.output.resolve()
    if args.runs < 2 or not output.is_relative_to(REPO):
        parser.error("Нужно не меньше двух прогонов; отчёт остаётся в worktree")
    report = {"environment": {"os": platform.platform(), "python": platform.python_version(),
                              "sqlite": sqlite3.sqlite_version, "machine": platform.machine()},
              "workload": {"openTasks": 1000, "snapshots": 1000, "searches": 200,
                           "writes": 100, "staleRequests": 15000, "staleSeededBeforeWorkload": True, "cleanupWrites": 75}, "runs": []}
    for number in range(args.runs):
        fixture = AgentHarness("runTest")
        fixture.setUp()
        try:
            binding = fixture.ok("snapshot", {"limits": {"tasks": 0}})["binding"]
            seed_tasks(fixture.state, binding, 1000)
            # Просроченные ответы лежат в журнале раньше свежих, как в настоящей базе: журнал пишется по порядку.
            with sqlite3.connect(fixture.state / "cockpit.db") as db:
                db.executemany("INSERT INTO requests VALUES (?,?,?,?)",
                    [(f"stale-{index}", "a" * 64, '{"v":1,"ok":true,"result":{"saved":true}}',
                      "2000-01-01T00:00:00.000000Z") for index in range(15000)])
            row = {"run": number + 1, "initial": measure(fixture.state), "operations": {}}
            for op, count, payload in (("snapshot", 1000, {}),
                                       ("tasks.search", 200, {"query": "сохранение"}),
                                       ("capture.prompt", 100, {"text": "Замер журнала запросов"})):
                before = measure(fixture.state)
                samples = []
                for index in range(count):
                    request = fixture.request(op, payload, key=f"bench-{op}-{index}")
                    started = time.perf_counter_ns()
                    response = fixture.invoke(request)
                    samples.append((time.perf_counter_ns() - started) / 1_000_000)
                    fixture.assertTrue(response["ok"], response)
                    if op == "snapshot":
                        fixture.assertEqual(len(response["result"]["tasks"]), 1000)
                        fixture.assertFalse(response["result"]["tasksTruncated"])
                row["operations"][op] = {"calls": count, "ok": count,
                    "medianMs": statistics.median(samples),
                    "p95Ms": sorted(samples)[int(len(samples) * .95) - 1], **measure(fixture.state)}
                if op in ("snapshot", "tasks.search"):
                    for field in ("requests", "responseBytes", "rowBytes"):
                        fixture.assertEqual(row["operations"][op][field], before[field], f"{op}: {field}")
                print(f"Прогон {number + 1}: {op}, {count} успешных вызовов", flush=True)
            row["workloadResult"] = measure(fixture.state)
            with sqlite3.connect(fixture.state / "cockpit.db") as db:
                row["staleLeft"] = db.execute("SELECT COUNT(*) FROM requests WHERE request_id LIKE 'stale-%'").fetchone()[0]
            # Все старые ответы убирают записи capture.prompt; виды журнал не пополняют и не чистят.
            row["beforeCleanup"] = measure(fixture.state)
            deleted, samples = [], []
            for index in range(75):
                before = measure(fixture.state)["requests"]
                started = time.perf_counter_ns()
                fixture.ok("capture.prompt", {"text": "Попутная уборка"}, key=f"cleanup-{index}")
                samples.append((time.perf_counter_ns() - started) / 1_000_000)
                deleted.append(before + 1 - measure(fixture.state)["requests"])
            row["cleanup"] = {"deletedPerCall": deleted, "totalDeleted": sum(deleted),
                "medianMs": statistics.median(samples), "maxMs": max(samples), **measure(fixture.state)}
            report["runs"].append(row)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        finally:
            fixture.doCleanups()
    print(f"Отчёт: {output.relative_to(REPO)}", flush=True)


if __name__ == "__main__":
    main()

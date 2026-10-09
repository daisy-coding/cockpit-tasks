#!/usr/bin/env python3
"""Виды панели: распределение времени и байты stdout в отдельных процессах."""

import argparse
import hashlib
import json
import math
import platform
import sqlite3
import statistics
import subprocess
import sys
import time
from pathlib import Path

from agent_support import AgentHarness
from scale_support import seed_tasks
from support import CLI, REPO


OPERATIONS = (
    ("snapshot", "snapshot", {}),
    ("snapshot.limits", "snapshot", {"limits": {"tasks": 50, "inbox": 10}}),
    ("tasks.page", "tasks.page", {"list": "queue", "offset": 0, "limit": 50}),
    ("tasks.context", "tasks.context", {}),
    ("tasks.search", "tasks.search", {"query": "сохранение", "limit": 50}),
)


def journal(state):
    with sqlite3.connect(state / "cockpit.db") as db:
        count, size = db.execute("""SELECT COUNT(*),
            COALESCE(SUM(length(CAST(response_json AS BLOB))),0) FROM requests""").fetchone()
    return {"rows": count, "responseBytes": size}


def verify(fixture, name, result, count):
    if name.startswith("snapshot"):
        fixture.assertEqual(result["openTaskCount"], count)
        fixture.assertEqual(len(result["tasks"]), count if name == "snapshot" else 50)
        fixture.assertEqual(result["tasksTruncated"], name != "snapshot")
    elif name == "tasks.page":
        fixture.assertEqual((result["total"], len(result["tasks"])), (count, 50))
    elif name == "tasks.context":
        fixture.assertEqual((result["counts"]["open"], len(result["queue"])), (count, 30))
    else:
        fixture.assertEqual((result["lists"]["queue"]["total"], len(result["lists"]["queue"]["rows"])), (count, 50))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--calls", type=int, default=50)
    parser.add_argument("--only", choices=[item[0] for item in OPERATIONS], action="append")
    args = parser.parse_args()
    output = args.output.resolve()
    if args.runs < 2 or args.calls < 50 or not output.is_relative_to(REPO):
        parser.error("Нужны два прогона и не меньше 50 вызовов; отчёт остаётся в worktree")
    report = {"environment": {"os": platform.platform(), "python": platform.python_version(),
                              "sqlite": sqlite3.sqlite_version, "machine": platform.machine()},
              "runtimeSha256": hashlib.sha256((REPO / "agents/claude/cockpit/rpc.py").read_bytes()).hexdigest(),
              "workload": {"openTasks": [100, 500, 1000], "runs": args.runs, "callsPerPoint": args.calls,
                           "profile": "scale_support.seed_tasks(worst=False)", "panelProof": True,
                           "freshRequestId": True, "newProcessPerCall": True,
                           "isolatedDatabasePerPoint": True, "warmupCalls": 0,
                           "timing": "subprocess.run; включает запуск Python и передачу JSON, без декодирования ответа",
                           "responseBytes": "stdout UTF-8, envelope и завершающий перевод строки",
                           "percentile": "nearest-rank: ceil(0.95 * calls)"}, "rows": []}
    for run in range(1, args.runs + 1):
        for count in (100, 500, 1000):
            for name, op, payload in OPERATIONS:
                if args.only and name not in args.only:
                    continue
                fixture = AgentHarness("runTest")
                fixture.setUp()
                try:
                    binding = fixture.ok("snapshot", {"limits": {"tasks": 0}})["binding"]
                    seed_tasks(fixture.state, binding, count)
                    before = journal(fixture.state)
                    samples, sizes = [], []
                    for index in range(args.calls):
                        request = {**fixture.request(op, payload, key=f"views-{index}"),
                                   "actor": "owner", "panelSecret": fixture.secret}
                        wire = json.dumps(request, ensure_ascii=False).encode("utf-8")
                        started = time.perf_counter_ns()
                        called = subprocess.run([sys.executable, str(CLI), "rpc"], input=wire,
                            capture_output=True, cwd=fixture.cwd, env=fixture.env, timeout=12)
                        samples.append((time.perf_counter_ns() - started) / 1_000_000)
                        fixture.assertEqual(called.returncode, 0, called.stderr)
                        fixture.assertEqual(called.stderr, b"")
                        fixture.assertEqual(len(called.stdout.splitlines()), 1)
                        response = json.loads(called.stdout)
                        fixture.assertTrue(response["ok"], response)
                        verify(fixture, name, response["result"], count)
                        sizes.append(len(called.stdout))
                    after = journal(fixture.state)
                    row = {"run": run, "openTasks": count, "name": name, "op": op, "args": payload,
                           "calls": args.calls, "ok": args.calls, "medianMs": statistics.median(samples),
                           "p95Ms": sorted(samples)[math.ceil(args.calls * .95) - 1],
                           "responseBytes": {"min": min(sizes), "median": statistics.median(sizes), "max": max(sizes)},
                           "samplesMs": samples, "samplesBytes": sizes, "journalBefore": before,
                           "journalAfter": after, "newRequestRows": after["rows"] - before["rows"],
                           "newResponseBytes": after["responseBytes"] - before["responseBytes"]}
                    report["rows"].append(row)
                    output.parent.mkdir(parents=True, exist_ok=True)
                    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
                    print(f"Прогон {run}, {count} задач, {name}: {row['medianMs']:.1f}/{row['p95Ms']:.1f} мс, "
                          f"{row['responseBytes']['median']:.0f} байт, {row['newRequestRows']} строк журнала", flush=True)
                finally:
                    fixture.doCleanups()
    print(f"Отчёт: {output.relative_to(REPO)}", flush=True)


if __name__ == "__main__":
    main()

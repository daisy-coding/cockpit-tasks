#!/usr/bin/env python3
"""Размер и время страницы из 50 строк на одноразовой базе из 1000 задач."""
import argparse
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
from agents.claude.cockpit import domain, rpc


def distribution(samples):
    return {"samples": samples, "min": min(samples), "median": statistics.median(samples),
            "p95": sorted(samples)[math.ceil(len(samples) * .95) - 1], "max": max(samples)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--runs", type=int, default=9)
    parser.add_argument("--preview", type=int)
    args = parser.parse_args()
    if args.runs < 7 or not args.output.resolve().is_relative_to(REPO):
        parser.error("Нужно не меньше семи повторов и отчёт внутри worktree")
    report = {"environment": {"os": platform.platform(), "python": platform.python_version(),
                              "machine": platform.machine()}, "runs": args.runs,
              "scope": "UTF-8 envelope + newline; CLI includes fresh process; domain includes filtering and serialization",
              "preview": args.preview, "rows": []}
    for worst in (False, True):
        fixture = AgentHarness("runTest")
        fixture.setUp()
        try:
            binding = fixture.ok("snapshot", {"limits": {"tasks": 0}})["binding"]
            seed_tasks(fixture.state, binding, 1000, worst=worst)
            payload = {"list": "queue", "offset": 0, "limit": 50}
            if args.preview is not None:
                payload["preview"] = args.preview
            samples, sizes, counts = [], [], []
            with sqlite3.connect(fixture.state / "cockpit.db") as db:
                db.row_factory = sqlite3.Row
                for _ in range(args.runs):
                    queries = []
                    db.set_trace_callback(queries.append)
                    begin = time.perf_counter_ns()
                    result = domain.tasks_page(db, binding, payload)
                    response = domain.shown_task_extensions(domain.shown_response({"v": 1, "ok": True, "result": result}))
                    wire = (rpc.canonical(response) + "\n").encode("utf-8")
                    samples.append((time.perf_counter_ns() - begin) / 1_000_000)
                    sizes.append(len(wire))
                    counts.append(len(queries))
                db.set_trace_callback(None)
            cli = {}
            for operation, request_args in (("tasks.page", payload), ("task.get", {"taskId": "scale-1"})):
                times, wire_sizes = [], []
                for _ in range(args.runs):
                    request = fixture.request(operation, request_args)
                    begin = time.perf_counter_ns()
                    ran = subprocess.run([sys.executable, str(CLI), "rpc"],
                        input=json.dumps(request, ensure_ascii=False).encode("utf-8"), capture_output=True,
                        cwd=fixture.cwd, env=fixture.env, check=True, timeout=12)
                    times.append((time.perf_counter_ns() - begin) / 1_000_000)
                    response = json.loads(ran.stdout)
                    if ran.stderr or not response["ok"]:
                        raise RuntimeError("Замер получил отказ RPC")
                    wire_sizes.append(len(ran.stdout))
                cli[operation] = {"ms": distribution(times), "bytes": distribution(wire_sizes)}
            row = {"profile": "worst" if worst else "typical", "tasks": 1000, "pageSize": 50,
                   "domainMs": distribution(samples), "responseBytes": distribution(sizes),
                   "sqlQueries": distribution(counts), "cli": cli}
            report["rows"].append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
        finally:
            fixture.doCleanups()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()

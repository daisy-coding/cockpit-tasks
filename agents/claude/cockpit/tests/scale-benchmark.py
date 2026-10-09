#!/usr/bin/env python3
"""Воспроизводимый замер CLI и настоящего парсера мода на временной базе."""

import argparse
import json
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=7)
    args = parser.parse_args()
    if args.runs < 7:
        parser.error("Нужно не меньше семи прогонов")
    output = args.output.resolve()
    if not output.is_relative_to(REPO):
        parser.error("Отчёт должен оставаться в worktree")
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"environment": {"os": platform.platform(), "python": platform.python_version(),
                              "machine": platform.machine(), "runs": args.runs}, "rows": []}
    for worst in (False, True):
        for count in (30, 100, 500, 1000, 5000):
            fixture = AgentHarness("runTest")
            fixture.setUp()
            try:
                binding = fixture.ok("snapshot", {"limits": {"tasks": 1, "inbox": 1}})["binding"]
                seed_tasks(fixture.state, binding, count, worst=worst)
                row = {"profile": "worst" if worst else "realistic", "open": count, "operations": {}}
                # Каждый запуск записи получает ту же исходную базу. Копирование не входит в замер.
                pristine = fixture.root / "baseline.db"
                with sqlite3.connect(fixture.state / "cockpit.db") as db, sqlite3.connect(pristine) as saved:
                    db.backup(saved)
                new_title = ("Проверить новую задачу измерительного набора и восстановление очереди "
                             + "после повторного запуска рантайма " * 10)[:300 if worst else 90]
                new_description = ("Проверить порядок и сохранить результат после перезагрузки. " * 80)[:4000 if worst else 450]
                for op, payload in (
                    ("snapshot", {}), ("tasks.context", {}),
                    ("tasks.agent.create", {"tasks": [{"title": new_title, "description": new_description}]}),
                    ("tasks.agent.rank", {"order": [f"scale-{count}"]}),
                    ("task.agent.action", {"taskId": "scale-1", "expectedRevision": 0, "expectedFocusRevision": 0, "action": "current"}),
                ):
                    samples, codes, wire = [], [], b""
                    for _ in range(args.runs):
                        with sqlite3.connect(pristine) as saved, sqlite3.connect(fixture.state / "cockpit.db") as db:
                            saved.backup(db)
                            if op == "tasks.agent.create" and count == 5000:
                                # При техническом пределе успешное создание измеряется с одним свободным местом.
                                db.execute("UPDATE tasks SET status='done' WHERE task_id='scale-1'")
                        request = fixture.request(op, payload)
                        if op in ("tasks.agent.create", "tasks.agent.rank", "task.agent.action"):
                            request.update(actor="agent", panelSecret=fixture.secret)
                        begin = time.perf_counter_ns()
                        ran = subprocess.run([sys.executable, str(CLI), "rpc"],
                            input=json.dumps(request, ensure_ascii=False).encode("utf-8"),
                            capture_output=True, cwd=fixture.cwd, env=fixture.env, check=True, timeout=12)
                        samples.append((time.perf_counter_ns() - begin) / 1_000_000)
                        if ran.stderr:
                            raise RuntimeError(ran.stderr.decode("utf-8"))
                        wire = ran.stdout
                        response = json.loads(wire)
                        codes.append("ok" if response["ok"] else response["error"]["code"])
                    row["operations"][op] = {"medianMs": statistics.median(samples), "samplesMs": samples, "outcomes": codes}
                    if op == "snapshot":
                        result = response["result"]
                        row.update(snapshotBytes=len(wire), snapshotTasks=len(result["tasks"]),
                                   tasksTruncated=result.get("tasksTruncated"), openTaskCount=result.get("openTaskCount"))
                        parse_script = REPO / "agents/claude/plugins/cockpit/scripts/scale-parse-benchmark.mjs"
                        measured = subprocess.run(["node", "--experimental-strip-types", str(parse_script), str(args.runs)],
                            input=wire, capture_output=True, check=True, timeout=30)
                        row["parseResponse"] = json.loads(measured.stdout)
                report["rows"].append(row)
                output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
                print(json.dumps(row, ensure_ascii=False), flush=True)
            finally:
                fixture.doCleanups()


if __name__ == "__main__":
    main()

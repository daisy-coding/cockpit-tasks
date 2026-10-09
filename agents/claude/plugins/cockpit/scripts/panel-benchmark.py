#!/usr/bin/env python3
"""Сравнение RPC настоящего мода на одинаковом изолированном тестовом хосте."""
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]
PLUGIN = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", action="store_true")
    parser.add_argument("--tests", nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(ROOT):
        parser.error("Отчёт должен оставаться в worktree")
    report = {"source": "HEAD" if args.before else "working tree", "runs": [],
              "profile": "task-panel-host; 100/500/1000 confirmed tasks, short titles, no focus or peers",
              "bytes": "UTF-8 JSON RPC replies of the mock host; font probe excluded",
              "stages": "incremental RPC counts and bytes; scrollEnd follows open, action follows full scroll"}
    temporary_root = PLUGIN / ".tmp"
    temporary_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="panel-bench-", dir=temporary_root) as temporary:
        target = Path(temporary)
        for directory in (".claude-plugin", "hooks", "types"):
            shutil.copytree(PLUGIN / directory, target / directory)
        if args.before:
            files = subprocess.run(["git", "ls-tree", "-r", "--name-only", "HEAD", "agents/claude/plugins/cockpit/hooks"],
                                   cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
            for name in files:
                raw = subprocess.run(["git", "show", f"HEAD:{name}"], cwd=ROOT, capture_output=True, check=True).stdout
                (target / Path(name).relative_to(PLUGIN.relative_to(ROOT))).write_bytes(raw)
        report["registerSha256"] = hashlib.sha256((target / "hooks/register.tsx").read_bytes()).hexdigest()
        (target / "tests").mkdir()
        for source in (PLUGIN / "tests").iterdir():
            if source.is_file() and ".test." not in source.name:
                shutil.copyfile(source, target / "tests" / source.name)
        (target / "scripts").mkdir()
        if args.tests:
            for name in args.tests:
                if Path(name).name != name:
                    parser.error("Нужны имена файлов тестов мода")
                # Прибор замера хранится в scripts под именем *.bench.tsx и в набор тестов не входит.
                bench = PLUGIN / "scripts" / name.replace(".test.", ".bench.")
                if bench.is_file():
                    shutil.copyfile(bench, target / "scripts" / name)
                else:
                    shutil.copyfile(PLUGIN / "tests" / name, target / "tests" / name)
        else:
            shutil.copyfile(PLUGIN / "scripts/panel-benchmark.bench.tsx", target / "scripts/panel-benchmark.test.tsx")
        for run in range(1, 2 if args.tests else 3):
            result = subprocess.run(["claude", "plugin", "test", str(target)], cwd=target, capture_output=True, text=True)
            records = []
            for line in (result.stdout + "\n" + result.stderr).splitlines():
                if line.startswith('{"panelMeasure":'):
                    records.append(json.loads(line))
            report["runs"].append({"run": run, "exitCode": result.returncode, "records": records})
            output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            print(f"Прогон {run}: {len(records)} точек, код {result.returncode}", flush=True)
            if result.returncode or not args.tests and len(records) != 9:
                print(result.stdout[-6000:] + result.stderr[-2000:])
                raise SystemExit(1)


if __name__ == "__main__":
    main()

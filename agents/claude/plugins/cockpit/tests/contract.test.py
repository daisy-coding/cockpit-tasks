#!/usr/bin/env python3
"""Запустить сверки мода с Python-оригиналами: фильтр секретов, рантайм, границы API.

Скрипты в scripts/ сами по себе в pre-push не попадают; без этого набора копия
фильтра секретов на TypeScript могла бы разойтись с core/decisioning/privacy.py молча.
"""
from pathlib import Path
import json
import re
import subprocess
import sys

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS.parents[4]))
from agents.claude.cockpit.store import SCHEMA_VERSION


def main():
    readme = (SCRIPTS.parent / "README.md").read_text()
    manifest = json.loads((SCRIPTS.parent / ".claude-plugin/plugin.json").read_text())
    # Номер версии сверяет tools/tests/plugin-version.test.py; здесь важен только формат.
    assert re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"]), "Версия мода должна быть вида X.Y.Z"
    runtime_readme = (SCRIPTS.parents[4] / "agents/claude/cockpit/README.md").read_text()
    for document in (readme, runtime_readme):
        for term in ("candidate.adopt", "candidate.dismiss", "actor", "tool", "attestation_revocations", "ПРЕДЛОЖЕНО"):
            assert term in document, f"Контракт не описывает {term}"
    assert f"storageSchemaVersion:{SCHEMA_VERSION}" in runtime_readme
    for term in ("tasks.agent.create", "tasks.agent.rank", "task.agent.action", "task.reopen", "tasks.context", "TASK_LIMIT_REACHED", "expectedFocusRevision", "ownerChanges"):
        assert term in runtime_readme, f"Контракт рантайма не описывает {term}"
    assert SCHEMA_VERSION == 13
    runtime_domain = (SCRIPTS.parents[4] / "agents/claude/cockpit/domain.py").read_text()
    mod_rpc = (SCRIPTS.parent / "hooks/domain/rpc.ts").read_text()
    assert '"tasks.search"' in runtime_domain and "'tasks.search'" in mod_rpc
    for operation in ('task.summary.claim', 'task.summary.report'):
        assert f'"{operation}"' in runtime_domain and f"'{operation}'" in mod_rpc
        assert operation in runtime_readme
    assert 'summarizeDescriptions' in manifest['userConfig']
    search_cases = json.loads((SCRIPTS.parent / "tests/task-search-cases.json").read_text())
    assert len(search_cases["cases"]) >= 10
    shared = subprocess.run(["node", "--experimental-strip-types", str(SCRIPTS / "runtime-requests.mjs"), "search-cases"],
                            text=True, capture_output=True, timeout=10)
    assert shared.returncode == 0, shared.stderr
    checked = json.loads(shared.stdout)
    for case, result in zip(search_cases["cases"], checked["results"], strict=True):
        assert result == {"parsed": {"terms": case["terms"], "numbers": case["numbers"]},
                          "matches": case["matches"], "ranges": case["ranges"]}, case["query"]
    assert checked["invalid"] == [None] * len(search_cases["invalidQueries"])
    print(f"task-search-contract: {len(search_cases['cases'])} общих примеров, {len(search_cases['invalidQueries'])} отказов входа")
    for term in ("task.comment.add", "task.comment.edit", "task.comment.delete", "ownerComments",
                 "task.owner.commented", "task.owner.comment-edited", "task.owner.comment-deleted"):
        assert term in runtime_readme, f"Контракт комментариев не описывает {term}"
    assert "## Известные ложные срабатывания стража" in readme
    for command in ("ls agents/claude/cockpit", "wc -l agents/claude/cockpit/*.py",
                    "grep -n 'session.attest' agents/claude/cockpit/rpc.py",
                    "git add agents/claude/cockpit", "git diff -- agents/claude/cockpit",
                    "cd agents/claude/cockpit"):
        assert command in readme, f"Не записан вход будущей фикстуры: {command}"
    for name in ("privacy-check.py", "runtime-check.py", "surface-check.py"):
        ran = subprocess.run([sys.executable, str(SCRIPTS / name)], text=True, capture_output=True, timeout=120)
        assert ran.returncode == 0, f"{name}: {ran.stderr.strip() or ran.stdout.strip()}"
        print(ran.stdout, end="")
    task_check = subprocess.run(["node", "--experimental-strip-types", str(SCRIPTS / "tasks-check.mjs")], text=True, capture_output=True, timeout=30)
    assert task_check.returncode == 0, task_check.stderr.strip() or task_check.stdout.strip()
    print(task_check.stdout, end="")
    theme_check = subprocess.run(["node", "--experimental-strip-types", str(SCRIPTS / "theme-check.mjs")], text=True, capture_output=True, timeout=30)
    assert theme_check.returncode == 0, theme_check.stderr.strip() or theme_check.stdout.strip()
    print(theme_check.stdout, end="")
    notices = subprocess.run([sys.executable, str(SCRIPTS.parent / "tests/notifications.test.py")],
                             text=True, capture_output=True, timeout=30)
    assert notices.returncode == 0, notices.stderr.strip() or notices.stdout.strip()
    print("notification-inventory: литералы всех уведомлений hooks проверены")
    print("cockpit-contract: фильтр секретов, рантайм и границы API сверены")


if __name__ == "__main__":
    main()

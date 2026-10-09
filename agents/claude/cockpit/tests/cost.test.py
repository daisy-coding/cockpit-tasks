#!/usr/bin/env python3
"""Замер десяти отдельных процессов capture.prompt с проверкой durable результата."""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
CLI = REPO / "tools" / "cockpitctl.py"


def main():
    with tempfile.TemporaryDirectory(prefix=".cockpit-cost-", dir=REPO) as directory:
        cwd = Path(directory)
        state = cwd / "state"
        environment = {"PATH": os.defpath, "COCKPIT_STATE_DIR": str(state),
                       "GIT_CEILING_DIRECTORIES": str(REPO), "PYTHONDONTWRITEBYTECODE": "1"}
        initialized = subprocess.run(["git", "-C", directory, "init", "-b", "main"],
                                     env=environment, capture_output=True, timeout=5)
        assert initialized.returncode == 0, initialized.stderr
        durations = []
        for number in range(10):
            request = {"v": 1, "op": "capture.prompt", "requestId": str(uuid.uuid4()),
                       "session": {"sessionId": "cost-session", "cwd": directory},
                       "args": {"text": f"Событие {number}: сохранить неизменяемый исходник 🐋\r\n"}}
            started = time.perf_counter()
            process = subprocess.run([sys.executable, str(CLI), "rpc"], input=json.dumps(request).encode(),
                                     cwd=cwd, env=environment, capture_output=True, timeout=10)
            durations.append((time.perf_counter() - started) * 1000)
            assert process.returncode == 0 and not process.stderr, process.stderr
            response = json.loads(process.stdout)
            assert response["ok"] and response["result"]["captured"] is True, response
        with sqlite3.connect(state / "cockpit.db") as db:
            for table in ("inbox", "requests", "events"):
                assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 10, table
        db.close()
        print(f"capture.prompt: 10 последовательных subprocess (Git checkout, WAL+FULL); всего {sum(durations):.1f} мс; "
              f"среднее {sum(durations) / 10:.1f} мс/событие; первый {durations[0]:.1f} мс; "
              f"последующие {sum(durations[1:]) / 9:.1f} мс/событие")
        print("Проверка записи: inbox=10, requests=10, events=10; все ответы captured=true.")


if __name__ == "__main__":
    main()

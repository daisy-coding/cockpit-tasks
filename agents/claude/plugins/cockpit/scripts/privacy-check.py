#!/usr/bin/env python3
"""Сверить TypeScript-порт с неизменённым Python-редактором на общих примерах."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[5]


def main():
    # Импорт оригинала только для чтения; __pycache__ в core не создаётся.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("cockpit_privacy_original", ROOT / "core/decisioning/privacy.py")
    original = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(original)
    ran = subprocess.run(
        ["node", "--experimental-strip-types", str(Path(__file__).with_name("privacy-cases.mjs"))],
        cwd=ROOT, text=True, capture_output=True, check=True, timeout=10,
    )
    examples = json.loads(ran.stdout)
    found = set()
    for example in examples:
        expected, classes = original.redact(example["text"])
        found.update(classes)
        assert example["actual"] == expected, f"Порт расходится с Python: {example['name']}"
        assert example["expected"] == expected, f"Ошибочный эталон примера: {example['name']}"
        assert example["viewActual"] == example.get("viewExpected", expected), f"Общий поиск расходится с примером: {example['name']}"
    assert found == {entry[0] for entry in original.SECRET_PATTERNS}, "Набор не проверяет все классы"
    print(f"privacy-check: {len(examples)} примеров совпали с Python; {len(found)} классов SECRET_PATTERNS проверены")


if __name__ == "__main__":
    main()

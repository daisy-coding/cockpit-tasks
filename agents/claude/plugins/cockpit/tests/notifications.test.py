#!/usr/bin/env python3
"""Проверить литералы уведомлений во всех исходниках hooks, включая вложенные каталоги."""
from pathlib import Path
import re
import unittest


HOOKS = Path(__file__).resolve().parents[1] / "hooks"
CALL = re.compile(r"\$\.ui\.(?:toast|status)\s*\(")
STRING = re.compile(r"(['\"`])(?:\\.|(?!\1)[\s\S])*?\1")
PREFIX = re.compile(r"^\s*(?:cockpit|задачи)\s*:", re.I)
INTERNAL = re.compile(r"\b[a-zA-Z_]\w*\.[a-zA-Z_]\w*\b|\b[A-Z]+(?:_[A-Z]+)+\b|/home/|/Users/")
HELPERS = {
    "register.tsx": ("ATTESTATION_FAILURE", "STARTUP_HINT", "ownerAccessNotice", "actionFailure"),
    "task-search-panel.ts": ("SEARCH_UNAVAILABLE",),
    "domain/compact-resume.ts": ("REFUSALS", "resumeRefusal"),
    "domain/task-loop.ts": ("compactResumeToast",),
    "owner/tasks.ts": ("statusOf",),
}


def call_text(source, start):
    """Прочитать аргументы целиком: скобки внутри строк не закрывают вызов."""
    depth = 1
    pos = start
    while pos < len(source):
        match = STRING.match(source, pos)
        if match:
            pos = match.end()
            continue
        if source[pos] == "(":
            depth += 1
        elif source[pos] == ")":
            depth -= 1
            if depth == 0:
                return source[start:pos]
        pos += 1
    raise AssertionError("Не найдена закрывающая скобка уведомления")


def notification_literals():
    for path in sorted(HOOKS.rglob("*")):
        if path.suffix not in (".ts", ".tsx"):
            continue
        source = path.read_text()
        for call in CALL.finditer(source):
            for literal in STRING.finditer(call_text(source, call.end())):
                text = literal.group()[1:-1]
                # Значения сравнений и ключи вариантов не являются текстом уведомления.
                if not re.search(r"[А-Яа-яЁё]", text):
                    continue
                line = source.count("\n", 0, call.end() + literal.start()) + 1
                yield path.relative_to(HOOKS), line, text
    # Сообщения, переданные через константу или чистую функцию, тоже входят в инвентарь.
    for relative, names in HELPERS.items():
        source = (HOOKS / relative).read_text()
        for name in names:
            declaration = re.search(r"^(?:export )?(?:const|function) " + name + r"\b", source, re.M)
            assert declaration is not None, f"Не найдена декларация уведомления {relative}: {name}"
            following = re.search(r"\n(?:export )?(?:(?:async )?function|const|let|interface|type) \w", source[declaration.end():])
            end = declaration.end() + following.start() if following else len(source)
            for literal in STRING.finditer(source, declaration.start(), end):
                text = literal.group()[1:-1]
                if re.search(r"[А-Яа-яЁё]", text):
                    yield Path(relative), source.count("\n", 0, literal.start()) + 1, text


class NotificationInventory(unittest.TestCase):
    def test_every_toast_and_status_literal(self):
        inventory = list(notification_literals())
        self.assertGreater(len(inventory), 20, "Инвентарь не нашёл уведомления")
        self.assertIn(Path("owner/engine.tsx"), {path for path, _, _ in inventory})
        for path, line, text in inventory:
            with self.subTest(file=str(path), line=line, text=text):
                # Интерполяции проверяются отдельно сценариями хоста, здесь — литералы.
                visible = re.sub(r"\$\{(?:[^{}]|\{[^{}]*\})*\}", "", text)
                self.assertLessEqual(len(visible), 80)
                self.assertIsNone(PREFIX.search(visible))
                self.assertIsNone(INTERNAL.search(visible))

    def test_scanner_keeps_parentheses_and_conditional_branches(self):
        source = "$.ui.toast(ok ? 'Задача (готова).' : 'Задача не сохранена. Повтори.')"
        call = CALL.search(source)
        self.assertIsNotNone(call)
        self.assertEqual([match.group()[1:-1] for match in STRING.finditer(call_text(source, call.end()))],
                         ["Задача (готова).", "Задача не сохранена. Повтори."])


if __name__ == "__main__":
    unittest.main()

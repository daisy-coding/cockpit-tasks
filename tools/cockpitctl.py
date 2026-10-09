#!/usr/bin/env python3
"""Запасной человеческий CLI и один JSON RPC-запрос на процесс."""

import argparse
import os
import sys
import uuid

# realpath нужен, когда ~/.local/bin/cockpitctl — симлинк на этот файл.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))

from agents.claude.cockpit import CockpitError
from agents.claude.cockpit import domain, rpc
from agents.claude.cockpit.store import configure_capture_mode


def parser():
    result = argparse.ArgumentParser(description="Локальный учёт Cockpit (observe, M1/M2).")
    result.add_argument("--cwd", default=os.getcwd(), help="Каталог проекта (по умолчанию текущий).")
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("rpc", help="Один JSON-запрос из stdin, один JSON-ответ в stdout.")
    commands.add_parser("status", help="Фокус и счётчики указаний.")
    for name, help_text in (("inbox", "Последние указания."), ("tasks", "Последние задачи проекта.")):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("--limit", type=int, default=10)
        if name == "tasks":
            command.add_argument("--candidates", action="store_true", help="Показать предложения вместо очереди.")
    commands.add_parser("show", help="Исходное указание или карточка задачи по идентификатору.").add_argument("inboxId")
    triage = commands.add_parser("triage", help="Задать вид, область действия и статус разбора указания.")
    triage.add_argument("inboxId")
    triage.add_argument("--expected-revision", required=True, type=int, help="Текущая triageRevision пункта.")
    triage.add_argument("--type", choices=(*domain.INBOX_TYPES, "unknown"), help="Вид; unknown снимает определение.")
    triage.add_argument("--status", choices=domain.TRIAGE_STATUSES)
    for name, label in (("task", "задачу"), ("resource", "ресурс")):
        scope = triage.add_mutually_exclusive_group()
        scope.add_argument("--" + name, help="Привязать к сущности по идентификатору.")
        scope.add_argument("--clear-" + name, action="store_true", help="Снять привязку на " + label + ".")
    confirm = commands.add_parser("confirm", help="Подтвердить задачу человеком.")
    confirm.add_argument("taskId")
    confirm.add_argument("--expected-revision", required=True, type=int, help="Текущая ревизия задачи.")
    feed = commands.add_parser("checkpoint", help="Лента контрольных точек задачи.")
    marks = feed.add_subparsers(dest="checkpoint_command", required=True)
    add = marks.add_parser("add", help="Добавить отметку.")
    add.add_argument("taskId")
    add.add_argument("text")
    add.add_argument("--expected-revision", required=True, type=int, help="Текущая ревизия задачи.")
    add.add_argument("--kind", choices=domain.CHECKPOINT_KINDS, default="note")
    add.add_argument("--source", choices=domain.SOURCES, default="user")
    listing = marks.add_parser("list", help="Показать последние отметки.")
    listing.add_argument("taskId")
    listing.add_argument("--limit", type=int, default=10)
    listing.add_argument("--expected-revision", type=int, help="Проверить ревизию задачи при чтении.")
    detour = commands.add_parser("detour", help="Запомнить текущую задачу и уйти к другой.")
    target = detour.add_mutually_exclusive_group(required=True)
    target.add_argument("--task", help="Идентификатор существующей задачи.")
    target.add_argument("--title", help="Название новой подтверждённой задачи.")
    detour.add_argument("--expected-revision", required=True, type=int, help="Текущая ревизия фокуса.")
    returning = commands.add_parser("return", help="Вернуться к предыдущей задаче с коротким пакетом.")
    returning.add_argument("--expected-revision", required=True, type=int, help="Текущая ревизия фокуса.")
    commands.add_parser("doctor", help="Проверить базу и права без ремонта.")
    gate = commands.add_parser("gate", help="Наблюдения стража мутаций.").add_subparsers(dest="gate_command", required=True)
    gate.add_parser("stats", help="Исходы и причины BLOCK в текущем проекте.").add_argument("--days", type=int)
    gate.add_parser("recent", help="Последние наблюдения проекта.").add_argument("--limit", type=int, default=10)
    config = commands.add_parser("config", help="Настройка захвата, проектного стража и очереди.").add_subparsers(dest="config_command", required=True)
    config.add_parser("get").add_argument("key", choices=("capture-mode", "gate", "queue"))
    setter = config.add_parser("set")
    setter.add_argument("key", choices=("capture-mode", "gate", "queue"))
    setter.add_argument("mode", choices=("full-local", "redacted", "off", "observe", "run", "paused"))
    return result


def call(op, args, cwd):
    return rpc.handle({"v": 1, "op": op, "requestId": str(uuid.uuid4()),
                       "session": {"sessionId": "cli", "cwd": os.path.abspath(cwd)}, "args": args})


def output(command, result):
    if command == "status":
        focused = result["focus"]["task"]
        print(f"Режим: observe; захват: {result['captureMode']}; схема: {result['storageSchemaVersion']}")
        print("Фокус: " + (f"{focused['alias']} — {focused['title']} ({focused['status']})" if focused else "нет"))
        print(f"Ревизия фокуса: {result['focus']['revision']}")
        if focused:
            print(f"Ревизия задачи: {focused['revision']}; уверенность: {focused['certainty']}/{focused['certaintySource']}; "
                  f"происхождение: {provenance_text(focused['certaintyProvenance'])}")
        for frame in result["focusStack"]:
            print(f"Стек {frame['depth']}: {frame['taskId']} · {provenance_text(frame['provenance'])}")
        print_inbox_counts(result)
    elif command == "inbox":
        print_inbox_counts(result)
        for row in result["inbox"]:
            preview = row["preview"] if row["preview"] is not None else "[исходный текст не сохранён]"
            print(f"{row['inboxId']}  {row['capturedAt']}  {row['length']} code points  "
                  f"вид={row['type'] or 'не определён'}  источник={row['classifiedBy'] or 'нет'}  "
                  f"разбор={row['triageStatus']}  {provenance_text(row['provenance'])}  "
                  f"разбор через {provenance_text(row['triageProvenance'])}  r{row['triageRevision']}  {preview!r}")
        if not result["inbox"]:
            print("Сохранённых указаний нет.")
    elif command == "tasks":
        for row in result["tasks"]:
            if row.get("stage") == "candidate":
                print(f"{row['taskId']}  предложено  r{row['revision']}  {row['title']}")
                continue
            print(f"{row['alias']}  {row['taskId']}  {row['status']}  r{row['revision']}  "
                  f"{priority_text(row)}  исполнитель={row.get('assignee') or 'не назначен'}  "
                  f"{row['certainty']}/{row['certaintySource']}  {provenance_text(row['certaintyProvenance'])}  {row['title']}")
        if not result["tasks"]:
            print("Задач нет.")
    elif command == "show" and "task" in result:
        row = result["task"]
        print(f"{row['alias']}  {row['taskId']}  {row['status']}  r{row['revision']}  "
              f"{priority_text(row)}  исполнитель={row.get('assignee') or 'не назначен'}  {row['title']}")
        print("Описание: " + continued(row.get("description", "")))
        for key, label in (("acceptance", "Готово, когда"), ("constraints", "Ограничения")):
            for position, text in enumerate(row.get(key, []), 1):
                print(f"{label} {position}: {continued(text)}")
    elif command == "show":
        print(f"{result['inboxId']}  {result['captureMode']}  {result['length']} code points  sha256={result['sha256']}")
        if result["text"] is None:
            print("Исходный текст не сохранён (off).")
        else:
            # Оригинал в файл или канал отдаётся дословно; в терминал — без управляющих символов.
            text = result["text"]
            if sys.stdout.isatty():
                text = "\n".join(domain.plain(line) for line in text.split("\n"))
            sys.stdout.write(text)
    elif command == "doctor":
        print("Целостность: " + ", ".join(result["integrityCheck"]))
        print(f"Нарушения внешних ключей: {len(result['foreignKeyCheck'])}; схема: {result['storageSchemaVersion']}")
        print("Права каталога: " + str(result["permissions"]["directory"]["mode"]))
        for name, info in result["permissions"]["files"].items():
            print(f"Права {name}: {info['mode'] if info['present'] else 'файл отсутствует'}")
        print("Записи: " + ", ".join(f"{name}={count}" for name, count in result["counts"].items()))
    elif command == "triage":
        print(f"{result['inboxId']}  вид={result['type'] or 'не определён'}  источник={result['classifiedBy']}  "
              f"разбор={result['triageStatus']}  {provenance_text(result['provenance'])}  r{result['triageRevision']}")
        print(f"Область: задача={result['scope']['taskId'] or 'нет'}, ресурс={result['scope']['resourceId'] or 'нет'}")
    elif command == "confirm":
        task = result["task"]
        print(f"{task['alias']}  {task['title']}  {task['certainty']}/{task['certaintySource']}  "
              f"{provenance_text(task['certaintyProvenance'])}  r{task['revision']}")
    elif command == "checkpoint":
        feed = result["checkpoints"] if "checkpoints" in result else [result["checkpoint"]]
        for row in feed:
            print_checkpoint(row)
        if not feed:
            print("Контрольных точек нет.")
        print(f"Ревизия задачи: {result['taskRevision']}")
    elif command in ("detour", "return"):
        task = result["focus"]["task"]
        print(f"Фокус: {task['alias']} — {task['title']}; ревизия {result['focus']['revision']}; стек {result['stackDepth']}")
        if command == "detour":
            print_checkpoint(result["checkpoint"])
        else:
            packet = result["returnPacket"]
            print("Пакет возврата: " + packet["title"])
            for row in packet["checkpoints"]:
                print_checkpoint(row)
            for row in packet["inbox"]:
                print(f"Inbox {row['inboxId']}: {row['preview'] if row['preview'] is not None else '[исходный текст не сохранён]'}")
    elif command == "config":
        label = "Режим очереди: " if result["key"] == "queue" else "Режим стража: "
        print(label + result["value"] + " · " + provenance_text(result["provenance"]))
    elif command == "gate":
        print("Режим стража: " + result["mode"])
        if "counts" in result:
            print("Исходы: " + ", ".join(f"{name}={count}" for name, count in result["counts"].items()))
            print("Причины BLOCK: " + ", ".join(f"{name}={count}" for name, count in result["blockReasons"].items()))
        else:
            for row in result["observations"]:
                resource = row["resource"]["path"] if row["resource"]["path"] is not None else row["resource"]["resourceId"]
                print(f"{row['observedAt']}  {row['outcome']}  причины={','.join(row['reasons']) or 'нет'}  "
                      f"задача={row['taskId']}  сессия={row['sessionId']}  ресурс={resource}")
            if not result["observations"]:
                print("Наблюдений стража нет.")


def priority_text(row):
    return f"P{row.get('priority', 2)}" + ("*" if row.get("priorityPinned") else "")


def continued(text):
    # Многострочное поле печатается с отступом у строк продолжения: строка текста задачи
    # не может начаться с первой колонки и изобразить соседнюю подпись вывода.
    return text.replace("\n", "\n    ")


def print_checkpoint(row):
    print(f"{row['createdAt']}  {row['kind']}  источник={row['source']}  {provenance_text(row['provenance'])}  {continued(row['text'])}")


def provenance_text(value):
    return "панель" if value == "panel" else "командная строка"


def print_inbox_counts(result):
    counts = result["inboxTriageCounts"]
    print(f"Inbox: всего {result['inboxCounts']['total']}, неразобрано {counts['untriaged']}, блокирующих {counts['blocking']}")


def operation_args(args):
    if args.command == "config":
        return "config." + args.config_command, {"key": args.key, **({"value": args.mode} if args.config_command == "set" else {})}
    if args.command == "gate":
        return "gate." + args.gate_command, ({"limit": args.limit} if args.gate_command == "recent"
                                             else {"days": args.days} if args.days is not None else {})
    if args.command in ("status", "doctor"):
        return ("snapshot" if args.command == "status" else "doctor"), {}
    if args.command in ("inbox", "tasks"):
        return "snapshot", {"limits": {"inbox": args.limit if args.command == "inbox" else 0,
                                       "tasks": args.limit if args.command == "tasks" else 0}}
    if args.command == "show":
        return "inbox.get", {"inboxId": args.inboxId}
    if args.command == "triage":
        payload = {"inboxId": args.inboxId, "expectedRevision": args.expected_revision}
        if args.type is not None:
            payload["type"] = None if args.type == "unknown" else args.type
        if args.status is not None:
            payload["status"] = args.status
        for name in ("task", "resource"):
            value = getattr(args, name)
            if value is not None or getattr(args, "clear_" + name):
                payload[name + "Id"] = value
        return "inbox.triage", payload
    if args.command == "confirm":
        return "task.confirm", {"taskId": args.taskId, "expectedRevision": args.expected_revision}
    if args.command == "checkpoint":
        payload = {"taskId": args.taskId}
        if args.expected_revision is not None:
            payload["expectedRevision"] = args.expected_revision
        if args.checkpoint_command == "add":
            payload.update(kind=args.kind, text=args.text, source=args.source)
        else:
            payload["limit"] = args.limit
        return "checkpoint." + args.checkpoint_command, payload
    if args.command == "detour":
        target = {"taskId": args.task} if args.task is not None else {"title": args.title}
        return "focus.detour", {"expectedRevision": args.expected_revision, **target}
    if args.command == "return":
        return "focus.return", {"expectedRevision": args.expected_revision}
    domain.invalid("Неизвестная команда CLI.")


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == "rpc":
            response = rpc.read_and_handle(sys.stdin.buffer)
            sys.stdout.write(rpc.canonical(response) + "\n")
            return 0
        if args.command == "config" and args.key == "capture-mode":
            if args.config_command == "set" and args.mode not in ("full-local", "redacted", "off"):
                domain.invalid("Допустимые режимы захвата: full-local, redacted, off.")
            result = configure_capture_mode(args.mode if args.config_command == "set" else None)
            print("Режим захвата: " + result["captureMode"] + " · " + provenance_text(result["provenance"]))
            return 0
        operation, payload = operation_args(args)
        response = call(operation, payload, args.cwd)
        if args.command == "show" and not response["ok"] and response["error"]["code"] == "NOT_FOUND":
            response = call("task.get", {"taskId": args.inboxId}, args.cwd)
        if not response["ok"]:
            raise CockpitError(response["error"]["code"], response["error"]["message"])
        result = response["result"]
        if args.command == "tasks" and args.candidates:
            result = {**result, "tasks": result["candidates"][:args.limit]}
        output(args.command, result)
        return 0
    except CockpitError as exc:
        print(f"{exc.code}: {exc.message}", file=sys.stderr)
        return 1
    except Exception:
        print("Внутренний сбой процесса Cockpit.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

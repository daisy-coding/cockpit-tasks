"""Операции M1/M2; вызывающий код держит одну транзакцию вместе с ответом RPC."""

import unicodedata
import hashlib
import hmac
import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone

from . import CockpitError
from . import identity
from .store import SCHEMA_VERSION, TABLES, capture_mode
from core.decisioning.privacy import redact

OPERATIONS = (
    "capture.prompt", "task.bind", "focus.get", "focus.set", "task.update",
    "snapshot", "inbox.get", "session.rebind", "doctor",
    "inbox.triage", "task.confirm", "checkpoint.add", "checkpoint.list", "focus.detour", "focus.return",
    "gate.check", "gate.stats", "gate.recent", "config.get", "config.set", "session.end", "session.attest", "session.revoke",
    "task.get", "task.create", "task.edit", "task.action", "inbox.material", "tasks.extract", "tasks.rank", "extraction.report",
    "candidate.adopt", "candidate.dismiss",
    "tasks.agent.create", "tasks.agent.rank", "task.agent.action", "task.reopen", "tasks.context",
    "task.comment.add", "task.comment.edit", "task.comment.delete",
    "tasks.page", "task.resolve", "tasks.search",
    "task.summary.claim", "task.summary.report",
)
RPC_SCHEMA_VERSION = 1
MAX_PROJECT_OPEN_TASKS = 5000
SNAPSHOT_RESPONSE_BYTES = 3 * 1024 * 1024
SNAPSHOT_FULL_TASKS = 100
SNAPSHOT_CLOSED_TASKS = 100
CONTEXT_HISTORY_ITEMS = 100
CONTEXT_HISTORY_BYTES = 128 * 1024
OWNER_COMMENT_OPERATIONS = ("task.comment.add", "task.comment.edit", "task.comment.delete")
SOURCES = ("user", "claude", "agent", "engine", "tool", "provider")
INBOX_TYPES = ("info", "proposal", "question", "decision", "approval", "conflict", "blocking")
TRIAGE_STATUSES = ("untriaged", "triaged", "rejected")
CHECKPOINT_KINDS = ("commit", "tests-passed", "note", "detour", "return")
MAX_DETOUR_DEPTH = 8
STATUSES = ("active", "paused", "done", "cancelled")
GATE_MODES = ("off", "observe")
QUEUE_MODES = ("run", "paused")
ASSIGNEES = ("claude", "codex", "antigravity", "human")
TASK_FIELDS = ("title", "description", "acceptance", "constraints", "assignee", "priority")
GATE_OUTCOMES = ("ALLOW", "BIND", "BLOCK")
GATE_REASONS = ("foreign-lease", "stale-read", "blocking-inbox", "pending-decision")
LEASE_IDLE_SECONDS = 15 * 60
ATTESTATION_IDLE_DAYS = 7
ATTESTATION_MAX_AGE_DAYS = 14
EXTRACTION_CODES = ("extracted", "no-tasks", "skipped-gate", "no-attestation", "model-timeout", "model-unparsable", "runtime-rejected", "error")
TRANSITIONS = {
    "active": {"active", "paused", "done", "cancelled"},
    "paused": {"paused", "active", "done", "cancelled"},
    "done": {"done"},
    "cancelled": {"cancelled"},
}



# Заголовок и предпросмотр уходят из базы в состояние мода, панель и вывод команд,
# то есть в контекст разговора. Исходник в inbox остаётся дословным; наружу
# секретоподобные значения выходят маркером. Редактирование идёт до обрезки:
# иначе граница разрезала бы токен и шаблон его бы не узнал.
REDACT_WINDOW = 4000


# Соединители эмодзи (ZWJ) сохраняются; убираются только знаки, меняющие порядок показа строки.
BIDI_CONTROLS = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u2028\u2029"


def plain(text: str, *, multiline: bool = False) -> str:
    # Управляющие символы (ESC, C0/C1, изменение направления письма) в терминале
    # перерисовывают экран и подделывают строки вывода. Наружу они не выходят:
    # Табуляция становится пробелом, остальное удаляется. Поля страницы сохраняют
    # переводы строк; однострочные подписи по-прежнему заменяют их пробелами.
    text = re.sub(r"</?pasted_content\b[^>]*>", "", text, flags=re.IGNORECASE)
    if multiline:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    out = []
    for ch in text:
        if ch in "\n\t":
            out.append("\n" if multiline and ch == "\n" else " ")
        elif unicodedata.category(ch) in ("Cc", "Cs") or ch in BIDI_CONTROLS:
            continue
        else:
            out.append(ch)
    return "".join(out)


def shown(text: str, limit: int, *, multiline: bool = False) -> str:
    text = re.sub(r"</?pasted_content\b[^>]*>", "", text, flags=re.IGNORECASE)
    window = text[:REDACT_WINDOW]
    if len(text) > REDACT_WINDOW:
        # Свёрнутый в маркер длинный секрет подтягивает хвост окна в начало вывода.
        # Окно поэтому кончается на пробельном символе: токен не бывает разрезан
        # границей, а значит либо узнан шаблоном целиком, либо не входит в окно вовсе.
        cut = max((i for i, ch in enumerate(window) if ch.isspace()), default=-1)
        if cut < 0:
            return "[фрагмент без пробелов длиннее окна проверки; не показан]"[:limit]
        window = window[:cut]
    return plain(redact(window)[0], multiline=multiline)[:limit]


def description_preview(text: str, limit: int) -> str:
    # Сначала та же выдача, что в полной карточке: обрезка не разрезает секрет до проверки.
    clean = shown(text, 4000, multiline=True)
    if len(clean) <= limit:
        return clean
    suffix = " …" if limit > 1 else "…"
    return clean[:limit - len(suffix)] + suffix


def shown_response(value):
    # В старом кэше M1 title мог прийти из task.update без фильтра. Не меняем
    # сохранённый ответ, но его текстовые проекции также проходят shown при выдаче.
    # Inbox.text — явное чтение оригинала, оно под этот фильтр не попадает.
    if isinstance(value, dict):
        if isinstance(value.get("returnContext"), dict):
            context = value["returnContext"]
            for field, maximum in (("result", 500), ("ownerComment", 4000)):
                if isinstance(context.get(field), str):
                    context[field] = shown(context[field], maximum, multiline=True)
        # Старый идемпотентный ответ может содержать заглушку в фокусе.
        # Фильтруем выдачу, не переписывая сохранённый кэш или саму карточку.
        held = value.get("focus", value if "revision" in value and "task" in value else None)
        if isinstance(held, dict) and isinstance(held.get("task"), dict) and service_task(held["task"]):
            held["task"] = None
        if value.get("bound") in ("existing", "created", "created-no-source") and isinstance(value.get("task"), dict) and service_task(value["task"]):
            value["bound"], value["task"] = "unbound", None
        # Новый снимок уже отобрал видимые строки в SQL. В сжатой строке шаги
        # отсутствуют: их отсутствие не означает прежнюю служебную заглушку.
        if isinstance(value.get("tasks"), list) and "openTaskCount" not in value:
            value["tasks"] = [card for card in value["tasks"] if not isinstance(card, dict) or not service_task(card)]
        for key, marker, limit in (("title", "taskId", 300), ("preview", "inboxId", 120),
                                   ("text", "checkpointId", 1000), ("path", "resourceId", 1000),
                                   ("title", "position", 300), ("sourcePhrase", "taskId", 2000),
                                   ("description", "taskId", 4000), ("summary", "taskId", 300),
                                   ("material", "inboxId", 6030)):
            if marker in value and isinstance(value.get(key), str):
                value[key] = material(value[key]) if key == "material" else shown(value[key], limit, multiline=key in ("text", "description"))
        if "taskId" in value:
            for key in ("acceptance", "constraints"):
                if isinstance(value.get(key), list):
                    value[key] = [shown(item, 300, multiline=True) if isinstance(item, str) else item for item in value[key]]
        for child in value.values():
            shown_response(child)
    elif isinstance(value, list):
        for child in value:
            shown_response(child)
    return value


def material(text):
    # Маскирование целиком предшествует выбору начала и конца. Исходник не меняется.
    clean = plain(redact(text)[0])
    return clean if len(clean) <= 6000 else clean[:3000] + "\n[середина реплики пропущена]\n" + clean[-3000:]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def invalid(message: str):
    raise CockpitError("INVALID_REQUEST", message)


def fields(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        invalid("Неверный набор полей запроса.")


def string(value, name, maximum=100, empty=False):
    if not isinstance(value, str) or (not empty and not value) or len(value) > maximum:
        invalid(f"Поле {name} должно быть строкой допустимой длины.")
    try:
        value.encode("utf-8")
    except UnicodeError:
        invalid(f"Поле {name} содержит недопустимый Unicode.")
    return value


def identifier(value, name):
    string(value, name)
    permitted = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-"
    if value[0] not in permitted[:62] or any(char not in permitted for char in value):
        invalid(f"Поле {name} должно быть идентификатором из ASCII-букв, цифр и _.:-.")
    return value


def revision(value):
    if type(value) is not int or not 0 <= value <= 2**63 - 1:
        invalid("expectedRevision должен быть неотрицательным целым числом.")


def limits(args) -> dict:
    value = args.get("limits", {})
    fields(value, ("tasks", "inbox", "preview"))
    result = {"tasks": None, "inbox": 10, **value}
    if any(type(number) is not int or not 0 <= number <= 100 for key, number in value.items() if key != "preview"):
        invalid("Лимиты tasks и inbox должны быть целыми числами от 0 до 100.")
    if "preview" in value:
        validate_preview(value["preview"])
    return result


def validate_preview(value):
    if type(value) is not int or not 1 <= value <= 2000:
        invalid("preview должен быть целым числом от 1 до 2000.")


def short_text(value, name, maximum):
    string(value, name, maximum=maximum)
    if not value.strip():
        invalid(f"Поле {name} не может состоять только из пробелов.")


def validate_args(op, args):
    if op not in OPERATIONS:
        raise CockpitError("UNKNOWN_OP", "Неизвестная операция Cockpit.")
    shapes = {
        "capture.prompt": (("text", "deliveryId", "kind"), ("text",)),
        "task.bind": (("reason", "resourcePath", "staleRead"), ()),
        "focus.get": ((), ()),
        "focus.set": (("taskId", "expectedRevision"), ("taskId", "expectedRevision")),
        "task.update": (("taskId", "expectedRevision", "status", "title"), ("taskId", "expectedRevision")),
        "task.get": (("taskId",), ("taskId",)),
        "task.create": ((*TASK_FIELDS, "steps"), ("title",)),
        "task.edit": (("taskId", "expectedRevision", *TASK_FIELDS, "pinned"), ("taskId", "expectedRevision")),
        "tasks.rank": (("items", "source"), ("items", "source")),
        "task.action": (("taskId", "expectedRevision", "expectedFocusRevision", "action", "step"),
                        ("taskId", "expectedRevision", "expectedFocusRevision", "action")),
        "tasks.agent.create": (("tasks",), ("tasks",)),
        "tasks.agent.rank": (("order",), ("order",)),
        "task.agent.action": (("taskId", "expectedRevision", "expectedFocusRevision", "action", "note"),
                              ("taskId", "expectedRevision", "expectedFocusRevision", "action")),
        "task.reopen": (("taskId", "expectedRevision", "place", "comment"), ("taskId", "expectedRevision")),
        "tasks.context": (("cursor",), ()),
        "tasks.page": (("list", "offset", "limit", "preview"), ("list", "offset", "limit")),
        "tasks.search": (("query", "lists", "offset", "limit"), ("query",)),
        "task.resolve": (("alias",), ("alias",)),
        "task.summary.claim": (("taskId", "expectedRevision"), ("taskId", "expectedRevision")),
        "task.summary.report": (("taskId", "descriptionHash", "summary", "metrics"), ("taskId", "descriptionHash", "summary")),
        "task.comment.add": (("taskId", "text"), ("taskId", "text")),
        "task.comment.edit": (("taskId", "commentId", "expectedRevision", "text"),
                              ("taskId", "commentId", "expectedRevision", "text")),
        "task.comment.delete": (("taskId", "commentId", "expectedRevision"), ("taskId", "commentId", "expectedRevision")),
        "snapshot": (("limits",), ()),
        "inbox.get": (("inboxId",), ("inboxId",)),
        "inbox.material": (("inboxId",), ("inboxId",)),
        "tasks.extract": (("inboxId", "tasks"), ("inboxId", "tasks")),
        "candidate.adopt": (("taskId", "expectedRevision"), ("taskId", "expectedRevision")),
        "candidate.dismiss": (("taskIds", "reason"), ("taskIds", "reason")),
        "extraction.report": (("inboxId", "code"), ("inboxId", "code")),
        "session.rebind": (("reason", "limits"), ("reason",)),
        "doctor": ((), ()),
        "task.confirm": (("taskId", "expectedRevision"), ("taskId", "expectedRevision")),
        "inbox.triage": (("inboxId", "expectedRevision", "type", "taskId", "resourceId", "status"),
                         ("inboxId", "expectedRevision")),
        "checkpoint.add": (("taskId", "expectedRevision", "kind", "text", "source"),
                           ("taskId", "expectedRevision", "kind", "text")),
        "checkpoint.list": (("taskId", "expectedRevision", "limit"), ("taskId",)),
        "focus.detour": (("expectedRevision", "taskId", "title"), ("expectedRevision",)),
        "focus.return": (("expectedRevision",), ("expectedRevision",)),
        "gate.check": (("resourcePath", "staleRead"), ("resourcePath",)),
        "gate.stats": (("days",), ()),
        "gate.recent": (("limit",), ()),
        "config.get": (("key",), ("key",)),
        "config.set": (("key", "value"), ("key", "value")),
        "session.end": ((), ()),
        "session.attest": ((), ()),
        "session.revoke": ((), ()),
    }
    fields(args, *shapes[op])
    if op == "tasks.search":
        from .task_search import parse_query, LISTS
        string(args["query"], "query", maximum=200)
        if parse_query(args["query"]) is None:
            invalid("query должен содержать хотя бы одно поисковое слово.")
        if "lists" in args and (not isinstance(args["lists"], list) or not args["lists"]
                or any(not isinstance(item, str) or item not in LISTS for item in args["lists"])
                or len(set(args["lists"])) != len(args["lists"])):
            invalid("lists должен содержать неповторяющиеся queue, deferred или closed.")
        revision(args.get("offset", 0))
        if type(args.get("limit", 20)) is not int or not 1 <= args.get("limit", 20) <= 50:
            invalid("limit должен быть целым числом от 1 до 50.")
    if op == "tasks.page":
        if args["list"] not in ("queue", "deferred", "closed"):
            invalid("list должен быть queue, deferred или closed.")
        revision(args["offset"])
        if type(args["limit"]) is not int or not 1 <= args["limit"] <= 50:
            invalid("limit должен быть целым числом от 1 до 50.")
        if "preview" in args:
            validate_preview(args["preview"])
    if op == "task.resolve":
        string(args["alias"], "alias")
        if not re.fullmatch(r"TASK-[1-9][0-9]*", args["alias"]):
            invalid("alias должен иметь вид TASK-N.")
    if op == "tasks.agent.create":
        if not isinstance(args["tasks"], list) or not 1 <= len(args["tasks"]) <= 20:
            invalid("Агент создаёт от 1 до 20 задач за вызов.")
        for item in args["tasks"]:
            fields(item, ("title", "description", "place"), ("title",))
            short_text(item["title"], "title", 300)
            if "description" in item:
                string(item["description"], "description", maximum=4000, empty=True)
            if "place" in item and item["place"] not in ("top", "bottom"):
                invalid("place должен быть top или bottom.")
    if op == "tasks.agent.rank":
        if not isinstance(args["order"], list) or not 1 <= len(args["order"]) <= 30:
            invalid("Ранжирование очереди принимает от 1 до 30 taskId.")
        for task_id in args["order"]:
            identifier(task_id, "taskId")
        if len(set(args["order"])) != len(args["order"]):
            invalid("Ранжирование очереди не допускает повторов taskId.")
    if op == "task.agent.action":
        revision(args["expectedFocusRevision"])
        if args["action"] not in ("current", "done", "defer", "note"):
            invalid("actor: agent разрешены только current, done, defer и note.")
        if args["action"] == "note" and "note" not in args:
            invalid("Для заметки агента требуется note.")
        if "note" in args:
            if args["action"] not in ("done", "note"):
                invalid("note допустима только для done или note.")
            short_text(args["note"], "note", 500 if args["action"] == "done" else 1000)
    if op == "task.summary.report":
        if not isinstance(args['descriptionHash'], str) or not re.fullmatch(r'[a-f0-9]{64}', args['descriptionHash']):
            invalid('descriptionHash должен быть отпечатком редакции описания.')
        if args['summary'] is not None and (not isinstance(args['summary'], str) or len(args['summary']) > 4000):
            invalid('summary должен быть текстом до 4000 знаков или null при отказе модели.')
        if 'metrics' in args:
            keys = ('durationMs', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens')
            fields(args['metrics'], keys, ('durationMs',))
            for key, value in args['metrics'].items():
                limit = 60000 if key == 'durationMs' else 1000000
                if type(value) is not int or not 0 <= value <= limit:
                    invalid('metrics допускает только ограниченные неотрицательные счётчики.')
    if op == "tasks.context" and "cursor" in args:
        revision(args["cursor"])
    if op == "task.reopen":
        if "place" in args and args["place"] not in ("top", "bottom"):
            invalid("place должен быть top или bottom.")
        if "comment" in args:
            string(args["comment"], "comment", maximum=4000, empty=True)
    if op == "extraction.report" and args["code"] not in EXTRACTION_CODES:
        invalid("Недопустимый код исхода выделения.")
    if op in ("task.comment.add", "task.comment.edit"):
        short_text(args["text"], "text", 4000)
        if not shown(args["text"], 4000).strip():
            invalid("Комментарий не может быть пустым после фильтрации.")
    for key in ("taskId", "commentId", "inboxId", "deliveryId", "resourceId"):
        if key in args:
            if op == "inbox.triage" and key in ("taskId", "resourceId") and args[key] is None:
                continue
            identifier(args[key], key)
    if "expectedRevision" in args:
        revision(args["expectedRevision"])
    if op == "capture.prompt":
        string(args["text"], "text", maximum=1024 * 1024, empty=True)
        if "kind" in args:
            string(args["kind"], "kind")
    if op == "task.bind" and "reason" in args:
        string(args["reason"], "reason", maximum=1000, empty=True)
    if op == "session.rebind" and args["reason"] not in ("start", "resume", "clear", "compact"):
        invalid("reason должен быть start, resume, clear или compact.")
    if op == "task.update":
        if "title" not in args and "status" not in args:
            invalid("task.update требует title или status.")
        if "title" in args:
            short_text(args["title"], "title", 300)
        if "status" in args and args["status"] not in STATUSES:
            invalid("Недопустимый статус задачи M1.")
    if op in ("task.create", "task.edit"):
        if op == "task.edit" and not set(args) & {*TASK_FIELDS, "pinned"}:
            invalid("task.edit требует хотя бы одно поле поручения или pinned.")
        if "title" in args:
            short_text(args["title"], "title", 300)
        if "description" in args:
            string(args["description"], "description", maximum=4000, empty=True)
        for key in ("acceptance", "constraints"):
            if key in args:
                if not isinstance(args[key], list) or len(args[key]) > 10:
                    invalid(f"Поле {key} должно быть списком до 10 строк.")
                for item in args[key]:
                    string(item, key, maximum=300, empty=True)
        if "assignee" in args and args["assignee"] is not None and args["assignee"] not in ASSIGNEES:
            invalid("Исполнитель должен быть claude, codex, antigravity, human или null.")
        if "priority" in args and (type(args["priority"]) is not int or not 0 <= args["priority"] <= 3):
            invalid("Приоритет должен быть целым числом от 0 до 3.")
        if "pinned" in args and type(args["pinned"]) is not bool:
            invalid("pinned должен быть boolean.")
    if op == "task.create":
        if "steps" in args:
            if not isinstance(args["steps"], list) or len(args["steps"]) > 50:
                invalid("Шаги должны быть списком до 50 пунктов.")
            for step in args["steps"]:
                short_text(step, "step", 300)
    if op == "tasks.rank":
        if args["source"] not in ("model", "jev"):
            invalid("Источник ранжирования должен быть model или jev.")
        if not isinstance(args["items"], list) or len(args["items"]) > 50:
            invalid("Ранжирование принимает список до 50 задач.")
        seen = set()
        for item in args["items"]:
            fields(item, ("taskId", "expectedRevision", "priority"), ("taskId", "expectedRevision", "priority"))
            identifier(item["taskId"], "taskId")
            revision(item["expectedRevision"])
            if type(item["priority"]) is not int or not 0 <= item["priority"] <= 3:
                invalid("Приоритет должен быть целым числом от 0 до 3.")
            if item["taskId"] in seen:
                invalid("Ранжирование не допускает повторов taskId.")
            seen.add(item["taskId"])
    if op == "tasks.extract":
        if not isinstance(args["tasks"], list):
            invalid("Выделенные кандидаты должны быть списком карточек.")
        for item in args["tasks"]:
            fields(item, ("title", "steps", "sourcePhrase", "description", "acceptance", "constraints"), ("title", "steps"))
            validate_args("task.create", {key: value for key, value in item.items() if key != "sourcePhrase"})
            if "sourcePhrase" in item:
                short_text(item["sourcePhrase"], "sourcePhrase", 2000)
    if op == "candidate.dismiss":
        if not isinstance(args["taskIds"], list) or not 1 <= len(args["taskIds"]) <= 20:
            invalid("Отклонение принимает от 1 до 20 идентификаторов кандидатов.")
        for task_id in args["taskIds"]:
            identifier(task_id, "taskId")
        if len(set(args["taskIds"])) != len(args["taskIds"]):
            invalid("Отклонение не допускает повторов taskId.")
        if args["reason"] not in ("answered", "owner", "duplicate"):
            invalid("Причина отклонения: answered, owner или duplicate; expired ставит рантайм.")
    if op == "task.action":
        revision(args["expectedFocusRevision"])
        if args["action"] not in ("current", "done", "defer", "restore", "up", "down", "delete", "step"):
            invalid("Неизвестное действие карточки.")
        if args["action"] == "step":
            if type(args.get("step")) is not int or not 0 <= args["step"] < 50:
                invalid("Требуется номер шага от 0 до 49.")
        elif "step" in args:
            invalid("Номер шага допустим только для действия step.")
    if op in ("snapshot", "session.rebind"):
        limits(args)
    if op == "inbox.triage":
        if not set(args) & {"type", "taskId", "resourceId", "status"}:
            invalid("inbox.triage требует вид, область действия или статус разбора.")
        if "type" in args and args["type"] is not None and args["type"] not in INBOX_TYPES:
            invalid("Недопустимый вид пункта Inbox.")
        if "status" in args and args["status"] not in TRIAGE_STATUSES:
            invalid("Статус разбора должен быть untriaged, triaged или rejected.")
    if op == "checkpoint.add":
        if args["kind"] not in CHECKPOINT_KINDS:
            invalid("Недопустимый вид контрольной точки.")
        short_text(args["text"], "text", 1000)
        if args.get("source", "user") not in SOURCES:
            invalid("Недопустимый источник контрольной точки.")
    if op == "checkpoint.list":
        value = args.get("limit", 10)
        if type(value) is not int or not 0 <= value <= 100:
            invalid("Лимит контрольных точек должен быть целым числом от 0 до 100.")
    if op == "focus.detour":
        if ("taskId" in args) == ("title" in args):
            invalid("Отход требует ровно одно из taskId или title.")
        if "title" in args:
            short_text(args["title"], "title", 300)
    if op in ("gate.check", "task.bind"):
        if "resourcePath" in args:
            path = string(args["resourcePath"], "resourcePath", maximum=32768)
            if not os.path.isabs(path) or "\x00" in path:
                invalid("resourcePath должен быть абсолютным путём без NUL.")
        if "staleRead" in args and type(args["staleRead"]) is not bool:
            invalid("staleRead должен быть boolean.")
    if op == "gate.stats" and "days" in args:
        if type(args["days"]) is not int or not 1 <= args["days"] <= 36500:
            invalid("days должен быть целым числом от 1 до 36500.")
    if op == "gate.recent":
        value = args.get("limit", 10)
        if type(value) is not int or not 0 <= value <= 100:
            invalid("Лимит наблюдений должен быть целым числом от 0 до 100.")
    if op in ("config.get", "config.set"):
        if args["key"] not in ("gate", "queue"):
            invalid("Проектные настройки RPC: gate, queue.")
        modes = GATE_MODES if args["key"] == "gate" else QUEUE_MODES
        if op == "config.set" and args["value"] not in modes:
            invalid("Допустимые значения настройки: " + ", ".join(modes) + ".")


def ensure_binding(db, identity, session_id) -> dict:
    timestamp = now()
    project = db.execute("SELECT project_id FROM projects WHERE identity_kind=? AND canonical_path=?",
                         (identity.kind, identity.project_path)).fetchone()
    project_id = project[0] if project else str(uuid.uuid4())
    if project is None:
        db.execute("INSERT INTO projects VALUES (?,?,?,?,?)",
                   (project_id, identity.kind, identity.project_path,
                    os.path.basename(identity.worktree_path), timestamp))
    worktree = db.execute("SELECT worktree_id,project_id FROM worktrees WHERE local_path=?",
                          (identity.worktree_path,)).fetchone()
    if worktree is not None and worktree["project_id"] != project_id:
        invalid("Checkout уже связан с другим Git common dir; автоматическая подмена проекта запрещена.")
    worktree_id = worktree["worktree_id"] if worktree else str(uuid.uuid4())
    if worktree is None:
        db.execute("INSERT INTO worktrees VALUES (?,?,?)", (worktree_id, project_id, identity.worktree_path))
    db.execute("""INSERT INTO sessions VALUES (?,?,?,?)
        ON CONFLICT(session_id,project_id,worktree_id) DO UPDATE SET last_seen_at=excluded.last_seen_at""",
               (session_id, project_id, worktree_id, timestamp))
    return {"projectId": project_id, "worktreeId": worktree_id, "sessionId": session_id,
            "worktreePath": identity.worktree_path}


def event(db, binding, kind, entity_id):
    # Свободный reason, заголовок, аргументы и исходный текст в журнал не попадают.
    db.execute("""INSERT INTO events(project_id,worktree_id,session_id,kind,entity_id,created_at)
        VALUES (?,?,?,?,?,?)""", (binding["projectId"], binding["worktreeId"],
                               binding["sessionId"], kind, entity_id, now()))


def extraction_stats(db, binding=None):
    where = "kind LIKE 'extraction.%'"
    parameters = ()
    if binding:
        where += " AND project_id=? AND worktree_id=? AND session_id=?"
        parameters = (binding["projectId"], binding["worktreeId"], binding["sessionId"])
    rows = db.execute(f"SELECT kind,created_at FROM events WHERE {where} ORDER BY event_id DESC", parameters).fetchall()
    counts = {code: 0 for code in EXTRACTION_CODES}
    last_success = None
    streak = 0
    for index, row in enumerate(rows):
        code = row["kind"].removeprefix("extraction.")
        if code not in counts:
            continue
        counts[code] += 1
        if code == "extracted" and last_success is None:
            last_success = row["created_at"]
        if streak == index and code not in ("extracted", "no-tasks", "skipped-gate"):
            streak += 1
    owner_where = "kind='prompt.captured'"
    if binding:
        owner_where += " AND project_id=? AND worktree_id=? AND session_id=?"
    owners = db.execute(f"SELECT COUNT(*) FROM events WHERE {owner_where}", parameters).fetchone()[0]
    return {"counts": counts, "lastSuccessAt": last_success, "consecutiveFailures": streak,
            "lastReason": rows[0]["kind"].removeprefix("extraction.") if rows else None, "ownerRequests": owners}


def extraction_report(db, binding, inbox_id, code):
    source = inbox_row(db, inbox_id, binding)
    if source["session_id"] != binding["sessionId"]:
        invalid("Исход выделения относится только к доставке своей сессии.")
    recorded = db.execute("SELECT 1 FROM events WHERE project_id=? AND worktree_id=? AND entity_id=? AND kind LIKE 'extraction.%' LIMIT 1",
                          (binding["projectId"], binding["worktreeId"], inbox_id)).fetchone()
    if recorded is None:
        event(db, binding, "extraction." + code, inbox_id)
    return {"recorded": True, "code": code, "extraction": extraction_stats(db, binding)}


def authenticate(db, binding, secret, registering=False):
    if secret is None:
        return "cli"
    digest = hashlib.sha256(secret.encode("ascii")).hexdigest()
    key = (binding["sessionId"], binding["projectId"], binding["worktreeId"])
    row = db.execute("""SELECT secret_sha256 FROM session_attestations
        WHERE session_id=? AND project_id=? AND worktree_id=?""", key).fetchone()
    if row is None and registering:
        timestamp = now()
        db.execute("INSERT INTO session_attestations VALUES (?,?,?,?,?)", (*key, digest, timestamp))
        db.execute("INSERT INTO attestation_usage VALUES (?,?,?,?)", (*key, timestamp))
    else:
        matched = hmac.compare_digest(row[0] if row else "0" * 64, digest)
        if row is None or not matched:
            code = "ATTESTATION_CONFLICT" if registering and row is not None else "ATTESTATION_FAILED"
            message = ("[attestation-unregistered] Для этой привязки сессии свидетельство панели не зарегистрировано."
                       if row is None else "[attestation-mismatch] Свидетельство панели не совпало с привязкой сессии; действующая регистрация сохранена.")
            raise CockpitError(code, message)
    revoked = db.execute("SELECT 1 FROM attestation_revocations WHERE session_id=? AND project_id=? AND worktree_id=?", key).fetchone()
    if revoked:
        error = CockpitError("ATTESTATION_CONFLICT" if registering else "ATTESTATION_FAILED", "[attestation-revoked] Свидетельство этой привязки отозвано; требуется новая привязка панели.")
        error.revoked = True
        raise error
    usage = db.execute("SELECT last_used_at FROM attestation_usage WHERE session_id=? AND project_id=? AND worktree_id=?", key).fetchone()
    if usage is None or datetime.fromisoformat(now()) >= datetime.fromisoformat(usage[0]) + timedelta(days=ATTESTATION_IDLE_DAYS):
        raise CockpitError("ATTESTATION_FAILED", "[attestation-expired] Свидетельство не использовалось успешно семь суток; требуется новая аттестация панели.")
    # Без автоотзыва прежних эпох ключ, которым продолжают пользоваться, жил бы вечно:
    # предельный возраст ограничивает и утёкший, и забытый ключ независимо от использования.
    created = db.execute("SELECT created_at FROM session_attestations WHERE session_id=? AND project_id=? AND worktree_id=?", key).fetchone()
    if created is None or datetime.fromisoformat(now()) >= datetime.fromisoformat(created[0]) + timedelta(days=ATTESTATION_MAX_AGE_DAYS):
        raise CockpitError("ATTESTATION_FAILED", "[attestation-expired] Свидетельство старше четырнадцати суток; требуется новая аттестация панели.")
    return "panel"


def touch_attestation(db, binding):
    db.execute("UPDATE attestation_usage SET last_used_at=? WHERE session_id=? AND project_id=? AND worktree_id=?",
               (now(), binding["sessionId"], binding["projectId"], binding["worktreeId"]))


def task_row_summary(row, needs_decision=False, return_count=0) -> dict:
    return {
        "taskId": row["task_id"], "projectId": row["project_id"], "worktreeId": row["worktree_id"],
        "alias": f"TASK-{row['alias_no']}", "title": shown(row["title"], 300), "status": row["status"],
        "revision": row["revision"], "origin": row["origin"],
        "certainty": row["certainty"], "certaintySource": row["certainty_source"],
        "certaintyProvenance": row["certainty_provenance"],
        "stage": row["stage"], "adoptedBy": row["adopted_by"],
        "dismissReason": row["dismiss_reason"], "dismissedAt": row["dismissed_at"],
        "assignee": row["assignee"], "priority": row["priority"],
        "prioritySource": row["priority_source"], "priorityPinned": bool(row["priority_pinned"]),
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
        "queuePosition": None if row["stage"] == "candidate" else row["queue_position"],
        "needsDecision": needs_decision, "elapsedMs": row["elapsed_ms"],
        "activeSince": row["active_since"], "deleted": bool(row["deleted"]),
        "returnCount": return_count,
    }


def task(db, task_id, project_id) -> dict:
    from .description_summary import summary_fields
    row = db.execute("SELECT * FROM tasks WHERE task_id=? AND project_id=?", (task_id, project_id)).fetchone()
    if row is None:
        raise CockpitError("NOT_FOUND", "Задача не найдена в текущем проекте.")
    source = db.execute("SELECT * FROM task_sources WHERE task_id=?", (task_id,)).fetchone()
    phrase = None
    if source is not None:
        original = db.execute("SELECT raw_text FROM inbox WHERE inbox_id=?", (source["inbox_id"],)).fetchone()
        if original and original[0] is not None:
            phrase = shown(original[0][source["start_pos"]:source["end_pos"]], 2000)
    latest = checkpoints(db, task_id, 1)
    steps = [{"position": step["position"], "title": shown(step["title"], 300), "status": step["status"]}
             for step in db.execute("SELECT * FROM task_steps WHERE task_id=? ORDER BY position", (task_id,))]
    needs_decision = db.execute("""SELECT 1 FROM inbox_state WHERE project_id=? AND task_id=?
        AND triage_status='untriaged' AND mode='active' AND inbox_type IN ('decision','approval','blocking') LIMIT 1""",
                                (project_id, task_id)).fetchone() is not None
    return {
        **task_row_summary(row, needs_decision),
        "returnCount": return_counts(db, [task_id]).get(task_id, 0),
        **task_return_context(db, task_id),
        "description": shown(row["description"], 4000, multiline=True),
        **summary_fields(db, [row]).get(task_id, {}),
        **{kind: [shown(item[0], 300, multiline=True) for item in db.execute(
            "SELECT text FROM task_lists WHERE task_id=? AND kind=? ORDER BY position", (task_id, kind))]
           for kind in ("acceptance", "constraints")},
        "steps": steps, "sourcePhrase": phrase,
        "lastCheckpoint": latest[0] if latest else None,
        "source": None if source is None else {
            "inboxId": source["inbox_id"], "start": source["start_pos"],
            "end": source["end_pos"], "sha256": source["source_sha256"],
        },
    }


def own_task(db, binding, task_id) -> dict:
    """Карточка по идентификатору из запроса: только своего рабочего дерева.

    Карточка несёт исходную фразу и отметку, а операции меняют фокус и ревизию;
    соседнему checkout того же проекта она не отдаётся ни на чтение, ни на запись.
    """
    card = task(db, task_id, binding["projectId"])
    if card["worktreeId"] != binding["worktreeId"]:
        raise CockpitError("NOT_FOUND", "Карточка недоступна в текущем рабочем дереве.")
    return card


def focus(db, binding) -> dict:
    row = db.execute("SELECT task_id,revision FROM focus WHERE worktree_id=? AND project_id=?",
                     (binding["worktreeId"], binding["projectId"])).fetchone()
    card = task(db, row["task_id"], binding["projectId"]) if row and row["task_id"] else None
    return {"task": None if card and (service_task(card) or card["stage"] == "candidate") else card,
            "revision": row["revision"] if row else 0}


def service_task(card):
    # Старые заглушки сохраняются в БД, но не становятся текущим поручением.
    return (card.get("certainty") == "observed" and card.get("certaintySource") == "engine"
            and card.get("certaintyProvenance", "cli") == "cli" and not card.get("steps"))


def stop_clock(db, task_id):
    row = db.execute("SELECT active_since FROM tasks WHERE task_id=?", (task_id,)).fetchone()
    if row and row[0]:
        start = datetime.fromisoformat(row[0].replace("Z", "+00:00"))
        elapsed = max(0, int((datetime.now(timezone.utc) - start).total_seconds() * 1000))
        db.execute("UPDATE tasks SET elapsed_ms=elapsed_ms+?,active_since=NULL WHERE task_id=?", (elapsed, task_id))


def set_focus(db, binding, task_id):
    if task_id:
        require_task(task(db, task_id, binding["projectId"]))
    previous = db.execute("SELECT task_id FROM focus WHERE worktree_id=?", (binding["worktreeId"],)).fetchone()
    if previous and previous[0] and previous[0] != task_id:
        stop_clock(db, previous[0])
        db.execute("UPDATE task_steps SET status='pending' WHERE task_id=? AND status='active'", (previous[0],))
    db.execute("""INSERT INTO focus VALUES (?,?,?,?,1)
        ON CONFLICT(worktree_id) DO UPDATE SET task_id=excluded.task_id,
        session_id=excluded.session_id,revision=focus.revision+1""",
               (binding["worktreeId"], binding["projectId"], binding["sessionId"], task_id))
    if task_id:
        db.execute("UPDATE tasks SET status='active',revision=revision+1,updated_at=? WHERE task_id=? AND status='paused'", (now(), task_id))
        db.execute("UPDATE tasks SET active_since=COALESCE(active_since,?) WHERE task_id=? AND status='active'", (now(), task_id))
        db.execute("UPDATE task_steps SET status='active' WHERE task_id=? AND position=(SELECT MIN(position) FROM task_steps WHERE task_id=? AND status='pending') AND NOT EXISTS(SELECT 1 FROM task_steps WHERE task_id=? AND status='active')", (task_id, task_id, task_id))
    event(db, binding, "focus.set", task_id or binding["worktreeId"])


def reattach_focus(db, binding):
    cursor = db.execute("""UPDATE focus SET session_id=?,revision=revision+1
        WHERE worktree_id=? AND project_id=? AND session_id<>?""",
                        (binding["sessionId"], binding["worktreeId"], binding["projectId"], binding["sessionId"]))
    if cursor.rowcount:
        event(db, binding, "focus.rebound", binding["worktreeId"])


def create_task(db, binding, title, origin="no-source", certainty="observed", certainty_source="engine", provenance="cli", stage="task"):
    task_id = str(uuid.uuid4())
    number = db.execute("SELECT COALESCE(MAX(alias_no),0)+1 FROM tasks WHERE project_id=?",
                        (binding["projectId"],)).fetchone()[0]
    timestamp = now()
    db.execute("""INSERT INTO tasks(task_id,project_id,worktree_id,alias_no,origin,title,status,
        revision,created_at,updated_at,certainty,certainty_source,certainty_provenance,queue_position,priority_provenance,stage) VALUES (?,?,?,?,?,?,'active',0,?,?,?,?,?,?,?,?)""",
               (task_id, binding["projectId"], binding["worktreeId"], number, origin, title,
                timestamp, timestamp, certainty, certainty_source, provenance, 0 if stage == "candidate" else number, provenance, stage))
    event(db, binding, "candidate.created" if stage == "candidate" else "task.created", task_id)
    return task_id


def bind(db, binding) -> dict:
    current = focus(db, binding)
    if current["task"] is not None:
        reattach_focus(db, binding)
        return {"bound": "existing", "task": current["task"], "focusRevision": focus(db, binding)["revision"]}
    return {"bound": "unbound", "task": None, "focusRevision": current["revision"]}


def gate_mode(db, binding):
    row = db.execute("SELECT gate_mode FROM project_config WHERE project_id=?", (binding["projectId"],)).fetchone()
    return row[0] if row else "off"


def queue_mode(db, binding):
    row = db.execute("SELECT queue_mode FROM project_config WHERE project_id=?", (binding["projectId"],)).fetchone()
    return row[0] if row else "run"


def gate_stats(db, binding, days=None, session_only=False) -> dict:
    where = "g.project_id=?"
    parameters = [binding["projectId"]]
    if session_only:
        where += " AND g.session_id=?"
        parameters.append(binding["sessionId"])
    if days is not None:
        since = datetime.fromisoformat(now().replace("Z", "+00:00")) - timedelta(days=days)
        where += " AND g.observed_at>=?"
        parameters.append(since.isoformat(timespec="microseconds").replace("+00:00", "Z"))
    counts = dict.fromkeys(GATE_OUTCOMES, 0)
    for row in db.execute(f"SELECT outcome,COUNT(*) AS n FROM gate_observations g WHERE {where} GROUP BY outcome", parameters):
        counts[row["outcome"]] = row["n"]
    reasons = dict.fromkeys(GATE_REASONS, 0)
    for row in db.execute(f"""SELECT r.value,COUNT(*) AS n FROM gate_observations g,json_each(g.reasons_json) r
        WHERE {where} AND g.outcome='BLOCK' GROUP BY r.value""", parameters):
        reasons[row["value"]] = row["n"]
    event_where = where.replace("g.observed_at", "g.created_at")
    for row in db.execute(f"SELECT * FROM events g WHERE {event_where} AND kind='gate.unbound'", parameters):
        observation = unbound_observation(row)
        counts[observation["outcome"]] += 1
        for reason in observation["reasons"]:
            reasons[reason] += 1
    return {"mode": gate_mode(db, binding), "counts": counts, "blockReasons": reasons}


def gate_resource(db, binding, path):
    # Не читаем содержимое: realpath нужен для одинакового ресурса через симлинк.
    canonical = os.path.realpath(path)
    root = db.execute("SELECT local_path FROM worktrees WHERE worktree_id=?", (binding["worktreeId"],)).fetchone()[0]
    resource_id = "path-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    relative = os.path.relpath(canonical, root) if os.path.commonpath((canonical, root)) == root else None
    return resource_id, relative


def gate_observation(row):
    return {"observationId": row["observation_id"], "outcome": row["outcome"],
            "reasons": json.loads(row["reasons_json"]), "taskId": row["task_id"],
            "resource": {"resourceId": row["resource_id"],
                         "path": shown(row["resource_path"], 1000) if row["resource_path"] is not None else None},
            "sessionId": row["session_id"], "observedAt": row["observed_at"]}


def unbound_observation(row):
    value = json.loads(row["entity_id"])
    return {"observationId": 2 ** 52 + row["event_id"], "outcome": value["outcome"],
            "reasons": value["reasons"], "taskId": None,
            "resource": {"resourceId": value["resourceId"], "path": None},
            "sessionId": row["session_id"], "observedAt": row["created_at"]}


def bind_with_gate(db, binding, args):
    # Весь путь, включая bind, аренду и журнал, уже под одним BEGIN IMMEDIATE.
    bound = bind(db, binding)
    if gate_mode(db, binding) == "off":
        return {**bound, "gate": gate_stats(db, binding, session_only=True), "observation": None}
    timestamp = now()
    lease = db.execute("SELECT * FROM worktree_leases WHERE worktree_id=?", (binding["worktreeId"],)).fetchone()
    reasons = []
    if lease and lease["expires_at"] > timestamp and lease["session_id"] != binding["sessionId"]:
        reasons.append("foreign-lease")
    else:
        expiry = datetime.fromisoformat(timestamp.replace("Z", "+00:00")) + timedelta(seconds=LEASE_IDLE_SECONDS)
        acquired = lease["acquired_at"] if lease and lease["session_id"] == binding["sessionId"] and lease["expires_at"] > timestamp else timestamp
        db.execute("""INSERT INTO worktree_leases VALUES (?,?,?,?,?,?)
            ON CONFLICT(worktree_id) DO UPDATE SET session_id=excluded.session_id,
            acquired_at=excluded.acquired_at,renewed_at=excluded.renewed_at,expires_at=excluded.expires_at""",
                   (binding["worktreeId"], binding["projectId"], binding["sessionId"], acquired, timestamp,
                    expiry.isoformat(timespec="microseconds").replace("+00:00", "Z")))
    if args.get("staleRead", False):
        reasons.append("stale-read")
    path = args.get("resourcePath")
    all_resources = path is None
    if path is None:
        path = db.execute("SELECT local_path FROM worktrees WHERE worktree_id=?", (binding["worktreeId"],)).fetchone()[0]
    resource_id, relative = gate_resource(db, binding, path)
    task_id = bound["task"]["taskId"] if bound["task"] else None
    # CLI не снимает прежнюю причину сменой вида или области. Только последняя
    # запись панели заменяет предшествующие наблюдения; показ использует inbox_state.
    pending = db.execute("""SELECT o.inbox_type,o.task_id,o.resource_id FROM inbox i
        JOIN inbox_observations o ON o.inbox_id=i.inbox_id
        LEFT JOIN inbox_observations p ON p.observation_id=(
            SELECT r.observation_id FROM authorized_inbox_observations r WHERE r.inbox_id=i.inbox_id
            ORDER BY r.observation_id DESC LIMIT 1)
        WHERE i.project_id=? AND i.worktree_id=? AND o.mode='active'
        AND (p.observation_id IS NULL OR o.observation_id=p.observation_id)
        AND (p.observation_id IS NULL OR COALESCE(o.triage_status,'untriaged')='untriaged')
        AND ((o.inbox_type='blocking' AND (o.task_id IS NULL OR o.task_id=?)
              AND (o.task_id=? OR o.resource_id=? OR (? AND o.resource_id IS NOT NULL)))
             OR (o.inbox_type IN ('decision','approval') AND o.task_id=?))""",
                         (binding["projectId"], binding["worktreeId"], task_id,
                          task_id, resource_id, all_resources, task_id)).fetchall()
    if any(row["inbox_type"] == "blocking" for row in pending):
        reasons.append("blocking-inbox")
    if any(row["inbox_type"] in ("decision", "approval") for row in pending):
        reasons.append("pending-decision")
    first_binding = task_id is not None and db.execute(
        "SELECT 1 FROM gate_observations WHERE worktree_id=? LIMIT 1", (binding["worktreeId"],)).fetchone() is None
    outcome = "BLOCK" if reasons else "BIND" if first_binding else "ALLOW"
    if task_id is None:
        # Схема журнала стража требует задачу. Для работы без задачи используем
        # существующий журнал событий, сохраняя только коды и хеш ресурса.
        event(db, binding, "gate.unbound", json.dumps({"outcome": outcome, "reasons": reasons,
                                                       "resourceId": resource_id}, separators=(",", ":")))
        row = db.execute("SELECT * FROM events WHERE event_id=last_insert_rowid()").fetchone()
        return {**bound, "gate": gate_stats(db, binding, session_only=True), "observation": unbound_observation(row)}
    cursor = db.execute("""INSERT INTO gate_observations
        (project_id,worktree_id,session_id,task_id,outcome,reasons_json,resource_id,resource_path,observed_at)
        VALUES (?,?,?,?,?,?,?,?,?)""",
                        (binding["projectId"], binding["worktreeId"], binding["sessionId"], bound["task"]["taskId"],
                         outcome, json.dumps(reasons, separators=(",", ":")), resource_id, relative, timestamp))
    row = db.execute("SELECT * FROM gate_observations WHERE observation_id=?", (cursor.lastrowid,)).fetchone()
    event(db, binding, "gate.observed", str(cursor.lastrowid))
    return {**bound, "gate": gate_stats(db, binding, session_only=True), "observation": gate_observation(row)}


def expect_revision(actual, expected, subject):
    if actual != expected:
        raise CockpitError("REVISION_CONFLICT", f"Ревизия {subject} устарела; получите свежее состояние.")


def classification(row) -> dict:
    return {
        "type": row["inbox_type"], "classifiedBy": row["classified_by"],
        "scope": {"taskId": row["task_id"], "resourceId": row["resource_id"]},
        "policyVersion": row["policy_version"], "confidence": row["confidence"],
        "mode": row["mode"], "observedAt": row["observed_at"],
        "triageStatus": row["triage_status"], "triageRevision": row["triage_revision"],
        "provenance": row["provenance"], "triageProvenance": row["triage_provenance"],
    }


def inbox_row(db, inbox_id, binding):
    row = db.execute("SELECT * FROM inbox_state WHERE inbox_id=? AND project_id=? AND worktree_id=?",
                     (inbox_id, binding["projectId"], binding["worktreeId"])).fetchone()
    if row is None:
        raise CockpitError("NOT_FOUND", "Указание не найдено в текущем checkout.")
    return row


def inbox_result(row) -> dict:
    return {
        "inboxId": row["inbox_id"],
        "binding": {"projectId": row["project_id"], "worktreeId": row["worktree_id"], "sessionId": row["session_id"]},
        "deliveryId": row["delivery_key"], "kind": row["source_kind"], "captureMode": row["capture_mode"],
        "text": row["raw_text"], "sha256": row["raw_sha256"], "length": row["raw_length"],
        "status": row["status"], "capturedAt": row["captured_at"], **classification(row),
    }


def inbox_preview(row) -> dict:
    return {
        "inboxId": row["inbox_id"], "capturedAt": row["captured_at"], "length": row["raw_length"],
        "preview": shown(row["raw_text"], 120) if row["capture_mode"] == "full-local" else None,
        **classification(row),
    }


def classify_prompt(db, binding, inbox_id, text):
    current = db.execute("""SELECT t.task_id FROM focus f JOIN tasks t ON t.task_id=f.task_id
        AND t.project_id=f.project_id WHERE f.worktree_id=? AND f.project_id=? AND t.status='active' AND t.stage='task'""",
                         (binding["worktreeId"], binding["projectId"])).fetchone()
    db.execute("""INSERT INTO inbox_observations
        (inbox_id,project_id,inbox_type,task_id,classified_by,policy_version,mode,created_at)
        VALUES (?,?,?,?,'rule','rule-1','active',?)""",
               (inbox_id, binding["projectId"], "question" if text.endswith("?") else "info",
                current["task_id"] if current else None, now()))


def triage(db, binding, args, provenance) -> dict:
    row = inbox_row(db, args["inboxId"], binding)
    expect_revision(row["triage_revision"], args["expectedRevision"], "разбора Inbox")
    task_id = args.get("taskId", row["task_id"])
    if task_id is not None:
        require_task(own_task(db, binding, task_id))
    # Статус из другого канала не становится решением текущего запроса по умолчанию.
    inherited_status = row["triage_status"] if row["triage_provenance"] == provenance else "untriaged"
    cursor = db.execute("""INSERT INTO inbox_observations
        (inbox_id,project_id,inbox_type,task_id,resource_id,classified_by,policy_version,mode,triage_status,created_at,provenance,
         author_session_id,author_worktree_id)
        VALUES (?,?,?,?,?,'user','user-1','active',?,?,?,?,?)""",
               (row["inbox_id"], binding["projectId"], args.get("type", row["inbox_type"]), task_id,
                args.get("resourceId", row["resource_id"]), args.get("status", inherited_status), now(), provenance,
                binding["sessionId"], binding["worktreeId"]))
    event(db, binding, "inbox.triage", row["inbox_id"])
    # Ответ описывает именно новую запись, даже когда действующим остаётся решение панели.
    recorded = db.execute("SELECT * FROM inbox_observations WHERE observation_id=?", (cursor.lastrowid,)).fetchone()
    result = dict(inbox_row(db, row["inbox_id"], binding))
    for key in ("inbox_type", "task_id", "resource_id", "classified_by", "policy_version", "confidence", "mode", "triage_status", "provenance"):
        result[key] = recorded[key]
    result["observed_at"] = recorded["created_at"]
    result["triage_provenance"] = provenance
    return inbox_preview(result)


def checkpoint_result(row) -> dict:
    return {"checkpointId": row["checkpoint_id"], "taskId": row["task_id"], "kind": row["kind"],
            "text": shown(row["text"], 1000, multiline=True), "source": row["source"], "createdAt": row["created_at"],
            "provenance": row["provenance"]}


def checkpoints(db, task_id, limit) -> list:
    return [checkpoint_result(row) for row in db.execute(
        """SELECT c.* FROM checkpoints c WHERE c.task_id=?
            AND NOT EXISTS (SELECT 1 FROM task_owner_comments o WHERE o.comment_id=c.checkpoint_id)
            ORDER BY c.rowid DESC LIMIT ?""", (task_id, limit))]


def add_checkpoint(db, binding, task_id, kind, text, source="user", provenance="cli") -> dict:
    checkpoint_id, timestamp = str(uuid.uuid4()), now()
    db.execute("INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?,?,?,?)",
               (checkpoint_id, task_id, binding["projectId"], binding["worktreeId"], binding["sessionId"],
                kind, text, source, timestamp, provenance))
    db.execute("UPDATE tasks SET revision=revision+1,updated_at=? WHERE task_id=?", (timestamp, task_id))
    event(db, binding, "checkpoint." + kind, checkpoint_id)
    return checkpoint_result(db.execute("SELECT * FROM checkpoints WHERE checkpoint_id=?", (checkpoint_id,)).fetchone())


def stack_depth(db, binding):
    return db.execute("SELECT COUNT(*) FROM focus_stack WHERE worktree_id=? AND project_id=?",
                      (binding["worktreeId"], binding["projectId"])).fetchone()[0]


def detour(db, binding, args, provenance) -> dict:
    current = focus(db, binding)
    expect_revision(current["revision"], args["expectedRevision"], "фокуса")
    if current["task"] is None:
        invalid("Для отхода нужна текущая задача в фокусе.")
    depth = stack_depth(db, binding)
    if depth >= MAX_DETOUR_DEPTH:
        invalid("Достигнут предел стека отхода: 8 задач.")
    if "taskId" in args:
        target = own_task(db, binding, args["taskId"])
        if target["status"] in ("done", "cancelled") or target["deleted"]:
            invalid("Завершённую или отменённую задачу нельзя поставить в фокус.")
        if target["taskId"] == current["task"]["taskId"]:
            invalid("Отход должен вести к другой задаче.")
    else:
        target_id = create_task(db, binding, args["title"], certainty="confirmed", certainty_source="user", provenance=provenance)
        target = task(db, target_id, binding["projectId"])
    db.execute("INSERT INTO focus_stack VALUES (?,?,?,?,?,'user',?,?)",
               (binding["worktreeId"], binding["projectId"], depth + 1, current["task"]["taskId"],
                binding["sessionId"], now(), provenance))
    checkpoint = add_checkpoint(db, binding, current["task"]["taskId"], "detour", f"Отход к {target['alias']}.", provenance=provenance)
    set_focus(db, binding, target["taskId"])
    return {"focus": focus(db, binding), "stackDepth": depth + 1, "checkpoint": checkpoint}


def return_focus(db, binding, args, provenance) -> dict:
    current = focus(db, binding)
    expect_revision(current["revision"], args["expectedRevision"], "фокуса")
    frame = db.execute("""SELECT task_id,depth FROM focus_stack WHERE worktree_id=? AND project_id=?
        ORDER BY depth DESC LIMIT 1""", (binding["worktreeId"], binding["projectId"])).fetchone()
    if frame is None:
        invalid("Стек возврата пуст.")
    target = task(db, frame["task_id"], binding["projectId"])
    if target["status"] in ("done", "cancelled") or target["deleted"]:
        invalid("Задача на вершине стека завершена или отменена; возврат невозможен.")
    db.execute("DELETE FROM focus_stack WHERE worktree_id=? AND depth=?", (binding["worktreeId"], frame["depth"]))
    text = f"Возврат из {current['task']['alias']}." if current["task"] else "Возврат к задаче после очистки фокуса."
    checkpoint = add_checkpoint(db, binding, target["taskId"], "return", text, provenance=provenance)
    set_focus(db, binding, target["taskId"])
    restored = focus(db, binding)
    pending = db.execute("""SELECT * FROM inbox_state WHERE project_id=? AND worktree_id=?
        AND task_id=? AND triage_status='untriaged' ORDER BY capture_order DESC LIMIT 5""",
                         (binding["projectId"], binding["worktreeId"], target["taskId"])).fetchall()
    return {"focus": restored, "stackDepth": frame["depth"] - 1, "checkpoint": checkpoint,
            "returnPacket": {"taskId": target["taskId"], "title": restored["task"]["title"],
                             "checkpoints": checkpoints(db, target["taskId"], 5),
                             "inbox": [inbox_preview(row) for row in pending]}}


VISIBLE_TASK_SQL = """t.project_id=? AND t.worktree_id=? AND t.deleted=0 AND t.stage='task'
    AND NOT (t.certainty='observed' AND t.certainty_source='engine' AND t.certainty_provenance='cli'
        AND NOT EXISTS (SELECT 1 FROM task_steps s WHERE s.task_id=t.task_id))"""


def snapshot(db, binding, bounds) -> dict:
    counts = db.execute("""SELECT COUNT(*) AS total,
        COALESCE(SUM(triage_status='untriaged'),0) AS untriaged,
        COALESCE(SUM(triage_status='untriaged' AND inbox_type='blocking' AND mode='active'),0) AS blocking
        FROM inbox_state WHERE worktree_id=? AND project_id=?""",
                        (binding["worktreeId"], binding["projectId"])).fetchone()
    current = focus(db, binding)
    key = (binding["projectId"], binding["worktreeId"])
    open_count = db.execute(f"SELECT COUNT(*) FROM tasks t WHERE {VISIBLE_TASK_SQL} AND t.status IN ('active','paused')", key).fetchone()[0]
    # Явный маленький лимит нужен поиску корня и CLI; он не разворачивает большую очередь.
    tasks = None if bounds["tasks"] is None else db.execute("""SELECT t.task_id FROM tasks t LEFT JOIN task_closures c ON c.task_id=t.task_id
        WHERE t.project_id=? AND t.worktree_id=? AND t.deleted=0 AND t.stage='task'
        AND NOT (t.certainty='observed' AND t.certainty_source='engine' AND t.certainty_provenance='cli'
                 AND NOT EXISTS (SELECT 1 FROM task_steps s WHERE s.task_id=t.task_id))
        ORDER BY CASE
            WHEN t.status IN ('active','paused') AND t.task_id=? THEN 0
            WHEN t.status='active'
                AND NOT EXISTS (SELECT 1 FROM inbox_state i WHERE i.project_id=t.project_id AND i.task_id=t.task_id
                    AND i.triage_status='untriaged' AND i.mode='active' AND i.inbox_type IN ('decision','approval','blocking'))
                AND NOT EXISTS (SELECT 1 FROM focus_stack f WHERE f.project_id=t.project_id
                    AND f.worktree_id=t.worktree_id AND f.task_id=t.task_id) THEN 1
            WHEN t.status IN ('active','paused') THEN 2 ELSE 3 END,
            CASE WHEN t.status IN ('active','paused') THEN t.priority END,
            CASE WHEN t.status IN ('active','paused') THEN t.queue_position END,
            CASE WHEN t.status IN ('active','paused') THEN t.alias_no END,
            CASE WHEN t.status='done' THEN COALESCE(c.closed_at,t.updated_at) ELSE t.updated_at END DESC,
            t.alias_no DESC LIMIT ?""", (binding["projectId"], binding["worktreeId"],
                                         current["task"]["taskId"] if current["task"] else None, bounds["tasks"]))
    sources = db.execute("""SELECT * FROM inbox_state
        WHERE worktree_id=? AND project_id=? ORDER BY (triage_status='untriaged') DESC,capture_order DESC LIMIT ?""",
                         (binding["worktreeId"], binding["projectId"], bounds["inbox"])).fetchall()
    candidate_where = "project_id=? AND worktree_id=? AND stage='candidate' AND dismiss_reason IS NULL AND deleted=0 AND created_at>?"
    candidate_parameters = (binding["projectId"], binding["worktreeId"], candidate_cutoff())
    candidates = db.execute(f"SELECT task_id FROM tasks WHERE {candidate_where} ORDER BY rowid DESC LIMIT 5", candidate_parameters).fetchall()
    candidate_summaries = []
    for row in candidates:
        card = task(db, row["task_id"], binding["projectId"])
        description = db.execute("SELECT description FROM tasks WHERE task_id=?", (row["task_id"],)).fetchone()[0]
        card["description"] = shown(description.splitlines()[0] if description.splitlines() else "", 4000)
        candidate_summaries.append({key: value for key, value in card.items() if key not in ("acceptance", "constraints")})
    result = {
        "binding": binding, "focus": current,
        "inboxCounts": {"total": counts["total"], "untriaged": counts["untriaged"]},
        "inboxTriageCounts": {"untriaged": counts["untriaged"], "blocking": counts["blocking"]},
        "tasks": [], "openTaskCount": open_count, "tasksTruncated": False,
        "candidates": candidate_summaries,
        "candidateCount": db.execute(f"SELECT COUNT(*) FROM tasks WHERE {candidate_where}", candidate_parameters).fetchone()[0],
        "focusStack": [{"taskId": row["task_id"], "depth": row["depth"], "provenance": row["provenance"]}
                       for row in db.execute("SELECT task_id,depth,provenance FROM focus_stack WHERE worktree_id=? ORDER BY depth",
                                             (binding["worktreeId"],))],
        "inbox": [inbox_preview(row) for row in sources],
        "captureMode": capture_mode(db), "schemaVersion": RPC_SCHEMA_VERSION, "storageSchemaVersion": SCHEMA_VERSION,
        "gate": gate_stats(db, binding, session_only=True), "extraction": extraction_stats(db, binding),
        "queue": queue_mode(db, binding),
    }
    if bounds["tasks"] is not None:
        # Метаданные нужны клиенту страниц; прежний клиент не платит за их расчёт.
        task_counts = db.execute(f"""SELECT COALESCE(SUM(t.status='active'),0) AS active,
            COALESCE(SUM(t.status='paused'),0) AS deferred,COALESCE(SUM(t.status='done'),0) AS done,
            COALESCE(SUM(t.status='active' AND t.task_id<>?
                AND NOT EXISTS(SELECT 1 FROM inbox_state i WHERE i.project_id=t.project_id AND i.task_id=t.task_id
                    AND i.triage_status='untriaged' AND i.mode='active' AND i.inbox_type IN ('decision','approval','blocking'))
                AND NOT EXISTS(SELECT 1 FROM focus_stack f WHERE f.worktree_id=t.worktree_id AND f.task_id=t.task_id)),0) AS queued
            FROM tasks t WHERE {VISIBLE_TASK_SQL}""", (current["task"]["taskId"] if current["task"] else "", *key)).fetchone()
        result["taskCounts"] = dict(task_counts)
        result["workingTasks"] = []
        for row in db.execute("""SELECT t.task_id,t.description FROM focus_stack f
            JOIN tasks t ON t.task_id=f.task_id WHERE f.worktree_id=? ORDER BY f.depth""", (binding["worktreeId"],)):
            card = task(db, row["task_id"], binding["projectId"])
            if "preview" in bounds:
                card["description"] = description_preview(row["description"], bounds["preview"])
            result["workingTasks"].append(card)
    # Считается весь envelope, UTF-8 и завершающий перевод строки stdout. Сумма
    # размеров строк вместо повторной сериализации растущего массива даёт O(N).
    used = len(json.dumps({"v": 1, "ok": True, "result": result}, ensure_ascii=False,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")) + 1
    decision_ids = None
    if tasks is None:
        tasks = db.execute(f"""SELECT t.* FROM tasks t WHERE {VISIBLE_TASK_SQL}
            AND t.status IN ('active','paused') ORDER BY t.priority,t.queue_position,t.alias_no""", key)
        closed = db.execute(f"""SELECT t.* FROM tasks t LEFT JOIN task_closures c ON c.task_id=t.task_id
            WHERE {VISIBLE_TASK_SQL} AND t.status IN ('done','cancelled')
            ORDER BY CASE WHEN t.status='done' THEN COALESCE(c.closed_at,t.updated_at) ELSE t.updated_at END DESC,
                t.alias_no DESC LIMIT ?""", (*key, SNAPSHOT_CLOSED_TASKS))
        # Нужность решения для сжатых строк вычисляется одним чтением Inbox,
        # а не коррелированным запросом для каждого поручения.
        decision_ids = {row[0] for row in db.execute("""SELECT DISTINCT task_id FROM inbox_state
            WHERE project_id=? AND triage_status='untriaged' AND mode='active'
                AND inbox_type IN ('decision','approval','blocking')""", (key[0],))}
    else:
        closed = ()
    included_open = 0
    compact_returns = {row["entity_id"]: row["total"] for row in db.execute("""SELECT entity_id,COUNT(*) AS total
        FROM events WHERE project_id=? AND worktree_id=? AND kind='task.owner.reopened' GROUP BY entity_id""", key)}
    for rows in (tasks, closed):
        for row in rows:
            if len(result["tasks"]) < SNAPSHOT_FULL_TASKS:
                card = {name: value for name, value in task(db, row["task_id"], key[0]).items()
                        if name not in ("description", "acceptance", "constraints")}
            else:
                card = task_row_summary(row, row["task_id"] in decision_ids, compact_returns.get(row["task_id"], 0))
            size = len(json.dumps(card, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
            size += bool(result["tasks"])
            if used + size >= SNAPSHOT_RESPONSE_BYTES:
                result["tasksTruncated"] = True
                return result
            used += size
            result["tasks"].append(card)
            included_open += card["status"] in ("active", "paused")
    result["tasksTruncated"] = included_open < open_count
    return result


def remove_stack_task(db, binding, task_id):
    # Удаление карточки сохраняет исходник и отметки, но не оставляет тупик возврата.
    db.execute("DELETE FROM focus_stack WHERE worktree_id=? AND task_id=?", (binding["worktreeId"], task_id))
    frames = db.execute("SELECT depth FROM focus_stack WHERE worktree_id=? ORDER BY depth", (binding["worktreeId"],)).fetchall()
    for depth, frame in enumerate(frames, 1):
        if frame[0] != depth:
            db.execute("UPDATE focus_stack SET depth=? WHERE worktree_id=? AND depth=?", (depth, binding["worktreeId"], frame[0]))


def owner_change(db, binding, action, task_id):
    # Автор задан самим путём аттестованной операции; текст в журнал не попадает.
    event(db, binding, "task.owner." + action, task_id)


def queue_end(db, binding, priority):
    return db.execute("""SELECT COALESCE(MAX(queue_position),0)+1 FROM tasks
        WHERE project_id=? AND worktree_id=? AND stage='task' AND deleted=0
            AND status IN ('active','paused') AND priority=?""",
                      (binding["projectId"], binding["worktreeId"], priority)).fetchone()[0]


def record_closure(db, task_id):
    db.execute("""INSERT INTO task_closures VALUES (?,?)
        ON CONFLICT(task_id) DO UPDATE SET closed_at=excluded.closed_at""", (task_id, now()))


def return_counts(db, task_ids):
    if not task_ids:
        return {}
    placeholders = ",".join("?" for _ in task_ids)
    return {row["entity_id"]: row["total"] for row in db.execute(f"""SELECT entity_id,COUNT(*) AS total
        FROM events WHERE kind='task.owner.reopened' AND entity_id IN ({placeholders}) GROUP BY entity_id""", task_ids)}


def task_return_context(db, task_id):
    returned = db.execute("""SELECT created_at FROM events WHERE entity_id=? AND kind='task.owner.reopened'
        ORDER BY event_id DESC LIMIT 1""", (task_id,)).fetchone()
    if returned is None:
        return {}
    # Итог берётся до возврата: заметки нового захода не вытесняют прежнюю попытку.
    result = db.execute("""SELECT text,created_at FROM task_agent_notes
        WHERE task_id=? AND kind='result' AND created_at<=? ORDER BY rowid DESC LIMIT 1""", (task_id, returned[0])).fetchone()
    closed = db.execute("""SELECT created_at FROM events WHERE entity_id=? AND created_at<=?
        AND kind IN ('task.agent.done','task.owner.completed') ORDER BY event_id DESC LIMIT 1""", (task_id, returned[0])).fetchone()
    comment = db.execute("""SELECT text FROM task_owner_comments WHERE task_id=? AND deleted=0
        AND created_at>=? AND created_at<=? ORDER BY created_at DESC,rowid DESC LIMIT 1""",
                         (task_id, closed[0] if closed else returned[0], returned[0])).fetchone()
    return {"returnContext": {"result": shown(result[0], 500, multiline=True) if result else None,
                              "ownerComment": shown(comment[0], 4000, multiline=True) if comment else None}}


def agent_notes(db, task_id, limit=None):
    rows = db.execute("SELECT * FROM task_agent_notes WHERE task_id=? ORDER BY rowid", (task_id,)) if limit is None else reversed(
        db.execute("SELECT * FROM task_agent_notes WHERE task_id=? ORDER BY rowid DESC LIMIT ?", (task_id, limit)).fetchall())
    return [{"noteId": row["note_id"], "taskId": row["task_id"], "kind": row["kind"],
             "text": shown(row["text"], 1000, multiline=True), "createdAt": row["created_at"],
             "source": "agent", "provenance": "tool"}
            for row in rows]


def bounded_context_response(response):
    if not response.get("ok"):
        return response
    result = response["result"]
    current = result.get("current")
    histories = [(result, "ownerChanges")]
    if isinstance(current, dict):
        histories.extend((current, name) for name in ("ownerNotes", "agentNotes"))
    sizes = []
    for container, name in histories:
        items = container.get(name)
        if not isinstance(items, list):
            continue
        omitted = container.get(name + "Omitted", 0)
        total = len(items) + omitted
        kept, lengths, used = [], [], 2
        # Берём свежий хвост, выдаём его в прежнем хронологическом порядке.
        for item in reversed(items[-CONTEXT_HISTORY_ITEMS:]):
            length = len(json.dumps(item, ensure_ascii=False, separators=(",", ":"),
                                    allow_nan=False).encode("utf-8"))
            if used + length + bool(kept) > CONTEXT_HISTORY_BYTES:
                break
            used += length + bool(kept)
            kept.append(item)
            lengths.append(length)
        container[name] = list(reversed(kept))
        container[name + "Omitted"] = total - len(kept)
        sizes.append([container, name, list(reversed(lengths)), used])
    used = len(json.dumps(response, ensure_ascii=False, separators=(",", ":"),
                          allow_nan=False).encode("utf-8")) + 1
    # Считается весь envelope с переводом строки. Удаление старой записи
    # учитывает запятую и увеличение числа цифр в счётчике без пересборки JSON.
    while used > SNAPSHOT_RESPONSE_BYTES:
        available = [history for history in sizes if history[2]]
        if not available:
            invalid("Обязательные поля контекста не помещаются в предел ответа.")
        history = max(available, key=lambda item: item[3])
        container, name, lengths, _ = history
        length = lengths.pop(0)
        container[name].pop(0)
        removed = length + bool(lengths)
        history[3] -= removed
        counter = name + "Omitted"
        omitted = container[counter]
        container[counter] += 1
        used -= removed
        used += len(str(omitted + 1)) - len(str(omitted))
    return response


def shown_task_extensions(value):
    # Используем прежний фильтр и для новых заметок в исторических ответах.
    if isinstance(value, dict):
        if "noteId" in value and isinstance(value.get("text"), str):
            value["text"] = shown(value["text"], 1000, multiline=True)
        if "commentId" in value and isinstance(value.get("text"), str):
            value["text"] = shown(value["text"], 4000, multiline=True)
        for child in value.values():
            shown_task_extensions(child)
    elif isinstance(value, list):
        for child in value:
            shown_task_extensions(child)
    return value


def owner_comment_result(row):
    return {"commentId": row["comment_id"], "text": shown(row["text"], 4000, multiline=True),
            "createdAt": row["created_at"], "updatedAt": row["updated_at"], "revision": row["revision"]}


def owner_comments(db, task_id, project_id, worktree_id):
    # Выбираем свежие дополнения, но показываем обсуждение в хронологическом порядке.
    rows = db.execute("""SELECT c.* FROM task_owner_comments c
        JOIN tasks t ON t.task_id=c.task_id AND t.project_id=c.project_id AND t.worktree_id=c.worktree_id
        WHERE c.task_id=? AND c.project_id=? AND c.worktree_id=? AND c.deleted=0 AND t.deleted=0
        ORDER BY c.created_at DESC,c.rowid DESC LIMIT 100""", (task_id, project_id, worktree_id)).fetchall()
    return [owner_comment_result(row) for row in reversed(rows)]


def owner_comment_action(db, binding, op, args):
    chosen = own_task(db, binding, args["taskId"])
    if chosen["deleted"]:
        raise CockpitError("NOT_FOUND", "Карточка недоступна в текущем рабочем дереве.")
    key = (chosen["taskId"], binding["projectId"], binding["worktreeId"])
    timestamp = now()
    if op == "task.comment.add":
        comment_id = str(uuid.uuid4())
        db.execute("INSERT INTO task_owner_comments VALUES (?,?,?,?,?,?,?,?,0,0)",
                   (comment_id, *key, binding["sessionId"], shown(args["text"], 4000, multiline=True), timestamp, timestamp))
        action = "commented"
    else:
        comment_id = args["commentId"]
        row = db.execute("""SELECT * FROM task_owner_comments
            WHERE comment_id=? AND task_id=? AND project_id=? AND worktree_id=? AND deleted=0""",
                         (comment_id, *key)).fetchone()
        if row is None:
            raise CockpitError("NOT_FOUND", "Комментарий не найден в текущей задаче.")
        expect_revision(row["revision"], args["expectedRevision"], "комментария")
        if op == "task.comment.edit":
            db.execute("""UPDATE task_owner_comments SET text=?,updated_at=?,revision=revision+1
                WHERE comment_id=? AND task_id=? AND project_id=? AND worktree_id=? AND deleted=0""",
                       (shown(args["text"], 4000, multiline=True), timestamp, comment_id, *key))
            action = "comment-edited"
        else:
            db.execute("""UPDATE task_owner_comments SET deleted=1,updated_at=?,revision=revision+1
                WHERE comment_id=? AND task_id=? AND project_id=? AND worktree_id=? AND deleted=0""",
                       (timestamp, comment_id, *key))
            action = "comment-deleted"
    owner_change(db, binding, action, chosen["taskId"])
    row = db.execute("SELECT * FROM task_owner_comments WHERE comment_id=? AND task_id=? AND project_id=? AND worktree_id=?",
                     (comment_id, *key)).fetchone()
    if row["deleted"]:
        return {"taskId": chosen["taskId"], "commentId": comment_id, "revision": row["revision"], "deleted": True}
    return {"taskId": chosen["taskId"], "comment": owner_comment_result(row)}


def current_owner_read(db, request, response):
    # Сохранённый ответ остаётся дословным в БД. При чтении старые отметки
    # скрываются, а комментарии выбираются заново, включая старые кэши схемы 10.
    def clean(value):
        if isinstance(value, dict):
            if "checkpointId" in value and db.execute("SELECT 1 FROM task_owner_comments WHERE comment_id=?",
                                                        (value["checkpointId"],)).fetchone():
                return None
            return {key: clean(child) for key, child in value.items()}
        if isinstance(value, list):
            return [item for child in value if (item := clean(child)) is not None]
        return value
    response = clean(response)
    if not response.get("ok") or request["op"] not in ("task.get", "tasks.context"):
        return response
    resolved = identity.registered(db, request["session"]["cwd"])
    binding = db.execute("""SELECT s.project_id,s.worktree_id FROM sessions s
        JOIN worktrees w ON w.worktree_id=s.worktree_id AND w.project_id=s.project_id
        WHERE s.session_id=? AND w.local_path=?""",
                         (request["session"]["sessionId"], resolved.worktree_path if resolved else "")).fetchone()
    if binding is None:
        raise CockpitError("NOT_FOUND", "Чтение недоступно в текущем рабочем дереве.")
    result = response["result"]
    if request["op"] == "task.get":
        result["comments"] = owner_comments(db, request["args"]["taskId"], *binding)
        result["task"]["returnCount"] = return_counts(db, [request["args"]["taskId"]]).get(request["args"]["taskId"], 0)
        result["task"].update(task_return_context(db, request["args"]["taskId"]))
    elif isinstance(result.get("current"), dict):
        current = result["current"]
        current["ownerComments"] = owner_comments(db, current["taskId"], *binding)
        current["returnCount"] = return_counts(db, [current["taskId"]]).get(current["taskId"], 0)
        current.update(task_return_context(db, current["taskId"]))
    return response


def agent_queue(db, binding):
    current = focus(db, binding)["task"]
    return [row for row in db.execute("""SELECT task_id,priority,queue_position,priority_source,priority_provenance,priority_pinned
        FROM tasks WHERE project_id=? AND worktree_id=?
        AND stage='task' AND deleted=0 AND status='active'
        AND NOT (certainty='observed' AND certainty_source='engine' AND certainty_provenance='cli'
            AND NOT EXISTS (SELECT 1 FROM task_steps s WHERE s.task_id=tasks.task_id))
        ORDER BY priority,queue_position,alias_no""", (binding["projectId"], binding["worktreeId"]))
        if current is None or row["task_id"] != current["taskId"]]


def agent_rank(db, binding, args):
    queue = agent_queue(db, binding)
    cards = {row["task_id"]: row for row in queue}
    # Сначала проверяем весь пакет: отказ не оставляет частичной перестановки.
    for task_id in args["order"]:
        if task_id not in cards:
            invalid("Ранжирование очереди принимает только открытые задачи этого рабочего дерева; текущая, отложенные, закрытые, удалённые, чужие и неизвестные taskId недоступны.")
    requested = set(args["order"])
    movable = [task_id for task_id in args["order"] if not cards[task_id]["priority_pinned"]]
    movable += [row["task_id"] for row in queue if not row["priority_pinned"] and row["task_id"] not in requested]
    remaining = iter(movable)
    ordered = [row if row["priority_pinned"] else cards[next(remaining)] for row in queue]
    slots = [(row["priority"], row["queue_position"]) for row in queue]
    # Старые карточки могли иметь одинаковые координаты. Нормализация сохраняет
    # место каждого якоря в очереди, не меняя его приоритет и закрепление.
    if len(set(slots)) != len(slots):
        slots = [(row["priority"], index + 1) for index, row in enumerate(queue)]
    for row, (priority, position) in zip(ordered, slots):
        if (row["priority"], row["queue_position"]) == (priority, position):
            continue
        db.execute("""UPDATE tasks SET priority=?,queue_position=?,priority_source=?,priority_provenance=?,
            revision=revision+1,updated_at=? WHERE task_id=?""",
                   (priority, position, row["priority_source"] if row["priority_pinned"] else "model",
                    row["priority_provenance"] if row["priority_pinned"] else "tool", now(), row["task_id"]))
        event(db, binding, "task.agent.ranked", row["task_id"])
    event(db, binding, "tasks.agent.ranked", binding["worktreeId"])
    return {"order": [row["task_id"] for row in ordered],
            "pinned": [row["task_id"] for row in queue if row["priority_pinned"]]}


def agent_create(db, binding, args):
    rows = db.execute("""SELECT task_id,title FROM tasks WHERE project_id=?
        AND stage='task' AND deleted=0 AND status IN ('active','paused') ORDER BY alias_no""",
                      (binding["projectId"],)).fetchall()
    known = {}
    for row in rows:
        known.setdefault(agent_normalized_title(shown(row["title"], 300)), row["task_id"])
    # Вход проходит тот же фильтр до хранения, нормализации и проверки вместимости.
    items = [{"title": shown(item["title"], 300),
              "description": "\n".join(plain(line) for line in redact(item.get("description", ""))[0].split("\n"))[:4000],
              "place": item.get("place", "bottom")}
             for item in args["tasks"]]
    for item in items:
        short_text(item["title"], "title", 300)
    additions = {agent_normalized_title(item["title"]) for item in items} - set(known)
    if len(rows) >= MAX_PROJECT_OPEN_TASKS or len(rows) + len(additions) > MAX_PROJECT_OPEN_TASKS:
        raise CockpitError("TASK_LIMIT_REACHED", "Достигнут технический предел открытых задач проекта; закройте существующие или сократите пакет.")
    result, top = [], []
    for item in items:
        normalized = agent_normalized_title(item["title"])
        duplicate = normalized in known
        if duplicate:
            task_id = known[normalized]
        else:
            queue = agent_queue(db, binding)
            priority = queue[-1]["priority"] if queue else 2
            position = queue_end(db, binding, priority)
            task_id = create_task(db, binding, item["title"], certainty="inferred", certainty_source="agent", provenance="tool")
            db.execute("UPDATE tasks SET description=?,priority=?,queue_position=? WHERE task_id=?", (item["description"], priority, position, task_id))
            event(db, binding, "task.agent.created", task_id)
            known[normalized] = task_id
            if item["place"] == "top":
                top.append(task_id)
        result.append((task_id, duplicate))
    if top:
        agent_rank(db, binding, {"order": top})
    references = []
    for task_id, duplicate in result:
        card = task(db, task_id, binding["projectId"])
        references.append({key: card[key] for key in ("taskId", "alias", "title", "revision")} | {"duplicate": duplicate})
    return {"tasks": references}


def agent_normalized_title(title):
    return " ".join("".join(char for char in title.casefold() if not unicodedata.category(char).startswith("P")).split())


def agent_task_action(db, binding, args):
    chosen = own_task(db, binding, args["taskId"])
    require_task(chosen)
    if chosen["deleted"]:
        raise CockpitError("NOT_FOUND", "Карточка недоступна в текущем рабочем дереве.")
    expect_revision(chosen["revision"], args["expectedRevision"], "задачи")
    current = focus(db, binding)
    expect_revision(current["revision"], args["expectedFocusRevision"], "фокуса")
    action = args["action"]
    if action != "note" and chosen["status"] in ("done", "cancelled"):
        invalid("Агент не возвращает закрытую или отменённую задачу; это делает владелец.")
    status = {"current": "active", "done": "done", "defer": "paused", "note": chosen["status"]}[action]
    db.execute("UPDATE tasks SET status=?,revision=revision+1,updated_at=? WHERE task_id=?", (status, now(), chosen["taskId"]))
    note = None
    if "note" in args:
        note_id, timestamp = str(uuid.uuid4()), now()
        text = shown(args["note"], 500 if action == "done" else 1000, multiline=True)
        short_text(text, "note", 500 if action == "done" else 1000)
        db.execute("INSERT INTO task_agent_notes VALUES (?,?,?,?,?,?,?,?,'agent','tool')",
                   (note_id, chosen["taskId"], binding["projectId"], binding["worktreeId"], binding["sessionId"],
                    "result" if action == "done" else "note", text, timestamp))
        note = agent_notes(db, chosen["taskId"])[-1]
    if action == "current":
        remove_stack_task(db, binding, chosen["taskId"])
        set_focus(db, binding, chosen["taskId"])
    elif action in ("done", "defer"):
        stop_clock(db, chosen["taskId"])
        db.execute("UPDATE task_steps SET status=? WHERE task_id=? AND status='active'",
                   ("done" if action == "done" else "pending", chosen["taskId"]))
        if action == "done":
            db.execute("UPDATE task_steps SET status='done' WHERE task_id=?", (chosen["taskId"],))
            record_closure(db, chosen["taskId"])
            remove_stack_task(db, binding, chosen["taskId"])
        if current["task"] and current["task"]["taskId"] == chosen["taskId"]:
            set_focus(db, binding, None)
    event(db, binding, "task.agent." + action, chosen["taskId"])
    return {"task": task(db, chosen["taskId"], binding["projectId"]), "focus": focus(db, binding), "note": note}


def reopen_task(db, binding, args):
    chosen = own_task(db, binding, args["taskId"])
    require_task(chosen)
    if chosen["deleted"]:
        raise CockpitError("NOT_FOUND", "Удалённую карточку вернуть нельзя.")
    expect_revision(chosen["revision"], args["expectedRevision"], "задачи")
    if chosen["status"] != "done":
        invalid("Возврат доступен только для выполненной задачи.")
    if args.get("place") == "top":
        # Очередь сортируется сначала по приоритету: один queue_position не ставит задачу первой.
        db.execute("""UPDATE tasks SET queue_position=queue_position+1,revision=revision+1,updated_at=? WHERE project_id=? AND worktree_id=?
            AND stage='task' AND deleted=0 AND status IN ('active','paused') AND priority=0""",
                   (now(), binding["projectId"], binding["worktreeId"]))
        db.execute("UPDATE tasks SET priority=0,priority_source='user',priority_provenance='panel' WHERE task_id=?", (chosen["taskId"],))
    db.execute("UPDATE tasks SET status='active',queue_position=?,active_since=NULL,revision=revision+1,updated_at=? WHERE task_id=?",
               (0 if args.get("place") == "top" else queue_end(db, binding, chosen["priority"]), now(), chosen["taskId"]))
    db.execute("UPDATE task_steps SET status='pending' WHERE task_id=? AND status='active'", (chosen["taskId"],))
    if shown(args.get("comment", ""), 4000).strip():
        owner_comment_action(db, binding, "task.comment.add", {"taskId": chosen["taskId"], "text": args["comment"]})
    owner_change(db, binding, "reopened", chosen["taskId"])
    return {"task": task(db, chosen["taskId"], binding["projectId"]), "focus": focus(db, binding)}


def task_context(db, binding, args):
    key = (binding["projectId"], binding["worktreeId"])
    cursor = db.execute("SELECT COALESCE(MAX(event_id),0) FROM events WHERE project_id=? AND worktree_id=?", key).fetchone()[0]
    since = args.get("cursor")
    if since is not None and (since > cursor or (since and db.execute(
            "SELECT 1 FROM events WHERE event_id=? AND project_id=? AND worktree_id=?", (since, *key)).fetchone() is None)):
        invalid("Курсор не принадлежит текущему рабочему дереву или находится в будущем.")
    current_card = focus(db, binding)["task"]
    current = None
    if current_card is not None and current_card["status"] == "active" and not current_card["deleted"]:
        current = {field: current_card[field] for field in ("taskId", "alias", "title", "revision", "description", "acceptance", "constraints", "returnCount")}
        current.update(task_return_context(db, current["taskId"]))
        owner_where = """c.task_id=? AND c.source='user' AND c.kind='note'
            AND NOT EXISTS (SELECT 1 FROM task_owner_comments o WHERE o.comment_id=c.checkpoint_id)"""
        rows = db.execute(f"SELECT c.* FROM checkpoints c WHERE {owner_where} ORDER BY c.rowid DESC LIMIT ?",
                          (current["taskId"], CONTEXT_HISTORY_ITEMS)).fetchall()
        current["ownerNotes"] = [checkpoint_result(row) for row in reversed(rows)]
        current["ownerNotesOmitted"] = db.execute(f"SELECT COUNT(*) FROM checkpoints c WHERE {owner_where}",
                                                  (current["taskId"],)).fetchone()[0] - len(rows)
        current["ownerComments"] = owner_comments(db, current["taskId"], *key)
        current["agentNotes"] = agent_notes(db, current["taskId"], CONTEXT_HISTORY_ITEMS)
        current["agentNotesOmitted"] = db.execute("SELECT COUNT(*) FROM task_agent_notes WHERE task_id=?",
                                                  (current["taskId"],)).fetchone()[0] - len(current["agentNotes"])
    counts = db.execute(f"""SELECT COUNT(*) AS total,
        COALESCE(SUM(t.status='active'),0) AS active, COALESCE(SUM(t.status='paused'),0) AS deferred,
        COALESCE(SUM(t.status='done'),0) AS done, COALESCE(SUM(t.status='cancelled'),0) AS cancelled,
        COALESCE(SUM(t.status='done' AND COALESCE(c.closed_at,t.updated_at)>=?),0) AS recent
        FROM tasks t LEFT JOIN task_closures c ON c.task_id=t.task_id WHERE {VISIBLE_TASK_SQL}""",
                        (candidate_cutoff(), *key)).fetchone()
    current_id = current["taskId"] if current else ""
    queued = db.execute(f"""SELECT t.task_id,t.alias_no,t.title,t.priority_pinned,t.description FROM tasks t
        WHERE {VISIBLE_TASK_SQL} AND t.status='active' AND t.task_id<>?
        ORDER BY t.priority,t.queue_position,t.alias_no LIMIT 30""", (*key, current_id))
    deferred = db.execute(f"""SELECT t.task_id,t.alias_no,t.title,t.priority_pinned FROM tasks t
        WHERE {VISIBLE_TASK_SQL} AND t.status='paused'
        ORDER BY t.priority,t.queue_position,t.alias_no LIMIT 10""", key)
    closed = db.execute(f"""SELECT t.task_id,t.alias_no,t.title,t.priority_pinned FROM tasks t
        LEFT JOIN task_closures c ON c.task_id=t.task_id WHERE {VISIBLE_TASK_SQL}
        AND t.status='done' AND COALESCE(c.closed_at,t.updated_at)>=?
        ORDER BY COALESCE(c.closed_at,t.updated_at) DESC,t.alias_no DESC LIMIT 10""", (*key, candidate_cutoff()))
    def summary(row, description=False):
        item = {"taskId": row["task_id"], "alias": f"TASK-{row['alias_no']}", "title": shown(row["title"], 300),
                "priorityPinned": bool(row["priority_pinned"]), "returnCount": counts_by_task.get(row["task_id"], 0)}
        if description:
            lines = redact(row["description"])[0].splitlines()
            item["description"] = shown(lines[0] if lines else "", 4000)
        return item
    change_where = """project_id=? AND worktree_id=?
        AND event_id>? AND event_id<=? AND kind LIKE 'task.owner.%'"""
    change_rows = [] if since is None else db.execute(
        f"SELECT * FROM events WHERE {change_where} ORDER BY event_id DESC LIMIT ?",
        (*key, since, cursor, CONTEXT_HISTORY_ITEMS)).fetchall()
    changes = [
        {"eventId": row["event_id"], "taskId": row["entity_id"], "action": row["kind"].removeprefix("task.owner."), "createdAt": row["created_at"]}
        for row in reversed(change_rows)]
    change_count = 0 if since is None else db.execute(f"SELECT COUNT(*) FROM events WHERE {change_where}",
                                                     (*key, since, cursor)).fetchone()[0]
    queued, deferred, closed = list(queued), list(deferred), list(closed)
    counts_by_task = return_counts(db, [row["task_id"] for row in [*queued, *deferred, *closed]])
    result = {"binding": binding, "current": current, "queue": [summary(row, True) for row in queued],
            "deferred": [summary(row) for row in deferred], "closed": [summary(row) for row in closed],
            "counts": {"total": counts["total"], "open": counts["active"] + counts["deferred"], "active": counts["active"],
                       "queued": counts["active"] - int(current is not None), "deferred": counts["deferred"], "done": counts["done"],
                       "cancelled": counts["cancelled"], "closedLast24h": counts["recent"],
                       "projectOpen": db.execute("SELECT COUNT(*) FROM tasks WHERE project_id=? AND stage='task' AND deleted=0 AND status IN ('active','paused')", (key[0],)).fetchone()[0]},
            "ownerChanges": changes, "ownerChangesOmitted": change_count - len(changes), "cursor": cursor}
    return bounded_context_response({"v": 1, "ok": True, "result": result})["result"]


def tasks_page(db, binding, args):
    from .description_summary import summary_fields
    key = (binding["projectId"], binding["worktreeId"])
    parameters = key
    if args["list"] == "closed":
        condition = "t.status='done'"
        order = "COALESCE(c.closed_at,t.updated_at) DESC,t.alias_no DESC"
    elif args["list"] == "deferred":
        condition = "t.status='paused'"
        order = "t.priority,t.queue_position,t.alias_no"
    else:
        held = db.execute("SELECT task_id FROM focus WHERE project_id=? AND worktree_id=?", key).fetchone()
        condition = "t.status='active' AND t.task_id<>?"
        parameters = (*key, held[0] if held and held[0] else "")
        order = "t.priority,t.queue_position,t.alias_no"
    where = VISIBLE_TASK_SQL + " AND " + condition
    total = db.execute(f"SELECT COUNT(*) FROM tasks t WHERE {where}", parameters).fetchone()[0]
    rows = db.execute(f"""SELECT t.*,COALESCE(c.closed_at,t.updated_at) AS closed_at,
        EXISTS(SELECT 1 FROM inbox_state i WHERE i.project_id=t.project_id AND i.task_id=t.task_id
            AND i.triage_status='untriaged' AND i.mode='active'
            AND i.inbox_type IN ('decision','approval','blocking')) AS needs_decision
        FROM tasks t LEFT JOIN task_closures c ON c.task_id=t.task_id WHERE {where}
        ORDER BY {order} LIMIT ? OFFSET ?""", (*parameters, args["limit"], args["offset"])).fetchall()
    ids = [row["task_id"] for row in rows]
    summaries = summary_fields(db, rows)
    counts_by_task = return_counts(db, ids)
    steps, discussions = {}, {}
    if ids:
        placeholders = ",".join("?" for _ in ids)
        # Агрегаты и необязательное описание ограничены выбранной страницей.
        steps = {row["task_id"]: {"total": row["total"], "done": row["done"], "active": row["active"]}
                 for row in db.execute(f"""SELECT task_id,COUNT(*) AS total,
                    SUM(status='done') AS done,SUM(status='active') AS active
                    FROM task_steps WHERE task_id IN ({placeholders}) GROUP BY task_id""", ids)}
        discussions = {row["task_id"]: row["total"] for row in db.execute(f"""SELECT task_id,COUNT(*) AS total FROM (
            SELECT task_id FROM task_owner_comments WHERE deleted=0 AND task_id IN ({placeholders})
            UNION ALL SELECT task_id FROM task_agent_notes WHERE task_id IN ({placeholders})) GROUP BY task_id""", (*ids, *ids))}
    return {"list": args["list"], "offset": args["offset"], "total": total,
            "tasks": [{"taskId": row["task_id"], "alias": f"TASK-{row['alias_no']}", "title": shown(row["title"], 300),
                       "status": row["status"], "updatedAt": row["updated_at"], "priorityPinned": bool(row["priority_pinned"]),
                       "priority": row["priority"], "queuePosition": row["queue_position"], "revision": row["revision"],
                       "needsDecision": bool(row["needs_decision"]), "stepCounts": steps.get(row["task_id"], {"total": 0, "done": 0, "active": 0}),
                       "discussionCount": discussions.get(row["task_id"], 0), "returnCount": counts_by_task.get(row["task_id"], 0), "certaintySource": row["certainty_source"],
                       "createdAt": row["created_at"], "elapsedMs": row["elapsed_ms"], "activeSince": row["active_since"],
                       **({"description": description_preview(row["description"], args["preview"])} if "preview" in args else {}),
                       **summaries.get(row['task_id'], {}),
                       **({"closedAt": row["closed_at"]} if args["list"] == "closed" else {})} for row in rows]}


def resolve_task(db, binding, args):
    # UNIQUE(project_id,alias_no) уже даёт поиск по номеру без обхода очереди.
    number = int(args["alias"][5:])
    row = None if number > 2**63 - 1 else db.execute(f"""SELECT t.task_id,t.alias_no,t.title,t.status,t.revision
        FROM tasks t WHERE {VISIBLE_TASK_SQL} AND t.alias_no=?""",
        (binding["projectId"], binding["worktreeId"], number)).fetchone()
    if row is None:
        raise CockpitError("NOT_FOUND", "Задача не найдена в текущем рабочем дереве.")
    return {"taskId": row["task_id"], "alias": f"TASK-{row['alias_no']}", "title": shown(row["title"], 300),
            "status": row["status"], "revision": row["revision"]}


def panel_task_action(db, binding, args):
    chosen = own_task(db, binding, args["taskId"])
    require_task(chosen)
    if chosen["deleted"]:
        raise CockpitError("NOT_FOUND", "Карточка недоступна в текущем рабочем дереве.")
    expect_revision(chosen["revision"], args["expectedRevision"], "задачи")
    current = focus(db, binding)
    expect_revision(current["revision"], args["expectedFocusRevision"], "фокуса")
    action = args["action"]
    if action == "restore" and chosen["status"] == "done":
        return reopen_task(db, binding, args)
    if action != "delete" and chosen["status"] in ("done", "cancelled"):
        invalid("Действие недоступно для завершённой карточки.")
    if action in ("up", "down"):
        ids = {row[0] for row in db.execute("SELECT task_id FROM focus_stack WHERE worktree_id=?", (binding["worktreeId"],))}
        if current["task"]:
            ids.add(current["task"]["taskId"])
        queue = [task(db, row[0], binding["projectId"]) for row in db.execute(
            "SELECT task_id FROM tasks WHERE worktree_id=? AND deleted=0 AND stage='task' AND status='active' AND priority=? ORDER BY priority,queue_position,alias_no", (binding["worktreeId"], chosen["priority"]))]
        queue = [item for item in queue if item["taskId"] not in ids and not item["needsDecision"]]
        index = next((i for i, item in enumerate(queue) if item["taskId"] == chosen["taskId"]), -1)
        other = index + (-1 if action == "up" else 1)
        if index < 0 or not 0 <= other < len(queue):
            invalid("Карточка не в очереди своего приоритета или уже на границе группы приоритета.")
        neighbour = queue[other]
        for item, position in ((chosen, neighbour["queuePosition"]), (neighbour, chosen["queuePosition"])):
            db.execute("UPDATE tasks SET queue_position=?,priority_pinned=1,priority_source='user',priority_provenance=?,revision=revision+1,updated_at=? WHERE task_id=?", (position, "panel", now(), item["taskId"]))
            owner_change(db, binding, "reordered", item["taskId"])
    elif action == "step":
        step = db.execute("SELECT status FROM task_steps WHERE task_id=? AND position=?", (chosen["taskId"], args["step"])).fetchone()
        if step is None:
            raise CockpitError("NOT_FOUND", "Шаг не найден.")
        new_status = "pending" if step[0] == "done" else "done"
        db.execute("UPDATE task_steps SET status=? WHERE task_id=? AND position=?", (new_status, chosen["taskId"], args["step"]))
        if current["task"] and current["task"]["taskId"] == chosen["taskId"]:
            db.execute("UPDATE task_steps SET status='active' WHERE task_id=? AND position=(SELECT MIN(position) FROM task_steps WHERE task_id=? AND status='pending') AND NOT EXISTS(SELECT 1 FROM task_steps WHERE task_id=? AND status='active')", (chosen["taskId"], chosen["taskId"], chosen["taskId"]))
        db.execute("UPDATE tasks SET revision=revision+1,updated_at=? WHERE task_id=?", (now(), chosen["taskId"]))
    else:
        status = "done" if action == "done" else "paused" if action == "defer" else "active" if action in ("current", "restore") else chosen["status"]
        db.execute("UPDATE tasks SET status=?,deleted=?,revision=revision+1,updated_at=? WHERE task_id=?",
                   (status, int(action == "delete"), now(), chosen["taskId"]))
        if action in ("done", "defer", "delete"):
            stop_clock(db, chosen["taskId"])
            db.execute("UPDATE task_steps SET status='pending' WHERE task_id=? AND status='active'", (chosen["taskId"],))
            if action == "done":
                db.execute("UPDATE task_steps SET status='done' WHERE task_id=?", (chosen["taskId"],))
                record_closure(db, chosen["taskId"])
            if current["task"] and current["task"]["taskId"] == chosen["taskId"]:
                set_focus(db, binding, None)
            if action in ("done", "delete"):
                remove_stack_task(db, binding, chosen["taskId"])
        elif action == "current":
            remove_stack_task(db, binding, chosen["taskId"])
            set_focus(db, binding, chosen["taskId"])
    event(db, binding, "task.panel." + action, chosen["taskId"])
    if action not in ("up", "down"):
        owner_change(db, binding, {"done": "completed", "defer": "deferred", "delete": "deleted", "restore": "restored"}.get(action, action), chosen["taskId"])
    return {"task": task(db, chosen["taskId"], binding["projectId"]), "focus": focus(db, binding)}


def extracted_tasks(db, binding, args):
    source = inbox_row(db, args["inboxId"], binding)
    if source["session_id"] != binding["sessionId"]:
        invalid("Задачи выделяются только из доставки текущей сессии.")
    # У выключенного захвата нет материала для модели; пустой результат ничего не меняет.
    if source["raw_text"] is None or not args["tasks"]:
        return {"tasks": [], "focus": focus(db, binding), "dropped": 0, "duplicates": []}
    recorded = db.execute("SELECT 1 FROM events WHERE project_id=? AND worktree_id=? AND kind='tasks.extracted' AND entity_id=? LIMIT 1",
                          (binding["projectId"], binding["worktreeId"], source["inbox_id"])).fetchone()
    if recorded:
        ids = db.execute("SELECT DISTINCT t.task_id,t.alias_no FROM task_sources s JOIN tasks t ON t.task_id=s.task_id WHERE s.inbox_id=? AND (t.stage='candidate' OR t.adopted_by IS NOT NULL OR t.certainty_source='provider') ORDER BY t.alias_no LIMIT 3", (source["inbox_id"],)).fetchall()
        return {"tasks": [task(db, row[0], binding["projectId"]) for row in ids], "focus": focus(db, binding),
                "dropped": max(0, len(args["tasks"]) - 3), "duplicates": []}
    active = db.execute("""SELECT task_id,title FROM tasks WHERE project_id=? AND deleted=0
        AND ((stage='task' AND status IN ('active','paused')) OR
             (stage='candidate' AND dismiss_reason IS NULL AND created_at>?)) ORDER BY alias_no""",
                        (binding["projectId"], candidate_cutoff())).fetchall()
    known = {normalized_title(row["title"]): row["task_id"] for row in active}
    created, duplicates = [], []
    for item in args["tasks"][:3]:
        normalized = normalized_title(item["title"])
        if normalized in known:
            duplicates.append({"title": shown(item["title"], 300), "taskId": known[normalized]})
            continue
        task_id = create_task(db, binding, item["title"], origin="ad-hoc", certainty="inferred",
                              certainty_source="provider", provenance="panel", stage="candidate")
        write_task_fields(db, task_id, item, "panel")
        phrase = item.get("sourcePhrase", "")
        start = source["raw_text"].find(phrase) if phrase else -1
        end = start + len(phrase) if start >= 0 else source["raw_length"]
        db.execute("INSERT INTO task_sources VALUES (?,?,?,?,?,?,'origin')", (task_id, source["inbox_id"], binding["projectId"], max(0, start), end, source["raw_sha256"]))
        for position, title in enumerate(item["steps"]):
            db.execute("INSERT INTO task_steps VALUES (?,?,?,'pending')", (task_id, position, title))
        created.append(task_id)
        known[normalized] = task_id
    event(db, binding, "tasks.extracted", source["inbox_id"])
    extraction_report(db, binding, source["inbox_id"], "extracted")
    return {"tasks": [task(db, task_id, binding["projectId"]) for task_id in created], "focus": focus(db, binding),
            "dropped": max(0, len(args["tasks"]) - 3), "duplicates": duplicates}


def normalized_title(title):
    title = " ".join(title.casefold().split())
    while title and unicodedata.category(title[-1]).startswith("P"):
        title = title[:-1].rstrip()
    return title


def candidate_cutoff():
    return (datetime.fromisoformat(now().replace("Z", "+00:00")) - timedelta(hours=24)).isoformat(timespec="microseconds").replace("+00:00", "Z")


def require_task(card):
    if card["stage"] != "task":
        invalid("Кандидата можно только принять или отклонить; сначала candidate.adopt.")


def expire_candidates(db, binding):
    ids = db.execute("""SELECT task_id FROM tasks WHERE project_id=? AND stage='candidate'
        AND dismiss_reason IS NULL AND created_at<=?""", (binding["projectId"], candidate_cutoff())).fetchall()
    for row in ids:
        db.execute("UPDATE tasks SET dismiss_reason='expired',dismissed_at=?,updated_at=?,revision=revision+1 WHERE task_id=?",
                   (now(), now(), row[0]))
        event(db, binding, "candidate.expired", row[0])


def adopt_candidate(db, binding, args, provenance):
    card = own_task(db, binding, args["taskId"])
    expect_revision(card["revision"], args["expectedRevision"], "кандидата")
    if card["stage"] != "candidate" or card["dismissReason"] is not None or card["deleted"]:
        invalid("Кандидат уже принят, отклонён или истёк.")
    position = db.execute("""SELECT COALESCE(MAX(queue_position),0)+1 FROM tasks
        WHERE worktree_id=? AND stage='task' AND deleted=0 AND status='active' AND priority=?""",
                          (binding["worktreeId"], card["priority"])).fetchone()[0]
    actor = "agent" if provenance == "tool" else "owner"
    db.execute("UPDATE tasks SET stage='task',adopted_by=?,queue_position=?,revision=revision+1,updated_at=? WHERE task_id=?",
               (actor, position, now(), card["taskId"]))
    if actor == "owner":
        db.execute("UPDATE tasks SET certainty='confirmed',certainty_source='user',certainty_provenance='panel' WHERE task_id=?", (card["taskId"],))
    event(db, binding, "candidate.adopted", card["taskId"])
    return {"task": task(db, card["taskId"], binding["projectId"])}


def dismiss_candidates(db, binding, args):
    cards = [own_task(db, binding, task_id) for task_id in args["taskIds"]]
    dismissed, skipped = [], []
    for card in cards:
        if card["stage"] != "candidate" or card["dismissReason"] is not None or card["deleted"]:
            skipped.append(card["taskId"])
            continue
        db.execute("UPDATE tasks SET dismiss_reason=?,dismissed_at=?,updated_at=?,revision=revision+1 WHERE task_id=?",
                   (args["reason"], now(), now(), card["taskId"]))
        event(db, binding, "candidate.dismissed", card["taskId"])
        dismissed.append(card["taskId"])
    return {"dismissed": dismissed, "skipped": skipped}


def write_task_fields(db, task_id, args, provenance):
    # Имена столбцов берутся только из закрытого набора; значения всегда параметры.
    updates = {key: args[key] for key in ("title", "description", "assignee", "priority") if key in args}
    if "priority" in args or "pinned" in args:
        updates.update(priority_source="user", priority_provenance=provenance)
        if "priority" in args:
            updates["priority_pinned"] = 1
        if "pinned" in args:
            updates["priority_pinned"] = int(args["pinned"])
    if updates:
        db.execute("UPDATE tasks SET " + ",".join(key + "=?" for key in updates) + " WHERE task_id=?",
                   (*updates.values(), task_id))
    for kind in ("acceptance", "constraints"):
        if kind in args:
            db.execute("DELETE FROM task_lists WHERE task_id=? AND kind=?", (task_id, kind))
            db.executemany("INSERT INTO task_lists VALUES (?,?,?,?)",
                           [(task_id, kind, position, text) for position, text in enumerate(args[kind])])


def rank_tasks(db, binding, args, provenance, actor=None):
    result = {"changed": [], "skipped": []}
    for item in args["items"]:
        row = db.execute("SELECT * FROM tasks WHERE task_id=? AND project_id=? AND deleted=0",
                         (item["taskId"], binding["projectId"])).fetchone()
        reason = ("not-found" if row is None else "candidate" if row["stage"] == "candidate" else "terminal" if row["status"] in ("done", "cancelled")
                  else "pinned" if row["priority_pinned"] else "stale" if row["revision"] != item["expectedRevision"] else None)
        if reason:
            result["skipped"].append({"taskId": item["taskId"], "reason": reason})
            continue
        db.execute("""UPDATE tasks SET priority=?,priority_source=?,priority_provenance=?,priority_pinned=?,
            revision=revision+1,updated_at=? WHERE task_id=?""",
                   (item["priority"], "user" if actor == "owner" else args["source"], provenance,
                    int(actor == "owner"), now(), item["taskId"]))
        event(db, binding, "task.ranked", item["taskId"])
        if actor == "owner":
            owner_change(db, binding, "reordered", item["taskId"])
        result["changed"].append({"taskId": item["taskId"], "priority": item["priority"]})
    return result


def execute(store, op, args, binding=None, provenance="cli", actor=None) -> dict:
    db = store.connection
    if op == "session.revoke":
        if provenance != "panel":
            invalid("Отзыв свидетельства разрешён только панели с actor: owner.")
        db.execute("INSERT INTO attestation_revocations VALUES (?,?,?,'owner',?,?)",
                   (binding["sessionId"], binding["projectId"], binding["worktreeId"], binding["sessionId"], now()))
        event(db, binding, "session.attestation-revoked", binding["sessionId"])
        return {"revoked": True}
    if provenance == "tool":
        readings = ("focus.get", "task.get", "snapshot", "inbox.get", "inbox.material",
                    "checkpoint.list", "gate.stats", "gate.recent", "config.get", "doctor", "tasks.context", "tasks.page", "task.resolve", "tasks.search")
        if op not in (*readings, "checkpoint.add", "candidate.adopt", "candidate.dismiss", "tasks.agent.create", "tasks.agent.rank", "task.agent.action"):
            invalid(f"actor: agent не разрешает запись {op}; действие доступно владельцу панели.")
        if op == "candidate.dismiss" and args["reason"] not in ("answered", "duplicate"):
            invalid("actor: agent отклоняет кандидата только с причиной answered или duplicate.")
    if op in ("candidate.adopt", "candidate.dismiss") and provenance not in ("panel", "tool"):
        raise CockpitError("ATTESTATION_FAILED", "Кандидаты требуют свидетельство панели или инструмента.")
    if op in ("tasks.agent.create", "tasks.agent.rank", "task.agent.action") and provenance != "tool":
        if provenance == "cli":
            raise CockpitError("ATTESTATION_FAILED", "Операция агента требует свидетельство инструмента.")
        invalid("Для операции агента требуется actor: agent.")
    if op in OWNER_COMMENT_OPERATIONS:
        if provenance != "panel":
            raise CockpitError("ATTESTATION_FAILED", "Комментарии владельца изменяет только аттестованная панель.")
        return owner_comment_action(db, binding, op, args)
    if binding and op not in ("focus.get", "task.get", "snapshot", "inbox.get", "inbox.material", "checkpoint.list", "gate.stats", "gate.recent", "config.get", "doctor", "tasks.context", "tasks.page", "task.resolve", "tasks.search"):
        expire_candidates(db, binding)
    if op == "tasks.agent.create":
        return agent_create(db, binding, args)
    if op == "tasks.agent.rank":
        return agent_rank(db, binding, args)
    if op == "task.agent.action":
        return agent_task_action(db, binding, args)
    if op == "tasks.context":
        return task_context(db, binding, args)
    if op == "tasks.page":
        return tasks_page(db, binding, args)
    if op == "tasks.search":
        from .task_search import search_tasks
        return search_tasks(db, binding, args)
    if op == "task.resolve":
        return resolve_task(db, binding, args)
    if op == "candidate.adopt":
        return adopt_candidate(db, binding, args, provenance)
    if op == "candidate.dismiss":
        return dismiss_candidates(db, binding, args)
    if op in ("task.create", "task.edit", "task.action", "tasks.extract", "tasks.rank", "task.reopen", "task.summary.claim", "task.summary.report") and provenance != "panel":
        raise CockpitError("ATTESTATION_FAILED", "Карточки изменяет только аттестованная панель.")
    if op in ('task.summary.claim', 'task.summary.report'):
        from .description_summary import summary_action
        return summary_action(db, binding, op, args)
    if op == "task.reopen":
        return reopen_task(db, binding, args)
    if op == "task.create":
        task_id = create_task(db, binding, args["title"], certainty="confirmed", certainty_source="user", provenance="panel")
        write_task_fields(db, task_id, args, provenance)
        for position, title in enumerate(args.get("steps", [])):
            db.execute("INSERT INTO task_steps VALUES (?,?,?,'pending')", (task_id, position, title))
        if focus(db, binding)["task"] is None:
            set_focus(db, binding, task_id)
        owner_change(db, binding, "created", task_id)
        return {"task": task(db, task_id, binding["projectId"]), "focus": focus(db, binding)}
    if op == "task.edit":
        chosen = own_task(db, binding, args["taskId"])
        require_task(chosen)
        if chosen["deleted"]:
            raise CockpitError("NOT_FOUND", "Карточка недоступна в текущем рабочем дереве.")
        expect_revision(chosen["revision"], args["expectedRevision"], "задачи")
        write_task_fields(db, chosen["taskId"], args, provenance)
        db.execute("UPDATE tasks SET revision=revision+1,updated_at=? WHERE task_id=?", (now(), chosen["taskId"]))
        event(db, binding, "task.edited", chosen["taskId"])
        owner_change(db, binding, "edited", chosen["taskId"])
        return {"task": task(db, chosen["taskId"], binding["projectId"])}
    if op == "tasks.rank":
        return rank_tasks(db, binding, args, provenance, actor)
    if op == "task.action":
        return panel_task_action(db, binding, args)
    if op == "tasks.extract":
        return extracted_tasks(db, binding, args)
    if op == "extraction.report":
        return extraction_report(db, binding, args["inboxId"], args["code"])
    if op == "doctor":
        extraction = extraction_stats(db)
        return {
            "integrityCheck": [row[0] for row in db.execute("PRAGMA integrity_check")],
            "foreignKeyCheck": [{"table": row[0], "rowId": row[1], "parent": row[2], "fkIndex": row[3]}
                                for row in db.execute("PRAGMA foreign_key_check")],
            "schemaVersion": RPC_SCHEMA_VERSION,
            "storageSchemaVersion": db.execute("PRAGMA user_version").fetchone()[0],
            "permissions": store.permissions(),
            "counts": {**{name: db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0] for name in TABLES},
                       **{"extraction." + code: count for code, count in extraction["counts"].items()},
                       "extraction.last-success-at": extraction["lastSuccessAt"] or "ещё не было"},
            "extraction": extraction,
        }
    if op == "capture.prompt":
        mode = capture_mode(db)
        if mode == "redacted":
            raise CockpitError("NOT_IMPLEMENTED", "Режим redacted не реализован в M1.")
        inbox_id = str(uuid.uuid4())
        text = args["text"]
        db.execute("""INSERT INTO inbox(inbox_id,project_id,worktree_id,session_id,delivery_key,source_kind,
            capture_mode,raw_text,raw_sha256,raw_length,captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                   (inbox_id, binding["projectId"], binding["worktreeId"], binding["sessionId"],
                    args.get("deliveryId") or str(uuid.uuid4()), args.get("kind", "prompt"), mode,
                    text if mode == "full-local" else None, hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    len(text), now()))
        event(db, binding, "prompt.captured", inbox_id)
        db.execute("SAVEPOINT capture_classification")
        try:
            classify_prompt(db, binding, inbox_id, text)
        except Exception:
            # Классификация — необязательная аннотация. Любой её сбой оставляет
            # оригинал, capture-событие и ответ; частичное наблюдение откатывается.
            db.execute("ROLLBACK TO capture_classification")
        finally:
            db.execute("RELEASE capture_classification")
        return {"inboxId": inbox_id, "captured": True, "captureMode": mode}
    if op == "session.attest":
        return {"attested": True}
    if op in ("task.bind", "gate.check"):
        result = bind_with_gate(db, binding, args)
        if op == "task.bind" and result["gate"]["mode"] == "off":
            return {key: result[key] for key in ("bound", "task", "focusRevision")}
        return result
    if op == "gate.stats":
        return gate_stats(db, binding, args.get("days"))
    if op == "gate.recent":
        limit = args.get("limit", 10)
        rows = db.execute("""SELECT * FROM gate_observations WHERE project_id=?
            ORDER BY observation_id DESC LIMIT ?""", (binding["projectId"], limit))
        observations = [gate_observation(row) for row in rows]
        observations.extend(unbound_observation(row) for row in db.execute(
            "SELECT * FROM events WHERE project_id=? AND kind='gate.unbound' ORDER BY event_id DESC LIMIT ?",
            (binding["projectId"], limit)))
        observations.sort(key=lambda item: item["observedAt"], reverse=True)
        return {"mode": gate_mode(db, binding), "observations": observations[:limit]}
    if op in ("config.get", "config.set"):
        key = args["key"]
        column, origin_column = ("gate_mode", "provenance") if key == "gate" else ("queue_mode", "queue_provenance")
        if op == "config.set":
            existing = db.execute(f"SELECT {origin_column} FROM project_config WHERE project_id=?", (binding["projectId"],)).fetchone()
            if existing and existing[0] == "panel" and provenance != "panel":
                raise CockpitError("ATTESTATION_FAILED", "Для изменения настройки панели требуется её свидетельство.")
            db.execute("INSERT INTO project_config(project_id,gate_mode) VALUES (?,'off') ON CONFLICT(project_id) DO NOTHING",
                       (binding["projectId"],))
            db.execute(f"UPDATE project_config SET {column}=?,{origin_column}=? WHERE project_id=?",
                       (args["value"], provenance, binding["projectId"]))
        row = db.execute(f"SELECT {origin_column} FROM project_config WHERE project_id=?", (binding["projectId"],)).fetchone()
        return {"key": key, "value": gate_mode(db, binding) if key == "gate" else queue_mode(db, binding),
                "provenance": row[0] if row else "cli"}
    if op == "session.end":
        held = db.execute("SELECT task_id FROM focus WHERE worktree_id=? AND session_id=?", (binding["worktreeId"], binding["sessionId"])).fetchone()
        if held and held[0]:
            stop_clock(db, held[0])
        released = db.execute("DELETE FROM worktree_leases WHERE session_id=? AND project_id=? AND worktree_id=?",
                              (binding["sessionId"], binding["projectId"], binding["worktreeId"])).rowcount
        return {"released": released}
    if op == "focus.get":
        return focus(db, binding)
    if op == "task.get":
        return {"task": own_task(db, binding, args["taskId"]),
                "comments": owner_comments(db, args["taskId"], binding["projectId"], binding["worktreeId"]),
                # Итог и ход работы нужны странице и истории любой задачи, а не только текущей.
                "agentNotes": agent_notes(db, args["taskId"])}
    if op == "focus.set":
        current = focus(db, binding)
        if current["revision"] != args["expectedRevision"]:
            raise CockpitError("REVISION_CONFLICT", "Ревизия фокуса устарела; получите текущий фокус.")
        chosen = own_task(db, binding, args["taskId"])
        if chosen["status"] in ("done", "cancelled") or chosen["deleted"]:
            invalid("Завершённую или отменённую задачу нельзя поставить в фокус.")
        set_focus(db, binding, chosen["taskId"])
        return focus(db, binding)
    if op == "task.update":
        current = own_task(db, binding, args["taskId"])
        require_task(current)
        if current["revision"] != args["expectedRevision"]:
            raise CockpitError("REVISION_CONFLICT", "Ревизия задачи устарела; получите свежий snapshot.")
        status = args.get("status", current["status"])
        if status not in TRANSITIONS[current["status"]]:
            invalid("Переход из терминального статуса задачи запрещён в M1.")
        db.execute("UPDATE tasks SET title=COALESCE(?,title),status=?,revision=revision+1,updated_at=? WHERE task_id=?",
                   (args.get("title"), status, now(), current["taskId"]))
        if status in ("done", "cancelled"):
            if status == "done" and current["status"] != "done":
                record_closure(db, current["taskId"])
            stop_clock(db, current["taskId"])
            cleared = db.execute("SELECT worktree_id FROM focus WHERE task_id=?", (current["taskId"],)).fetchall()
            db.execute("UPDATE focus SET task_id=NULL,revision=revision+1 WHERE task_id=?", (current["taskId"],))
            for row in cleared:
                event(db, binding, "focus.cleared", row["worktree_id"])
        event(db, binding, "task.updated", current["taskId"])
        return {"task": task(db, current["taskId"], binding["projectId"])}
    if op == "inbox.get":
        return inbox_result(inbox_row(db, args["inboxId"], binding))
    if op == "inbox.material":
        source = inbox_row(db, args["inboxId"], binding)
        return {"inboxId": source["inbox_id"], "material": None if source["raw_text"] is None else material(source["raw_text"])}
    if op == "inbox.triage":
        return triage(db, binding, args, provenance)
    if op == "task.confirm":
        current = own_task(db, binding, args["taskId"])
        require_task(current)
        expect_revision(current["revision"], args["expectedRevision"], "задачи")
        db.execute("""UPDATE tasks SET certainty='confirmed',certainty_source='user',certainty_provenance=?,
            revision=revision+1,updated_at=? WHERE task_id=?""", (provenance, now(), current["taskId"]))
        event(db, binding, "task.confirmed", current["taskId"])
        return {"task": task(db, current["taskId"], binding["projectId"])}
    if op in ("checkpoint.add", "checkpoint.list"):
        current = own_task(db, binding, args["taskId"])
        if "expectedRevision" in args:
            expect_revision(current["revision"], args["expectedRevision"], "задачи")
        if op == "checkpoint.add":
            require_task(current)
            checkpoint = add_checkpoint(db, binding, current["taskId"], args["kind"], args["text"],
                                        "agent" if provenance == "tool" else args.get("source", "user"), provenance)
            if provenance == "panel" and args["kind"] == "note" and args.get("source", "user") == "user":
                owner_change(db, binding, "noted", current["taskId"])
            return {"checkpoint": checkpoint, "taskRevision": current["revision"] + 1}
        return {"taskId": current["taskId"], "taskRevision": current["revision"],
                "checkpoints": checkpoints(db, current["taskId"], args.get("limit", 10))}
    if op == "focus.detour":
        return detour(db, binding, args, provenance)
    if op == "focus.return":
        return return_focus(db, binding, args, provenance)
    if op == "session.rebind":
        reattach_focus(db, binding)
        held = focus(db, binding)
        if held["task"] and held["task"]["status"] == "active":
            db.execute("UPDATE tasks SET active_since=COALESCE(active_since,?) WHERE task_id=?", (now(), held["task"]["taskId"]))
        event(db, binding, "session." + args["reason"], binding["sessionId"])
        return snapshot(db, binding, limits(args))
    if op == "snapshot":
        return snapshot(db, binding, limits(args))
    raise CockpitError("UNKNOWN_OP", "Неизвестная операция Cockpit.")

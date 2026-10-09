"""Строгий JSON ingress и идемпотентный транзакционный протокол M1/M2."""

import hashlib
import json
import os
import sqlite3
from datetime import datetime, timedelta

from . import CockpitError
from . import domain, identity
from .store import Store, unavailable

MAX_REQUEST_BYTES = 1024 * 1024
REQUEST_RETENTION = timedelta(days=1)
REQUEST_CLEANUP_BATCH = 200
REQUEST_CLEANUP_FRESH_HEAD = 8
VIEW_OPERATIONS = frozenset({
    "snapshot", "tasks.search", "tasks.page", "task.get", "task.resolve", "focus.get",
    "inbox.get", "inbox.material", "checkpoint.list", "gate.stats", "gate.recent", "config.get",
})


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def failure(error) -> dict:
    return {"v": 1, "ok": False, "error": {"code": error.code, "message": error.message}}


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            domain.invalid("Повторяющиеся поля JSON запрещены.")
        result[key] = value
    return result


def _constant(_):
    domain.invalid("NaN и Infinity не являются допустимым JSON.")


def parse(payload: bytes) -> dict:
    if len(payload) > MAX_REQUEST_BYTES:
        domain.invalid("Размер JSON-запроса превышает 1 МиБ.")
    try:
        return json.loads(payload.decode("utf-8"), object_pairs_hook=_object, parse_constant=_constant)
    except (ValueError, UnicodeError, RecursionError):
        domain.invalid("Ожидался ровно один корректный JSON-запрос в UTF-8.")


def envelope(request):
    domain.fields(request, ("v", "op", "requestId", "session", "args", "panelSecret", "actor"),
                  ("v", "op", "requestId", "session", "args"))
    if type(request["v"]) is not int or request["v"] != 1:
        domain.invalid("Поддерживается только v=1.")
    domain.string(request["op"], "op")
    domain.identifier(request["requestId"], "requestId")
    domain.fields(request["session"], ("sessionId", "cwd"), ("sessionId", "cwd"))
    domain.identifier(request["session"]["sessionId"], "sessionId")
    cwd = domain.string(request["session"]["cwd"], "cwd", maximum=32768)
    if "\x00" in cwd or not os.path.isabs(cwd):
        domain.invalid("session.cwd должен быть абсолютным путём без NUL.")
    if not isinstance(request["args"], dict):
        domain.invalid("args должен быть объектом.")
    if "panelSecret" in request:
        secret = domain.string(request["panelSecret"], "panelSecret", maximum=64)
        if len(secret) != 64 or any(char not in "0123456789abcdef" for char in secret):
            domain.invalid("Свидетельство панели должно содержать 32 байта в hex.")
    if request["op"] == "session.revoke" and "panelSecret" not in request:
        raise CockpitError("ATTESTATION_FAILED", "[attestation-unregistered] Отзыв требует действующий ключ целевой привязки.")
    if "actor" in request:
        if request["actor"] not in ("owner", "agent") or "panelSecret" not in request:
            domain.invalid("actor должен быть owner или agent и требует свидетельство панели.")
    if request["op"] == "session.attest" and "panelSecret" not in request:
        domain.invalid("Для регистрации требуется свидетельство панели.")


def request_digest(request):
    # Значение секрета не участвует в сохраняемом отпечатке. Признак наличия
    # отделяет повтор панели от CLI; само свидетельство проверяется до кэша.
    safe = {key: value for key, value in request.items() if key != "panelSecret"}
    if "panelSecret" in request:
        safe["panelProof"] = True
    return hashlib.sha256(canonical(safe).encode("utf-8")).hexdigest()


def prune_requests(db, timestamp):
    cutoff = (datetime.fromisoformat(timestamp) - REQUEST_RETENTION).isoformat(
        timespec="microseconds").replace("+00:00", "Z")
    # Журнал пишется по порядку, поэтому просроченные строки лежат в голове таблицы. Отбор по времени без индекса
    # читал бы каждую строку вместе с её ответом: время стоит после ответа, а снимок большого проекта занимает
    # сотни килобайт. Уборка идёт с головы и останавливается на нескольких свежих строках подряд: они переживают
    # строки, записанные при переведённых часах, и не дают читать весь журнал, когда убирать нечего.
    # Уборка и новый ответ фиксируются одной транзакцией; повтор ответа её не запускает.
    expired, fresh = [], 0
    cursor = db.execute("SELECT rowid, committed_at FROM requests ORDER BY rowid")
    for rowid, committed_at in cursor:
        if committed_at < cutoff:
            expired.append((rowid,))
            fresh = 0
            if len(expired) == REQUEST_CLEANUP_BATCH:
                break
        else:
            fresh += 1
            if fresh == REQUEST_CLEANUP_FRESH_HEAD:
                break
    cursor.close()
    if expired:
        db.executemany("DELETE FROM requests WHERE rowid=?", expired)


def cached_response(db, request, digest):
    # Исторический ответ вида не читаем: нужен лишь отпечаток для проверки конфликта.
    columns = "request_sha256" if request["op"] in VIEW_OPERATIONS else "request_sha256,response_json"
    cached = db.execute(f"SELECT {columns} FROM requests WHERE request_id=?",
                        (request["requestId"],)).fetchone()
    if cached is None:
        return None
    if cached["request_sha256"] != digest:
        raise CockpitError("IDEMPOTENCY_CONFLICT", "requestId уже использован для другого запроса.")
    if request["op"] in VIEW_OPERATIONS:
        return None
    response = domain.current_owner_read(db, request, json.loads(cached["response_json"]))
    response = domain.shown_task_extensions(domain.shown_response(response))
    return domain.bounded_context_response(response) if request["op"] == "tasks.context" else response


def handle(request) -> dict:
    try:
        envelope(request)
        encoded = canonical(request).encode("utf-8")
        if len(encoded) > MAX_REQUEST_BYTES:
            domain.invalid("Размер канонического запроса превышает 1 МиБ.")
        digest = request_digest(request)
        # Виды заново проходят ingress и читают текущую базу. Сводка контекста
        # сохраняет прежнее состояние и cursor, поэтому остаётся в журнале вместе с записями.
        log_response = request["op"] not in VIEW_OPERATIONS and (
            request["op"] != "doctor" or "panelSecret" in request)
        with Store(diagnostic=request["op"] == "doctor") as store:
            db = store.connection
            if "panelSecret" not in request:
                cached = cached_response(db, request, digest)
                if cached is not None:
                    return cached
            prepared_error = None
            resolved = None
            try:
                domain.validate_args(request["op"], request["args"])
                # Git — чтение внешнего состояния; не держим write lock при запуске процесса.
                if request["op"] != "doctor" or "panelSecret" in request:
                    resolved = identity.registered(db, request["session"]["cwd"]) or identity.resolve(request["session"]["cwd"])
            except CockpitError as exc:
                if exc.code == "DB_UNAVAILABLE":
                    return failure(exc)
                prepared_error = exc
            db.execute("BEGIN IMMEDIATE")
            db.execute("SAVEPOINT operation")
            try:
                if prepared_error is not None:
                    raise prepared_error
                binding = None
                if resolved is not None:
                    binding = domain.ensure_binding(db, resolved, request["session"]["sessionId"])
                provenance = domain.authenticate(db, binding, request.get("panelSecret"),
                                                 registering=request["op"] == "session.attest")
                if request.get("actor", "owner") == "agent":
                    provenance = "tool"
                if (request["op"] in domain.OWNER_COMMENT_OPERATIONS and provenance == "panel"
                        and request.get("actor") != "owner"):
                    domain.invalid("Комментарии владельца требуют явный actor: owner.")
                if request["op"] == "session.revoke" and request.get("actor") != "owner":
                    domain.invalid("Отзыв свидетельства требует явный actor: owner от панели.")
                # Конкурент мог уже сохранить ответ. Секрет проверен даже при
                # повторе: неверное свидетельство никогда не читает кэш панели.
                cached = cached_response(db, request, digest)
                if cached is not None:
                    if cached["ok"] and "panelSecret" in request:
                        domain.touch_attestation(db, binding)
                        db.execute("RELEASE operation")
                        db.execute("COMMIT")
                    else:
                        db.execute("ROLLBACK")
                    return cached
                result = domain.execute(store, request["op"], request["args"], binding, provenance, request.get("actor"))
                if "panelSecret" in request:
                    domain.touch_attestation(db, binding)
                response = {"v": 1, "ok": True, "result": result}
            except CockpitError as exc:
                db.execute("ROLLBACK TO operation")
                response = failure(exc)
                if exc.code == "ATTESTATION_CONFLICT" or getattr(exc, "revoked", False):
                    # Отказ откатывает действие, но сигнал возможной подмены обязан сохраниться.
                    db.execute("RELEASE operation")
                    # Для новой запрещённой эпохи сохраняем только автора сигнала.
                    db.execute("INSERT OR IGNORE INTO sessions VALUES (?,?,?,?)",
                               (binding["sessionId"], binding["projectId"], binding["worktreeId"], domain.now()))
                    kind = "security.attestation-revoked-use" if exc.code == "ATTESTATION_FAILED" else "security.attestation-conflict"
                    recorded = db.execute("""SELECT 1 FROM events WHERE project_id=? AND worktree_id=?
                        AND session_id=? AND kind=? AND entity_id=?""",
                                          (binding["projectId"], binding["worktreeId"], binding["sessionId"], kind, request["requestId"])).fetchone()
                    if recorded is None:
                        domain.event(db, binding, kind, request["requestId"])
                    db.execute("COMMIT")
                    return response
                # Отказ доступности нельзя кэшировать: следующий повтор может восстановиться.
                if exc.code in ("DB_UNAVAILABLE", "ATTESTATION_FAILED", "IDEMPOTENCY_CONFLICT"):
                    db.execute("ROLLBACK")
                    return response
            db.execute("RELEASE operation")
            if log_response:
                timestamp = domain.now()
                db.execute("INSERT INTO requests VALUES (?,?,?,?)",
                           (request["requestId"], digest, canonical(response), timestamp))
                prune_requests(db, timestamp)
            db.execute("COMMIT")
            return response
    except CockpitError as exc:
        return failure(exc)
    except (OSError, sqlite3.Error):
        return failure(unavailable())
    except (ValueError, UnicodeError, RecursionError):
        return failure(CockpitError("INVALID_REQUEST", "Запрос содержит недопустимые данные."))


def read_and_handle(stream) -> dict:
    try:
        return handle(parse(stream.read(MAX_REQUEST_BYTES + 1)))
    except CockpitError as exc:
        return failure(exc)

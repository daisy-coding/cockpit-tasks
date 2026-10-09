"""Приватность до вызова провайдера — детерминированно и без модели (инвариант 4).

Согласие отправлять текст запросов (решение 2026-09-25) не отменяет этот
фильтр: NEVER_SEND и REDACT действуют всегда. Спрашивать у модели, можно ли
отправить модели секрет, нельзя по построению.

Фильтр — разрешённый список, а не запрещённый: провайдеру уходят только
ключи состояния из ALLOWED_KEYS, и в каждом из них редактируется каждая
строка на любой глубине. Ключ, которого нет в списке, не уходит вовсе: новая
политика, положившая в состояние что-то своё, по умолчанию ничего не выдаёт.
"""
import fnmatch
import json
import os
import re

ALLOW = "ALLOW"
REDACT = "REDACT"
LOCAL_ONLY = "LOCAL_ONLY"
NEVER_SEND = "NEVER_SEND"

NEVER_SEND_PATHS = (
    "~/.ssh/*", "~/.aws/*", "~/.gnupg/*", "~/.config/agent-config/*", "~/.docker/config.json",
    "~/.netrc", "*/.netrc", ".netrc", "~/.gemini/antigravity-cli/antigravity-oauth-token",
    "*/.env", "*/.env.*", ".env", ".env.*",
    "*/auth.json", "auth.json", "*credentials*", "*.pem", "*.key", "*/id_rsa*", "*/id_ed25519*",
)
# Имена каталогов и файлов, которые не уходят даже как имена (отпечаток проекта).
PROTECTED_NAMES = (".ssh", ".aws", ".gnupg", ".docker", ".netrc", ".env", "auth.json")

# Что вообще может уйти провайдеру. Текст — редактируется; структура — редактируется
# каждая строка внутри; files — отдельная обработка по путям.
TEXT_KEYS = ("prompt", "text")
STRUCT_KEYS = ("project", "task", "chunks", "items", "routing", "agent", "task_mode", "tool", "zone",
               "size", "policy")
ALLOWED_KEYS = (*TEXT_KEYS, *STRUCT_KEYS, "files")

# Значения, которые заменяются маркером. Порядок важен: сначала конкретные
# форматы, потом общее «ключ = значение». Третий элемент — замена (\g<1> сохраняет
# безопасный префикс); None — весь найденный фрагмент становится маркером.
SECRET_PATTERNS = (
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)"), None),
    ("typesafe_key", re.compile(r"\bapikey_[A-Za-z0-9]{16,}(?:_[A-Za-z0-9]{16,})*\b"), None),
    ("aws_key_id", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"), None),
    ("github_token", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b"), None),
    ("api_key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"), None),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"), None),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"), None),
    # userinfo в URL: и user:pass, и одиночный токен (https://TOKEN@host).
    ("url_credentials", re.compile(r"(\b[a-zA-Z][a-zA-Z0-9+.-]*://)(?:[^\s/@:]+:[^\s/@]+|[^\s/@:]+)@"),
     r"\g<1>[REDACTED:url_credentials]@"),
    ("basic_auth", re.compile(r"((?:^|\s)(?:-u|--user)(?:\s+|=)?)['\"]?[^\s:'\"]+:[^\s'\"]+['\"]?"),
     r"\g<1>[REDACTED:basic_auth]"),
    ("basic_header", re.compile(r"(?i)\b(basic)\s+[A-Za-z0-9+/]{8,}=*"), r"\g<1> [REDACTED:basic_header]"),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*"), None),
    # «ключ = значение» и JSON: "api_token": "…" — кавычки вокруг имени и значения.
    ("assignment", re.compile(
        r"(?i)\b([A-Z0-9_]*(?:api[_-]?key|token|secret|password|passwd)[A-Z0-9_]*)(\\?['\"]?\s*[:=]\s*\\?['\"]?)[^\s'\",}\\]{6,}"),
     r"\g<1>\g<2>[REDACTED:assignment]"),
)


# Значение под таким именем редактируется целиком, какого бы вида оно ни было:
# голый пароль не похож ни на один формат токена. Ключевое слово ищется как
# отдельная часть имени (secret_value, x-cookie), поэтому счётчики вроде tokens
# или input_tokens не задеваются.
SENSITIVE_KEY = re.compile(
    r"(?i)(^|[_.-])(password|passwd|passphrase|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|"
    r"credentials?|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|token|"
    r"cookie|set-cookie)([_.-]|$)")
# Строка, которая сама является JSON (конфиг, записываемый через MCP): после
# json.dumps её "ключ": "значение" превращаются в \"ключ\": \"значение\", и имя
# секрета больше не выглядит именем. Такие строки разбираются и чистятся как структура.
JSON_TEXT_LIMIT = 200_000


class NeverSend(Exception):
    """Во входе нашёлся приватный ключ: такое состояние провайдеру не уходит целиком."""


def is_protected_name(name: str) -> bool:
    base = os.path.basename(str(name).rstrip("/"))
    return (base in PROTECTED_NAMES or base.startswith(".env") or "credential" in base.lower()
            or base.endswith((".pem", ".key")))


def classify_path(path: str, local_only: tuple[str, ...] = ()) -> str:
    expanded = os.path.expanduser(path)
    for pattern in NEVER_SEND_PATHS:
        target = os.path.expanduser(pattern)
        if fnmatch.fnmatch(expanded, target) or fnmatch.fnmatch(os.path.basename(expanded), pattern):
            return NEVER_SEND
    if any(is_protected_name(part) for part in expanded.split(os.sep) if part):
        return NEVER_SEND
    for pattern in local_only:
        if fnmatch.fnmatch(expanded, os.path.expanduser(pattern)):
            return LOCAL_ONLY
    return ALLOW


def redact(text: str) -> tuple[str, list[str]]:
    """Заменяет секретоподобные значения маркером. Возвращает текст и найденные классы."""
    found = []
    for name, pattern, replacement in SECRET_PATTERNS:
        if pattern.search(text):
            found.append(name)
            text = pattern.sub(replacement or f"[REDACTED:{name}]", text)
    return text, found


def _clean(value, report: dict, key: str = ""):
    """Редакция каждой строки структуры; приватный ключ где угодно — NeverSend."""
    if isinstance(value, str):
        nested = _json_structure(value)
        if nested is not None:
            return json.dumps(_clean(nested, report, key), ensure_ascii=False, sort_keys=True)
        cleaned, found = redact(value)
        if "private_key" in found:
            raise NeverSend
        report["redacted"].extend(found)
        return cleaned
    if isinstance(value, dict):
        cleaned = {}
        for raw_key, item in value.items():
            # Ключ — тоже вход провайдера: проверяется так же, как значение.
            clean_key = _clean(str(raw_key), report)
            if clean_key != str(raw_key):
                report["dropped_keys"].append("[secret-key]")
                continue
            if SENSITIVE_KEY.search(clean_key) and not isinstance(item, (bool, type(None))):
                report["redacted"].append("sensitive_key")
                cleaned[clean_key] = "[REDACTED:sensitive_key]"
                continue
            cleaned[clean_key] = _clean(item, report, clean_key)
        return cleaned
    if isinstance(value, (list, tuple)):
        items = list(value)
        if key == "directories":
            # Защищённые имена не уходят даже как имена каталогов.
            kept = [item for item in items if not (isinstance(item, str) and is_protected_name(item))]
            report["dropped_names"] += len(items) - len(kept)
            items = kept
        return [_clean(item, report, key) for item in items]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return _clean(str(value), report, key)


def _json_structure(value: str):
    """Разобранный JSON-объект или массив из строки, иначе None."""
    text = value.strip()
    if len(text) > JSON_TEXT_LIMIT or not text or text[0] not in "{[":
        return None
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    return parsed if isinstance(parsed, (dict, list)) else None


def clean_value(value):
    """Редакция произвольной структуры без отбора ключей; приватный ключ — NeverSend."""
    report = {"redacted": [], "dropped_keys": [], "dropped_names": 0}
    return _clean(value, report), report


def _files(value, local_only: tuple[str, ...], report: dict) -> dict:
    files = {}
    if not isinstance(value, dict):
        # Не словарь путь → содержимое: форму не угадываем, не отправляем ничего.
        report["dropped_files"] += len(value) if isinstance(value, (list, tuple)) else 1
        return files
    for path, content in value.items():
        path = str(path)
        if redact(path)[1]:
            # Секрет в самом пути (https://TOKEN@host/…): путь — тоже вход провайдера.
            report["dropped_files"] += 1
            continue
        if classify_path(path, local_only) != ALLOW:
            report["dropped_files"] += 1
            continue
        cleaned, found = redact(str(content))
        if "private_key" in found:
            report["dropped_files"] += 1
            continue
        report["redacted"].extend(found)
        files[path] = cleaned
    return files


def prepare_state(state: dict, local_only: tuple[str, ...] = ()) -> tuple[dict | None, dict]:
    """Готовит состояние к отправке провайдеру.

    Возвращает (безопасное состояние или None, отчёт). None — отправлять нельзя
    совсем: политика обязана уйти в запасное поведение без вызова провайдера.
    """
    report = {"verdict": ALLOW, "redacted": [], "dropped_files": 0, "dropped_keys": [], "dropped_names": 0}
    safe: dict = {}
    try:
        for key, value in (state or {}).items():
            if key not in ALLOWED_KEYS:
                report["dropped_keys"].append(str(key))
            elif key == "files":
                safe["files"] = _files(value, local_only, report)
            else:
                safe[key] = _clean(value, report, key)
    except NeverSend:
        report["verdict"] = NEVER_SEND
        report["redacted"].append("private_key")
        return None, report
    if report["redacted"] or report["dropped_files"] or report["dropped_keys"] or report["dropped_names"]:
        report["verdict"] = REDACT
    return safe, report


def prepare_instructions(text: str) -> str | None:
    """Инструкции вопроса — тоже вход провайдера: редакция, приватный ключ — None (не отправлять)."""
    cleaned, found = redact(text or "")
    return None if "private_key" in found else cleaned

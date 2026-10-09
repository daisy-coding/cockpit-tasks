"""Поиск без изменения схемы; функции запроса совпадают с доменом мода."""
import json
import re

LISTS = ("queue", "deferred", "closed")
STATUS_LIST = {"active": "queue", "paused": "deferred", "done": "closed"}


def normalize(text):
    return text.lower().replace("ё", "е")


def parse_query(query):
    if not isinstance(query, str) or not 1 <= len(query) <= 200:
        return None
    try:
        query.encode("utf-8")
    except UnicodeError:
        return None
    words = re.findall(r"[^\W_]+", normalize(query))
    terms = list(dict.fromkeys(word for index, word in enumerate(words)
                               if not (word == "task" and index + 1 < len(words) and re.fullmatch(r"[0-9]+", words[index + 1]))))
    if not terms:
        return None
    return {"terms": terms, "numbers": [word.lstrip("0") or "0" for word in terms if re.fullmatch(r"[0-9]+", word)]}


def matches_row(query, row):
    texts = [normalize(row.get(field, "")) for field in ("title", "description")]
    texts.append(row.get("alias", "").removeprefix("TASK-"))
    return all(any(term in text for text in texts) for term in query["terms"])


def search_tasks(db, binding, args):
    from . import domain
    query = parse_query(args["query"])
    selected = args.get("lists", list(LISTS))
    offset, limit = args.get("offset", 0), args.get("limit", 20)
    key = (binding["projectId"], binding["worktreeId"])
    statuses = [{"queue": "active", "deferred": "paused", "closed": "done"}[name] for name in selected]
    scope = domain.VISIBLE_TASK_SQL + " AND t.status IN (" + ",".join("?" for _ in statuses) + ")"
    parameters = (*key, *statuses)
    records = {}

    def shown_text(text):
        # Оболочка вставки и секреты убираются так же, как при показе любого поля.
        raw = re.sub(r"</?pasted_content\b[^>]*>", "", text, flags=re.IGNORECASE)
        return domain.plain(domain.redact(raw)[0])

    def visit(record, field, text):
        normalized = normalize(text)
        hit = False
        for term in query["terms"]:
            position = normalized.find(term)
            if position < 0:
                continue
            hit = True
            record["remaining"].discard(term)
            word_start = position == 0 or not normalized[position - 1].isalnum()
            if field == "title" and not word_start:
                following = normalized.find(term, position + 1)
                while following >= 0:
                    if not normalized[following - 1].isalnum():
                        word_start = True
                        break
                    following = normalized.find(term, following + 1)
            rank = (0 if field == "number" and term in query["numbers"] and text == term else
                    1 if field == "title" and word_start else
                    2 if field == "title" else 3 if field in ("description", "acceptance", "constraints") else 4)
            # Подстрока номера сама по себе не выше совпадения в названии.
            if field == "number" and rank != 0:
                rank = 5
            if rank < record["rank"]:
                record.update(rank=rank, field=field, text=text, term=term)
            # Лучшее совпадение в тексте карточки запоминается отдельно: ранг его не видит, а владельцу
            # нужны слова вокруг совпадения и тогда, когда слово есть ещё и в названии.
            if field not in ("number", "title") and rank < record["inside_rank"]:
                record.update(inside_rank=rank, inside=(field, text, term))
        if hit:
            record["fields"].append((field, text))

    for row in db.execute(f"""SELECT t.task_id,t.alias_no,t.title,t.description,t.status,t.updated_at,t.priority_pinned,
        t.priority,t.queue_position,COALESCE(c.closed_at,t.updated_at) AS closed_at
        FROM tasks t LEFT JOIN task_closures c ON c.task_id=t.task_id WHERE {scope}""", parameters):
        record = {"row": row, "remaining": set(query["terms"]), "rank": 6, "fields": [], "inside_rank": 6, "inside": None}
        visit(record, "number", str(row["alias_no"]))
        visit(record, "title", row["title"])
        visit(record, "description", row["description"])
        records[row["task_id"]] = record

    # Четыре пакетных чтения вместо отдельного запроса к каждой карточке. Записи
    # остаются раздельными: слово не совпадает через границу двух комментариев.
    extra_queries = (
        (f"SELECT x.task_id,x.kind AS field,x.text FROM task_lists x JOIN tasks t ON t.task_id=x.task_id WHERE {scope}", parameters),
        (f"SELECT x.task_id,CASE WHEN x.kind='result' THEN 'result' ELSE 'comment' END AS field,x.text FROM task_agent_notes x JOIN tasks t ON t.task_id=x.task_id WHERE {scope}", parameters),
        (f"SELECT x.task_id,'comment' AS field,x.text FROM task_owner_comments x JOIN tasks t ON t.task_id=x.task_id WHERE {scope} AND x.deleted=0 AND x.project_id=t.project_id AND x.worktree_id=t.worktree_id", parameters),
        (f"""SELECT x.task_id,'comment' AS field,x.text FROM checkpoints x JOIN tasks t ON t.task_id=x.task_id
            WHERE {scope} AND x.kind='note'
            AND NOT EXISTS (SELECT 1 FROM task_owner_comments o WHERE o.comment_id=x.checkpoint_id)""", parameters),
    )
    for sql, values in extra_queries:
        for row in db.execute(sql, values):
            visit(records[row["task_id"]], row["field"], row["text"])

    # Поиск видит только то, что рантайм показывает. Слово, найденное лишь внутри замаскированного секрета,
    # совпадением не считается: иначе перебором запросов секрет читается по частям, хотя отрывок его скрывает.
    # Маскирование дорого, поэтому показанный текст строится только для полей кандидатов, где слово нашлось.
    for record in records.values():
        if record["remaining"]:
            continue
        fields = record["fields"]
        record.update(remaining=set(query["terms"]), rank=6, fields=[], inside_rank=6, inside=None)
        for field, text in fields:
            visit(record, field, text if field == "number" else shown_text(text))

    def excerpt(source, term):
        # Весь текст маскируется до выбора отрывка: секрет нельзя разрезать
        # границей окна, даже если совпадение далеко от начала описания.
        raw = re.sub(r"</?pasted_content\b[^>]*>", "", source, flags=re.IGNORECASE)
        text = domain.plain(domain.redact(raw)[0])
        position = normalize(text).find(term)
        start = max(0, position - 50) if position >= 0 else 0
        return text[start:start + 160]

    groups = {name: [] for name in selected}
    for record in records.values():
        if not record["remaining"]:
            groups[STATUS_LIST[record["row"]["status"]]].append(record)
    result = {"offset": offset, "limit": limit, "lists": {name: {"total": len(rows), "rows": []} for name, rows in groups.items()}, "truncated": False}
    counts_by_task = domain.return_counts(db, list(records))
    used = len(json.dumps({"v": 1, "ok": True, "result": result}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1
    for name, records in groups.items():
        # Стабильная сортировка сохраняет порядок обычного списка при равном ранге.
        if name == "closed":
            records.sort(key=lambda record: (record["row"]["closed_at"], record["row"]["alias_no"]), reverse=True)
        else:
            records.sort(key=lambda record: (record["row"]["priority"], record["row"]["queue_position"], record["row"]["alias_no"]))
        records.sort(key=lambda record: record["rank"])
        for record in records[offset:offset + limit]:
            row = record["row"]
            snippet = f"TASK-{row['alias_no']}" if record["field"] == "number" else excerpt(record["text"], record["term"])
            match = {"field": record["field"], "snippet": snippet}
            if record["field"] in ("number", "title") and record["inside"]:
                field, source, term = record["inside"]
                match["inside"] = {"field": field, "snippet": excerpt(source, term)}
            item = {"taskId": row["task_id"], "alias": f"TASK-{row['alias_no']}", "title": domain.shown(row["title"], 300),
                    "returnCount": counts_by_task.get(row["task_id"], 0),
                    "status": row["status"], "updatedAt": row["updated_at"], "priorityPinned": bool(row["priority_pinned"]),
                    "match": match}
            size = len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + bool(result["lists"][name]["rows"])
            if used + size > domain.SNAPSHOT_RESPONSE_BYTES:
                result["truncated"] = True
                return result
            used += size
            result["lists"][name]["rows"].append(item)
    return result

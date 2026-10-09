"""Кеш короткого описания: один захват до вызова модели, без повторов после сбоя."""
import hashlib
import re

from . import CockpitError
from .domain import own_task, shown, expect_revision


def description_hash(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def accepted_summary(text, description):
    if not isinstance(text, str) or not text.strip() or len(text.strip()) > 300:
        return None
    clean = shown(text, 4000).strip()
    if not clean or len(clean) > 300 or clean.endswith(('…', '...')) or clean[-1] not in '.!?':
        return None
    # Проверка связи с исходником отсекает посторонний ответ, но не доказывает точность пересказа.
    generic = {'зада', 'карт', 'рабо', 'опис', 'свод', 'нужн', 'сдел', 'пунк', 'task', 'desc', 'summ'}
    words = lambda value: {word[:4] for word in re.findall(r'[^\W\d_]{4,}', value.lower())} - generic
    source = words(description)
    meaningful = words(clean)
    if len(source & meaningful) < 2:
        return None
    return clean


def summary_fields(db, rows):
    rows = list(rows)
    if not rows:
        return {}
    ids = [row['task_id'] for row in rows]
    placeholders = ','.join('?' for _ in ids)
    cached = {(row['task_id'], row['description_hash']): row['summary'] for row in db.execute(
        f'SELECT task_id,description_hash,summary FROM task_description_summaries WHERE task_id IN ({placeholders}) AND summary IS NOT NULL', ids)}
    result = {}
    for row in rows:
        text = cached.get((row['task_id'], description_hash(row['description'])))
        if text:
            clean = accepted_summary(text, shown(row['description'], 4000, multiline=True))
            if clean:
                result[row['task_id']] = {'summary': clean}
    return result


def summary_action(db, binding, op, args):
    card = own_task(db, binding, args['taskId'])
    if card['deleted'] or card['stage'] != 'task':
        raise CockpitError('NOT_FOUND', 'Сводка недоступна для этой карточки.')
    row = db.execute('SELECT description FROM tasks WHERE task_id=?', (card['taskId'],)).fetchone()
    digest = description_hash(row['description'])
    if op == 'task.summary.claim':
        expect_revision(card['revision'], args['expectedRevision'], 'задачи')
        description = shown(row['description'], 4000, multiline=True)
        if len(description) <= 300:
            return {'claimed': False}
        claimed = db.execute('INSERT OR IGNORE INTO task_description_summaries(task_id,description_hash,session_id) VALUES (?,?,?)',
                             (card['taskId'], digest, binding['sessionId'])).rowcount == 1
        return {'claimed': True, 'descriptionHash': digest, 'description': description} if claimed else {'claimed': False}
    cached = db.execute('SELECT * FROM task_description_summaries WHERE task_id=? AND description_hash=?',
                        (card['taskId'], args['descriptionHash'])).fetchone()
    if cached is None or cached['session_id'] != binding['sessionId']:
        raise CockpitError('ATTESTATION_FAILED', 'Исход сводки принимает только сессия, захватившая эту редакцию.')
    if digest != args['descriptionHash']:
        return {'summary': None}
    if not cached['reported']:
        summary = accepted_summary(args['summary'], shown(row['description'], 4000, multiline=True))
        metrics = args.get('metrics', {})
        db.execute('''UPDATE task_description_summaries SET summary=?,reported=1,duration_ms=?,
                   input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_creation_tokens=?
                   WHERE task_id=? AND description_hash=?''',
                   (summary, *(metrics.get(key) for key in ('durationMs', 'inputTokens', 'outputTokens',
                    'cacheReadTokens', 'cacheCreationTokens')), card['taskId'], digest))
    current = db.execute('SELECT * FROM tasks WHERE task_id=?', (card['taskId'],)).fetchone()
    return {'summary': summary_fields(db, [current]).get(card['taskId'], {}).get('summary')}

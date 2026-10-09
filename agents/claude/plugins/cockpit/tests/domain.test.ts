import { expect, test } from 'claude-code/testing'
import { buildRequest, isFileMutation, missingExecutable, parseResponse, rebindReason, shouldCapture, validId, isHumanSurfaceCommand } from '../hooks/domain/rpc'
import { contextPercent, initialProjection, reduceProjection } from '../hooks/domain/projection'
import { classificationText, inboxTypeText, INBOX_TYPES, line, returnPacketText, statusText, timelineText } from '../hooks/domain/text'
import { CHECKPOINT, DOCTOR, ENTRY, seeded, snapshot, TASK } from './fixtures'

test('Причина отказа свидетельства читается только из известной метки, произвольный текст не переносится', () => {
  for (const reason of ['revoked', 'unregistered', 'mismatch', 'stale-epoch', 'expired'] as const) {
    const result = parseResponse('task.agent.action', JSON.stringify({ v: 1, ok: false,
      error: { code: 'ATTESTATION_FAILED', message: `[attestation-${reason}] Текст рантайма` } }))
    expect(result).toEqual({ kind: 'error', code: 'ATTESTATION_FAILED', attestationReason: reason })
  }
  for (const message of ['Произвольный текст', '[attestation-invented] Текст', '[attestation-revokedX] Текст']) {
    expect(parseResponse('task.agent.action', JSON.stringify({ v: 1, ok: false, error: { code: 'ATTESTATION_FAILED', message } })))
      .toEqual({ kind: 'error', code: 'ATTESTATION_FAILED' })
  }
  expect(parseResponse('task.agent.action', JSON.stringify({ v: 1, ok: false, error: { code: 'REVISION_CONFLICT', message: '[attestation-revoked] Текст' } })))
    .toEqual({ kind: 'error', code: 'REVISION_CONFLICT' })
})

test('Явный отзыв требует ключ панели, а схема 12 сохраняет канонический корень', () => {
  const session = { sessionId: 'session-1', cwd: '/fixture' }
  const secret = 'cd'.repeat(32) // gitleaks:allow
  expect(() => buildRequest('session.revoke', 'revoke', session, {})).toThrow()
  expect(() => buildRequest('session.revoke', 'revoke', session, {}, secret, 'agent')).toThrow()
  expect(buildRequest('session.revoke', 'revoke', session, {}, secret).actor).toBe('owner')
  expect(parseResponse('session.revoke', JSON.stringify({ v: 1, ok: true, result: { revoked: true, panelSecret: secret } }))).toEqual({ kind: 'revoked' })
  expect(parseResponse('session.revoke', JSON.stringify({ v: 1, ok: true, result: { revoked: false } }))).toEqual({ kind: 'unknown' })
  const result = parseResponse('snapshot', JSON.stringify({ v: 1, ok: true, result: { ...snapshot(null), storageSchemaVersion: 12, candidates: [], candidateCount: 0,
    binding: { ...snapshot().binding, worktreePath: '/fixture' } } }))
  expect(result.kind).toBe('snapshot')
  if (result.kind === 'snapshot') expect(result.snapshot.binding.worktreePath).toBe('/fixture')
})

test('Версия 8 сохраняет кандидатов, tool и ответы принятия и отклонения', () => {
  const reply = (result: unknown) => JSON.stringify({ v: 1, ok: true, result })
  const candidate = { ...snapshot().tasks[0], stage: 'candidate', adoptedBy: null, dismissReason: null, dismissedAt: null,
    queuePosition: null, description: 'Описание предложения', certainty: 'inferred', certaintySource: 'provider' }
  const current = { ...snapshot(null), storageSchemaVersion: 8, tasks: [], candidates: [candidate], candidateCount: 1 }
  expect(parseResponse('snapshot', reply(current))).toEqual({ kind: 'snapshot', snapshot: current })
  expect(parseResponse('candidate.adopt', reply({ task: { ...TASK, ...candidate, stage: 'task', adoptedBy: 'agent', queuePosition: 3 } })).kind).toBe('adopted')
  expect(parseResponse('candidate.dismiss', reply({ dismissed: [TASK.taskId], skipped: ['old-task'] }))).toEqual({ kind: 'dismissed', dismissed: [TASK.taskId], skipped: ['old-task'] })
  expect(parseResponse('checkpoint.add', reply({ checkpoint: { ...CHECKPOINT, source: 'agent', provenance: 'tool' }, taskRevision: 4 })).kind).toBe('noted')
  for (const change of [{ stage: 'proposal' }, { adoptedBy: 'other' }, { dismissReason: 'done' }, { dismissedAt: 'bad' }, { queuePosition: -1 }]) {
    expect(parseResponse('task.get', reply({ task: { ...TASK, ...candidate, ...change } }))).toEqual({ kind: 'unknown' })
  }
  for (const change of [{ candidateCount: -1 }, { candidateCount: 0 }, { candidates: Array(6).fill(candidate) }, { candidates: [TASK] }]) {
    expect(parseResponse('snapshot', reply({ ...current, ...change }))).toEqual({ kind: 'unknown' })
  }
  expect(parseResponse('candidate.dismiss', reply({ dismissed: [TASK.taskId], skipped: [TASK.taskId] }))).toEqual({ kind: 'unknown' })
})

test('Действия панели несут actor owner, инструмент требует свидетельство', () => {
  const session = { sessionId: 'session-1', cwd: '/fixture' }
  const secret = 'ab'.repeat(32) // gitleaks:allow
  expect(buildRequest('task.confirm', 'actor-owner', session, { taskId: TASK.taskId, expectedRevision: 3 }, secret).actor).toBe('owner')
  expect(buildRequest('candidate.adopt', 'actor-adopt', session, { taskId: TASK.taskId, expectedRevision: 0 }, secret).actor).toBe('owner')
  expect(buildRequest('snapshot', 'actor-read', session, {}, secret, 'agent').actor).toBe('agent')
  expect(() => buildRequest('snapshot', 'no-proof', session, {}, undefined, 'agent')).toThrow()
  expect(() => buildRequest('task.confirm', 'forbidden', session, { taskId: TASK.taskId, expectedRevision: 3 }, secret, 'agent')).toThrow()
  expect(buildRequest('focus.get', 'actor-focus-read', session, {}, secret, 'agent').actor).toBe('agent')
  const focus = { task: TASK, revision: 2 }
  expect(parseResponse('focus.get', JSON.stringify({ v: 1, ok: true, result: focus }))).toEqual({ kind: 'focused', focus })
  expect(parseResponse('focus.set', JSON.stringify({ v: 1, ok: true, result: focus }))).toEqual({ kind: 'focused', focus })
})

test('Поля поручения и очередь версии 7 принимаются, очищаются, старые ответы остаются прежними', () => {
  const reply = (result: unknown) => JSON.stringify({ v: 1, ok: true, result })
  const secret = 'sk-' + 'Q'.repeat(25)  // gitleaks:allow
  const card = { ...TASK, description: `<pasted_content>Описание ${secret}</pasted_content>`,
    acceptance: ['<pasted_content>Готово</pasted_content>'], constraints: [`Запрет ${secret}`],
    assignee: 'codex', priority: 0, prioritySource: 'user', priorityPinned: true }
  const clean = { ...card, description: 'Описание [REDACTED:api_key]', acceptance: ['Готово'], constraints: ['Запрет [REDACTED:api_key]'] }
  expect(parseResponse('task.get', reply({ task: card }))).toEqual({ kind: 'task', task: clean })
  expect(parseResponse('task.get', reply({ task: TASK }))).toEqual({ kind: 'task', task: TASK })
  const summary = { ...snapshot().tasks[0], assignee: 'codex', priority: 0, prioritySource: 'user', priorityPinned: true }
  const current = { ...snapshot(), storageSchemaVersion: 7, queue: 'paused', focus: { task: card, revision: 1 }, tasks: [summary] }
  expect(parseResponse('snapshot', reply(current))).toEqual({ kind: 'snapshot', snapshot: { ...current, focus: { task: clean, revision: 1 } } })
  expect(parseResponse('snapshot', reply(snapshot()))).toEqual({ kind: 'snapshot', snapshot: snapshot() })
  expect(parseResponse('doctor', reply({ ...DOCTOR, storageSchemaVersion: 7 }))).toEqual({ kind: 'doctor', doctor: { ...DOCTOR, storageSchemaVersion: 7 } })
})

test('Неверные новые поля и очередь отвергаются, длина текста измеряется code points', () => {
  const reply = (result: unknown) => JSON.stringify({ v: 1, ok: true, result })
  for (const change of [{ description: 1 }, { description: 'x'.repeat(4001) }, { acceptance: ['x'.repeat(301)] },
    { acceptance: Array(11).fill('x') }, { constraints: [1] }, { assignee: 'other' }, { assignee: ['codex'] }, { priority: 4 },
    { priority: -1 }, { priority: 1.5 }, { priorityPinned: 1 }, { prioritySource: 'claude' }]) {
    expect(parseResponse('task.get', reply({ task: { ...TASK, ...change } }))).toEqual({ kind: 'unknown' })
  }
  expect(parseResponse('task.get', reply({ task: { ...TASK, description: '🐋'.repeat(4000), acceptance: ['🐋'.repeat(300)] } })).kind).toBe('task')
  expect(parseResponse('snapshot', reply({ ...snapshot(), storageSchemaVersion: 7, queue: 'off' }))).toEqual({ kind: 'unknown' })
})

test('Новые запросы несут свидетельство и ответы редактирования, ранжирования, queue проходят парсер', () => {
  const session = { sessionId: 'session-1', cwd: '/fixture' }
  const secret = 'ab'.repeat(32)  // gitleaks:allow
  expect(buildRequest('task.create', 'create-fields', session, { title: 'Поручение', description: 'Описание', acceptance: [], constraints: [], assignee: null, priority: 1 }, secret).panelSecret).toBe(secret)
  expect(buildRequest('task.edit', 'edit-fields', session, { taskId: TASK.taskId, expectedRevision: 3, pinned: false }, secret).panelSecret).toBe(secret)
  expect(buildRequest('tasks.rank', 'rank-fields', session, { items: [{ taskId: TASK.taskId, expectedRevision: 3, priority: 1 }], source: 'model' }, secret).panelSecret).toBe(secret)
  expect(buildRequest('config.set', 'pause-queue', session, { key: 'queue', value: 'paused' }, secret).panelSecret).toBe(secret)
  const reply = (result: unknown) => JSON.stringify({ v: 1, ok: true, result })
  expect(parseResponse('task.edit', reply({ task: TASK }))).toEqual({ kind: 'updated', task: TASK })
  const ranked = { changed: [{ taskId: TASK.taskId, priority: 1 }], skipped: [{ taskId: 'other', reason: 'pinned' }] }
  expect(parseResponse('tasks.rank', reply(ranked))).toEqual({ kind: 'ranked', ...ranked })
  expect(parseResponse('tasks.rank', reply({ ...ranked, skipped: [{ taskId: 'other', reason: 'PRIVATE' }] }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('tasks.rank', reply({ ...ranked, skipped: [{ taskId: 'other', reason: ['pinned'] }] }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('tasks.rank', reply({ ...ranked, skipped: [{ taskId: TASK.taskId, reason: 'pinned' }] }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('tasks.rank', reply({ ...ranked, changed: [{ taskId: TASK.taskId, priority: 4 }] }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('config.get', reply({ key: 'queue', value: 'run', provenance: 'cli' }))).toEqual({ kind: 'configured', key: 'queue', value: 'run', provenance: 'cli' })
  expect(parseResponse('config.set', reply({ key: 'queue', value: 'paused', provenance: 'panel' }))).toEqual({ kind: 'configured', key: 'queue', value: 'paused', provenance: 'panel' })
  expect(parseResponse('config.set', reply({ key: 'gate', value: 'paused', provenance: 'panel' }))).toEqual({ kind: 'unknown' })
})

test('Классификация CLI не показывается как решение текущего человека', () => {
  const cli = classificationText({ ...ENTRY, classifiedBy: 'user', provenance: 'cli' })
  expect(cli).not.toContain('Кем поставлен: вы')
  expect(cli).toContain('Кем поставлен: командная строка')
  expect(classificationText({ ...ENTRY, classifiedBy: 'user', provenance: 'panel' })).toContain('Кем поставлен: вы')
})

test('Сборка envelope сохраняет точный текст и проверяет идентификаторы', () => {
  const current = { sessionId: 'session:1', cwd: '/fixture' }
  const request = buildRequest('capture.prompt', 'delivery-1', current, { text: 'Текст\r\n👩\u0000', kind: 'prompt' })
  expect(request).toEqual({ v: 1, op: 'capture.prompt', requestId: 'delivery-1', session: current, args: { text: 'Текст\r\n👩\u0000', kind: 'prompt' } })
  expect(validId('a'.repeat(100))).toBe(true)
  for (const value of ['', '-bad', 'промпт', 'a'.repeat(101), 'with space']) expect(validId(value)).toBe(false)
  expect(() => buildRequest('snapshot', '/PRIVATE', current, {})).toThrow('Некорректные идентификаторы')
})

test('Парсер M2 сохраняет типы, ревизии и только разрешённые поля вложенных ответов', () => {
  const dirty = { ...snapshot(), extra: 'PRIVATE', inbox: [{ ...ENTRY, rawText: 'PRIVATE', scope: { ...ENTRY.scope, extra: 'PRIVATE' } }] }
  expect(parseResponse('snapshot', JSON.stringify({ v: 1, ok: true, result: dirty }))).toEqual({ kind: 'snapshot', snapshot: snapshot() })
  const reply = (result: unknown) => JSON.stringify({ v: 1, ok: true, result })
  expect(parseResponse('inbox.triage', reply({ ...ENTRY, rawText: 'PRIVATE' }))).toEqual({ kind: 'triaged', entry: ENTRY })
  expect(parseResponse('task.confirm', reply({ task: { ...TASK, text: 'PRIVATE' } }))).toEqual({ kind: 'confirmed', task: TASK })
  const dirtyMark = { ...CHECKPOINT, original: 'PRIVATE' }
  expect(parseResponse('checkpoint.add', reply({ checkpoint: dirtyMark, taskRevision: 4 }))).toEqual({ kind: 'noted', checkpoint: CHECKPOINT, taskRevision: 4 })
  expect(parseResponse('checkpoint.list', reply({ taskId: TASK.taskId, taskRevision: 3, checkpoints: [dirtyMark], extra: 'PRIVATE' }))).toEqual({ kind: 'timeline', taskId: TASK.taskId, taskRevision: 3, checkpoints: [CHECKPOINT] })
  const focus = { task: TASK, revision: 5 }
  const packet = { taskId: TASK.taskId, title: TASK.title, checkpoints: [CHECKPOINT], inbox: [ENTRY] }
  expect(parseResponse('focus.return', reply({ focus, stackDepth: 0, checkpoint: dirtyMark, returnPacket: { ...packet, text: 'PRIVATE' } }))).toEqual({ kind: 'returned', focus, stackDepth: 0, checkpoint: CHECKPOINT, returnPacket: packet })
  expect(parseResponse('focus.detour', reply({ focus, stackDepth: 1, checkpoint: dirtyMark, text: 'PRIVATE' }))).toEqual({ kind: 'detoured', focus, stackDepth: 1, checkpoint: CHECKPOINT })
})

test('Неверные поля M2 и чужие отметки отвергаются без текста отказа', () => {
  const reply = (result: unknown) => JSON.stringify({ v: 1, ok: true, result })
  for (const change of [{ type: 'PRIVATE' }, { classifiedBy: 'PRIVATE' }, { triageStatus: 'PRIVATE' }, { triageRevision: -1 }, { confidence: 1.1 }, { mode: 'PRIVATE' }]) {
    expect(parseResponse('inbox.triage', reply({ ...ENTRY, ...change }))).toEqual({ kind: 'unknown' })
  }
  for (const change of [{ certainty: 'PRIVATE' }, { certaintySource: 'PRIVATE' }]) expect(parseResponse('task.confirm', reply({ task: { ...TASK, ...change } }))).toEqual({ kind: 'unknown' })
  for (const version of [3, 4, 8]) expect(parseResponse('snapshot', reply({ ...snapshot(), storageSchemaVersion: version }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('snapshot', reply({ ...snapshot(), inboxTriageCounts: { untriaged: 2, blocking: -1 } }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('checkpoint.list', reply({ taskId: TASK.taskId, taskRevision: 3, checkpoints: [{ ...CHECKPOINT, taskId: 'other-task' }] }))).toEqual({ kind: 'unknown' })
  for (const change of [{ kind: 'PRIVATE' }, { source: 'PRIVATE' }, { createdAt: 'PRIVATE' }]) expect(parseResponse('checkpoint.add', reply({ checkpoint: { ...CHECKPOINT, ...change }, taskRevision: 4 }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('focus.return', reply({ focus: { task: TASK, revision: 3 }, stackDepth: 0, checkpoint: CHECKPOINT,
    returnPacket: { taskId: 'other-task', title: 'PRIVATE', checkpoints: [], inbox: [] } }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('focus.detour', reply({ focus: { task: TASK, revision: 3 }, stackDepth: 9, checkpoint: CHECKPOINT }))).toEqual({ kind: 'unknown' })
})

test('Сборка свидетельства разрешена только для действий человека, парсер не сохраняет секрет', () => {
  const session = { sessionId: 'session-1', cwd: '/fixture' }
  const secret = 'ab'.repeat(32)  // gitleaks:allow
  expect(buildRequest('session.attest', 'attest', session, {}, secret).panelSecret).toBe(secret)
  expect(buildRequest('task.confirm', 'confirm', session, { taskId: TASK.taskId, expectedRevision: 3 }, secret).panelSecret).toBe(secret)
  expect(buildRequest('task.update', 'background-title', session, { taskId: TASK.taskId, expectedRevision: 3, title: 'Название' }).panelSecret).toBeUndefined()
  expect(() => buildRequest('snapshot', 'snapshot', session, {}, secret)).toThrow('Недопустимое свидетельство')
  const body = (result: unknown) => JSON.stringify({ v: 1, ok: true, result })
  expect(parseResponse('session.attest', body({ attested: true, panelSecret: secret }))).toEqual({ kind: 'attested' })
  expect(parseResponse('session.attest', body({ attested: false }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('checkpoint.add', body({ checkpoint: { ...CHECKPOINT, provenance: 'PRIVATE' }, taskRevision: 3 }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('task.confirm', body({ task: { ...TASK, certaintyProvenance: 'PRIVATE' } }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('inbox.triage', body({ ...ENTRY, triageProvenance: 'PRIVATE' }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('snapshot', body({ ...snapshot(), focusStack: [{ taskId: TASK.taskId, depth: 1, provenance: 'PRIVATE' }] }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('config.set', body({ key: 'gate', value: 'observe', provenance: 'panel', panelSecret: secret }))).toEqual({ kind: 'configured', key: 'gate', value: 'observe', provenance: 'panel' })
})

test('Необязательные отказы сохраняют связь и подтверждённые данные', () => {
  const state = seeded()
  for (const outcome of [{ kind: 'unknown' }, { kind: 'unavailable' }, { kind: 'error', code: 'REVISION_CONFLICT' }] as const) {
    const next = reduceProjection(state, outcome, true)
    expect(next.connection).toEqual(state.connection)
    expect(next.focus).toEqual(state.focus)
    expect(next.snapshot).toEqual(state.snapshot)
    expect(next.counters.failures).toBe(state.counters.failures + 1)
  }
})

test('Лента ограничена пятью отметками и не выдаётся за актуальную после изменения задачи', () => {
  const entries = Array.from({ length: 6 }, (_, index) => ({ ...CHECKPOINT, checkpointId: `mark-${index}`, text: `Отметка ${index}` }))
  const state = reduceProjection(seeded(), { kind: 'timeline', taskId: TASK.taskId, taskRevision: TASK.revision, checkpoints: entries })
  expect(state.timeline?.checkpoints).toHaveLength(5)
  expect(timelineText(state)).toContain('Отметка 4')
  expect(timelineText(state)).not.toContain('Отметка 5')
  expect(timelineText({ ...state, focus: { task: { ...TASK, revision: 4 }, revision: 2 } })).toContain('лента обновится при повторном открытии')
  expect(timelineText({ ...state, focus: { task: { ...TASK, taskId: 'other' }, revision: 2 } })).not.toContain('Отметка 0')
  const updated = reduceProjection(state, { kind: 'noted', checkpoint: { ...CHECKPOINT, text: 'Новая отметка' }, taskRevision: 4 })
  expect(updated.focus?.task?.revision).toBe(4)
  expect(updated.timeline?.checkpoints).toHaveLength(5)
  expect(updated.timeline?.checkpoints[0]?.text).toBe('Новая отметка')
  const unread = reduceProjection(seeded(), { kind: 'noted', checkpoint: CHECKPOINT, taskRevision: 4 })
  expect(unread.timeline).toBeNull()
  expect(returnPacketText({ taskId: TASK.taskId, title: TASK.title, checkpoints: [CHECKPOINT], inbox: [ENTRY] })).not.toMatch(/контрольные точки|чекпоинт/i)
})

test('Первая и последующие отметки одинаково показывают происхождение в ленте и пакете возврата', () => {
  for (const [provenance, label] of [['cli', 'командная строка'], ['panel', 'панель']] as const) {
    const entries = Array.from({ length: 3 }, (_, index) => ({
      ...CHECKPOINT, checkpointId: `mark-${index}`, text: `Отметка ${index}`, provenance,
    }))
    const state = reduceProjection(seeded(), { kind: 'timeline', taskId: TASK.taskId, taskRevision: TASK.revision, checkpoints: entries })
    const packet = { taskId: TASK.taskId, title: TASK.title, checkpoints: entries, inbox: [] }
    for (const rendered of [timelineText(state), returnPacketText(packet)]) {
      for (const entry of entries) expect(rendered).toContain(`${entry.text} · ${label}`)
      expect(rendered.split(label)).toHaveLength(entries.length + 1)
    }

  }
})

test('Правила захвата, имена инструментов и причины rebind соответствуют сборке', () => {
  for (const text of ['', ' \n', '/cockpit', '/cockpit status', ' /COCKPIT inbox']) expect(shouldCapture(text, 'composer')).toBe(false)
  for (const text of ['Исправить файл', '/other', '/cockpit-new']) expect(shouldCapture(text, 'composer')).toBe(true)
  // Уведомления фоновых задач, расписание и прочие нечеловеческие источники не захватываются.
  for (const origin of ['task-notification', 'schedule', 'peer', 'plugin', 'sdk', 'unclassified']) expect(shouldCapture('Исправить файл', origin)).toBe(false)
  expect(shouldCapture('Исправить файл', 'bridge')).toBe(true)
  expect(shouldCapture('/tasks add Проверить', 'composer')).toBe(false)
  for (const name of ['Edit', 'Write', 'NotebookEdit']) expect(isFileMutation(name)).toBe(true)
  for (const name of ['Bash', 'Read', 'MultiEdit', 'mcp__example__Edit']) expect(isFileMutation(name)).toBe(false)
  expect(['startup', 'resume', 'clear', 'compact', 'fork', 'unknown'].map(rebindReason)).toEqual(['start', 'resume', 'clear', 'compact', 'start', 'start'])
  expect(missingExecutable(Object.assign(new Error('PRIVATE'), { code: 'ENOENT' }))).toBe(true)
  expect(missingExecutable(new Error('timeout PRIVATE'))).toBe(false)
})

test('Парсер проверяет результат операции и удаляет неизвестные поля проекции', () => {
  const original = snapshot()
  const dirty = { ...original, secret: 'PRIVATE', focus: { ...original.focus, task: { ...TASK, text: 'PRIVATE' } } }
  const parsed = parseResponse('snapshot', JSON.stringify({ v: 1, ok: true, result: dirty }))
  expect(parsed).toEqual({ kind: 'snapshot', snapshot: original })
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE')
  for (const body of ['', 'not-json PRIVATE', '{', 'null', '{"v":2,"ok":true}', '{"v":1,"ok":true,"result":{}}']) expect(parseResponse('snapshot', body)).toEqual({ kind: 'unknown' })
  expect(parseResponse('snapshot', JSON.stringify({ v: 1, ok: true, result: original }), 1)).toEqual({ kind: 'unknown' })
  expect(parseResponse('snapshot', JSON.stringify({ v: 1, ok: true, result: original }), 0, true)).toEqual({ kind: 'unknown' })
  const invalid = { ...original, inboxCounts: { total: -1, untriaged: 0 } }
  expect(parseResponse('snapshot', JSON.stringify({ v: 1, ok: true, result: invalid }))).toEqual({ kind: 'unknown' })
})

test('DB_UNAVAILABLE означает неизвестный исход, REVISION_CONFLICT — известный отказ', () => {
  expect(parseResponse('task.update', '{"v":1,"ok":false,"error":{"code":"DB_UNAVAILABLE","message":"PRIVATE"}}')).toEqual({ kind: 'unknown' })
  expect(parseResponse('task.update', '{"v":1,"ok":false,"error":{"code":"REVISION_CONFLICT","message":"PRIVATE"}}')).toEqual({ kind: 'error', code: 'REVISION_CONFLICT' })
})

test('Редьюсер сохраняет подтверждённые данные при деградации, захват не сохраняет промпт', () => {
  const previous = seeded()
  const next = reduceProjection(previous, { kind: 'unknown' })
  expect(previous.connection.status).toBe('ready')
  expect(next.connection.status).toBe('degraded')
  expect(next.snapshot).toEqual(previous.snapshot)
  const captured = reduceProjection(initialProjection(), { kind: 'captured', inboxId: 'inbox-1', captureMode: 'off' })
  expect(captured.snapshot).toBeNull()
  expect(captured.counters.captures).toBe(1)
  expect(captured.captureMode).toBe('off')
  expect(contextPercent(undefined)).toBeNull()
  expect(contextPercent(0)).toBe(0)
  expect(contextPercent(51)).toBe(51)
  expect(contextPercent(NaN)).toBeNull()
  expect(contextPercent(101)).toBeNull()
})

test('Всё с упоминанием Cockpit вне перечня чтений агенту закрыто', () => {
  for (const command of ['cockpitctl newcommand', 'cockpitctl status; cockpitctl confirm task-1', 'cockpitctl status $(cockpitctl confirm task-1)',
    'cockpitctl inbox | tee out.txt', 'sqlite3 ~/.local/state/agent-config/cockpit/cockpit.db .dump', 'python3 -c "from agents.claude.cockpit import rpc"',
    'c=cockpitctl; $c confirm task-1', 'cockpitctl status && rm -f ~/.local/state/agent-config/cockpit/cockpit.db']) {
    expect(isHumanSurfaceCommand(command)).toBe(true)
  }
  for (const command of ['python3 agents/claude/cockpit/tests/../rpc.py < request.json', 'python3 agents/claude/cockpit/rpc.py < request.json', 'python3 -m agents.claude.cockpit.rpc', 'cat agents/claude/cockpit/domain.py | python3 -']) {
    expect(isHumanSurfaceCommand(command)).toBe(true)
  }
  for (const command of ['cockpitctl show inbox-1', '/home/user/.local/bin/cockpitctl status', 'ls -la', 'grep -rn triage docs/',
    'python3 agents/claude/cockpit/tests/gate.test.py', 'claude plugin test agents/claude/plugins/cockpit']) {
    expect(isHumanSurfaceCommand(command)).toBe(false)
  }
})

test('Команды Cockpit от имени человека агенту закрыты, чтение открыто', () => {
  for (const command of ['cockpitctl triage inbox-1 --status triaged --expected-revision 1', 'cockpitctl confirm task-1 --expected-revision 2',
    'cockpitctl checkpoint add task-1 "Текст" --expected-revision 1', 'cd /x && cockpitctl detour --title Y --expected-revision 3', 'cockpitctl return --expected-revision 3',
    'echo {} | cockpitctl rpc', 'python3 tools/cockpitctl.py rpc < request.json', 'cockpitctl config set capture-mode off', 'cockpitctl config set gate observe', 'python3 tools/cockpitctl.py config set gate off']) {
    expect(isHumanSurfaceCommand(command)).toBe(true)
  }
  for (const command of ['cockpitctl status', 'cockpitctl inbox --limit 3', 'cockpitctl tasks', 'cockpitctl doctor', 'cockpitctl checkpoint list task-1', 'git commit -m "confirm return"', 'cockpitctl config get capture-mode', 'cockpitctl config get gate', 'cockpitctl gate stats --days 7', 'python3 tools/cockpitctl.py gate recent --limit 5']) {
    expect(isHumanSurfaceCommand(command)).toBe(false)
  }
})

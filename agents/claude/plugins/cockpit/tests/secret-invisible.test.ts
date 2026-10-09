import { expect, test } from 'claude-code/testing'
import { hasSecrets, redactSecrets, stripPastedContent } from '../hooks/domain/privacy'
import { line } from '../hooks/domain/text'
import { cleanTitle } from '../hooks/domain/title'
import { parseResponse, type Operation } from '../hooks/domain/rpc'
import { cleanTaskText, clipWords } from '../hooks/domain/task-loop'
import { clean, printable } from '../hooks/owner/text'
import { looksSecret, looksSecretInDraft, parseAsk } from '../hooks/owner/tasks'
import { adopt } from '../hooks/owner/project'
import { cleanWorkText } from '../hooks/work-history'
import { cleanTrailText } from '../hooks/domain/work-trail'
import { cleanSearchText } from '../hooks/task-search-panel'
import { TASK, ENTRY, CHECKPOINT, OBSERVATION, gateSummary, snapshot } from './fixtures'
import { secretText, redactRawSecrets } from '../hooks/domain/privacy'
import { createSecretView } from '../hooks/secret-view'

const CODES = [0xe0001, 0xe0041, 0xe007f, 0x180e, 0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x061c, 0x200b, 0x200c, 0x200d, 0x2060, 0xd800, 0xdfff, 0x0301]
const KEY = ['sk', '-', 'A7b8C9d0E1'.repeat(3)].join('')
const POSITIONS = [3, 13, 23]
const wire = (op: Operation, result: unknown) => {
  const parsed = parseResponse(op, JSON.stringify({ v: 1, ok: true, result }))
  if (parsed.kind === 'unknown' || parsed.kind === 'error') throw new Error(`Не достигнута поверхность ${op}: ${parsed.kind}`)
  return parsed
}
const task = (text: string) => ({ ...TASK, title: text, description: text, acceptance: [text], constraints: [text],
  steps: [{ position: 0, title: text, status: 'pending' }], sourcePhrase: text })
const readTask = (text: string) => {
  const parsed = wire('task.get', { task: task(text) })
  if (parsed.kind !== 'task') throw new Error('Не получена задача')
  return parsed.task
}
const readSummary = (text: string) => {
  const parsed = wire('snapshot', { ...snapshot(null), tasks: [task(text)] })
  if (parsed.kind !== 'snapshot') throw new Error('Не получен снимок')
  return parsed.snapshot.tasks[0]!
}
const readContext = (text: string) => {
  const parsed = wire('tasks.context', { binding: snapshot().binding, current: { ...task(text),
    ownerNotes: [{ ...CHECKPOINT, text }], ownerComments: [{ commentId: 'comment-1', text, revision: 0, createdAt: TASK.createdAt, updatedAt: TASK.createdAt }],
    agentNotes: [{ noteId: 'note-1', taskId: TASK.taskId, kind: 'note', text, source: 'agent', provenance: 'tool', createdAt: TASK.createdAt }] },
    queue: [], deferred: [], closed: [], ownerChanges: [], cursor: 0,
    counts: { total: 1, open: 1, active: 1, queued: 0, deferred: 0, done: 0, cancelled: 0, closedLast24h: 0, projectOpen: 1 } })
  if (parsed.kind !== 'context') throw new Error('Не получен контекст')
  return parsed.context
}

// Эти места аудита не искали секреты до исправления. Они сохраняют прежнюю границу:
// снять теги, очистить управление, проверить форму либо восстановить черновик владельца.
const surfaces: { name: string; filters: boolean; show: (text: string) => string }[] = [
  { name: 'privacy.redactSecrets', filters: true, show: redactSecrets },
  { name: 'privacy.stripPastedContent', filters: false, show: stripPastedContent },
  { name: 'text.line', filters: false, show: line },
  { name: 'title.cleanTitle', filters: false, show: text => cleanTitle(text) ?? '' },
  { name: 'rpc.cleanTask.title', filters: false, show: text => readTask(text).title },
  { name: 'rpc.cleanTask.body', filters: true, show: text => { const item = readTask(text); return JSON.stringify([item.description, item.acceptance, item.constraints]) } },
  { name: 'rpc.cleanSummary.title/steps/sourcePhrase', filters: false, show: text => { const item = readSummary(text); return JSON.stringify([item.title, item.steps, item.sourcePhrase]) } },
  { name: 'rpc.cleanInbox', filters: false, show: text => { const item = wire('inbox.triage', { ...ENTRY, preview: text }); return item.kind === 'triaged' ? item.entry.preview ?? '' : '' } },
  { name: 'rpc.cleanCheckpoint', filters: false, show: text => { const item = wire('checkpoint.list', { taskId: TASK.taskId, taskRevision: 0, checkpoints: [{ ...CHECKPOINT, text }] }); return item.kind === 'timeline' ? item.checkpoints[0]!.text : '' } },
  { name: 'rpc.cleanGateObservation', filters: false, show: text => { const item = wire('gate.check', { bound: 'created', task: TASK, focusRevision: 0, gate: gateSummary('observe'), observation: { ...OBSERVATION, resource: { ...OBSERVATION.resource, path: text } } }); return item.kind === 'gated' ? item.observation?.resource.path ?? '' : '' } },
  { name: 'rpc.cleanOwnerComment', filters: true, show: text => readContext(text).current!.ownerComments![0]!.text },
  { name: 'rpc.cleanAgentNote', filters: true, show: text => readContext(text).current!.agentNotes[0]!.text },
  { name: 'rpc.cleanContextEntry', filters: true, show: text => readContext(text).current!.title },
  { name: 'rpc.cleanSearchSnippet', filters: true, show: text => { const item = wire('tasks.search', { offset: 0, limit: 20, truncated: false, lists: { queue: { total: 1, rows: [{ ...TASK, priorityPinned: false, match: { field: 'description', snippet: text } }] } } }); return item.kind === 'search' ? item.search.lists.queue!.rows[0]!.match.snippet : '' } },
  { name: 'rpc.cleanTaskContext', filters: true, show: text => JSON.stringify(readContext(text)) },
  { name: 'task-loop.cleanTaskText', filters: true, show: cleanTaskText },
  { name: 'task-loop.clipWords', filters: true, show: text => clipWords(text, 300) },
  { name: 'owner.text.clean', filters: false, show: clean },
  { name: 'owner.text.printable', filters: false, show: text => printable(text, 80) },
  { name: 'owner.tasks.looksSecret', filters: true, show: text => looksSecret(text) ? '' : text },
  { name: 'owner.tasks.looksSecretInDraft', filters: true, show: text => looksSecretInDraft(text) ? '' : text },
  { name: 'owner.tasks.parseAsk', filters: false, show: text => { const item = parseAsk({ title: text, why: text, done_when: text, kind: 'do' }); return 'error' in item ? '' : JSON.stringify(item) } },
  { name: 'owner.project.restored', filters: false, show: text => JSON.stringify(adopt({ nextId: 2, sessions: { old: { seenMs: 0, endedMs: 0, tasks: [{ id: 1, sessionId: 'old', kind: 'do', state: 'open', update: 'none', title: text, why: text, doneWhen: text, answer: text, createdMs: 0, updatedMs: 0 }] } } }, 'now', 1).adopted) },
  { name: 'work-history.cleanWorkText', filters: false, show: cleanWorkText },
  { name: 'work-trail.cleanTrailText', filters: true, show: cleanTrailText },
  { name: 'task-search-panel.cleanSearchText', filters: true, show: cleanSearchText },
]

const leaks = (text: string) => text.includes(KEY.slice(3, 13)) || text.includes(KEY.slice(13, 23))
test('Матрица аудита: 26 мест, 18 кодов, три позиции; 13 прежних фильтров', () => {
  expect(surfaces).toHaveLength(26)
  expect(CODES).toHaveLength(18)
  expect(surfaces.filter(item => item.filters)).toHaveLength(13)
})
for (const surface of surfaces) for (const at of POSITIONS) test(`Невидимые вставки: ${surface.name}, позиция ${at}, ${surface.filters ? 'скрывает' : 'прежняя граница'}`, () => {
  expect(surface.show('Безопасный текст')).toContain('Безопасный текст')
  expect(leaks(surface.show(KEY))).toBe(!surface.filters)
  const failed: string[] = []
  for (const code of CODES) {
    const input = KEY.slice(0, at) + String.fromCodePoint(code) + KEY.slice(at)
    const actual = leaks(surface.show(input))
    const rejectedByShape = !surface.filters && ['owner.tasks.parseAsk', 'owner.project.restored'].includes(surface.name) && [0xd800, 0xdfff, 0x0301].includes(code)
    if (actual !== (!surface.filters && !rejectedByShape)) failed.push(`U+${code.toString(16)}`)
  }
  expect(failed.join(' ')).toBe('')
})

test('Восстановленный ответ владельца остаётся дословным черновиком', () => {
  const answer = KEY.slice(0, 13) + String.fromCodePoint(0xe0001) + KEY.slice(13)
  const read = adopt({ nextId: 2, sessions: { old: { seenMs: 0, endedMs: 0, tasks: [{ id: 1, sessionId: 'old', kind: 'answer', state: 'done', update: 'none', title: 'Дай ответ', why: 'Продолжить работу', answer, createdMs: 0, updatedMs: 0 }] } } }, 'now', 1)
  expect(read.drafts.get(1)).toBe(answer)
})

test('Секрет маскируется до усечения исходного префикса', () => {
  const input = 'Начало ' + KEY.slice(0, 13) + String.fromCodePoint(0x180e) + KEY.slice(13) + ' ПОЗДНИЙ ХВОСТ'
  const shown = redactSecrets(input, 20)
  expect(leaks(shown)).toBe(false)
  expect(shown).not.toContain('ПОЗДНИЙ')
})

test('Маскирование сохраняет абзацы, составные буквы, индийское письмо и эмодзи', () => {
  const accent = 'q' + String.fromCodePoint(0x0301)
  const devanagari = String.fromCodePoint(0x0915, 0x093f, 0x0902)
  const emoji = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)
  const text = `Первая строка ${accent} ${devanagari} ${emoji}\n\nВторая строка`
  expect(redactSecrets(text)).toBe(text)
  expect(readTask(text).description).toBe(text)
})

test('Очистка безопасного текста не требует согласия на отправку секрета', () => {
  for (const code of CODES) expect(hasSecrets('Обычный' + String.fromCodePoint(code) + ' текст')).toBe(false)
  expect(hasSecrets('Две\r\nстроки\tи табуляция')).toBe(false)
  const text = 'q' + String.fromCodePoint(0x0301) + ' ' + String.fromCodePoint(0x0915, 0x093f, 0x0902, 0x1f469, 0x200d, 0x1f4bb)
  expect(hasSecrets(text)).toBe(false)
  expect(looksSecretInDraft(text)).toBe(false)
})

test('Раздельный вид находит ключ между словами, слитный — внутри тела ключа', () => {
  for (const code of CODES) {
    const char = String.fromCodePoint(code)
    for (const text of ['слово' + char + KEY + char + 'конец', KEY.slice(0, 13) + char + KEY.slice(13)]) {
      expect(leaks(redactSecrets(text))).toBe(false)
      expect(hasSecrets(text)).toBe(true)
      expect(looksSecret(text)).toBe(true)
      expect(looksSecretInDraft(text)).toBe(true)
    }
  }
})

test('Восстановление по-прежнему отвергает секретный result, черновик не маскирует', () => {
  for (const code of CODES) {
    const result = KEY.slice(0, 13) + String.fromCodePoint(code) + KEY.slice(13)
    const read = adopt({ nextId: 2, sessions: { old: { seenMs: 0, endedMs: 0, tasks: [{ id: 1, sessionId: 'old', kind: 'answer', state: 'done', update: 'none', title: 'Дай ответ', why: 'Продолжить работу', result, createdMs: 0, updatedMs: 0 }] } } }, 'now', 1)
    expect(read.adopted).toEqual([])
  }
})

// Общий поиск только добавляет к прежнему. Нормализация и очистка укорачивают значение: слоги, записанные частями,
// собираются в один знак, невидимые знаки в хвосте исчезают — и значение уходит под порог шаблона. Версия 0.16.84
// в таком случае возвращала результат общего поиска, и скрытое прежде значение переставало скрываться.
const RAW_ONLY = [
  ['слоги, записанные частями', 'password=' + String.fromCodePoint(0xd55c, 0xae00, 0xbe44, 0xbc00).normalize('NFD'), String.fromCodePoint(0xd55c, 0xae00)],
  ['значение с невидимым хвостом', 'token=abc' + String.fromCodePoint(0x200b).repeat(3), '=abc'],
] as const
for (const [name, text, open] of RAW_ONLY) test(`RAW-1 ${name}: скрытое прежним поиском остаётся скрытым`, () => {
  const shown = redactSecrets(text)
  expect(shown).toContain('[REDACTED:assignment]')
  expect(shown.normalize('NFC').includes(open)).toBe(false)
  expect(redactSecrets(text, 300)).toContain('[REDACTED:assignment]')
  expect(hasSecrets(text)).toBe(true)
  expect(cleanTrailText(text)).not.toContain(open)
  expect(cleanSearchText(text).normalize('NFC').includes(open)).toBe(false)
})

const ESC = String.fromCodePoint(27), BEL = String.fromCodePoint(7), CSI = String.fromCodePoint(0x9b)
const PASSWORD = ['hunter', '2'].join('').repeat(2)
const ESC_INPUTS = [
  ['1: CSI съедает первую букву', 'ключ ' + ESC + '[' + KEY + ' конец'],
  ['2: CSI с параметрами перед ключом', 'ключ ' + ESC + '[1;31' + KEY + ' конец'],
  ['3: восьмибитный CSI перед ключом', 'ключ ' + CSI + KEY + ' конец'],
  ['4: незакрытый OSC с ключом', 'ключ ' + ESC + ']0;' + KEY],
  ['5: ключ через закрытие OSC', 'ключ ' + ESC + ']' + KEY.slice(0, 8) + BEL + KEY.slice(8) + ' конец'],
  ['6: цвет внутри ключа', 'ключ ' + KEY.slice(0, 8) + ESC + '[31m' + KEY.slice(8) + ' конец'],
  ['7: CSI съедает начало присваивания', 'x ' + ESC + '[password=' + PASSWORD + ' y'],
] as const
const escapeLeaks = (text: string) => text.includes(PASSWORD)
  || Array.from({ length: KEY.length - 19 }, (_, at) => KEY.slice(at, at + 20)).some(part => text.includes(part))
const escapeSurfaces = [
  ['redactSecrets', redactSecrets], ['cleanSearchText', cleanSearchText], ['cleanTrailText', cleanTrailText],
] as const
for (const [name, text] of ESC_INPUTS) {
  for (const [surface, show] of escapeSurfaces) test(`ESC-1 ${name}: ${surface}`, () => {
    expect(escapeLeaks(show(text))).toBe(false)
  })
  test(`ESC-1 ${name}: hasSecrets`, () => { expect(hasSecrets(text)).toBe(true) })
  test(`ESC-1 ${name}: усечение до 300`, () => {
    const input = text + ' конец префикса ' + 'обычный текст '.repeat(40)
    expect(escapeLeaks(redactSecrets(input, 300))).toBe(false)
    expect(hasSecrets(input)).toBe(true)
  })
  for (const [surface, show] of escapeSurfaces) test(`ESC-1 ${name}: многострочный ${surface}`, () => {
    const input = 'Первая строка\n' + text + '\nПоследняя строка'
    expect(escapeLeaks(show(input))).toBe(false)
    expect(escapeLeaks(redactSecrets(input, 300))).toBe(false)
    expect(hasSecrets(input)).toBe(true)
  })
}
const ESC_ADJACENT = [
  ['CSI и CSI перед ключом', 'ключ ' + ESC + '[31m' + ESC + '[1;31' + KEY + ' конец'],
  ['OSC и CSI перед ключом', 'ключ ' + ESC + ']0;заголовок' + BEL + ESC + '[' + KEY + ' конец'],
  ['CSI и OSC внутри ключа', 'ключ ' + KEY.slice(0, 8) + ESC + '[31m' + ESC + ']0;цвет' + ESC + '\\' + KEY.slice(8) + ' конец'],
  ['OSC и CSI внутри ключа', 'ключ ' + ESC + ']' + KEY.slice(0, 8) + BEL + ESC + '[31m' + KEY.slice(8) + ' конец'],
  ['CSI и восьмибитный CSI', 'ключ ' + ESC + '[31m' + CSI + KEY + ' конец'],
] as const
for (const [name, text] of ESC_ADJACENT) test(`ESC-1 две последовательности подряд: ${name}`, () => {
  for (const [, show] of escapeSurfaces) expect(escapeLeaks(show(text))).toBe(false)
  expect(escapeLeaks(redactSecrets(text, 300))).toBe(false)
  expect(hasSecrets(text)).toBe(true)
})

for (const index of [1, 4]) test(`ESC-1 вход ${index + 1}: privacy возвращает маску вместо исходника`, () => {
  const input = ESC_INPUTS[index]![1], raw = redactRawSecrets(input)
  const masked = secretText.mask(input, { multiline: true })
  expect(raw).toBe(input)
  expect(masked).toContain('[REDACTED:api_key]')
  expect(secretText.clean(raw, { multiline: true }) === masked).toBe(false)
  expect(redactSecrets(input)).toBe(masked)
})

const boundaryProbe = createSecretView([['probe', /Z/gu]], text => text.replace(/Z/gu, '[REDACTED:probe]'))
for (const [name, sequence] of [
  ['CSI', ESC + '[1;2Z'], ['восьмибитный CSI', CSI + '1;2Z'],
  ['OSC с BEL', ESC + ']0;доZпосле' + BEL], ['OSC с ESC и обратной косой чертой', ESC + ']0;доZпосле' + ESC + '\\'],
] as const) test(`ESC-1 границы: совпадение внутри ${name} удаляет последовательность целиком`, () => {
  for (const view of ['joined', 'spaced'] as const) {
    expect(boundaryProbe.mask('до ' + sequence + ' после', { view })).toBe('до [REDACTED:probe] после')
    expect(boundaryProbe.mask('до ' + sequence + ' после', { view, multiline: true, maxCodePoints: 300 })).toBe('до [REDACTED:probe] после')
  }
})

for (const [name, text] of ESC_INPUTS) test(`ESC-1 ${name}: секрет пересекает границу усечения`, () => {
  const input = 'a '.repeat(130) + text + ' ПОЗДНИЙ ХВОСТ'
  const shown = redactSecrets(input, 280)
  expect(escapeLeaks(shown)).toBe(false)
  expect(shown.includes(KEY.slice(0, 8))).toBe(false)
  expect(shown).not.toContain('ПОЗДНИЙ')
  expect(hasSecrets(input)).toBe(true)
})

for (const [name, sequence] of [
  ['CSI', ESC + '[31m'], ['восьмибитный CSI', CSI + '31m'],
  ['OSC с BEL', ESC + ']0;заголовок' + BEL], ['OSC с ESC и обратной косой чертой', ESC + ']0;заголовок' + ESC + '\\'],
] as const) test(`ESC-1 clean без секретов сохраняет прежний показ: ${name}`, () => {
  const input = 'до' + sequence + 'после'
  expect(secretText.clean(input)).toBe('допосле')
  expect(secretText.clean(input, { view: 'spaced' })).toBe('до после')
  expect(secretText.clean(input, { multiline: true })).toBe('допосле')
  expect(redactSecrets(input)).toBe(input)
  expect(hasSecrets(input)).toBe(false)
})

test('ESC-1 NFC, CRLF и табуляция сохраняют позиции исходника при замене OSC', () => {
  const prefix = 'q' + String.fromCodePoint(0x0301) + ' a' + String.fromCodePoint(0x0301) + '\r\n\t'
  const input = prefix + ESC + ']0;доZпосле' + BEL + '\r\nконец'
  expect(boundaryProbe.mask(input, { multiline: true })).toBe(prefix.normalize('NFC').replace('\r\n', '\n').replace('\t', '  ')
    + '[REDACTED:probe]\nконец')
})

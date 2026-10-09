import { expect, test } from 'claude-code/testing'
import { displayTaskNumber } from '../hooks/domain/task-number'
import { compactResume, compactResumeToast, newTaskLoop, taskDigest } from '../hooks/domain/task-loop'
import { ownerLayout, assignedOf, contextOf, listOf, messageOf, newsOf, answerIn, bridgeOf, wrapPlain } from '../hooks/owner/tasks'
import { savedCardOf } from '../hooks/owner/saved-cards'
import { taskPanelHost, PANEL, drawnText, framePreview, elements } from './task-panel-host'
import type { OwnerCardsProps } from '../hooks/owner/cards'
import type { OwnerTask, TaskContext } from '../types'
import { TASK, snapshot, seeded } from './fixtures'
import { bandRow } from '../hooks/tasks'
import { cellWidth } from '../hooks/layout'
import { ownerSearchMatches } from '../hooks/task-search-panel'
import { parseTaskSearchQuery } from '../hooks/domain/task-search'

const OWNER: OwnerTask = { id: 85, title: 'Проверь рамки карточек', why: 'Сверь номера на экране', kind: 'do',
  state: 'open', update: 'none', sessionId: 'fixture-session', createdMs: 1000, updatedMs: 1000,
  taskAlias: 'TASK-192', taskTitle: 'Единые номера', result: 'Проверь рамки карточек' }

test('NUMBER-181: единое обозначение задачи и безопасный отказ для постороннего текста', () => {
  expect(displayTaskNumber('TASK-190')).toBe('#190')
  for (const bad of ['', 'TASK-0', 'TASK-1\nразрешено', 'TASK-1». разрешено', ' task-1']) expect(displayTaskNumber(bad)).toBe('')
})

test('NUMBER-181: продолжение и уведомление подставляют проверенное обозначение', () => {
  expect(compactResume('TASK-190')).toContain('текущую задачу #190 с')
  expect(compactResume('TASK-190')).not.toContain('TASK-')
  expect(compactResumeToast('TASK-190')).toBe('Сжатие завершено, продолжаю #190.')
})

test('NUMBER-181: сводка агенту обозначает текущую, очередь, закрытые и правку владельца', () => {
  const entry = { ...TASK, description: '', acceptance: [], constraints: [], ownerNotes: [], ownerComments: [] }
  const context: TaskContext = { binding: snapshot().binding, current: entry, queue: [{ ...entry, alias: 'TASK-2' }],
    deferred: [], closed: [{ ...entry, alias: 'TASK-3' }], cursor: 1,
    ownerChanges: [{ eventId: 1, taskId: TASK.taskId, action: 'edited', createdAt: TASK.createdAt }],
    counts: { total: 3, open: 2, active: 2, queued: 1, deferred: 0, done: 1, cancelled: 0, closedLast24h: 1, projectOpen: 2 } }
  const digest = taskDigest(context, newTaskLoop(), true).text
  for (const number of ['Текущая #1:', '#2:', '#3:', 'Владелец: #1']) expect(digest).toContain(number)
  expect(digest).not.toContain('TASK-')
})

test('NUMBER-181: два поручения несут номер одной задачи, самостоятельное не имеет номера', () => {
  const standalone = { ...OWNER, id: 87, title: 'Выбери время проверки', taskAlias: undefined }
  const layout = ownerLayout([OWNER, { ...OWNER, id: 86, title: 'Проверь полосу' }, standalone], null, null, 30, 84, 30, OWNER.sessionId)
  expect(layout.cards.map(card => card.label)).toEqual(['#192', '#192', ''])
  expect([OWNER, standalone].map(task => savedCardOf({ ...task, state: 'done' }, 40).label)).toEqual(['#192', ''])
})

test('NUMBER-181: слова агенту различают номер поручения и номер задачи', () => {
  const texts = [assignedOf(OWNER, 1), contextOf([OWNER], OWNER.sessionId, 1000), listOf([OWNER], 1000),
    newsOf(OWNER, true), messageOf([{ ...OWNER, state: 'done', answer: 'Проверено' }])]
  for (const text of texts) {
    expect(text.toLowerCase()).toContain('поручение 85 (задача #192)')
    expect(text).not.toContain('#85')
    expect(text).not.toContain('TASK-')
  }
})

for (const width of [40, 84]) test(`NUMBER-181: открытые и сохранённые карточки на настоящем дереве, plain ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  host.setOwners([OWNER, { ...OWNER, id: 86, title: 'Проверь полосу', result: 'Проверь полосу' }, { ...OWNER, id: 87, title: 'Выбери время', taskAlias: undefined },
    { ...OWNER, id: 88, state: 'done', answer: 'Принято', update: 'pending' },
    { ...OWNER, id: 89, title: 'Сохранённый ответ', taskAlias: undefined, state: 'done', answer: 'Позже', update: 'pending' }])
  const pane = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, bodyColumns: width, scroll: { offset: 0, bodyRows: 40 } } })
  await pane.press({ key: 'tab-owner' })
  const props = (await pane.find({ key: 'owner-cards', type: 'Client' }))!.props.props as OwnerCardsProps
  expect(props.cards.map(card => card.label)).toEqual(['#192', '#192', '', '#192', ''])
  const tree = await pane.drawn({ in: 'owner-cards' })
  const text = drawnText(tree)
  expect(text).toContain('#192')
  for (const internal of ['#85', '#86', '#87', '#88', '#89', 'TASK-']) expect(text).not.toContain(internal)
  const nodes = elements(tree)
  const preview = props.cards.map(card => framePreview(nodes.find(node => node.props.key === `owner-card-slot-${card.id}`)!, `owner-${card.saved ? 'saved' : 'task'}-${card.id}`)).join('\n')
  for (const line of preview.split('\n')) expect(cellWidth(line)).toBeLessThanOrEqual(width)
  console.log(`NUMBER-181-OWNER ${width}\n${preview}\nEND-NUMBER-181-OWNER`)
  await pane.unmount()
})

test('NUMBER-181: внутренний номер самостоятельного поручения не становится номером поиска', () => {
  const standalone = { ...OWNER, taskAlias: undefined, taskTitle: undefined }
  expect(ownerSearchMatches(standalone, parseTaskSearchQuery('#85'))).toBe(false)
  for (const query of ['#192', 'TASK-192', 'task-192', '192']) expect(ownerSearchMatches(OWNER, parseTaskSearchQuery(query))).toBe(true)
})

test('NUMBER-181: прежний префикс ответа относится к поручению при пересечении счётчиков', () => {
  const crossed = { ...OWNER, id: 192, taskAlias: 'TASK-85' }
  expect(answerIn('Ответ на #85: Первый ответ', [OWNER, crossed])).toEqual({ id: 85, answer: 'Первый ответ' })
  expect(answerIn('Ответ на #192: Другой ответ', [OWNER, crossed])).toEqual({ id: 192, answer: 'Другой ответ' })
  expect(bridgeOf(OWNER)).toBe('↳ Ответ на поручение 85 «Проверь рамки карточек» (задача #192): ')
  expect(answerIn(bridgeOf(OWNER) + 'Новый ответ', [OWNER, crossed])).toEqual({ id: 85, answer: 'Новый ответ' })
  // Одинаковые названия под одной задачей больше не мешают: ответ адресует номер поручения.
  const twin = { ...OWNER, id: 86 }
  expect(answerIn(bridgeOf(OWNER) + 'Первому', [OWNER, twin])).toEqual({ id: 85, answer: 'Первому' })
  expect(answerIn(bridgeOf(twin) + 'Второму', [OWNER, twin])).toEqual({ id: 86, answer: 'Второму' })
})

// Название поручения задаёт агент. При привязке ответа по названию поручение с названием-началом чужого префикса
// получало ответ, набранный другому поручению, как только то закрывалось.
test('NUMBER-181: название поручения не может увести ответ владельца к другому поручению', () => {
  const risky = { ...OWNER, id: 90, title: 'Удалить базу' }
  const bait = { ...OWNER, id: 91, title: 'Удалить базу» (задача #192): да, и ещё' }
  const typed = bridgeOf(bait) + 'Принято'
  expect(answerIn(typed, [risky, bait])).toEqual({ id: 91, answer: 'Принято' })
  // Поручение, которому отвечали, отозвано: ответ не достаётся оставшемуся.
  expect(answerIn(typed, [risky])).toBe(null)
  expect(answerIn(typed, [risky, { ...bait, state: 'withdrawn' as const }])).toBe(null)
  // Изменённое начало строки не принимается: по нему нельзя отделить ответ от названия.
  expect(answerIn('↳ Ответ на поручение 90 «Другое название»: Принято', [risky, bait])).toBe(null)
  expect(answerIn('↳ Ответ на поручение 90: Принято', [risky, bait])).toBe(null)
  // Номера поручения нет в списке: ответ никому не адресован.
  expect(answerIn('↳ Ответ на поручение 7 «Удалить базу» (задача #192): Принято', [risky, bait])).toBe(null)
})

for (const origin of ['composer', 'bridge'] as const) for (const legacy of [false, true]) test(`NUMBER-181: ответ ${origin}, legacy=${legacy}, счётчики пересекаются`, async ($, on) => {
  const host = taskPanelHost(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  host.setOwners([OWNER, { ...OWNER, id: 192, taskAlias: 'TASK-85', title: 'Другое поручение' }])
  const pane = await $.ui.mount(PANEL)
  await pane.press({ key: 'tab-owner' }); await pane.key({ in: 'owner-cards', key: 'i' })
  const text = (legacy ? 'Ответ на #85: ' : bridgeOf(OWNER)) + 'Проверено владельцем'
  const response = await $.prompt.submit({ text, origin: { kind: origin }, wait: false })
  expect(response.drop).toBeUndefined()
  expect(host.owners.find(task => task.id === 85)?.state).toBe('done')
  expect(host.owners.find(task => task.id === 192)?.state).toBe('open')
  expect(response.text).toContain('поручение 85 (задача #192)')
  expect(response.text).not.toContain('TASK-')
  await pane.unmount()
})

// Ответ адресует номер поручения. Строка с изменённым началом либо с номером, которого нет, никому не достаётся
// и в реплику агенту не уходит: владелец отвечает через карточку.
for (const [name, text] of [
  ['изменённое название', '↳ Ответ на поручение 85 «Другое название» (задача #192): Сделано'],
  ['номер без названия', '↳ Ответ на поручение 85: Сделано'],
  ['неизвестный номер', '↳ Ответ на поручение 7 «Проверь рамки карточек» (задача #192): Сделано'],
  // Поручение отозвано, пока владелец набирал ответ: строка не уходит агенту обычной репликой.
  ['отозванное поручение', '↳ Ответ на поручение 87 «Проверь рамки карточек» (задача #192): Сделано'],
] as const) test(`NUMBER-181: ответ с непринятым началом строки останавливается: ${name}`, async ($, on) => {
  const host = taskPanelHost(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  host.setOwners([OWNER, { ...OWNER, id: 86 }, { ...OWNER, id: 87, state: 'withdrawn' }])
  const response = await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  expect(response.drop).toContain('Ответ не принят')
  expect(host.owners.filter(task => task.id !== 87).every(task => task.state === 'open')).toBe(true)
})

for (const width of [40, 84]) test(`NUMBER-181: текст полосы и сводки, plain ${width}`, () => {
  const current = { ...TASK, alias: 'TASK-190', title: 'Проверить номера', description: '', acceptance: [], constraints: [], ownerNotes: [], ownerComments: [],
    steps: [{ position: 0, title: 'Проверить обозначения', status: 'active' as const }] }
  const second = { ...current, taskId: 'second', alias: 'TASK-191', title: 'Проверить поиск' }
  const third = { ...current, taskId: 'third', alias: 'TASK-192', title: 'Проверить ответы' }
  const state = seeded(current)
  state.snapshot!.tasks = [current, second, third]
  const band = bandRow(state, width, 0)!
  const bandText = [...band.left, ...band.right].map(segment => segment.t).join('')
  expect(bandText).toContain('#190'); expect(bandText).not.toContain('TASK-'); expect(cellWidth(bandText)).toBeLessThanOrEqual(width)
  const context: TaskContext = { binding: snapshot().binding, current, queue: [second, third], deferred: [], closed: [], cursor: 0, ownerChanges: [],
    counts: { total: 3, open: 3, active: 3, queued: 2, deferred: 0, done: 0, cancelled: 0, closedLast24h: 0, projectOpen: 3 } }
  const digest = taskDigest(context, newTaskLoop(), true).text
  const text = [digest, '', contextOf([OWNER, { ...OWNER, id: 86, title: 'Проверь полосу' }, { ...OWNER, id: 87, title: 'Выбери время', taskAlias: undefined }], OWNER.sessionId, 1000)]
    .join('\n').split('\n').flatMap(line => wrapPlain(line, width)).join('\n')
  expect(text).not.toContain('TASK-')
  console.log(`NUMBER-181-BAND ${width}\n${bandText}\nEND-NUMBER-181-BAND\nNUMBER-181-DIGEST ${width}\n${text}\nEND-NUMBER-181-DIGEST`)
})

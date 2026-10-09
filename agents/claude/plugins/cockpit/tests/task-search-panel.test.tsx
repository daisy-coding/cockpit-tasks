import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderChildren, RenderElement, RenderPropsOf } from 'claude-code'
import type { Mounted } from 'claude-code/testing'
import type { OwnerTask, Projection, Task, TaskSearch, TaskSearchRow } from '../types/index'
import type { Request } from '../hooks/domain/rpc'
import type { TaskCardsProps } from '../hooks/tasks'
import type { TaskTabsProps } from '../hooks/task-tabs'
import { tabSpans } from '../hooks/task-tabs'
import { DEFAULT_THEME, roleColors } from '../hooks/theme'
import type { OwnerCardsProps } from '../hooks/owner/cards'
import { acceptSearch, newSearchPanel, ownerSearchMatches, ownerShownTitle, searchRows, searchSnippet } from '../hooks/task-search-panel'
import { parseTaskSearchQuery } from '../hooks/domain/task-search'
import type { PanelActionsProps } from '../hooks/panel-actions'
import { cellWidth, truncateCells } from '../hooks/layout'
import { seeded, snapshot, TASK, reply } from './fixtures'

const PANE: RenderPropsOf['Pane'] = { title: 'Задачи', isFocused: true, bodyColumns: 84, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} }
const first: Task = { ...TASK, alias: 'TASK-191', stage: 'task', certainty: 'confirmed', certaintySource: 'user', title: 'Поиск панели', description: 'Первое описание', steps: [], lastCheckpoint: null }
const second: Task = { ...first, taskId: 'search-second', alias: 'TASK-192', title: 'Проверить выдачу', description: 'Поиск по описанию' }
const closed: Task = { ...first, taskId: 'search-closed', alias: 'TASK-193', title: 'Поиск в истории', status: 'done' }
const entry = (task: Task, field: TaskSearchRow['match']['field'] = 'title'): TaskSearchRow => ({ taskId: task.taskId, alias: task.alias, title: task.title,
  status: task.status, updatedAt: task.updatedAt, priorityPinned: false, match: { field, snippet: field === 'title' ? task.title : task.description! } })
const answer = (queue = [entry(first), entry(second, 'description')], history = [entry(closed)], total = history.length): TaskSearch => ({ offset: 0, limit: 50, truncated: false,
  lists: { queue: { total: queue.length, rows: queue }, deferred: { total: 0, rows: [] }, closed: { total, rows: history } } })
const wire = (result: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify({ v: 1, ok: true, result }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function host(on: On, search: (request: Request) => unknown | Promise<unknown> = () => wire(answer()), owners: OwnerTask[] = [], otherTasks: Task[] = []) {
  mock.store(on); mock.env(on, { HOME: '/fixture-home' })
  const clock = mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  const live = { ...snapshot(first), tasks: [first, second, closed] }
  let state: Projection = { ...seeded(first), snapshot: live }, version = 1
  const calls: Request[] = [], statuses: string[] = [], writes: string[] = [], focuses: string[] = []
  on('session.id', () => ({ value: 'fixture-session' }))
  on('session.cwd', () => ({ value: '/fixture' }))
  on('state.get', { plugin: 'cockpit', key: 'projection' }, () => ({ value: { value: state, version } }))
  on('state.set', { plugin: 'cockpit', key: 'projection' }, (_$, e) => { state = e.value; version++; writes.push(JSON.stringify(e.value)); return { value: { isSet: true, version } } })
  on('state.get', { plugin: 'cockpit', key: 'ownerTasks' }, () => ({ value: { value: owners, version: 1 } }))
  on('process.run', async (_$, e) => {
    if (!e.init?.stdin) return { value: { exitCode: 0, stdout: 'missing', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const request: Request = JSON.parse(e.init.stdin); calls.push(request)
    if (request.op === 'tasks.search') return await search(request)
    if (request.op === 'task.get') return wire({ task: [first, second, closed, ...otherTasks].find(task => task.taskId === request.args.taskId) ?? first, comments: [], agentNotes: [] })
    if (request.op === 'tasks.context') return wire({ binding: live.binding, current: null, queue: [], deferred: [], closed: [closed], ownerChanges: [], cursor: 0,
      counts: { total: 3, open: 2, active: 2, queued: 2, deferred: 0, done: 1, cancelled: 0, closedLast24h: 1, projectOpen: 2 } })
    if (request.op === 'snapshot' || request.op === 'session.rebind') return wire(live)
    return { value: { exitCode: 0, stdout: reply(request), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_$, e) => { statuses.push(e.text ?? ''); return { value: undefined } })
  on('ui.toast', () => { throw new Error('Поиск не показывает тосты') })
  on('ui.focus', (_$, e) => { focuses.push(e.key ?? e.element ?? ''); return { value: {} } })
  on('model.complete', () => { throw new Error('Поиск не вызывает модель') })
  return { clock, calls, statuses, writes, focuses }
}
function text(node: RenderChildren): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  if (!node || typeof node !== 'object' || !('type' in node)) return ''
  if (node.type === 'Box' && node.props?.display === 'none') return ''
  return node.type === 'Button' ? node.props.label ?? '' : 'children' in node ? text(node.children) : ''
}
function nodes(node: RenderChildren): RenderElement[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !('type' in node)) return []
  return [node, ...('children' in node ? nodes(node.children) : [])]
}
async function tab(pane: Mounted<'terminal', 'Pane'>, id: string) {
  const props = (await pane.find({ key: 'tabs' }))!.props.props as TaskTabsProps
  const span = tabSpans(props).find(item => item.tab.id === id)!
  await pane.pointer({ in: 'tabs', type: 'up', button: 'left', x: span.left + 1, y: 0 })
}
async function open(pane: Mounted<'terminal', 'Pane'>) {
  await pane.key({ in: 'rows', key: '/' })
  expect((await pane.find({ key: 'task-search-input' }))?.props.placeholder).toBe('Поиск задач')
}

// Текстовый вид из данных настоящей отрисовки: рамки и видимое окно без проверки краски терминала.
async function textView(pane: Mounted<'terminal', 'Pane'>, width: number, name: string): Promise<void> {
  const tabs = (await pane.find({ key: 'tabs' }))!.props.props as TaskTabsProps
  const cards = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
  // Поле набранное не повторяет: запрос читается из ключа окна выдачи.
  const query = (cards.windowKey ?? '').split(':').slice(2).join(':')
  const header = (await pane.find({ key: 'panel-header' }))!.props.props as PanelActionsProps
  const controls = header.actions.filter(action => !action.hidden).map(action => action.label).join('  ')
  const pad = (value: string, cells: number) => truncateCells(value, cells) + ' '.repeat(Math.max(0, cells - cellWidth(truncateCells(value, cells))))
  const lines = ['─'.repeat(width), tabSpans(tabs).map(span => `${' '.repeat(span.padding)}${span.tab.label}${' '.repeat(span.padding)}`).join(' '),
    ' '.repeat(Math.max(0, width - cellWidth(controls) - 1)) + controls + ' ', pad(`/ ${query}`, width - 1) + '×']
  const body: string[] = []
  for (const row of cards.rows) {
    if (row.kind === 'card') {
      const number = ` ${row.number} `
      body.push('╭─' + number + '─'.repeat(Math.max(0, row.width - cellWidth(number) - 3)) + '╮')
      for (const line of [...row.titleLines, ...(row.search?.snippet ? [row.search.snippet] : []), ...row.context]) body.push('│' + pad(line, row.innerWidth) + '│')
      body.push('╰' + '─'.repeat(Math.max(0, row.width - 2)) + '╯')
    } else if (row.kind === 'heading') body.push(row.label)
    else if (row.kind === 'day') body.push(row.label)
    else if (row.kind === 'empty') body.push(...(row.lines ?? [row.text]))
    else if (row.kind === 'gap') body.push(...Array.from({ length: row.height }, () => ''))
  }
  lines.push(...body.slice(Math.max(0, -cards.top), Math.max(0, -cards.top) + (cards.viewportHeight ?? cards.height)))
  console.log(JSON.stringify({ searchView: name, width, lines: lines.map(line => truncateCells(line, width)), offset: cards.offset }))
}

for (const width of [40, 84]) test(`Поиск: общий запрос, счётчики, отрывок и пустая вкладка на ${width} колонках`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = host(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  await open(pane)
  await pane.input({ key: 'task-search-input', text: 'поиск', kind: 'change' })
  await fixture.clock.advance(150); await pane.redraw()
  expect(fixture.calls.filter(call => call.op === 'tasks.search').map(call => call.args)).toEqual([{ query: 'поиск', lists: ['queue', 'deferred', 'closed'], limit: 50, offset: 0 }])
  const tabs = (await pane.find({ key: 'tabs' }))!.props.props as TaskTabsProps
  expect(tabs.tabs.map(item => item.label)).toEqual(['Агенту 2', 'Мне 0', 'Бэклог 0', 'История 1'])
  expect(tabs.tabs.filter(item => item.dimmed).map(item => item.id)).toEqual(['owner', 'backlog'])
  const drawn = await pane.drawn({ in: 'rows' })
  expect(text(drawn)).toContain('Поиск по описанию')
  expect(text(drawn)).not.toContain('описание:')
  expect(nodes(drawn).some(node => node.type === 'Text' && node.props.color === roleColors(DEFAULT_THEME).accent && text(node).toLowerCase() === 'поиск')).toBe(true)
  await textView(pane, width, 'agent')
  await tab(pane, 'backlog')
  expect(text(await pane.drawn({ in: 'rows' }))).toContain('Здесь совпадений нет. Есть в других вкладках.')
  expect(await pane.find({ key: 'task-search-clear' })).toBeDefined()
  await textView(pane, width, 'empty-tab')
  expect(fixture.writes.some(value => value.includes('"query"'))).toBe(false)
  await pane.unmount()
})

test('Поиск: поздний ответ старого запроса не меняет новую выдачу и счётчики', { options: { glyphs: 'plain' } }, async ($, on) => {
  let release!: (value: unknown) => void, started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<unknown>(resolve => { release = resolve })
  const fixture = host(on, request => {
    if (request.op === 'tasks.search' && request.args.query === 'старый') { started(); return held }
    return wire(answer([entry(second)], []))
  })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'старый', kind: 'change' })
  const advancing = fixture.clock.advance(150)
  await ready
  await pane.input({ key: 'task-search-input', text: 'новый', kind: 'change' })
  await fixture.clock.advance(150); await pane.redraw()
  expect(text(await pane.drawn({ in: 'rows' }))).toContain(second.title)
  release(wire(answer()))
  await advancing; await pane.redraw()
  const props = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
  expect(props.rows.filter(row => row.kind === 'card').map(row => row.taskId)).toEqual([second.taskId])
  expect(fixture.statuses).toHaveLength(0)
  await pane.unmount()
})

for (const glyphs of ['plain', 'nerd'] as const) test(`Поиск: поле видно и активно сразу, значок поиска вместо «/», лупы в шапке нет: ${glyphs}`, { options: { glyphs } }, async ($, on) => {
  const fixture = host(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const header = (await pane.find({ key: 'panel-header' }))!.props.props as PanelActionsProps
  expect(header.actions.some(action => action.key === 'search')).toBe(false)
  expect(header.hint).toBe('')
  // Поле стоит в панели до любого действия и берёт фокус само, как поиск файлов: открыл вкладку — печатаешь.
  const field = (await pane.find({ key: 'task-search-input' }))!.props
  expect(field).toMatchObject({ placeholder: 'Поиск задач', autoFocus: true })
  expect(field.value).toBeUndefined()
  // Метку родного поля движок рисует с двоеточием, подсказку Enter — рядом с полем: значок стоит отдельным текстом.
  expect(field.label).toBeUndefined()
  expect(field.submitLabel).toBe('')
  expect(text((await pane.find({ key: 'task-search-icon' })) as never)).toBe(glyphs === 'plain' ? '⌕ ' : `${String.fromCodePoint(0xf0349)} `)
  await pane.input({ key: 'task-search-input', text: 'поиск', kind: 'change' })
  // Крестик очистки стоит в потоке строки после поля: две ячейки, последняя — отступ от края панели.
  expect((await pane.find({ key: 'task-search-clear-slot' }))?.props).toMatchObject({ width: 2, height: 1 })
  expect((await pane.find({ key: 'task-search-clear-slot' }))?.props.position).toBeUndefined()
  await $.ui.focus({ plugin: 'cockpit', component: 'Pane', requestId: 'tasks', origin: { kind: 'person' } })
  await pane.redraw()
  expect((await pane.find({ key: 'task-search-input' }))?.props.value).toBe('')
  await $.ui.focus({ plugin: 'cockpit', component: 'Pane', requestId: 'tasks', origin: { kind: 'person' } })
  await pane.redraw()
  // Второй Esc поля не закрывает: оно часть панели.
  expect((await pane.find({ key: 'task-search-input' }))?.props.value).toBe('')
  await fixture.clock.advance(200)
  expect(fixture.calls.filter(call => call.op === 'tasks.search')).toHaveLength(0)
  await pane.unmount()
})

const owner = (id: number, overrides: Partial<OwnerTask> = {}): OwnerTask => ({ id, title: `Поручение ${id}`, why: 'Нужно продолжить', doneWhen: 'Проверено', kind: 'do',
  state: 'open', update: 'none', sessionId: 'fixture-session', createdMs: 0, updatedMs: 0, ...overrides })

// Кольцо фокуса панели движок ведёт номером в списке Button, Input и Select по порядку дерева (Claude Code 2.1.293):
// элемент, появившийся перед полем, занимает его номер, и клавиатура уходит из поля в строку ввода агенту.
async function ring(pane: Mounted<'terminal', 'Pane'>): Promise<string[]> {
  return nodes(await pane.drawn()).filter(node => ['Button', 'Input', 'Select'].includes(node.type)).map(node => String(node.props?.key ?? (node as { key?: string }).key))
}
const TYPED = 'поиск по задачам и ещё сорок знаков набора'

for (const target of ['agent', 'owner', 'backlog', 'history'] as const) test(`RING-1 ${target}: набор ${[...TYPED].length} знаков не сдвигает поле в кольце фокуса`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = host(on, () => wire(answer()), [owner(1, { title: 'Поиск владельцу' }), owner(2)])
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  if (target !== 'agent') await tab(pane, target)
  const before = (await ring(pane)).indexOf('task-search-input')
  expect(before).toBeGreaterThanOrEqual(0)
  let typed = ''
  for (const char of TYPED) {
    typed += char
    await pane.input({ key: 'task-search-input', text: typed, kind: 'change' })
    expect((await ring(pane)).indexOf('task-search-input')).toBe(before)
  }
  await fixture.clock.advance(150); await pane.redraw()
  expect((await ring(pane)).indexOf('task-search-input')).toBe(before)
  expect(await pane.find({ key: 'task-search-clear' })).toBeDefined()
  await pane.unmount()
})

// Набранный текст поле хранит у движка, пока мод рисует прежнее значение; другое значение набранное сбрасывает.
// Мод, повторявший набор в value с опозданием на отрисовку, стирал знаки, набранные за это время.
test('FIELD-1: набор не перерисовывает значение поля; очистка рисует другое пустое значение', { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = host(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const value = async () => (await pane.find({ key: 'task-search-input' }))!.props.value
  const base = await value()
  let typed = ''
  for (const char of TYPED) {
    typed += char
    await pane.input({ key: 'task-search-input', text: typed, kind: 'change' })
    expect(await value()).toBe(base)
  }
  await fixture.clock.advance(150); await pane.redraw()
  expect(await value()).toBe(base)
  expect(fixture.calls.filter(call => call.op === 'tasks.search').at(-1)?.args).toMatchObject({ query: TYPED })
  await pane.press({ key: 'task-search-clear' })
  const cleared = await value()
  expect(cleared).not.toBe(base)
  expect(cleared ?? '').toBe('')
  expect(await pane.find({ key: 'task-search-clear' })).toBeUndefined()
  await pane.input({ key: 'task-search-input', text: 'ещё', kind: 'change' })
  expect(await value()).toBe(cleared)
  await pane.press({ key: 'task-search-clear' })
  expect(await value()).not.toBe(cleared)
  expect((await value()) ?? '').toBe('')
  await pane.unmount()
})

test('Поиск: «Мне» отбирает по названию, зачем, приёмке и ответу теми же правилами', () => {
  const query = parseTaskSearchQuery('ёлка пан')!
  for (const field of ['title', 'why', 'doneWhen', 'answer'] as const) {
    expect(ownerSearchMatches(owner(1, { [field]: 'Елка панель' }), query)).toBe(true)
    expect(ownerSearchMatches(owner(1, { [field]: 'Елка' }), query)).toBe(false)
  }
  expect(ownerSearchMatches(owner(7), parseTaskSearchQuery('#7'))).toBe(true)
})

test('Поиск: карточка проверки находится по номеру задачи с рамки и по итогу агента, который служит её названием', () => {
  const review = owner(82, { title: 'Проверить: Конец списка держится', taskAlias: 'TASK-184', taskTitle: 'Держать конец списка', result: 'Конец списка держится при смене ширины' })
  // На рамке карточки стоит номер задачи: по нему её и ищут. Собственный номер поручения владельцу не показан.
  expect(ownerSearchMatches(review, parseTaskSearchQuery('184'))).toBe(true)
  expect(ownerSearchMatches(review, parseTaskSearchQuery('#82'))).toBe(false)
  expect(ownerSearchMatches(review, parseTaskSearchQuery('ширины'))).toBe(true)
  expect(ownerShownTitle(review)).toBe('Конец списка держится при смене ширины')
  expect(ownerShownTitle({ ...review, result: undefined })).toBe('Держать конец списка')
  expect(ownerShownTitle(owner(7))).toBe('Поручение 7')
})

test('Поиск: подсветка в карточке проверки считается по показанному названию', { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = host(on, () => wire(answer()), [owner(82, { title: 'Проверить: Конец списка держится', taskAlias: 'TASK-184', result: 'Конец списка держится при смене ширины' })])
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'ширины', kind: 'change' }); await fixture.clock.advance(150)
  await tab(pane, 'owner')
  const cards = (await pane.find({ key: 'owner-cards' }))!.props.props as OwnerCardsProps
  expect(cards.cards.map(card => [card.id, card.label, card.titleLines.join(' ')])).toEqual([[82, '#184', 'Конец списка держится при смене ширины']])
  // Слово стоит только в итоге: диапазон подсветки попадает на него в показанной строке.
  const lines = cards.searchTitles?.[82] ?? []
  expect(lines.flat()).toHaveLength(1)
  const index = lines.findIndex(ranges => ranges.length > 0)
  const range = lines[index]![0]!
  expect(cards.cards[0]!.titleLines[index]!.slice(range.start, range.end)).toBe('ширины')
  await pane.unmount()
})

test('Поиск: «Мне» сохраняет запрос, показывает только совпавшие карточки и свою лупу', { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = host(on, () => wire(answer()), [owner(1, { title: 'Поиск владельцу' }), owner(2, { why: 'Поиск по описанию' }), owner(3)])
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'поиск', kind: 'change' }); await fixture.clock.advance(150)
  await tab(pane, 'owner')
  const cards = (await pane.find({ key: 'owner-cards' }))!.props.props as OwnerCardsProps
  expect(cards.cards.map(card => card.id)).toEqual([1, 2])
  const tabs = (await pane.find({ key: 'tabs' }))!.props.props as TaskTabsProps
  expect(tabs.tabs.find(item => item.id === 'owner')?.label).toBe('Мне 2')
  const header = (await pane.find({ key: 'panel-header' }))!.props.props as PanelActionsProps
  expect(header.actions.some(action => action.key === 'search')).toBe(false)
  expect(await pane.find({ key: 'task-search-clear' })).toBeDefined()
  await pane.input({ key: 'task-search-input', text: 'bmhz', kind: 'change' })
  expect((await pane.find({ key: 'tabs' }))!.props.props.tabs.find((item: { active: boolean }) => item.active).id).toBe('owner')
  await pane.unmount()
})

test('Поиск: запрос и отрывок очищены, а пробел между словами сохраняется в поле', { options: { glyphs: 'plain' } }, async ($, on) => {
  const credential = ['gh', 'p_', 'x'.repeat(35)].join('')
  const fixture = host(on, () => wire(answer([{ ...entry(second, 'description'), match: { field: 'description', snippet: 'Поиск\u001b\u202e ' + credential } }], [])))
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'поиск ', kind: 'change' })
  // Набранное мод в поле не перерисовывает: пробел в конце остаётся у движка как введён.
  expect((await pane.find({ key: 'task-search-input' }))?.props.value).toBeUndefined()
  await pane.input({ key: 'task-search-input', text: 'поиск\u001b\u202e ' + credential, kind: 'change' }); await fixture.clock.advance(150); await pane.redraw()
  const request = fixture.calls.filter(call => call.op === 'tasks.search').at(-1)!
  expect(JSON.stringify(request)).not.toContain(credential)
  const shown = text(await pane.drawn({ in: 'rows' }))
  expect(shown).not.toContain(credential); expect(shown).not.toContain('\u001b'); expect(shown).not.toContain('\u202e')
  expect(shown).toContain('[REDACTED:github_token]')
  await pane.unmount()
})

test('Поиск: отрывок — контекст вокруг слова; многоточие только с обрезанной стороны, обрывков слов нет', () => {
  const query = parseTaskSearchQuery('значок')!
  // Короткое поле целиком: ни многоточий, ни названия поля.
  expect(searchSnippet(query, 'Новый значок вкладки', 40)).toEqual({ text: 'Новый значок вкладки', ranges: [{ start: 6, end: 12 }] })
  // Окно рантайма: 50 знаков до совпадения и 160 всего — текст обрезан с обеих сторон, по краям обрывки слов.
  const before = 'а нижней рамке справа, на месте значков действий, '
  expect(Array.from(before)).toHaveLength(50)
  const window = (before + 'значок отправки с подписью при наведении в шапке слева, как у остальных значков; нажатие делает то же, что прежняя кнопка').slice(0, 160)
  expect(Array.from(window)).toHaveLength(160)
  for (const width of [36, 80]) {
    const shown = searchSnippet(query, window, width)
    expect(shown.text.startsWith('…')).toBe(true)
    expect(shown.text.endsWith('…')).toBe(true)
    expect(cellWidth(shown.text)).toBeLessThanOrEqual(width)
    // Слова целые: обрывка «а» в начале окна нет, конец стоит на границе слова.
    const words = shown.text.slice(1, -1).split(' ')
    expect(words.every(word => window.split(' ').slice(1).includes(word))).toBe(true)
    expect(words).toContain('значок')
    expect(shown.ranges.length).toBeGreaterThan(0)
    expect(shown.text.slice(shown.ranges[0]!.start, shown.ranges[0]!.end)).toBe('значок')
  }
  // Совпадение в начале поля: слева не обрезано, справа — шириной карточки.
  const head = searchSnippet(query, 'Значок поиска стоит перед полем ввода, а поле активно сразу после открытия вкладки', 30)
  expect(head.text.startsWith('Значок поиска')).toBe(true)
  expect(head.text.endsWith('…')).toBe(true)
  // Совпадение в конце длинного поля: контекст до него остаётся, справа многоточия нет.
  const tail = searchSnippet(query, 'Поле активно сразу после открытия вкладки, перед ним стоит значок', 30)
  expect(tail.text.startsWith('…')).toBe(true)
  expect(tail.text.endsWith('значок')).toBe(true)
})

test('Поиск: строка отрывка есть у каждого поля, без названия поля, с отрезками подсветки', () => {
  const panel = newSearchPanel(); panel.open = true; panel.query = 'поиск'
  const fields = ['description', 'acceptance', 'constraints', 'result', 'comment'] as const
  const rows = fields.map((field, index) => ({ ...entry(second, field), taskId: `field-${index}`, alias: `TASK-${300 + index}`, match: { field, snippet: 'Поиск по полю' } }))
  acceptSearch(panel, answer(rows, []), panel.query)
  const view = panel.views.queue
  const cards = searchRows(panel, seeded(first), view, 'agent', 84, 0, 0).filter(row => row.kind === 'card')
  expect(cards.map(card => card.search?.snippet)).toEqual(Array(5).fill('Поиск по полю'))
  expect(cards.every(card => card.search?.ranges?.length === 1 && card.height === card.titleLines.length + 3)).toBe(true)
})

test('Поиск: совпадение длинного слова продолжается на следующей строке названия', () => {
  for (const word of ['название'.repeat(7), '界'.repeat(24)]) {
    const panel = newSearchPanel(); panel.open = true; panel.query = word
    acceptSearch(panel, answer([entry({ ...second, title: word + ' конец' })], []), word)
    const cards = searchRows(panel, seeded(first), panel.views.queue, 'agent', 40, 0, 0).filter(row => row.kind === 'card')
    const card = cards[0]!
    expect(card.titleLines.length).toBeGreaterThan(1)
    expect(card.search?.title[0]).toEqual([{ start: 0, end: cellWidth(card.titleLines[0]!) }])
    expect(card.search?.title[1]?.[0]?.start).toBe(0)
  }
})

test('Поиск: карточка вне загруженного snapshot раскрывается и открывает страницу', { options: { glyphs: 'plain' } }, async ($, on) => {
  const extra: Task = { ...first, taskId: 'outside-snapshot', alias: 'TASK-300', title: 'Поиск вне снимка', description: 'Описание из полного чтения' }
  const fixture = host(on, () => wire(answer([entry(extra)], [])), [], [extra])
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'поиск', kind: 'change' }); await fixture.clock.advance(150); await pane.redraw()
  await pane.pointer({ in: 'rows', type: 'move', x: 4, y: 2 }); await pane.advance(200)
  expect(text(await pane.drawn({ in: 'rows' }))).toContain(extra.description!)
  await pane.key({ in: 'rows', key: 'return' })
  expect(await pane.find({ key: 'task-search-input' })).toBeUndefined()
  expect(await pane.find({ key: `task-page:${extra.taskId}` })).toBeDefined()
  await pane.unmount()
})

// Отрывок — одна строка вокруг слова. Раскрытая карточка показывает описание как есть, и отрывок рядом с ним был бы
// повтором: описание занимает его место, найденные слова в нём выделены.
test('Поиск: при наведении отрывок заменяется описанием, найденные слова в нём выделены', { options: { glyphs: 'plain' } }, async ($, on) => {
  const description = 'Сейчас в проекте не больше тридцати открытых задач. Предела быть не должно: список задач как план, в нём сотни пунктов. Ограничение остаётся одно.'
  const task: Task = { ...first, taskId: 'with-plan', alias: 'TASK-301', title: 'Снять предел числа открытых задач', description }
  const fixture = host(on, () => wire(answer([{ ...entry(task, 'description'), match: { field: 'description', snippet: description } }], [])), [], [task])
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'план', kind: 'change' }); await fixture.clock.advance(150); await pane.redraw()
  const snippet = ((await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps).rows.flatMap(row => row.kind === 'card' ? [row] : [])[0]?.search?.snippet
  expect(snippet).toContain('…')
  const before = text(await pane.drawn({ in: 'rows' }))
  expect(before).toContain(snippet!)
  expect(before).not.toContain('Сейчас в проекте')
  await pane.pointer({ in: 'rows', type: 'move', x: 4, y: 2 }); await pane.advance(200)
  const drawn = await pane.drawn({ in: 'rows' })
  const after = text(drawn)
  expect(after).not.toContain(snippet!)
  expect(after).toContain('Сейчас в проекте')
  expect(after).toContain('Ограничение остаётся одно.')
  const accent = roleColors(DEFAULT_THEME).accent
  expect(nodes(drawn).filter(node => node.type === 'Text' && node.props?.color === accent).map(node => text(node).toLowerCase())).toEqual(['план'])
  // Указатель ушёл: карточка свернулась, отрывок вернулся.
  await pane.pointer({ in: 'rows', type: 'move', x: 4, y: 40 }); await pane.advance(400)
  expect(text(await pane.drawn({ in: 'rows' }))).toContain(snippet!)
  await pane.unmount()
})

// Требование владельца: при наведении на любую карточку выдачи остаётся одно описание, без строки отрывка над ним.
test('Поиск: совпадение вне раскрытых строк описания — отрывок всё равно заменяется описанием', { options: { glyphs: 'plain' } }, async ($, on) => {
  const task: Task = { ...first, taskId: 'criteria-hit', alias: 'TASK-302', title: 'Снять предел числа открытых задач', description: 'Описание без искомого слова.' }
  const fixture = host(on, () => wire(answer([{ ...entry(task, 'description'), match: { field: 'acceptance', snippet: 'Готово, когда список задач читается как план работ.' } }], [])), [], [task])
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'план', kind: 'change' }); await fixture.clock.advance(150); await pane.redraw()
  await pane.pointer({ in: 'rows', type: 'move', x: 4, y: 2 }); await pane.advance(200)
  const after = text(await pane.drawn({ in: 'rows' }))
  expect(after).toContain('Описание без искомого слова.')
  expect(after).not.toContain('как план работ')
  // Указатель ушёл: карточка свернулась, отрывок вернулся.
  await pane.pointer({ in: 'rows', type: 'move', x: 4, y: 40 }); await pane.advance(400)
  expect(text(await pane.drawn({ in: 'rows' }))).toContain('как план работ')
  await pane.unmount()
})

// INSIDE-218: слово есть и в названии, и в тексте карточки. Название подсвечено, под ним — одна строка со словами
// вокруг совпадения в тексте; при наведении её место занимает обычное описание с выделенным словом.
test('Поиск: совпадение в названии и в описании — строка с вхождением показана, при наведении заменяется описанием', { options: { glyphs: 'plain' } }, async ($, on) => {
  const description = 'Набор ставится одной установкой десяти модов. Панель управления задачами — главное в наборе, и её нужно уметь поставить отдельно: мод с рантаймом, без остальных панелей.'
  const task: Task = { ...first, taskId: 'title-and-body', alias: 'TASK-216', title: 'Устанавливать панель отдельным модом', description }
  const fixture = host(on, () => wire(answer([{ ...entry(task), match: { field: 'title', snippet: task.title, inside: { field: 'description', snippet: description.slice(0, 160) } } }], [])), [], [task])
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'панель', kind: 'change' }); await fixture.clock.advance(150); await pane.redraw()
  const card = ((await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps).rows.flatMap(row => row.kind === 'card' ? [row] : [])[0]!
  expect(card.search?.snippet).toContain('Панель управления')
  expect(card.search?.snippet?.endsWith('…')).toBe(true)
  const accent = roleColors(DEFAULT_THEME).accent
  const marked = async () => { const drawn = await pane.drawn({ in: 'rows' }); return { text: text(drawn), hits: nodes(drawn).filter(node => node.type === 'Text' && node.props?.color === accent).map(node => text(node).toLowerCase()) } }
  const before = await marked()
  expect(before.text).toContain(card.search!.snippet!)
  expect(before.hits).toEqual(['панель', 'панель'])
  await pane.pointer({ in: 'rows', type: 'move', x: 4, y: 2 }); await pane.advance(200)
  const after = await marked()
  expect(after.text).not.toContain(card.search!.snippet!)
  expect(after.text).toContain('Набор ставится одной установкой')
  expect(after.text).toContain('остальных панелей.')
  expect(after.hits).toEqual(['панель', 'панель'])
  await pane.unmount()
})

// Без внутреннего совпадения карточка с найденным названием остаётся без строки отрывка.
test('Поиск: совпадение только в названии — строки с вхождением нет', { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = host(on, () => wire(answer([entry(first)], [])))
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'поиск', kind: 'change' }); await fixture.clock.advance(150); await pane.redraw()
  const card = ((await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps).rows.flatMap(row => row.kind === 'card' ? [row] : [])[0]!
  expect(card.search?.snippet).toBeUndefined()
  await pane.unmount()
})

for (const target of ['agent', 'backlog'] as const) test(`Поиск: ${target} дочитывает свою страницу и останавливается у total`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const list = target === 'agent' ? 'queue' : 'deferred'
  const row = (index: number) => entry({ ...first, taskId: `${list}-${index}`, alias: `TASK-${400 + index}`, title: `Поиск ${index}`, status: target === 'agent' ? 'active' : 'paused' })
  const page = Array.from({ length: 50 }, (_, index) => row(index))
  const fixture = host(on, request => wire({ ...answer([], []), offset: request.op === 'tasks.search' ? request.args.offset ?? 0 : 0,
    lists: request.op === 'tasks.search' && request.args.offset === 50 ? { [list]: { total: 51, rows: [row(50)] } }
      : { queue: { total: 0, rows: [] }, deferred: { total: 0, rows: [] }, closed: { total: 0, rows: [] }, [list]: { total: 51, rows: page } } }))
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'поиск', kind: 'change' }); await fixture.clock.advance(150)
  await tab(pane, target); await pane.key({ in: 'rows', key: 'end' }); await pane.redraw()
  expect(fixture.calls.filter(call => call.op === 'tasks.search').at(-1)?.args).toEqual({ query: 'поиск', lists: [list], limit: 50, offset: 50 })
  await pane.key({ in: 'rows', key: 'end' }); await pane.redraw()
  expect(text(await pane.drawn({ in: 'rows' }))).toContain('Поиск 50')
  expect(fixture.calls.filter(call => call.op === 'tasks.search')).toHaveLength(2)
  await pane.unmount()
})

test('Поиск: нулевой ответ во всех вкладках не переключает активную вкладку', { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = host(on, () => wire(answer([], [])))
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'пусто', kind: 'change' }); await fixture.clock.advance(150); await pane.redraw()
  expect(text(await pane.drawn({ in: 'rows' }))).toBe('Ничего не найдено')
  expect((await pane.find({ key: 'tabs' }))!.props.props.tabs.find((item: { active: boolean }) => item.active).id).toBe('agent')
  await pane.unmount()
})

test('Поиск: родное поле и карточки доступны на desktop', { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = host(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'desktop', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ in: 'rows', key: '/' })
  expect((await pane.find({ key: 'task-search-input' }))?.props.placeholder).toBe('Поиск задач')
  await pane.input({ key: 'task-search-input', text: 'поиск', kind: 'change' }); await fixture.clock.advance(150); await pane.redraw()
  expect(text(await pane.drawn({ in: 'rows' }))).toContain(first.title)
  await pane.unmount()
})

test('Поиск: 150 мс от последнего знака, Enter и возврат со страницы сохраняют запрос', { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = host(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane)
  await pane.input({ key: 'task-search-input', text: 'по', kind: 'change' }); await fixture.clock.advance(149)
  await pane.input({ key: 'task-search-input', text: 'поиск', kind: 'change' }); await fixture.clock.advance(149)
  expect(fixture.calls.filter(call => call.op === 'tasks.search')).toHaveLength(0)
  await fixture.clock.advance(1); await pane.redraw()
  await pane.key({ in: 'rows', key: 'down' })
  await pane.input({ key: 'task-search-input', text: 'поиск', kind: 'submit' })
  const rows = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
  expect(rows.rows.find(row => row.kind === 'card' && row.selected)?.taskId).toBe(first.taskId)
  expect(await pane.find({ key: 'page-content' })).toBeUndefined()
  await pane.key({ in: 'rows', key: 'return' })
  expect(await pane.find({ key: 'task-search-input' })).toBeUndefined()
  await pane.key({ in: 'page-content', key: 'q' })
  // Поле вернулось с прежним нарисованным значением: набранное у движка не сброшено, запрос действует.
  expect((await pane.find({ key: 'task-search-input' }))?.props.value).toBeUndefined()
  expect(await pane.find({ key: 'task-search-clear' })).toBeDefined()
  await pane.press({ key: 'task-search-clear' })
  expect((await pane.find({ key: 'task-search-input' }))?.props.value).toBe('')
  await pane.unmount()
})

test('Поиск: отказ сохраняет выдачу; старый рантайм использует загруженные строки один раз', { options: { glyphs: 'plain' } }, async ($, on) => {
  let code = ''
  const fixture = host(on, () => code ? { value: { ...wire(null).value, stdout: JSON.stringify({ v: 1, ok: false, error: { code } }) } } : wire(answer()))
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'поиск', kind: 'change' }); await fixture.clock.advance(150)
  code = 'BUSY'
  await pane.input({ key: 'task-search-input', text: 'отказ', kind: 'change' }); await fixture.clock.advance(150); await pane.redraw()
  expect(text(await pane.drawn({ in: 'rows' }))).toContain(first.title)
  expect(fixture.statuses).toHaveLength(1)
  code = 'UNKNOWN_OP'
  await pane.input({ key: 'task-search-input', text: 'первое', kind: 'change' }); await fixture.clock.advance(150); await pane.redraw()
  expect(text(await pane.drawn({ in: 'rows' }))).toContain(first.title)
  const before = fixture.calls.filter(call => call.op === 'tasks.search').length
  await pane.input({ key: 'task-search-input', text: 'нет-совпадения', kind: 'change' }); await fixture.clock.advance(150); await pane.redraw()
  expect(fixture.calls.filter(call => call.op === 'tasks.search')).toHaveLength(before)
  expect(text(await pane.drawn({ in: 'rows' }))).toContain('Поиск по описаниям недоступен в этой версии. Обнови панель задач.')
  await pane.unmount()
})

for (const width of [40, 84]) test(`Поиск: история дочитывается тем же запросом с offset 50 на ${width} колонках`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const history = Array.from({ length: 50 }, (_, index) => entry({ ...closed, taskId: `closed-${index}`, alias: `TASK-${200 + index}`, title: `Поиск ${index}` }))
  const fixture = host(on, request => request.op === 'tasks.search' && request.args.offset === 50
    ? wire({ ...answer([], [entry(closed)], 51), offset: 50, lists: { closed: { total: 51, rows: [entry(closed)] } } }) : wire(answer(undefined, history, 51)))
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  await open(pane); await pane.input({ key: 'task-search-input', text: 'поиск', kind: 'change' }); await fixture.clock.advance(150)
  await tab(pane, 'history'); await pane.key({ in: 'rows', key: 'end' }); await pane.redraw()
  expect(fixture.calls.filter(call => call.op === 'tasks.search').at(-1)?.args).toEqual({ query: 'поиск', lists: ['closed'], limit: 50, offset: 50 })
  await pane.key({ in: 'rows', key: 'end' }); await pane.redraw()
  expect(text(await pane.drawn({ in: 'rows' }))).toContain('Поиск в истории')
  await textView(pane, width, 'history-page-2')
  await pane.unmount()
})

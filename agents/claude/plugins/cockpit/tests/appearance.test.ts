import { expect, test } from 'claude-code/testing'
import { taskRows, historyRows, historyList, rowsProps, bandRow, moveCursor, sourceIcon, formatDuration, taskList, queueTasks, backlogTasks, taskActionEnabled } from '../hooks/tasks'
import { seeded, TASK } from './fixtures'
import { cellWidth } from '../hooks/layout'
import { DEFAULT_THEME, activityTones, contrast, hoverColor, roleColors } from '../hooks/theme'
import { drawTaskCards } from '../hooks/task-cards'
import { drawTaskTabs, type TaskTab, type TaskTabsProps } from '../hooks/task-tabs'
import { inkOn } from '../hooks/rows'

const card = { ...TASK, steps: [{ position: 0, title: 'Выполняемый шаг', status: 'active' as const }] }
const view = () => ({ cursor: `task:${TASK.taskId}`, expanded: new Set([TASK.taskId]), collapsed: new Set<string>(), offset: 0, limit: 3 })

for (const width of [40, 60, 100]) test(`HANDOFF-2: подсказка первой задачи не заменяет бэклог, историю проекта и недоступный рантайм: ${width}`, () => {
  const empty = seeded(null)
  expect(taskRows(empty, view(), width, 0, DEFAULT_THEME, 'backlog')).toEqual([
    { kind: 'empty', id: 'tasks-empty', width: width - 2, height: 3, text: 'Бэклог пуст' },
  ])
  const closed = taskRows(seeded({ ...TASK, status: 'done' }), view(), width, 0)[0]
  expect(closed?.kind === 'empty' ? closed.lines : 'missing').toBeUndefined()
  expect(closed?.height).toBe(3)
  empty.snapshot = null
  expect(taskRows(empty, view(), width, 0)).toEqual([
    { kind: 'empty', id: 'tasks-empty', width: width - 2, height: 3, text: 'Панель временно недоступна' },
  ])
})

for (const width of [40, 60, 100]) test(`Предложения не входят в список панели: ${width}`, () => {
  const state = seeded(null)
  if (state.snapshot) {
    state.snapshot.candidates = [{ ...TASK, stage: 'candidate', queuePosition: null, description: 'Первая строка\nВторая строка', title: 'Очень длинное название '.repeat(25) }]
    state.snapshot.candidateCount = 1
  }
  const rows = taskRows(state, { ...view(), cursor: '' }, width, 0)
  expect(rows.map(row => row.kind)).toEqual(['empty'])
  expect(rows.some(row => row.kind === 'heading' && row.label === 'Предложено')).toBe(false)
})

for (const width of [40, 60, 100]) {
  test(`Каждая строка карточки укладывается в ширину с правым отступом: ${width}`, () => {
    const rows = taskRows(seeded(card), view(), width, 0)
    const task = rows.find(row => row.kind === 'card')
    expect(task?.kind).toBe('card')
    if (task?.kind !== 'card') return
    expect(task.width).toBe(width - 2)
    for (const line of task.lines) expect(cellWidth(line)).toBeLessThanOrEqual(task.innerWidth)
    expect(task.actions).toHaveLength(0)
    expect(rowsProps(rows, view()).totalHeight).toBe(rows.reduce((sum, row) => sum + row.height, 0))
  })
}
test('Группы не содержат каталоги, пустые группы пропущены, cursor ходит по карточкам', () => {
  const state = seeded(card)
  if (state.snapshot) state.snapshot.tasks.push({ ...card, taskId: 'next', queuePosition: 2 })
  const v = view()
  const rows = taskRows(state, v, 80, 0)
  expect(rows.filter(row => row.kind === 'heading').map(row => row.group)).toEqual(['now', 'queue'])
  expect(rows.filter(row => row.kind === 'gap')).toHaveLength(1)
  moveCursor(rows, v, 'down')
  expect(v.cursor).toBe('task:next')
  moveCursor(rows, v, 'up')
  expect(v.cursor).toBe(`task:${TASK.taskId}`)
})
test('Блик относится к названию текущей карточки только во время хода', () => {
  const rows = taskRows(seeded(card), { ...view(), working: true }, 80, 0)
  const task = rows.find(row => row.kind === 'card')
  expect(task?.kind === 'card' ? task.running : false).toBe(true)
  expect(task?.kind === 'card' ? task.titleLines[0] : '').toBe(TASK.title)
  // Блик — градиент от цвета «в работе»: каждая ступень светлее предыдущей и того же оттенка, серого нет.
  for (const bg of ['#ffffff', '#1e1e1e', '']) {
    const theme = { ...DEFAULT_THEME, bg }
    const { bright, dim } = activityTones(theme)
    expect(bright[0]).toBe(roleColors(theme).work)
    expect(new Set(bright).size).toBe(4)
    expect(dim.at(-1)).toBe(roleColors(theme).work)
    for (const tones of [bright, dim]) for (let index = 0; index < tones.length; index++) {
      const [r, g, b] = [1, 3, 5].map(at => parseInt(tones[index]!.slice(at, at + 2), 16))
      expect(r! > g! && g! > b!).toBe(true)
      if (index) expect(r! + g! + b!).toBeGreaterThan([1, 3, 5].reduce((sum, at) => sum + parseInt(tones[index - 1]!.slice(at, at + 2), 16), 0))
    }
  }
  expect(DEFAULT_THEME.accent).toBe(roleColors(DEFAULT_THEME).accent)
  expect(task?.kind === 'card' ? task.shimmer : false).toBe(true)
  const idle = taskRows(seeded(card), view(), 80, 0).find(row => row.kind === 'card')
  expect(idle?.kind === 'card' ? idle.shimmer : true).toBe(false)
  expect(bandRow(seeded(card), 80, 0)?.left.some(seg => seg.sh)).toBe(false)
})

test('Контекст показывает только дописанные абзацы, без шагов и контрольных точек', () => {
  const state = seeded(null)
  if (state.snapshot) state.snapshot.tasks = [{ ...card, taskId: 'steps', description: 'Контекст\nВторой абзац' }, { ...card, taskId: 'checkpoint', steps: [], lastCheckpoint: {
    checkpointId: 'cp', taskId: 'checkpoint', kind: 'note', text: 'Проверки прошли', source: 'user', provenance: 'panel', createdAt: TASK.createdAt,
  }, certainty: 'confirmed' }]
  const rows = taskRows(state, view(), 100, 0)
  const contexts = rows.flatMap(row => row.kind === 'card' ? row.details : [])
  expect(contexts).toEqual(['Контекст', 'Второй абзац'])
  const cards = rows.filter(row => row.kind === 'card')
  expect(cards[0]?.height).toBe(cards[1]?.height)
  expect(cards.flatMap(row => row.kind === 'card' ? row.lines : []).join('')).not.toContain('шаги')
  expect(cards.flatMap(row => row.kind === 'card' ? row.lines : []).join('')).not.toContain('Проверки прошли')
  expect(cards.flatMap(row => row.kind === 'card' ? row.lines : []).join('')).not.toContain('0/0')
})
test('Переносы контекста учитываются в высоте, шаги не рисуются', () => {
  const task = { ...card, steps: [{ position: 0, title: 'Проверить\nузкую\tпанель', status: 'active' as const }] }
  const rows = taskRows(seeded(task), view(), 60, 0)
  const current = rows.find(row => row.kind === 'card')
  expect(current?.kind).toBe('card')
  if (current?.kind !== 'card') return
  expect(current.context).toEqual([])
  expect(current.steps).toEqual([])
  expect(current.height).toBe(2 + current.titleLines.length)
  for (const line of current.lines) expect(line).not.toMatch(/[\n\r\t]/)
})
test('Источник занимает одну ячейку в Nerd Font и unicode; время словами', () => {
  const manual = { ...card, certaintySource: 'user' as const, sourcePhrase: null, source: null }
  const extracted = { ...card, certaintySource: 'provider' as const }
  for (const mode of ['nerd', 'unicode'] as const) {
    expect(cellWidth(sourceIcon(manual, mode))).toBe(1)
    expect(cellWidth(sourceIcon(extracted, mode))).toBe(1)
    expect(sourceIcon(manual, mode)).not.toBe(sourceIcon(extracted, mode))
    expect(sourceIcon({ ...manual, sourcePhrase: 'Поручение из реплики' }, mode)).toBe(sourceIcon(extracted, mode))
  }
  expect(formatDuration(49_000)).toBe('49 сек')
  expect(formatDuration(489_000)).toBe('8 мин')
  expect(formatDuration(4_800_000)).toBe('1 ч 20 мин')
})
test('На рамке номер самой задачи, а не место в очереди; текст получает всю ширину рамки', () => {
  const state = seeded({ ...card, alias: 'TASK-7', priority: 1, priorityPinned: true })
  state.snapshot?.tasks.push({ ...card, taskId: 'next', alias: 'TASK-42', priority: 3, queuePosition: 2 })
  const cards = taskRows(state, view(), 100, 0).filter(row => row.kind === 'card')
  expect(cards[0]?.kind === 'card' ? cards[0].number : null).toBe('#7')
  expect(cards[1]?.kind === 'card' ? cards[1].number : null).toBe('#42')
  expect(cards[0]?.kind === 'card' ? cards[0].gutterWidth : null).toBe(0)
  expect(cards[1]?.kind === 'card' ? cards[1].gutterWidth : null).toBe(0)
  for (const item of cards) if (item.kind === 'card') expect(item.textWidth).toBe(item.innerWidth)
  expect(cards[0]?.kind === 'card' ? cards[0].lines.join('') : '').not.toContain('P1')
  expect(cards[1]?.kind === 'card' ? cards[1].titleLines.join('') : '').not.toContain('#1')
})

for (const width of [40, 60, 100]) test(`Название до четырёх строк определяет высоту; раскрытие хранит до восьми строк описания: ${width}`, () => {
  const state = seeded({ ...card, title: 'Полная формулировка поручения со словами '.repeat(12), description: 'Дополнение владельца '.repeat(80) })
  const current = taskRows(state, view(), width, 0).find(row => row.kind === 'card')
  if (current?.kind !== 'card') throw new Error('Карточка отсутствует')
  expect(current.titleLines).toHaveLength(4)
  expect(current.context).toHaveLength(0)
  expect(current.details).toHaveLength(8)
  expect(current.titleLines[3]).toMatch(/…$/)
  expect(current.details[7]).toMatch(/…$/)
  for (const line of current.titleLines.slice(0, 3)) expect(line).not.toMatch(/\S…$/)
  expect(current.height).toBe(6)
  const selected = taskRows(state, { ...view(), cursor: '' }, width, 0).find(row => row.kind === 'card')
  expect(selected?.height).toBe(current.height)
})
test('Очередь сохраняет приоритет модели; доступность перемещения следует этому порядку', () => {
  const state = seeded(null)
  const first = { ...card, taskId: 'low', queuePosition: 1, priority: 3 as const }
  const second = { ...card, taskId: 'urgent', queuePosition: 2, priority: 0 as const }
  const third = { ...second, taskId: 'urgent-two', queuePosition: 3 }
  if (state.snapshot) state.snapshot.tasks = [first, second, third]
  expect(taskList(state).map(task => task.taskId)).toEqual(['urgent', 'urgent-two', 'low'])
  expect(taskActionEnabled(state, second, 'up')).toBe(false)
  expect(taskActionEnabled(state, second, 'down')).toBe(true)
  expect(taskActionEnabled(state, third, 'up')).toBe(true)
  expect(taskActionEnabled(state, third, 'down')).toBe(false)
  expect(taskActionEnabled(state, first, 'up')).toBe(false)
  expect(taskActionEnabled(state, first, 'down')).toBe(false)
})
test('Списки задач не зависят от порядка snapshot, равные позиции разрешаются числом псевдонима', () => {
  const current = { ...card, taskId: 'current', alias: 'TASK-99', priority: 2 as const, queuePosition: 99 }
  const first = { ...card, taskId: 'queue-first', alias: 'TASK-2', priority: 1 as const, queuePosition: 5 }
  const second = { ...first, taskId: 'queue-second', alias: 'TASK-10' }
  const last = { ...first, taskId: 'queue-last', alias: 'TASK-30', priority: 3 as const, queuePosition: 0 }
  const paused = { ...first, taskId: 'paused-first', alias: 'TASK-4', status: 'paused' as const }
  const backlog = { ...paused, taskId: 'paused-second', alias: 'TASK-12' }
  const waiting = { ...first, taskId: 'waiting', alias: 'TASK-6', needsDecision: true }
  const detour = { ...first, taskId: 'detour', alias: 'TASK-7' }
  const older = { ...first, taskId: 'closed-older', alias: 'TASK-11', status: 'done' as const, updatedAt: '2026-10-05T12:00:00.000000Z' }
  const newer = { ...older, taskId: 'closed-newer', alias: 'TASK-9', updatedAt: '2026-10-06T12:00:00.000000Z' }
  const ordered = [current, first, second, last, waiting, detour, paused, backlog, newer, older]
  const expected = ['queue-first', 'paused-first', 'waiting', 'detour', 'closed-newer', 'queue-second', 'closed-older', 'paused-second', 'current', 'queue-last']
  for (const tasks of [ordered, [...ordered].reverse(), [...ordered.slice(5), ...ordered.slice(0, 5)]]) {
    const state = seeded(current)
    if (state.snapshot) {
      state.snapshot.tasks = tasks
      state.snapshot.focusStack = [{ taskId: detour.taskId, depth: 1, provenance: 'panel' }]
    }
    expect(taskList(state).map(task => task.taskId)).toEqual(expected)
    expect(queueTasks(state).map(task => task.taskId)).toEqual(['queue-first', 'queue-second', 'queue-last'])
    expect(backlogTasks(state).map(task => task.taskId)).toEqual(['paused-first', 'paused-second'])
    expect(historyList(state, view()).map(task => task.taskId)).toEqual(['closed-newer', 'closed-older'])
    expect(taskActionEnabled(state, first, 'up')).toBe(false)
    expect(taskActionEnabled(state, first, 'down')).toBe(true)
    expect(taskActionEnabled(state, second, 'up')).toBe(true)
    expect(bandRow(state, 80, 0)?.right.map(segment => segment.t).join('')).toBe('  в очереди 3')
  }
})
test('Старый engine/cli без шагов и подтверждения не становится текущей карточкой или полосой', () => {
  const legacy = { ...TASK, title: 'ок, остаёмся на CLI, продолжай', steps: [] }
  expect(taskRows(seeded(legacy), view(), 80, 0).some(row => row.taskId === legacy.taskId)).toBe(false)
  expect(bandRow(seeded(legacy), 80, 0)).toBeNull()
})
test('Шаги, подтверждение человеком и провайдерное извлечение сохраняют задачи', () => {
  for (const task of [card, { ...TASK, certainty: 'confirmed' as const, certaintySource: 'user' as const },
    { ...TASK, certainty: 'inferred' as const, certaintySource: 'provider' as const, certaintyProvenance: 'panel' as const }]) {
    expect(taskRows(seeded(task), view(), 80, 0).some(row => row.taskId === task.taskId)).toBe(true)
    expect(bandRow(seeded(task), 80, 0)).not.toBeNull()
  }
})

test('Закрытые и отменённые задачи не попадают во вкладку агента даже при раскрытом done', () => {
  const state = seeded(card)
  state.snapshot?.tasks.push({ ...card, taskId: 'closed', status: 'done' }, { ...card, taskId: 'cancelled', status: 'cancelled' })
  const rows = taskRows(state, view(), 80, 0)
  expect(rows.some(row => row.id === 'group:done')).toBe(false)
  expect(rows.some(row => row.taskId === 'closed' || row.taskId === 'cancelled')).toBe(false)
})

test('Карточка показывает суть без префикса владельца и встроенного критерия', () => {
  const task = { ...card, description: 'Владелец: Исправить переносы. Готово, когда: Все проверки проходят.', acceptance: ['Сохранить клавиши'] }
  const row = taskRows(seeded(task), view(), 80, 0).find(row => row.kind === 'card')
  expect(row?.kind === 'card' ? row.details : null).toEqual(['Исправить переносы.'])
})

for (const width of [40, 60, 100]) test(`История группирует дни, новые сверху; итог и номер помещаются в карточку, время на рамке: ${width}`, () => {
  const date = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString()
  const closed = (id: number, day: number, hour: number) => ({ ...card, taskId: `done-${id}`, alias: `TASK-${id}`, status: 'done' as const,
    updatedAt: date(day, hour, 7), description: 'Владелец: Первая строка\nВторое предложение\n\nГотово, когда: Не показывать критерий' })
  const state = seeded(null)
  if (state.snapshot) state.snapshot.tasks = [closed(1, 3, 10), closed(3, 5, 8), closed(2, 4, 12), closed(4, 5, 11),
    { ...closed(5, 5, 13), status: 'cancelled' }, { ...closed(6, 5, 14), deleted: true }]
  const v = { ...view(), cursor: 'task:done-4', notes: new Map([['done-4', [{ noteId: 'result', taskId: 'done-4', kind: 'result' as const, text: 'Проверил результат и записал итог', createdAt: date(5, 11, 7), source: 'agent' as const, provenance: 'tool' as const }]]]) }
  const rows = historyRows(state, v, width, new Date(2026, 9, 5, 14).getTime())
  expect(rows.filter(row => row.kind === 'day').map(row => row.kind === 'day' ? row.label : '')).toEqual(['Сегодня', 'Вчера', '03.10.2026'])
  expect(historyList(state, v).map(task => task.taskId)).toEqual(['done-4', 'done-3', 'done-2', 'done-1'])
  const cards = rows.filter(row => row.kind === 'card')
  expect(cards[0]?.kind === 'card' ? cards[0].number : null).toBe('#4')
  expect(cards[0]?.kind === 'card' ? cards[0].details : null).toEqual(['Проверил результат и записал итог'])
  expect(cards[0]?.kind === 'card' ? cards[0].closedTime : null).toBe('2 ч назад')
  expect(cards[1]?.kind === 'card' ? cards[1].details : null).toEqual(['Первая строка', 'Второе предложение'])
  for (const item of cards) if (item.kind === 'card') {
    expect(item.actions).toEqual([])
    expect(item.shimmer).toBe(false)
    expect(item.height).toBe(2 + item.titleLines.length + item.context.length) // время стоит на рамке
    for (const line of item.lines) expect(cellWidth(line)).toBeLessThanOrEqual(item.innerWidth)
    expect(item.lines.join(' ')).not.toContain('Готово, когда')
    expect(item.context).toEqual([])
    expect(item.details.length).toBeLessThanOrEqual(8)
  }
  moveCursor(rows, v, 'j'); expect(v.cursor).toBe('task:done-3')
  moveCursor(rows, v, 'k'); expect(v.cursor).toBe('task:done-4')
  expect(rowsProps(rows, v).bar).toBeDefined()
})

test('Расчёт контраста для каждой роли на светлом, тёмном и неизвестном фоне', () => {
  // 1. Светлый фон (#ffffff)
  const onLight = roleColors({ ...DEFAULT_THEME, bg: '#ffffff' })
  expect(contrast(onLight.accent, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(onLight.urgent, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(onLight.hover, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(onLight.green, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(onLight.red, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(onLight.muted, '#ffffff')).toBeGreaterThanOrEqual(4.5)

  // 2. Тёмный фон (#1e1e1e)
  const onDark = roleColors({ ...DEFAULT_THEME, bg: '#1e1e1e' })
  expect(contrast(onDark.accent, '#1e1e1e')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(onDark.urgent, '#1e1e1e')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(onDark.hover, '#1e1e1e')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(onDark.green, '#1e1e1e')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(onDark.red, '#1e1e1e')).toBeGreaterThanOrEqual(4.5)
  expect(contrast(onDark.muted, '#1e1e1e')).toBeGreaterThanOrEqual(4.5)

  // 3. Неизвестный фон: средние тона читаются и на белом, и на тёмном
  const unknown = roleColors({ ...DEFAULT_THEME, bg: '' })
  for (const bg of ['#ffffff', '#1e1e1e']) {
    expect(contrast(unknown.accent, bg)).toBeGreaterThanOrEqual(3.5)
    expect(contrast(unknown.urgent, bg)).toBeGreaterThanOrEqual(3.5)
    expect(contrast(unknown.hover, bg)).toBeGreaterThanOrEqual(3.5)
    expect(contrast(unknown.green, bg)).toBeGreaterThanOrEqual(3.5)
    expect(contrast(unknown.red, bg)).toBeGreaterThanOrEqual(3.5)
    expect(contrast(unknown.muted, bg)).toBeGreaterThanOrEqual(3.0)
  }
})

test('Текст на заливке активной вкладки контрастен заливке не ниже 4.5:1', () => {
  for (const fill of [DEFAULT_THEME.selection, '#6b7280', '#2563eb', '#1e293b', '#f3f4f6', '#000000', '#ffffff', '#fb923c']) {
    const ink = inkOn(fill)
    expect(contrast(ink, fill)).toBeGreaterThanOrEqual(4.5)
  }
})

test('В отрисованном дереве карточек backgroundColor и inverse отсутствуют, ни одного Box с hover без стилевого свойства, ни одного scope вне [a-z0-9-]', () => {
  const state = seeded(card)
  const rows = taskRows(state, view(), 80, 0)
  const props = rowsProps(rows, view())

  const elements: { Box: (p: Record<string, unknown>) => unknown; Text: (p: Record<string, unknown>) => unknown } = {
    Box: (p: Record<string, unknown>) => ({ type: 'Box', props: p }),
    Text: (p: Record<string, unknown>) => ({ type: 'Text', props: p }),
  }
  const tree = drawTaskCards(elements, props, () => {})

  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    const n = node as { type?: string; props?: Record<string, unknown>; children?: unknown }
    if (n.props) {
      expect(n.props.backgroundColor).toBeUndefined()
      expect(n.props.inverse).toBeUndefined()
      if (n.props.hover && typeof n.props.hover === 'object') {
        const h = n.props.hover as { scope?: string; display?: string; color?: string; borderColor?: string; borderDimColor?: boolean; top?: number }
        if (n.type === 'Box') {
          expect(h.display || h.color || h.borderColor || h.top !== undefined).toBeDefined()
        }
        if (h.scope) {
          expect(h.scope).toMatch(/^[a-z0-9-]+$/)
        }
      }
    }
    if (n.children) walk(n.children)
  }
  walk(tree)
})

test('В отрисованном дереве вкладок backgroundColor есть только у активной вкладки, inverse отсутствует, текст на заливке контрастен', () => {
  const roles = roleColors(DEFAULT_THEME)
  const tabList: TaskTab[] = [
    { id: 'agent', label: 'Агенту 1', active: true, attention: false },
    { id: 'owner', label: 'Мне 0', active: false, attention: false },
    { id: 'backlog', label: 'Бэклог 0', active: false, attention: false },
    { id: 'history', label: 'История 0', active: false, attention: false },
  ]
  const tabProps: TaskTabsProps = {
    tabs: tabList,
    width: 80,
    fill: roles.fill,
    ink: inkOn(roles.fill),
    muted: roles.muted,
    alert: roles.warn,
    hover: hoverColor(DEFAULT_THEME),
  }

  const elements: { Box: (p: Record<string, unknown>) => unknown; Text: (p: Record<string, unknown>) => unknown } = {
    Box: (p: Record<string, unknown>) => ({ type: 'Box', props: p }),
    Text: (p: Record<string, unknown>) => ({ type: 'Text', props: p }),
  }
  const tree = drawTaskTabs(elements, tabProps)

  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    const n = node as { type?: string; props?: Record<string, unknown>; children?: unknown }
    if (n.props) {
      expect(n.props.inverse).toBeUndefined()
      if (n.props.backgroundColor) {
        expect(n.props.key).toBe('agent-tab-label')
        expect(n.props.backgroundColor).toBe(roles.fill)
        expect(contrast(String(n.props.color), String(n.props.backgroundColor))).toBeGreaterThanOrEqual(4.5)
      }
    }
    if (n.children) walk(n.children)
  }
  walk(tree)
})

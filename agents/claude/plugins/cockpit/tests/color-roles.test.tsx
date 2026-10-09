import { expect, test } from 'claude-code/testing'
import { DEFAULT_THEME, contrast, roleColors, inkOn, activityTones } from '../hooks/theme'
import { seeded, TASK } from './fixtures'
import { taskRows, rowsProps, bandRow } from '../hooks/tasks'
import { drawTaskCards } from '../hooks/task-cards'
import { drawTaskTabs } from '../hooks/task-tabs'
import { drawEditor, editorState, type EditorProps } from '../hooks/editor'
import PanelActions from '../hooks/panel-actions'
import { newTaskPage, pageLines, pageWindow } from '../hooks/task-page-model'
import { drawTaskPage } from '../hooks/task-page'

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown }
const elements = {
  Box: (props: Record<string, unknown>) => ({ type: 'Box', props }),
  Text: (props: Record<string, unknown>) => ({ type: 'Text', props }),
  Button: (props: Record<string, unknown>) => ({ type: 'Button', props }),
}
function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  const node = tree as Node
  return [node, ...nodes(node.children), ...nodes(node.props?.children)]
}
const ui = elements as unknown as Parameters<typeof drawEditor>[0]

for (const bg of ['#ffffff', '#1e1e1e', '']) test(`COLORS-2: работа, вкладки, подписи и фокус ${bg || 'неизвестный фон'}`, () => {
  const theme = { ...DEFAULT_THEME, bg }, roles = roleColors(theme)
  const task = { ...TASK, steps: [{ position: 0, title: 'Проверить', status: 'active' as const }] }
  const state = seeded(task)
  const view = { cursor: '', expanded: new Set<string>(), collapsed: new Set<string>(), offset: 0, limit: 20, working: true }
  const rows = taskRows(state, view, 80, 0, theme)
  const cards = drawTaskCards(ui, rowsProps(rows, view, theme), () => {}, 3)
  expect(nodes(cards).find(node => node.props?.key === `card:${task.taskId}`)?.props?.borderColor).toBe(roles.work)
  expect(nodes(cards).find(node => node.props?.key === `number:${task.taskId}`)?.props?.color).toBe(roles.work)
  expect(bandRow(state, 80, 0, theme, true)?.left[0]?.c).toBe(roles.work)
  const props = { tabs: [{ id: 'agent', label: 'Агенту', active: true, attention: false }, { id: 'owner', label: 'Мне', active: false, attention: false }], width: 80, fill: roles.fill, ink: inkOn(roles.fill), muted: roles.muted, alert: roles.warn, hover: roles.accent }
  const tabs = drawTaskTabs(ui, props, 'owner')
  expect(nodes(tabs).find(node => node.props?.key === 'owner-tab-label')?.props?.color).toBe(roles.accent)
  // Выбранная вкладка: в покое заливка и чернила; под указателем текст берёт цвет наведения, заливка остаётся.
  expect(nodes(tabs).find(node => node.props?.key === 'agent-tab-label')?.props).toMatchObject({ bold: true, color: inkOn(roles.fill), backgroundColor: roles.fill })
  expect(nodes(drawTaskTabs(ui, props, 'agent')).find(node => node.props?.key === 'agent-tab-label')?.props)
    .toMatchObject({ bold: true, color: roles.accent, backgroundColor: roles.fill })
  expect(contrast(roles.accent, roles.fill)).toBeGreaterThanOrEqual(4.5)
  const actions = PanelActions({ title: '', accent: roles.accent, muted: roles.muted, actions: [{ key: 'close', label: '×', hint: 'Закрыть', keyHint: 'q' }], hint: '', focused: 'close' }, {
    elements: ui, columns: 80, rows: 1, state: undefined, setState: () => {}, onKey: () => () => {}, post: () => {},
  } as unknown as Parameters<typeof PanelActions>[1])
  const button = nodes(actions).find(node => node.type === 'Button')
  expect(button?.props?.color).toBe(roles.muted)
  expect(button?.props?.hover).toMatchObject({ color: roles.accent, inverse: false })
  const caption = nodes(actions).filter(node => node.type === 'Text' && node.props?.bold)
  for (const node of caption) expect(node.props?.color).toBe(roles.accent)
  const editorProps: EditorProps = { id: 'edit', value: 'Текст', epoch: 0, version: 0, ack: 0, element: 'edit', frame: 'edit-frame', width: 40, height: 3, placeholder: 'Введите текст', submitLabel: 'Сохранить', plain: true, theme, actions: [], focused: true }
  const editor = drawEditor(ui, editorProps, editorState(editorProps), () => {})
  expect(nodes(editor).find(node => node.props?.key === 'edit-frame')?.props?.borderColor).toBe(roles.accent)
  // Блик — производные ступени роли work, других цветов вне ролей нет.
  const allowed = new Set([...Object.values(roles), theme.bg, inkOn(roles.fill), ...activityTones(theme).bright, ...activityTones(theme).dim])
  for (const tree of [cards, tabs, actions, editor]) for (const node of nodes(tree)) {
    for (const key of ['color', 'borderColor', 'backgroundColor']) {
      const value = node.props?.[key]
      if (typeof value === 'string' && value.startsWith('#')) expect(allowed.has(value)).toBe(true)
    }
  }
})

for (const bg of ['#ffffff', '#1e1e1e', '']) test(`PAGE-2: журнал использует роли общей темы ${bg || 'неизвестный фон'}`, () => {
  const theme = { ...DEFAULT_THEME, bg }, roles = roleColors(theme)
  const page = newTaskPage({ ...TASK, status: 'cancelled' }, [{ commentId: 'owner', text: 'Ответ', revision: 0, createdAt: TASK.createdAt, updatedAt: TASK.createdAt }],
    [{ noteId: 'agent', taskId: TASK.taskId, kind: 'result', source: 'agent', provenance: 'tool', text: 'Проверки', createdAt: TASK.createdAt }])
  page.height = 20
  page.tab = 'comments'
  const tree = drawTaskPage(ui, pageWindow(page, pageLines(page, Date.parse(TASK.createdAt)), theme))
  const texts = nodes(tree).filter(node => node.type === 'Text')
  const allowed = new Set([roles.fg, roles.muted, roles.accent, roles.work, roles.ok, roles.fail, roles.warn, roles.fill])
  for (const node of texts) expect(allowed.has(String(node.props?.color))).toBe(true)
  const content = (node: Node) => String(node.children ?? node.props?.children ?? '')
  expect(texts.filter(node => node.props?.color === roles.ok).map(content)).toEqual(['закрыта'])
  expect(texts.filter(node => node.props?.color === roles.fail).map(content)).toEqual(['отклонена'])
  expect(texts.find(node => content(node) === '  Ответ')?.props?.color).toBe(roles.fg)
  expect(texts.filter(node => /^[яа·] /u.test(content(node))).map(node => node.props?.color)).toEqual(Array(4).fill(roles.muted))
})

// Одна система: цвет «в работе» — у всей карточки группы «В РАБОТЕ» и у строки над вводом; блик — только там, где
// кто-то исполняет прямо сейчас; задача очереди остаётся обычным текстом.
for (const bg of ['#ffffff', '#1e1e1e', '']) for (const working of [false, true]) test(`COLORS-3: в работе — цвет, исполняется — блик: ${bg || 'неизвестный фон'}, ход ${working ? 'идёт' : 'не идёт'}`, () => {
  const theme = { ...DEFAULT_THEME, bg }, roles = roleColors(theme)
  const own = { ...TASK, steps: [{ position: 0, title: 'Проверить', status: 'active' as const }] }
  const delegated = { ...own, taskId: 'delegated', alias: 'TASK-2', title: 'Задача исполнителя', queuePosition: 2 }
  const waiting = { ...own, taskId: 'waiting', alias: 'TASK-3', title: 'Задача очереди', queuePosition: 3 }
  const state = seeded(own)
  state.snapshot!.tasks = [own, delegated, waiting]
  const view = { cursor: '', expanded: new Set<string>(), collapsed: new Set<string>(), offset: 0, limit: 30, working,
    peers: new Map([[delegated.taskId, [{ jobId: 'c'.repeat(32), agent: 'codex' as const, mode: 'implement' as const, status: 'running' as const, createdAt: 0, startedAt: 0 }]]]) }
  const rows = taskRows(state, view, 80, 0, theme)
  const cards = rows.filter(row => row.kind === 'card')
  expect(cards.map(row => [row.taskId, row.group, row.shimmer])).toEqual([[TASK.taskId, 'now', working], [delegated.taskId, 'now', true], [waiting.taskId, 'queue', false]])
  const tree = nodes(drawTaskCards(ui, rowsProps(rows, view, theme), () => {}, 3))
  const title = (taskId: string) => nodes(tree.find(node => node.props?.key === `title:${taskId}:0`)).filter(node => node.type === 'Text')
  const glint = new Set(activityTones(theme).bright)
  for (const taskId of [TASK.taskId, delegated.taskId, waiting.taskId]) {
    const inWork = taskId !== waiting.taskId, lit = taskId === delegated.taskId || (taskId === TASK.taskId && working)
    expect(title(taskId)[0]?.props?.bold).toBe(true)
    if (lit) for (const letter of title(taskId).slice(1)) expect(glint.has(String(letter.props?.color))).toBe(true)
    else expect(title(taskId)[0]?.props?.color).toBe(inWork ? roles.work : theme.fg || undefined)
    expect(tree.find(node => node.props?.key === `card:${taskId}`)?.props?.borderColor).toBe(inWork ? roles.work : roles.muted)
    expect(tree.find(node => node.props?.key === `number:${taskId}`)?.props?.color).toBe(inWork ? roles.work : roles.muted)
    expect(tree.find(node => node.props?.key === `worker:${taskId}`)?.props?.color).toBe(inWork ? roles.work : undefined)
  }
  // Строка над вводом подчиняется тому же правилу: текущая задача всегда цветом «в работе» и жирная, блик — только в ходе.
  const band = bandRow(state, 80, 0, theme, working)!
  const name = band.left.at(-1)!
  expect(name.b).toBe(true)
  expect(working ? name.sh : name.c).toBe(working ? 'task' : roles.work)
  expect(band.left[0]?.c).toBe(roles.work)
})


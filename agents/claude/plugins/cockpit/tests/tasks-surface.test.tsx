import { inputEditor, findEditor, expectEditorHover, promptEditHost, pasted } from './editor-driver'
import { EDITOR_FOCUS_TTL_MS, type EditorProps } from '../hooks/editor'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'
import type { CommandRunInput, ModelCompleteRequest, On, PromptFillArgs, RenderChildren, RenderElement, RenderPropsOf, PaneOpenArgs, UiPane } from 'claude-code'
import type { Request } from '../hooks/domain/rpc'
import { buildRequest, HUMAN_WRITES } from '../hooks/domain/rpc'
import type { AgentTaskNote, Checkpoint, Task, TaskContext, Snapshot, Projection, OwnerComment, OwnerTask, TaskWorkTrails } from '../types/index'
import { seeded, snapshot, TASK, CHECKPOINT, reply } from './fixtures'
import { actionCaption, actionSpans, type PanelActionsProps } from '../hooks/panel-actions'
import { DEFAULT_THEME, roleColors } from '../hooks/theme'
import { faint } from '../hooks/theme'
import { cellWidth } from '../hooks/layout'
import { MARK, type TaskCardsProps } from '../hooks/tasks'
import type { PageLine, TaskPageProps } from '../hooks/task-page-model'
import { tabSpans, type TaskTabsProps } from '../hooks/task-tabs'
import { taskTabTitle, TASK_ICON, PAGE_RULE_ROOM } from '../hooks/register'
import { gitReply, START_REVISION, LATER_REVISION, type GitFixture } from './work-trail-fixtures'
import { CARD_HOVER } from '../hooks/card-controls'
import { PAGE_TAB_ICONS, TASK_TAB_ICONS } from '../hooks/icons'

// Вкладку страницы переключает нажатие на неё: клавиш переключения и скрытых кнопок у страницы нет.
async function pageTab(pane: Mounted<'terminal', 'Pane'>, tab: 'description' | 'comments'): Promise<void> {
  const tabs = (await pane.find({ type: 'Client', key: 'page-tabs' }))?.props.props as TaskTabsProps
  const span = tabSpans(tabs).find(item => item.tab.id === tab)!
  await pane.pointer({ in: 'page-tabs', type: 'up', button: 'left', x: span.left + 1, y: 0 })
}

// Окно отдаёт только видимые строки: вкладка читается целиком прокруткой от начала до конца.
async function wholeTab(pane: Mounted<'terminal', 'Pane'>): Promise<PageLine[]> {
  const props = async () => (await pane.find({ type: 'Client', key: 'page-content' }))?.props.props as TaskPageProps
  await pane.key({ key: 'home', in: 'page-content' })
  const seen = new Map<string, PageLine>()
  for (;;) {
    const view = await props()
    for (const line of view.lines) seen.set(line.id, line)
    if (view.offset + view.height >= view.total) break
    await pane.key({ key: 'pagedown', in: 'page-content' })
  }
  await pane.key({ key: 'home', in: 'page-content' })
  return [...seen.values()]
}

for (const width of [40, 60]) test(`HOVER-1: покой, задержка 200 мс и немедленное сворачивание без сообщений хуку: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  taskHost(on, { ...CARD, description: 'Подробности раскрытой задачи' }, { tasks: [{ ...CARD, description: 'Подробности раскрытой задачи' }, QUEUED] })
  let messages = 0
  on('ui.message', { element: 'rows' }, () => { messages += 1; return {} })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  const text = async () => drawnText(await pane.drawn({ in: 'rows' }))
  const props = (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  const current = props.rows.find(row => row.kind === 'card')!
  expect(await text()).not.toContain('Подробности раскрытой задачи')
  expect(current.height).toBe(2 + (current.kind === 'card' ? current.titleLines.length : 0))
  await pane.pointer({ in: 'rows', type: 'move', x: 4, y: 2 })
  await pane.advance(199)
  expect(await text()).not.toContain('Подробности раскрытой задачи')
  await pane.advance(1)
  expect(await text()).toContain('Подробности раскрытой задачи')
  await pane.pointer({ in: 'rows', type: 'leave', x: -1, y: -1 })
  expect(await text()).not.toContain('Подробности раскрытой задачи')
  expect(messages).toBe(0)
  await pane.unmount()
})

test('HOVER-2: пролёт не раскрывает; клавиша i переключает выбранную карточку, Enter открывает страницу', { options: { glyphs: 'plain' } }, async ($, on) => {
  taskHost(on, { ...CARD, description: 'Текст для раскрытия' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const text = async () => drawnText(await pane.drawn({ in: 'rows' }))
  expect(await text()).not.toContain('Текст для раскрытия')
  await pane.pointer({ in: 'rows', type: 'move', x: 3, y: 2 })
  await pane.advance(100)
  await pane.pointer({ in: 'rows', type: 'move', x: 3, y: 0 })
  await pane.advance(220)
  expect(await text()).not.toContain('Текст для раскрытия')
  await pane.key({ in: 'rows', key: 'i' })
  expect(await text()).toContain('Текст для раскрытия')
  await pane.key({ in: 'rows', key: 'i' })
  expect(await text()).not.toContain('Текст для раскрытия')
  // Клавиша работает без строки-подсказки: постоянных подсказок о клавишах в панели нет.
  const header = (await pane.find({ type: 'Client', key: 'panel-header' }))!.props.props as PanelActionsProps
  expect(header.hint).toBe('')
  expect(drawnText(await pane.drawn({ in: 'panel-header' }))).not.toContain('[i]')
  await pane.key({ in: 'rows', key: 'return' })
  expect(await pane.find({ type: 'Client', key: 'page-content' })).toBeDefined()
  await pane.unmount()
})

for (const tab of ['backlog', 'history'] as const) test(`HOVER-3: раскрытие описания во вкладке ${tab}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const other = { ...QUEUED, status: tab === 'history' ? 'done' as const : 'paused' as const, description: 'Текст другой вкладки' }
  taskHost(on, CARD, { tasks: [CARD, other] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ in: 'rows', key: tab === 'history' ? 'h' : 'z' })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain('Текст другой вкладки')
  await pane.pointer({ in: 'rows', type: 'move', x: 3, y: tab === 'history' ? 2 : 1 })
  await pane.advance(200)
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('Текст другой вкладки')
  await pane.pointer({ in: 'rows', type: 'leave', x: -1, y: -1 })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain('Текст другой вкладки')
  await pane.unmount()
})

for (const width of [30, 60, 100]) for (const rows of [8, 20]) test(`Страница с вкладками сохраняет содержимое, номер и бюджет: ${width}x${rows}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const task = { ...CARD, alias: 'TASK-186', title: 'Название задачи с широкими знаками 界 и ' + ('а' + String.fromCharCode(0x301)).repeat(40),
    description: 'Первый абзац\n\nГотово, когда: Проверка\n• Критерий\n• Критерий\n\nПоследний абзац', acceptance: ['Критерий\nВторая строка'], constraints: ['Ограничение\nЕго продолжение'], lastCheckpoint: undefined }
  const note = { ...HISTORY_RESULT, taskId: task.taskId, kind: 'note' as const, text: 'Заметка агента\n\nКонец заметки' }
  taskHost(on, task, { comments: [COMMENTS[0]!], agentNotes: [note], checkpoints: [{ ...CHECKPOINT, kind: 'detour', source: 'engine' }],
    ownerChanges: [{ eventId: 1, taskId: task.taskId, action: 'edited', createdAt: task.updatedAt }, { eventId: 2, taskId: task.taskId, action: 'completed', createdAt: task.updatedAt }] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width, scroll: { offset: 0, bodyRows: rows } } })
  await pane.key({ key: 'o', in: 'rows' })
  const props = async () => (await pane.find({ type: 'Client', key: 'page-content' }))?.props.props as TaskPageProps
  // Вкладки стоят под разделителем. Номер задачи — в шапке панели над ним, жирным цветом акцента, там же, где
  // при наведении появляются подписи значков; «Описание» начинается с названия.
  expect(await pane.find({ type: 'Box', key: 'page-title' })).toBeUndefined()
  const header = async () => (await pane.find({ type: 'Client', key: 'panel-header' }))?.props.props as PanelActionsProps
  expect((await header()).title).toBe(` #${task.alias.slice(5)}`)
  const number = elements(await pane.drawn({ in: 'panel-header' })).find(node => node.type === 'Text' && drawnText(node) === ` #${task.alias.slice(5)}`)
  expect(number?.type === 'Text' ? [number.props.bold, number.props.color] : null).toEqual([true, roleColors(DEFAULT_THEME).accent])
  // На низкой панели строка разделителя отдана содержимому.
  const rule = await pane.find({ type: 'Box', key: 'page-rule' })
  if (rows - 3 >= PAGE_RULE_ROOM) expect(drawnText(asTree(rule))).toBe('─'.repeat(width))
  else expect(rule).toBeUndefined()
  const description = await props()
  expect(description.lines[0]?.kind).toBe('title')
  expect(description.tab).toBe('description')
  expect(description.height).toBeGreaterThan(0)
  const whole = await wholeTab(pane)
  expect(whole.filter(line => line.kind === 'heading').map(line => line.text)).toEqual(['Задача:', 'Приёмка:', 'Ограничения:'])
  expect(whole.some(line => line.kind === 'description' && line.text.includes('Первый абзац'))).toBe(true)
  expect(whole.some(line => line.text.includes('Готово, когда'))).toBe(false)
  expect(whole.some(line => line.text.includes(`#${task.alias.slice(5)}`))).toBe(false)
  expect(await pane.find({ key: `page-comment:${task.taskId}` })).toBeUndefined()
  const tabProps = (await pane.find({ type: 'Client', key: 'page-tabs' }))?.props.props as TaskTabsProps
  expect(tabProps.tabs.map(tab => [tab.label, tab.active])).toEqual([['Описание', true], ['Комментарии 4', false]])
  const descriptions = tabSpans(tabProps).find(span => span.tab.id === 'comments')!
  await pane.pointer({ in: 'page-tabs', type: 'move', x: descriptions.left + 1, y: 0 })
  const hovered = elements(await pane.drawn({ in: 'page-tabs' })).find(node => node.type === 'Text' && drawnText(node).includes('Комментарии 4'))
  expect(hovered?.props.color).toBe(tabProps.hover)
  await pane.pointer({ in: 'page-tabs', type: 'up', button: 'left', x: descriptions.left + 1, y: 0 })
  const comments = await props()
  expect(comments.tab).toBe('comments')
  expect(comments.lines.some(line => line.kind === 'title')).toBe(false)
  expect((await header()).title).toBe(` #${task.alias.slice(5)}`)
  expect(comments.height).toBeGreaterThan(0)
  expect(comments.lines.some(line => ['comment', 'note', 'trail'].includes(line.kind) && line.text.trim())).toBe(true)
  expect(comments.lines.some(line => line.text.includes('Задача изменена'))).toBe(false)
  const chosen = elements(await pane.drawn({ in: 'page-tabs' })).find(node => node.type === 'Text' && drawnText(node).includes('Комментарии 4'))
  expect(chosen?.props.backgroundColor).toBe(tabProps.fill)
  for (const view of [description, comments]) for (const line of view.lines) expect(cellWidth(line.text)).toBeLessThanOrEqual(width - 4)
  const pageBox = await pane.find({ type: 'Box', key: `task-page:${task.taskId}` })
  const tree = asTree(pageBox)
  const children = isElement(tree) && 'children' in tree ? tree.children : []
  const height = (Array.isArray(children) ? children : [children]).reduce((total, child) => total + (isElement(child) ? child.type === 'Text' ? 1 : Number(child.props?.height ?? 0) : 0), 0)
  expect(height).toBe(rows - 3)
  expect(comments.lines.length).toBeLessThanOrEqual(comments.height)
  expect(await pane.find({ key: 'work-scrollbar' })).toBeUndefined()
  // Подсказки о клавишах вкладок нет, и клавиши d и c вкладку не переключают.
  expect(await pane.find({ key: 'page-tab-hint' })).toBeUndefined()
  for (const where of ['page-tabs', 'page-content'] as const) {
    await pane.key({ key: 'd', in: where })
    expect((await props()).tab).toBe('comments')
  }
  await pageTab(pane, 'description')
  expect((await props()).tab).toBe('description')
  for (const where of ['page-tabs', 'page-content'] as const) {
    await pane.key({ key: 'c', in: where })
    expect((await props()).tab).toBe('description')
  }
  await pane.key({ key: 'end', in: 'page-content' })
  const bottom = await props()
  expect(bottom.offset).toBe(bottom.total - bottom.height)
  expect(bottom.lines.at(-1)?.text).toContain('Его продолжение')
  // После возврата к списку номера в шапке нет.
  await pane.key({ key: 'q', in: 'page-content' })
  expect((await header()).title).toBe('')
  await pane.unmount()
})

test('Вкладки страницы со значками; в наборе без Nerd Font — только названия', { options: { glyphs: 'nerd' } }, async ($, on) => {
  taskHost(on, { ...CARD, lastCheckpoint: undefined }, { comments: COMMENTS, checkpoints: [] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' })
  const tabs = (await pane.find({ type: 'Client', key: 'page-tabs' }))?.props.props as TaskTabsProps
  expect(tabs.tabs.map(tab => tab.label)).toEqual([`${PAGE_TAB_ICONS.description} Описание`, `${PAGE_TAB_ICONS.comments} Комментарии ${COMMENTS.length}`])
  // Значок входит в ширину вкладки: нажатие на него тоже переключает.
  const span = tabSpans(tabs).find(item => item.tab.id === 'comments')!
  await pane.pointer({ in: 'page-tabs', type: 'up', button: 'left', x: span.left, y: 0 })
  expect(((await pane.find({ type: 'Client', key: 'page-content' }))?.props.props as TaskPageProps).tab).toBe('comments')
  await pane.unmount()
})

for (const width of [100, 40]) test(`Вкладки панели со значками; на узкой панели неактивные — значок со счётчиком: ${width}`, { options: { glyphs: 'nerd' } }, async ($, on) => {
  taskHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  const tabs = async () => (await pane.find({ type: 'Client', key: 'tabs' }))?.props.props as TaskTabsProps
  const name = (id: keyof typeof TASK_TAB_ICONS, text: string, active: boolean) => `${TASK_TAB_ICONS[id]} ${width === 100 || active ? `${text} ` : ''}`
  expect((await tabs()).tabs.map(tab => tab.label)).toEqual([`${name('agent', 'Агенту', true)}1`, `${name('owner', 'Мне', false)}0`, `${name('backlog', 'Бэклог', false)}0`, `${name('history', 'История', false)}0`])
  // Название переходит к выбранной вкладке; нажатие на значок без названия переключает её.
  const history = tabSpans(await tabs()).find(span => span.tab.id === 'history')!
  await pane.pointer({ in: 'tabs', type: 'up', button: 'left', x: history.left, y: 0 })
  expect((await tabs()).tabs.map(tab => tab.label)).toEqual([`${name('agent', 'Агенту', false)}1`, `${name('owner', 'Мне', false)}0`, `${name('backlog', 'Бэклог', false)}0`, `${name('history', 'История', true)}0`])
  const spans = tabSpans(await tabs())
  expect(spans.at(-1)!.left + spans.at(-1)!.cells).toBeLessThanOrEqual(width)
  await pane.unmount()
})

test('Вкладка страницы и её прокрутка переживают возврат к списку; старые сообщения вкладки отвергаются', async ($, on) => {
  taskHost(on, { ...CARD, description: 'Абзац\n'.repeat(60).trim() }, { comments: COMMENTS })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' })
  const props = async () => (await pane.find({ type: 'Client', key: 'page-content' }))?.props.props as TaskPageProps
  await pane.key({ key: 'pagedown', in: 'page-content' })
  const description = await props()
  expect(description.offset).toBeGreaterThan(0)
  await pageTab(pane, 'comments')
  expect((await props()).tab).toBe('comments')
  await pane.post({ taskId: CARD.taskId, generation: description.generation, activeTab: 'description', scrollTo: 0 }, { in: 'page-content' })
  await pane.post({ taskId: 'foreign', generation: description.generation, tab: 'description' }, { in: 'page-tabs' })
  await pane.post({ taskId: CARD.taskId, generation: description.generation - 1, tab: 'description' }, { in: 'page-tabs' })
  expect((await props()).tab).toBe('comments')
  await pane.key({ key: 'q', in: 'page-content' }); await pane.press({ key: 'open' })
  expect((await props()).tab).toBe('comments')
  await pageTab(pane, 'description')
  expect((await props()).offset).toBe(description.offset)
  await pane.unmount()
})

test('Ctrl+J добавляет новую строку описания, подсказка видна под редактором, повторная правка сохраняет абзац', async ($, on) => {
  const fixture = taskHost(on, { ...CARD, description: 'Начало' })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pane.press({ key: 'page-description-edit' })
  expect(drawnText(await pane.drawn({ in: 'page-content' }))).toContain('Ctrl+J — новая строка')
  const key = `page-description:${CARD.taskId}`
  await pane.key({ in: key, key: 'end', ctrl: true })
  await pane.key({ in: key, key: 'j', ctrl: true })
  await pane.key({ in: key, key: 'К' })
  await pane.key({ in: key, key: 'return' })
  expect(fixture.calls.filter(call => call.op === 'task.edit').at(-1)?.args.description).toBe('Начало\nК')
  expect(drawnText(await pane.drawn({ in: 'page-content' }))).toContain('Начало')
  await pane.press({ key: 'page-description-edit' })
  expect((await pane.find({ key }))?.props.props.value).toBe('Начало\nК')
  await pane.unmount()
})

test('Протяжка страницы продолжается вне области и завершается при смене вкладки', async ($, on) => {
  taskHost(on, { ...CARD, description: 'Строка описания\n'.repeat(60).trim(), lastCheckpoint: undefined },
    { agentNotes: Array.from({ length: 30 }, (_, index) => progressNote(index)) })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' })
  const props = async () => (await pane.find({ type: 'Client', key: 'page-content' }))?.props.props as TaskPageProps
  const start = await props()
  await pane.pointer({ in: 'page-content', type: 'down', button: 'left', x: start.width - 1, y: 0 })
  await pane.pointer({ in: 'page-content', type: 'leave', x: -1, y: start.height + 1 })
  await pane.pointer({ in: 'page-content', type: 'move', button: 'left', x: -1, y: start.height + 1 })
  const bottom = await props()
  expect(bottom.offset).toBe(bottom.total - bottom.height)
  await pageTab(pane, 'comments')
  const comments = await props()
  await pane.pointer({ in: 'page-content', type: 'move', button: 'left', x: 0, y: 0 })
  expect((await props()).offset).toBe(comments.offset)
  await pageTab(pane, 'description')
  expect((await props()).offset).toBe(bottom.offset)
  await pane.unmount()
})

for (const change of [
  { name: 'строка после пометки и повтор критерия', before: 'Цель\n\nГотово, когда: Проверить ввод\n• Проверить повтор',
    after: 'Цель\n\nГотово, когда: Проверить ввод\n• Проверить повтор\n• Проверить повтор',
    // Пометка хранения на странице не печатается: текст после неё стоит под заголовком «Приёмка:».
    shown: ['Цель', 'Проверить ввод', '• Проверить повтор', '• Проверить повтор'],
    editor: 'Цель\n\nПриёмка:\nПроверить ввод\n• Проверить повтор\n• Проверить повтор' },
  { name: 'новый абзац без пометки', before: 'Первый абзац', after: 'Первый абзац\n\nНовый абзац' },
  { name: 'правка середины', before: 'Начало\nСередина\nКонец', after: 'Начало\nИзменённая середина\nКонец' },
] as { name: string; before: string; after: string; shown?: string[]; editor?: string }[]) test(`Описание после сохранения показывает исходные строки на месте: ${change.name}`, async ($, on) => {
  const fixture = taskHost(on, { ...CARD, description: change.before, acceptance: [], constraints: [] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, scroll: { offset: 0, bodyRows: 20 } } })
  await pane.press({ key: 'open' }); await pane.press({ key: 'page-description-edit' })
  await inputEditor(pane, { key: `page-description:${CARD.taskId}`, text: change.after, kind: 'submit' })
  expect(fixture.calls.filter(call => call.op === 'task.edit').at(-1)?.args.description).toBe(change.after)
  const props = (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  expect(props.lines.filter(line => line.kind === 'description' || line.kind === 'criteria').map(line => line.text)).toEqual(change.shown ?? change.after.split('\n'))
  await pane.press({ key: 'page-description-edit' })
  expect((await pane.find({ type: 'Client', key: `page-description:${CARD.taskId}` }))?.props?.props?.value).toBe(change.editor ?? change.after)
  await pane.unmount()
})

for (const width of [40, 60, 100]) test(`Общая шапка: вкладки, только применимые значки одной ячейки и подписи наведения: ${width}`, async ($, on) => {
  const fixture = taskHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  const client = await pane.find({ key: 'panel-header', type: 'Client' })
  expect(client?.props?.module).toBe('hooks/card-panel-header.tsx')
  const props = client?.props?.props as PanelActionsProps
  expect(props.plugin).toBe('cockpit')
  expect(props.accent).toBe(roleColors(DEFAULT_THEME).accent)
  expect(props.title).toBe('')
  expect(((await pane.find({ type: 'Client', key: 'tabs' }))?.props?.props as { tabs: { label: string; active: boolean }[] }).tabs.map(tab => [tab.label, tab.active])).toEqual([['Агенту 1', true], ['Мне 0', false], ['Бэклог 0', false], ['История 0', false]])
  const header = await pane.drawn({ in: 'panel-header' })
  const nodes = elements(header)
  const buttons = nodes.filter(node => node.type === 'Button')
  expect(buttons.map(node => node.props?.key)).toEqual(['new'])
  // Значки карточки рисует модуль карточек, на её же рамке; хук поверх списка их не кладёт.
  const controls = elements(await pane.drawn({ in: 'rows' })).filter(node => node.type === 'Button' && ['open', 'defer', 'delete'].includes(String(node.props.key)))
  expect(controls.map(node => node.props.key)).toEqual(['open', 'defer', 'delete'])
  expect(elements(await pane.drawn()).some(node => node.type === 'Button' && ['open', 'defer', 'delete'].includes(String(node.props.key)))).toBe(false)
  expect(buttons.some(node => node.props?.key === 'append')).toBe(false)
  expect(await pane.find({ key: 'append' })).toBeUndefined()
  for (const button of buttons) if (button.type === 'Button') {
    expect(cellWidth(button.props?.label ?? '')).toBe(1)
    expect(button.props?.label).not.toMatch(/\p{L}/u)
    const caption = nodes.find(node => node.type === 'Box' && node.props?.key === `caption-${button.props?.key}`)
    expect(caption?.type === 'Box' ? caption.props?.display : null).toBe('none')
    type Hovered = { hover?: { scope?: string } }
    expect(caption?.type === 'Box' ? (caption.props as Hovered | undefined)?.hover?.scope : null).toBe((button.props as Hovered | undefined)?.hover?.scope)
  }
  expect(await pane.find({ type: 'Button', key: 'queue' })).toBeUndefined()
  expect(fixture.calls.filter(call => call.op === 'config.set')).toHaveLength(0)
  await pane.key({ key: 'tab', in: 'panel-header' })
  await pane.key({ key: 'tab', in: 'panel-header' })
  expect(drawnText(await pane.drawn({ in: 'panel-header' }))).toContain('Новая задача  [n]')
  // Подпись начинается с того же значка, на который наведён указатель.
  const newTask = ((await pane.find({ type: 'Client', key: 'panel-header' }))!.props.props as PanelActionsProps).actions.find(action => action.key === 'new')!
  expect(actionCaption(newTask)).toBe(`${newTask.label} Новая задача  [n]`)
  await pane.unmount()
})

const CARD: Task = { ...TASK, stage: 'task', sourcePhrase: 'Исправить панель задач', lastCheckpoint: CHECKPOINT, queuePosition: 1,
  elapsedMs: 70_000, activeSince: null, steps: [{ position: 0, title: 'Собрать ряды', status: 'done' }, { position: 1, title: 'Проверить тему', status: 'active' }] }
const PANE: RenderPropsOf['Pane'] = { title: 'Задачи', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 24 }, view: {} }
const BAND: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }

function peerFiles(on: On, states: Record<string, unknown>, unstable = () => false) {
  const root = '/fixture-home/.local/state/agent-config/peer-agents'
  const reads: string[] = []
  let revision = 1, statSequence = 0
  on('fs.stat', (_$, e) => {
    if (e.path === root) return { value: { kind: 'dir' as const, isLink: false, realPath: root, size: 0, mtimeMs: revision } }
    const id = e.path.slice(root.length + 1, -5)
    if (!e.path.startsWith(root + '/') || !e.path.endsWith('.json') || !(id in states)) throw new Error('Нет файла фикстуры')
    return { value: { kind: 'file' as const, isLink: false, realPath: e.path, size: new TextEncoder().encode(JSON.stringify(states[id])).length, mtimeMs: revision + (unstable() ? ++statSequence : 0) } }
  })
  on('fs.read', (_$, e) => {
    const id = e.path.slice(root.length + 1, -5)
    if (!e.path.startsWith(root + '/') || !(id in states)) throw new Error('Нет файла фикстуры')
    reads.push(id)
    return { value: JSON.stringify(states[id]) }
  })
  return { reads, change(id: string, value: unknown) { states[id] = value; revision++ } }
}
const JOB_CODEX = 'a'.repeat(32)
const JOB_AGY = 'b'.repeat(32)
// Завершённое задание кончается через completedIn секунд после начала теста: раньше его конца агент о нём знать не мог.
function peerState(id: string, status = 'running', agent = 'codex', source = '/fixture', completedIn = 5) {
  const now = Date.parse('2026-10-05T04:00:00Z') / 1000
  return { job_id: id, agent, mode: 'implement', task_size: 'medium', status, source_cwd: source, created_at: now - 100, started_at: now - 90,
    ...(status === 'running' || status === 'queued' ? {} : { completed_at: now + completedIn }) }
}

for (const line of ['Задача: #2', 'Задачи: #2, #3']) test(`JOBS-1: строка задания задаёт только его задачи: ${line}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const third = { ...QUEUED, taskId: 'third', alias: 'TASK-3' }
  const world = taskHost(on, CARD, { tasks: [CARD, { ...QUEUED, alias: 'TASK-2' }, third] })
  on('tool.call', { tool: 'mcp__peer_agents__delegate_codex' }, () => ({ result: JSON.stringify({ job_id: JOB_CODEX, agent: 'codex' }) }))
  await $.tool.call({ tool: 'mcp__peer_agents__delegate_codex', mode: 'implement', task: `${line}\nТекст задания хранить нельзя` })
  expect(world.workTrails[CARD.taskId]?.jobs ?? []).toEqual([])
  expect(world.workTrails[QUEUED.taskId]?.jobs.map(job => job.jobId)).toEqual([JOB_CODEX])
  expect(world.workTrails[third.taskId]?.jobs.map(job => job.jobId) ?? []).toEqual(line.includes('#3') ? [JOB_CODEX] : [])
  expect(JSON.stringify(world.workTrails)).not.toContain('Текст задания')
})

for (const width of [30, 40, 60, 100]) test(`JOBS-2: три задачи в работе, блик только идущему заданию, на рамке счётчики значками: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const third = { ...QUEUED, taskId: 'third', alias: 'TASK-3' }
  taskHost(on, CARD, { tasks: [CARD, { ...QUEUED, alias: 'TASK-2' }, third], workTrails: {
    [QUEUED.taskId]: { jobs: [{ jobId: JOB_CODEX, agent: 'codex', mode: 'implement' }] },
    [third.taskId]: { jobs: [{ jobId: JOB_AGY, agent: 'antigravity', mode: 'implement' }] },
  } })
  peerFiles(on, { [JOB_CODEX]: peerState(JOB_CODEX), [JOB_AGY]: peerState(JOB_AGY, 'completed', 'antigravity') })
  on('ui.panes', () => ({ value: [{ id: 'tasks', title: 'Задачи', isShown: true, isPlaced: true, isFocused: true }] }))
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  const props = (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  expect(props.rows.filter(row => row.kind === 'heading').map(row => row.label)).toEqual(['В РАБОТЕ'])
  const cards = props.rows.filter(row => row.kind === 'card')
  expect(cards.map(row => [row.taskId, row.shimmer])).toEqual([[CARD.taskId, false], [QUEUED.taskId, true], [third.taskId, false]])
  const nodes = elements(await pane.drawn({ in: 'rows' }))
  // На рамке — счётчики: сколько исполнителей заняты задачей и сколько результатов ждут сверки. Слов на рамке нет.
  const frames = nodes.filter(node => node.type === 'Box' && String(node.props?.key).startsWith('worker-frame:'))
  expect(Object.fromEntries(frames.map(node => [String(node.props?.key).slice('worker-frame:'.length), drawnText(node).trim()])))
    .toEqual({ [CARD.taskId]: '▶ 1', [QUEUED.taskId]: '▶ 1', [third.taskId]: '✓ 1' })
  for (const frame of frames) {
    const counter = elements(asTree(frame)).filter(node => node.type === 'Text')
    expect(counter.map(node => node.props?.color)).toEqual([roleColors(DEFAULT_THEME).work])
    expect(cellWidth(drawnText(frame))).toBeLessThanOrEqual(width - 4)
  }
  for (const word of ['агент', 'Codex', 'ждёт сверки']) expect(drawnText(nodes)).not.toContain(word)
  // Кто именно занят, сказано словами в подписи: она появляется в шапке при наведении на счётчики и начинается с них же.
  expect(cards.map(row => row.workerLabel)).toEqual(['В работе: агент ждёт хода', 'В работе: Codex 1 мин', 'Ждёт сверки: Antigravity'])
  const header = (await pane.find({ type: 'Client', key: 'panel-header' }))!.props.props as PanelActionsProps
  const caption = header.actions.find(action => action.key === `card-${third.taskId}-workers`)!
  expect(caption).toMatchObject({ label: '✓ 1', hint: 'Ждёт сверки: Antigravity', hidden: true })
  expect(actionCaption(caption)).toBe('✓ 1 Ждёт сверки: Antigravity')
  await pane.unmount()
})

test('JOBS-3: опрос останавливается при скрытии и после завершения, чужой проект отсечён', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = taskHost(on, CARD, { tasks: [CARD, QUEUED], workTrails: { [QUEUED.taskId]: { jobs: [{ jobId: JOB_CODEX, agent: 'codex', mode: 'implement' }] } } })
  const files = peerFiles(on, { [JOB_CODEX]: peerState(JOB_CODEX) })
  let shown = true
  on('ui.panes', () => ({ value: [{ id: 'tasks', title: 'Задачи', isShown: shown, isPlaced: true, isFocused: shown }] }))
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  expect(files.reads.length).toBeGreaterThan(0)
  shown = false
  const hiddenReads = files.reads.length
  await world.clock.advance(10_000)
  expect(files.reads.length).toBe(hiddenReads)
  shown = true
  files.change(JOB_CODEX, peerState(JOB_CODEX, 'completed'))
  await pane.redraw()
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('✓ 1')
  const completedReads = files.reads.length
  await world.clock.advance(10_000)
  expect(files.reads.length).toBe(completedReads)
  await pane.unmount()
})

test('JOBS-13: перерисовки внутри такта кеша не перечитывают панели и состояние моста', { options: { glyphs: 'plain' } }, async ($, on) => {
  taskHost(on, CARD, { tasks: [CARD, QUEUED], workTrails: { [QUEUED.taskId]: { jobs: [{ jobId: JOB_CODEX, agent: 'codex', mode: 'implement' }] } } })
  const files = peerFiles(on, { [JOB_CODEX]: peerState(JOB_CODEX) })
  let queries = 0
  on('ui.panes', () => { queries++; return { value: [{ id: 'tasks', title: 'Задачи', isShown: true, isPlaced: true, isFocused: true }] } })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const initial = queries
  const reads = files.reads.length
  for (let index = 0; index < 4; index++) await pane.redraw()
  expect(queries).toBe(initial)
  expect(files.reads.length).toBe(reads)
  await pane.unmount()
})

test('HOVER-4: карточка растёт вниз, нижняя помещается и окно возвращается после ухода', { options: { glyphs: 'plain' } }, async ($, on) => {
  const tasks = Array.from({ length: 6 }, (_, index) => ({ ...QUEUED, taskId: `hover-${index}`, alias: `TASK-${index + 2}`, title: `Задача ${index + 2}`, description: 'Описание\n'.repeat(12).trim() }))
  const current = { ...CARD, description: 'Описание\n'.repeat(12).trim() }
  taskHost(on, current, { tasks: [current, ...tasks] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, scroll: { offset: 0, bodyRows: 18 } } })
  const props = (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  const card = props.rows.find(row => row.kind === 'card')!
  const before = Number((await pane.find({ in: 'rows', key: 'card-window', type: 'Box' }))!.props.top)
  const y = props.top + props.rows.slice(0, props.rows.indexOf(card)).reduce((sum, row) => sum + row.height, 0) + 1
  await pane.pointer({ in: 'rows', type: 'move', x: 3, y })
  await pane.advance(200)
  const grown = (await pane.find({ in: 'rows', type: 'Box', key: `card-slot:${card.taskId}` }))!
  expect(Number(grown.props.height) - card.height).toBe(8)
  expect(Number((await pane.find({ in: 'rows', key: 'card-window', type: 'Box' }))!.props.top)).toBe(before)
  await pane.pointer({ in: 'rows', type: 'leave', x: -1, y: -1 })
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 1000, bodyRows: 18, contentRows: 18, origin: { kind: 'person' } })
  const end = (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  const last = end.rows.at(-1)!
  const lastTop = end.top + end.rows.slice(0, -1).reduce((sum, row) => sum + row.height, 0)
  await pane.pointer({ in: 'rows', type: 'move', x: 3, y: lastTop + 1 })
  await pane.advance(200)
  const shifted = Number((await pane.find({ in: 'rows', key: 'card-window', type: 'Box' }))!.props.top)
  expect(shifted).toBe(end.top - 8)
  const lastBox = await pane.find({ in: 'rows', type: 'Box', key: `card-slot:${last.taskId}` })
  expect(lastTop - 8 + Number(lastBox?.props.height)).toBe(end.height)
  await pane.pointer({ in: 'rows', type: 'leave', x: -1, y: -1 })
  expect(Number((await pane.find({ in: 'rows', key: 'card-window', type: 'Box' }))!.props.top)).toBe(end.top)
  await pane.unmount()
})

test('HOVER-5: дочитывание описаний не меняет свёрнутую высоту и полосу прокрутки', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = taskHost(withoutDescriptions(on), CARD, { tasks: [CARD, ...resizeTasks()] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: 40 } })
  const read = async () => (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  const before = await read()
  world.changeTask({ ...CARD, description: 'Дочитанное описание '.repeat(200), revision: CARD.revision + 1 }, true)
  await pane.redraw()
  const after = await read()
  expect(after.totalHeight).toBe(before.totalHeight)
  expect(after.bar).toEqual(before.bar)
  expect(after.rows.map(row => row.height)).toEqual(before.rows.map(row => row.height))
  await pane.unmount()
})

test('HOVER-6: раскрытая карточка обнимает содержимое — строка «Загрузка…», после чтения столько строк, сколько в тексте', { options: { glyphs: 'plain' } }, async ($, on) => {
  const text = ['Первая строка описания.', 'Вторая строка описания.', 'Третья строка описания.'].join('\n')
  const world = taskHost(withoutDescriptions(on), { ...CARD, description: text }, {
    pauseWrite: request => request.op === 'task.get' ? world.clock.sleep(1000) : Promise.resolve(),
  })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const card = async () => ((await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps).rows.find(row => row.kind === 'card' && row.taskId === CARD.taskId) as Extract<TaskCardsProps['rows'][number], { kind: 'card' }>
  const slot = async () => Number((await pane.find({ in: 'rows', key: `card-slot:${CARD.taskId}`, type: 'Box' }))?.props.height)
  const base = (await card()).height
  await pane.pointer({ in: 'rows', type: 'move', x: 3, y: 2 })
  await pane.advance(200)
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('Загрузка •••')
  // Запаса под непрочитанное нет: название и одна строка загрузки.
  expect(await slot()).toBe(base + 1)
  await world.clock.advance(1000)
  const drawn = drawnText(await pane.drawn({ in: 'rows' }))
  expect(drawn).toContain('Третья строка описания.')
  expect(drawn).not.toContain('Загрузка')
  const lines = (await card()).details.length
  expect(lines).toBe(3)
  expect(await slot()).toBe(base + lines)
  expect(world.calls.filter(request => request.op === 'task.get')).toHaveLength(1)
  await pane.unmount()
})

test('LOADER-230: пока описание читается — слово и три точки, светится одна и идёт по кругу; после срока запроса — неподвижный текст', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = taskHost(withoutDescriptions(on), { ...CARD, description: 'Текст, который не успел прийти' }, {
    pauseWrite: request => request.op === 'task.get' ? world.clock.sleep(60_000) : Promise.resolve(),
  })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.pointer({ in: 'rows', type: 'move', x: 3, y: 2 })
  await pane.advance(200)
  const frame = async () => {
    const tree = await pane.drawn({ in: 'rows' })
    const dots = elements(tree).filter(node => node.type === 'Text' && drawnText(node) === '•')
    return { text: drawnText(tree), lit: dots.map(node => node.props.dimColor !== true) }
  }
  const slot = async () => Number((await pane.find({ in: 'rows', key: `card-slot:${CARD.taskId}`, type: 'Box' }))?.props.height)
  const height = await slot()
  const seen: number[] = []
  for (let step = 0; step < 7; step++) {
    const { text, lit } = await frame()
    // Точек всегда три, светится ровно одна: строка не меняет ширину между кадрами.
    expect(text).toContain('Загрузка •••')
    expect(lit).toHaveLength(3)
    expect(lit.filter(Boolean)).toHaveLength(1)
    seen.push(lit.indexOf(true))
    await pane.advance(200)
  }
  for (let step = 1; step < seen.length; step++) expect(seen[step]).toBe((seen[step - 1]! + 1) % 3)
  expect(await slot()).toBe(height)
  // Срок запроса к рантайму вышел: движение останавливается, отказ назван словами.
  await pane.advance(3000)
  const late = await frame()
  expect(late.text).toContain('Описание не прочитано')
  expect(late.text).not.toContain('Загрузка')
  expect(late.lit).toEqual([])
  expect(await slot()).toBe(height)
  await pane.advance(1000)
  expect((await frame()).text).toBe(late.text)
  await pane.unmount()
})

test('HOVER-INPUT: дочитывание описания и перерисовка во время набора сохраняют весь черновик и эпоху', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = taskHost(withoutDescriptions(on), { ...CARD, description: 'Описание догрузилось' }, {
    pauseWrite: request => request.op === 'task.get' ? world.clock.sleep(1000) : Promise.resolve(),
  })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'new' })
  await pane.pointer({ in: 'new-task', type: 'down', x: 2, y: 1, button: 'left' })
  await pane.key({ in: 'new-task', key: 'а' })
  const epoch = (await pane.find({ key: 'new-task' }))!.props.props.epoch
  await pane.key({ in: 'new-task', key: 'б' })
  await world.clock.advance(1000)
  await pane.key({ in: 'new-task', key: 'в' })
  await pane.key({ in: 'new-task', key: 'г' })
  await pane.redraw()
  expect((await pane.find({ key: 'new-task' }))!.props.props.value).toBe('абвг')
  expect((await pane.find({ key: 'new-task' }))!.props.props.epoch).toBe(epoch)
  expect(drawnText(await pane.drawn({ in: 'new-task' }))).toContain('абвг')
  expect(((await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps).rows.some(row => row.kind === 'card' && row.details.includes('Описание догрузилось'))).toBe(true)
  expect(world.calls.filter(request => request.op === 'task.get')).toHaveLength(1)
  await pane.unmount()
})

for (const status of ['failed', 'timed_out', 'cancelled']) test(`JOBS-4: исход ${status}: неудача ждёт сверки без блика, отменённое задание задачу в работе не держит`, { options: { glyphs: 'plain' } }, async ($, on) => {
  taskHost(on, CARD, { tasks: [CARD, QUEUED], workTrails: { [QUEUED.taskId]: { jobs: [{ jobId: JOB_CODEX, agent: 'codex', mode: 'implement' }] } } })
  peerFiles(on, { [JOB_CODEX]: peerState(JOB_CODEX, status) })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const props = (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  const job = props.rows.find(row => row.taskId === QUEUED.taskId)
  // Отменил задание сам агент: сверять нечего.
  expect(job?.kind === 'card' ? job.group : null).toBe(status === 'cancelled' ? 'queue' : 'now')
  expect(job?.kind === 'card' ? job.shimmer : null).toBe(false)
  expect(drawnText(await pane.drawn({ in: 'rows' })).includes('✓ 1')).toBe(status !== 'cancelled')
  await pane.unmount()
})

// «В работе» — столько задач, сколько действительно в процессе: результат, о котором агент уже знает, задачу в группе не держит.
test('JOBS-14: завершённое задание ждёт сверки до начала следующего хода агента либо до чтения результата', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = taskHost(on, CARD, { tasks: [CARD, { ...QUEUED, alias: 'TASK-2' }], workTrails: { [QUEUED.taskId]: { jobs: [
    { jobId: JOB_CODEX, agent: 'codex', mode: 'implement' }, { jobId: JOB_AGY, agent: 'antigravity', mode: 'implement' },
  ] } } })
  const files = peerFiles(on, { [JOB_CODEX]: peerState(JOB_CODEX, 'completed'), [JOB_AGY]: peerState(JOB_AGY, 'running', 'antigravity') })
  on('tool.call', { tool: 'mcp__peer_agents__agent_result' }, () => ({ result: '{}' }))
  on('ui.panes', () => ({ value: [{ id: 'tasks', title: 'Задачи', isShown: true, isPlaced: true, isFocused: true }] }))
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const card = async () => {
    await pane.redraw()
    const row = ((await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps).rows.find(item => item.taskId === QUEUED.taskId)
    return row?.kind === 'card' ? { group: row.group, label: row.workerLabel } : null
  }
  expect(await card()).toEqual({ group: 'now', label: 'В работе: Antigravity 1 мин; Ждёт сверки: Codex' })
  // Ход начался после конца задания Codex: агент о нём узнал. Задачу в работе держит только идущее задание.
  await world.clock.advance(10_000)
  await $.turn.start({ text: 'go', turnId: 'informed' })
  expect(await card()).toEqual({ group: 'now', label: 'В работе: Antigravity 1 мин' })
  expect(String((await $.tool.call({ tool: 'mcp__cockpit__task_list' })).result)).not.toContain('ждёт сверки')
  // Задание, которое кончилось уже во время хода, ждёт сверки, пока агент сам не заберёт результат.
  files.change(JOB_AGY, peerState(JOB_AGY, 'completed', 'antigravity', '/fixture', 60))
  await world.clock.advance(1000)
  expect(await card()).toEqual({ group: 'now', label: 'Ждёт сверки: Antigravity' })
  expect(String((await $.tool.call({ tool: 'mcp__cockpit__task_list' })).result)).toContain('#2 Antigravity ждёт сверки')
  await $.tool.call({ tool: 'mcp__peer_agents__agent_result', job_id: JOB_AGY })
  expect(await card()).toEqual({ group: 'queue', label: '' })
  await pane.unmount()
})

// Один значок у вкладки «Бэклог» и у действия карточки, которое отправляет задачу туда.
test('ICONS-BACKLOG: действие «В бэклог» несёт значок вкладки «Бэклог»', { options: { glyphs: 'nerd' } }, async ($, on) => {
  taskHost(on, CARD, { tasks: [CARD, QUEUED] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const rows = ((await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps).rows
  const controls = rows.flatMap(row => row.kind === 'card' ? row.controls : []).filter(control => control.hint === 'В бэклог')
  expect(controls.length).toBeGreaterThan(0)
  for (const control of controls) expect(control.label).toBe(TASK_TAB_ICONS.backlog)
  const tabs = (await pane.find({ type: 'Client', key: 'tabs' }))!.props.props as TaskTabsProps
  expect(tabs.tabs.find(tab => tab.id === 'backlog')?.label.startsWith(TASK_TAB_ICONS.backlog)).toBe(true)
  await pane.unmount()
})

// Два одинаковых знака на одной рамке — два действия, которые не различить: в наборе без Nerd Font так стояли «В бэклог» и «Ниже».
for (const glyphs of ['nerd', 'plain'] as const) test(`ICONS-DISTINCT: значки действий одной карточки не повторяются: ${glyphs}`, { options: { glyphs } }, async ($, on) => {
  taskHost(on, CARD, { tasks: [CARD, QUEUED, { ...QUEUED, taskId: 'second', alias: 'TASK-3', queuePosition: 4 }, { ...QUEUED, taskId: 'third', alias: 'TASK-4', queuePosition: 5 }] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const cards = ((await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps).rows.flatMap(row => row.kind === 'card' ? [row.controls.map(control => control.label)] : [])
  // Средняя карточка очереди несёт полный набор: открыть, запустить, в бэклог, выше, ниже, удалить.
  expect(Math.max(...cards.map(labels => labels.length))).toBe(6)
  for (const labels of cards) expect(new Set(labels).size).toBe(labels.length)
  await pane.unmount()
})

test('JOBS-5: чужой source_cwd и подменённый идентификатор состояния не активируют задачу', { options: { glyphs: 'plain' } }, async ($, on) => {
  taskHost(on, CARD, { tasks: [CARD, QUEUED], workTrails: { [QUEUED.taskId]: { jobs: [
    { jobId: JOB_CODEX, agent: 'codex', mode: 'implement' }, { jobId: JOB_AGY, agent: 'antigravity', mode: 'implement' },
  ] } } })
  peerFiles(on, { [JOB_CODEX]: peerState(JOB_CODEX, 'running', 'codex', '/other'), [JOB_AGY]: peerState(JOB_CODEX, 'running', 'antigravity') })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const props = (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  expect(props.rows.filter(row => row.kind === 'card' && row.group === 'now').map(row => row.taskId)).toEqual([CARD.taskId])
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain('Codex')
  await pane.unmount()
})

test('JOBS-6: несколько заданий — одна карточка; сводка называет исполнителей и оба состояния', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = taskHost(on, CARD, { tasks: [CARD, { ...QUEUED, alias: 'TASK-2' }], workTrails: { [QUEUED.taskId]: { jobs: [
    { jobId: JOB_CODEX, agent: 'codex', mode: 'implement' }, { jobId: JOB_AGY, agent: 'antigravity', mode: 'implement' },
  ] } } })
  peerFiles(on, { [JOB_CODEX]: peerState(JOB_CODEX, 'queued'), [JOB_AGY]: peerState(JOB_AGY, 'completed', 'antigravity') })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const props = (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  expect(props.rows.filter(row => row.taskId === QUEUED.taskId)).toHaveLength(1)
  const full = String((await $.tool.call({ tool: 'mcp__cockpit__task_list' })).result)
  expect(full).toContain('В работе:')
  expect(full).toContain('#2 Codex идёт, Antigravity ждёт сверки')
  expect(full.length).toBeLessThanOrEqual(6000)
  const short = await $.prompt.submit({ text: 'Продолжай', origin: { kind: 'composer' }, wait: false })
  expect(short.context?.join('\n')).toContain('В работе:')
  expect(short.context?.join('\n').length).toBeLessThanOrEqual(1500)
  world.changeTask({ ...QUEUED, status: 'paused', revision: QUEUED.revision + 1 })
  await pane.redraw()
  const after = (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  expect(after.rows.filter(row => row.taskId === QUEUED.taskId)).toHaveLength(0)
  await pane.unmount()
})

test('JOBS-11: запись состояния между stat и чтением не теряет задание и не прекращает его опрос', { options: { glyphs: 'plain' } }, async ($, on) => {
  let unstable = false
  const world = taskHost(on, CARD, { tasks: [CARD, QUEUED], workTrails: { [QUEUED.taskId]: { jobs: [{ jobId: JOB_CODEX, agent: 'codex', mode: 'implement' }] } } })
  const files = peerFiles(on, { [JOB_CODEX]: peerState(JOB_CODEX) }, () => unstable)
  // Панель в списке показанных: опрос идёт самим таймером, как в живом движке. Без списка панелей такт таймера
  // останавливает опрос, и состояние обновляла бы только посторонняя перерисовка.
  on('ui.panes', () => ({ value: [{ id: 'tasks', title: 'Задачи', isShown: true, isPlaced: true, isFocused: true }] }))
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const card = async () => ((await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps).rows.find(row => row.taskId === QUEUED.taskId)
  unstable = true; files.change(JOB_CODEX, peerState(JOB_CODEX, 'completed'))
  await world.clock.advance(1000)
  expect(await card()).toMatchObject({ shimmer: true, group: 'now' })
  unstable = false
  await world.clock.advance(1000)
  expect(await card()).toMatchObject({ shimmer: false, group: 'now' })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('✓ 1')
  const finished = files.reads.length
  await world.clock.advance(10_000)
  expect(files.reads.length).toBe(finished)
  await pane.unmount()
})

// Текстовый отчёт берёт строки и накладки рамок из дерева настоящего Client оснастки.
function listPreview(props: TaskCardsProps, tree: RenderChildren): string {
  const nodes = elements(tree)
  const find = (key: string) => nodes.find(node => node.props?.key === key)
  const paint = (line: string, left: number, text: string) => line.slice(0, left) + text + line.slice(left + cellWidth(text))
  const lines: string[] = []
  for (const row of props.rows) {
    if (row.kind !== 'card') { lines.push(drawnText(asTree(find(row.id)))); continue }
    const card = find(`card:${row.taskId}`)
    const height = Number(card?.props?.height)
    const width = row.width
    let top = '╭' + '─'.repeat(width - 2) + '╮'
    const number = find(`number-frame:${row.taskId}`)
    if (number) top = paint(top, Number(number.props.left), drawnText(number))
    lines.push(top)
    for (let index = 0; index < height - 2; index++) {
      const text = drawnText(asTree(find(`body:${row.taskId}:${index}`)))
      lines.push('│' + text + ' '.repeat(Math.max(0, width - 2 - cellWidth(text))) + '│')
    }
    let bottom = '╰' + '─'.repeat(width - 2) + '╯'
    for (const key of [`worker-frame:${row.taskId}`, `card-action-frame-${row.taskId}`]) {
      const frame = find(key)
      if (frame) bottom = paint(bottom, Number(frame.props.left), drawnText(frame))
    }
    lines.push(bottom)
  }
  for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(props.width)
  return lines.join('\n')
}

for (const width of [40, 60, 84]) test(`JOBS-PREVIEW: текстовый вид трёх задач в покое, при наведении и клавишей i: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const agent = { ...CARD, title: 'Проверить карточки задач', description: 'Описание работы агента' }
  const codex = { ...QUEUED, alias: 'TASK-2', title: 'Добавить раскрытие карточек', description: 'Показать описание после задержки. Сохранить рамку и действия.' }
  const review = { ...QUEUED, taskId: 'review-task', alias: 'TASK-3', title: 'Проверить несколько задач', description: 'Сверить результат исполнителя' }
  taskHost(on, agent, { tasks: [agent, codex, review], workTrails: {
    [codex.taskId]: { jobs: [{ jobId: JOB_CODEX, agent: 'codex', mode: 'implement' }] },
    [review.taskId]: { jobs: [{ jobId: JOB_AGY, agent: 'antigravity', mode: 'implement' }] },
  } })
  peerFiles(on, { [JOB_CODEX]: peerState(JOB_CODEX), [JOB_AGY]: peerState(JOB_AGY, 'completed', 'antigravity') })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  const props = (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  const idle = listPreview(props, await pane.drawn({ in: 'rows' }))
  const index = props.rows.findIndex(row => row.taskId === codex.taskId)
  await pane.pointer({ in: 'rows', type: 'move', x: 3, y: props.top + props.rows.slice(0, index).reduce((sum, row) => sum + row.height, 0) + 1 })
  await pane.advance(200)
  const expanded = listPreview(props, await pane.drawn({ in: 'rows' }))
  expect(idle).not.toContain('Показать описание')
  expect(expanded).toContain('Показать описание')
  await pane.pointer({ in: 'rows', type: 'leave', x: -1, y: -1 })
  expect(listPreview(props, await pane.drawn({ in: 'rows' }))).toBe(idle)
  await pane.post({ press: props.rows[index]!.id }, { in: 'rows' })
  await pane.key({ in: 'rows', key: 'i' })
  const keyboard = listPreview(props, await pane.drawn({ in: 'rows' }))
  expect(keyboard).toBe(expanded)
  console.log(`TASK-LIST-PREVIEW ${width} idle\n${idle}\nTASK-LIST-PREVIEW ${width} hover\n${expanded}\nTASK-LIST-PREVIEW ${width} keyboard-i\n${keyboard}\nEND-TASK-LIST-PREVIEW`)
  await pane.unmount()
})

test('Нет заголовка Задачи, подвала подсказок и точек-разделителей; разделы приглушены', async ($, on) => {
  taskHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const tree = await pane.drawn()
  expect(drawnText(tree)).not.toContain('Задачи')
  expect(drawnText(tree)).not.toContain('j/k')
  expect(drawnText(tree)).not.toContain('·')
  expect(await pane.find({ type: 'Box', key: 'task-hints' })).toBeUndefined()
  const heading = await pane.find({ in: 'rows', type: 'Box', key: 'group:now' })
  for (const node of elements(asTree(heading)).filter(node => node.type === 'Text')) {
    expect(node.type === 'Text' ? node.props?.color : null).toBe(DEFAULT_THEME.muted)
    expect(node.type === 'Text' ? node.props?.bold : null).not.toBe(true)
  }
  await pane.unmount()
})
// Найденный хостом элемент несёт то же дерево, но объявлен отдельным типом.
function asTree(found: unknown): RenderChildren { return (found ?? null) as RenderChildren }
function drawnText(node: RenderChildren): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(drawnText).join('')
  if (!isElement(node)) return ''
  if (node.type === 'Box' && node.props?.display === 'none') return ''
  if (node.type === 'Button') return node.props?.label
  if (node.type === 'Text' && 'text' in node && typeof node.text === 'string') return node.text
  return 'children' in node ? drawnText(node.children) : ''
}
function isElement(node: RenderChildren): node is RenderElement {
  return node !== null && typeof node === 'object' && 'type' in node
}
// Поле поиска стоит в списке всегда; «поле не открылось» — это про поля редактора.
const isFieldInput = (node: RenderElement): boolean => node.type === 'Input' && node.props?.key !== 'task-search-input'

function elements(node: RenderChildren): RenderElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isElement(node)) return []
  return [node, ...('children' in node ? elements(node.children) : [])]
}
function taskCommand(args = '', command = 'tasks'): CommandRunInput {
  return { command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }
}
// Ответ проверки шрифта; null — «шрифта нет», как у большинства тестов.
let fontProbe: (() => string) | null = null
function taskHost(on: On, task: Task | null = CARD, options: { env?: Record<string, string>; tasks?: Task[]; closed?: Task[]; agentNotes?: AgentTaskNote[]; checkpoints?: Checkpoint[]; ownerChanges?: TaskContext['ownerChanges']; candidates?: Task[]; focusStack?: Snapshot['focusStack']; editConflicts?: number; unknownEdit?: boolean; comments?: OwnerComment[]; commentConflicts?: number; unknownComment?: boolean; readOnly?: boolean; openMode?: 'throw' | 'unplaced'; git?: GitFixture; workTrails?: TaskWorkTrails; followCurrent?: true; pauseWrite?: (request: Request) => Promise<void> } = {}) {
  mock.store(on); mock.env(on, { HOME: '/fixture-home', ...options.env })
  const clock = mock.clock(on, { now: Date.parse('2026-10-05T04:00:00Z') })
  let live: Snapshot = { ...snapshot(task), queue: 'run', storageSchemaVersion: 11, tasks: options.tasks ?? (task ? [task] : []), focusStack: options.focusStack ?? [], candidates: options.candidates ?? [], candidateCount: options.candidates?.length ?? 0 }
  let state: Projection = { ...seeded(task), snapshot: live }; let version = 1
  let workTrails = options.workTrails ?? {}
  let trailVersion = 1
  const calls: Request[] = []; const opens: PaneOpenArgs[] = []; const fills: PromptFillArgs[] = []
  const toasts: string[] = []; const models: ModelCompleteRequest[] = []; const writes: string[] = []; const focuses: string[] = []
  let editConflicts = options.editConflicts ?? 0
  let commentConflicts = options.commentConflicts ?? 0
  let comments = options.comments?.map(comment => ({ ...comment })) ?? []
  let commentNumber = 0
  let prompt = ''
  let promptReadFails = false
  let sessionId = 'fixture-session'
  let cwd = '/fixture'
  const edited = new Map<string, object>()
  const commentReplies = new Map<string, unknown>()
  on('session.id', () => ({ value: sessionId }))
  on('session.cwd', () => ({ value: cwd }))
  if (options.readOnly) on('state.get', { plugin: 'cockpit', key: 'attestations' }, () => ({ value: { version: 1, value: {
    [JSON.stringify(['fixture-session', '/fixture'])]: { ownerRoot: '/other-copy', loadId: 'other-load', epoch: 0, runtimeSessionId: 'fixture-session' },
  } } }))
  on('state.get', { plugin: 'cockpit', key: 'projection' }, () => ({ value: { value: state, version } }))
  on('state.get', { plugin: 'cockpit', key: 'workTrails' }, () => ({ value: { value: workTrails, version: trailVersion } }))
  on('state.set', { plugin: 'cockpit', key: 'workTrails' }, (_$, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== trailVersion) return { value: { isSet: false, version: trailVersion } }
    workTrails = e.value; trailVersion += 1
    return { value: { isSet: true, version: trailVersion } }
  })
  on('state.set', { plugin: 'cockpit', key: 'projection' }, (_$, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    state = e.value; writes.push(JSON.stringify(state)); version += 1
    return { value: { isSet: true, version } }
  })
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'git') return gitReply(e.argv, options.git ?? { nonGit: true })
    if (!e.init?.stdin) return { value: { exitCode: 0, stdout: fontProbe ? fontProbe() : 'missing', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const request: Request = JSON.parse(e.init?.stdin ?? '{}'); calls.push(request)
    await options.pauseWrite?.(request)
    let result: unknown
    switch (request.op) {
      case 'candidate.adopt': {
        const candidate = options.candidates?.find(item => item.taskId === request.args.taskId)
        if (!candidate) throw new Error('Кандидат фикстуры не найден')
        const adopted: Task = { ...candidate, stage: 'task', adoptedBy: 'owner', queuePosition: 2, certainty: 'confirmed', certaintySource: 'user', revision: 1 }
        live = { ...live, candidates: live.candidates?.filter(item => item.taskId !== request.args.taskId), candidateCount: (live.candidateCount ?? 1) - 1, tasks: [...live.tasks, adopted] }
        result = { task: adopted }; break
      }
      case 'candidate.dismiss': {
        live = { ...live, candidates: live.candidates?.filter(item => !request.args.taskIds.includes(item.taskId)), candidateCount: (live.candidateCount ?? 1) - request.args.taskIds.length }
        result = { dismissed: request.args.taskIds, skipped: [] }; break
      }
      case 'task.get': result = { task: [...live.tasks, ...(live.candidates ?? []), ...(options.closed ?? [])].find(item => item.taskId === request.args.taskId) ?? CARD,
        comments, agentNotes: (options.agentNotes ?? []).filter(note => note.taskId === request.args.taskId) }; break
      case 'checkpoint.list': result = { taskId: request.args.taskId, taskRevision: task?.revision ?? CARD.revision,
        checkpoints: (options.checkpoints ?? [CHECKPOINT]).filter(mark => mark.taskId === request.args.taskId) }; break
      case 'tasks.context': {
        const active = live.tasks.filter(task => task.status === 'active' && !task.deleted)
        const deferred = live.tasks.filter(task => task.status === 'paused' && !task.deleted)
        const closed = options.closed ?? live.tasks.filter(task => task.status === 'done' && !task.deleted)
        const queued = active.filter(task => task.taskId !== live.focus.task?.taskId)
        const context: TaskContext = { binding: live.binding, current: live.focus.task ? { ...live.focus.task, description: live.focus.task.description ?? '',
          acceptance: live.focus.task.acceptance ?? [], constraints: live.focus.task.constraints ?? [], ownerNotes: [], ownerComments: comments,
          agentNotes: (options.agentNotes ?? []).filter(note => note.taskId === live.focus.task?.taskId) } : null,
          queue: queued.map(task => ({ ...task, description: task.description ?? '' })), deferred: deferred.slice(0, 10), closed: closed.slice(0, 10),
          ownerChanges: request.args.cursor === undefined ? [] : (options.ownerChanges ?? []).filter(change => change.eventId > request.args.cursor!),
          cursor: Math.max(1, ...(options.ownerChanges ?? []).map(change => change.eventId)), counts: { total: live.tasks.length, open: active.length + deferred.length, active: active.length, queued: queued.length,
            deferred: deferred.length, done: closed.length, cancelled: 0, closedLast24h: closed.length, projectOpen: active.length + deferred.length } }
        result = context; break
      }
      case 'task.comment.add': case 'task.comment.edit': case 'task.comment.delete': {
        if (request.actor !== 'owner' || !request.panelSecret) throw new Error('Запись комментария без аттестации владельца')
        if (commentReplies.has(request.requestId)) { result = commentReplies.get(request.requestId); break }
        const target = request.op === 'task.comment.add' ? undefined : comments.find(comment => comment.commentId === request.args.commentId)
        if (request.op !== 'task.comment.add' && (commentConflicts > 0 || target?.revision !== request.args.expectedRevision)) {
          if (target && commentConflicts > 0) { target.revision += 1; target.text = 'Другая редакция'; target.updatedAt = '2026-10-05T03:00:00.000001Z'; commentConflicts -= 1 }
          return { value: { exitCode: 0, stdout: JSON.stringify({ v: 1, ok: false, error: { code: 'REVISION_CONFLICT' } }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
        }
        if (request.op === 'task.comment.delete') {
          comments = comments.filter(comment => comment.commentId !== request.args.commentId)
          result = { taskId: request.args.taskId, commentId: request.args.commentId, revision: request.args.expectedRevision + 1, deleted: true }
        } else {
          const comment: OwnerComment = request.op === 'task.comment.add'
            ? { commentId: `new-comment-${++commentNumber}`, text: request.args.text, revision: 0, createdAt: '2026-10-05T04:00:00.000001Z', updatedAt: '2026-10-05T04:00:00.000001Z' }
            : { ...target!, text: request.args.text, revision: request.args.expectedRevision + 1, updatedAt: '2026-10-05T04:00:00.000001Z' }
          if (target) comments = comments.map(one => one.commentId === target.commentId ? comment : one)
          else comments.push(comment)
          result = { taskId: request.args.taskId, comment }
        }
        commentReplies.set(request.requestId, result)
        if (options.unknownComment) return { value: { exitCode: 0, stdout: 'ответ оборвался', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
        break
      }
      case 'config.set': {
        if (request.args.key === 'queue') live = { ...live, queue: request.args.value }
        result = { key: request.args.key, value: request.args.value, provenance: 'panel' }; break
      }
      case 'session.rebind': case 'snapshot': result = live; break
      case 'task.create': {
        const added = { ...CARD, taskId: 'task-new', alias: 'TASK-2', title: request.args.title, revision: 0, lastCheckpoint: null,
          certainty: 'confirmed' as const, certaintySource: 'user' as const, certaintyProvenance: 'panel' as const }
        live = { ...live, tasks: [...live.tasks, added] }; result = { task: added, focus: live.focus }; break
      }
      case 'task.action': {
        const target = live.tasks.find(item => item.taskId === request.args.taskId) ?? CARD
        const changed = { ...target, revision: request.args.expectedRevision + 1, status: request.args.action === 'done' ? 'done' as const : request.args.action === 'defer' ? 'paused' as const : request.args.action === 'restore' ? 'active' as const : target.status }
        if (request.args.action === 'defer' || request.args.action === 'restore') live = { ...live, tasks: live.tasks.map(item => item.taskId === changed.taskId ? changed : item),
          focus: live.focus.task?.taskId === changed.taskId ? { task: null, revision: live.focus.revision + 1 } : live.focus }
        if (options.followCurrent && request.args.action === 'current') live = { ...live, tasks: live.tasks.map(item => item.taskId === changed.taskId ? changed : item), focus: { task: changed, revision: live.focus.revision + 1 } }
        result = { task: changed, focus: live.focus }; break
      }
      case 'task.edit': {
        const cached = edited.get(request.requestId)
        if (cached) { result = { task: cached }; break }
        const target = live.tasks.find(item => item.taskId === request.args.taskId) ?? CARD
        if (request.args.description !== undefined && editConflicts > 0) {
          editConflicts -= 1
          const changed = { ...target, description: 'Свежее описание', revision: target.revision + 1 }
          live = { ...live, tasks: live.tasks.map(item => item.taskId === changed.taskId ? changed : item), focus: live.focus.task?.taskId === changed.taskId ? { ...live.focus, task: { ...live.focus.task, ...changed } } : live.focus }
          return { value: { exitCode: 0, stdout: JSON.stringify({ v: 1, ok: false, error: { code: 'REVISION_CONFLICT' } }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
        }
        const changed = { ...target, ...request.args, priorityPinned: request.args.pinned ?? target.priorityPinned, revision: target.revision + 1 }
        live = { ...live, tasks: live.tasks.map(item => item.taskId === changed.taskId ? changed : item), focus: live.focus.task?.taskId === changed.taskId ? { ...live.focus, task: { ...live.focus.task, ...changed } } : live.focus }
        edited.set(request.requestId, changed)
        if (options.unknownEdit && request.args.description !== undefined) return { value: { exitCode: 0, stdout: 'ответ оборвался', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
        result = { task: changed }; break
      }
      default: return { value: { exitCode: 0, stdout: reply(request), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify({ v: 1, ok: true, result }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', (_$, e) => {
    opens.push(e)
    if (options.openMode === 'throw') throw new Error('Панель недоступна')
    return { value: options.openMode === 'unplaced' ? { isPlaced: false as const, reason: 'no surface' } : { isPlaced: true as const } }
  })
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('prompt.fill', (_$, e) => { fills.push(e); prompt = e.mode === 'append' ? prompt + e.text : e.text; return { isFilled: true } })
  on('prompt.read', () => {
    if (promptReadFails) throw new Error('Строка ввода недоступна')
    return { value: { text: prompt, cursor: prompt.length } }
  })
  on('ui.focus', (_$, e) => { focuses.push(e.key); return {} })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 200000 }, rateLimits: [] } }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', (_$, e) => {
    models.push(e)
    throw new Error('Мод Cockpit не должен обращаться к модели')
  })
  return { calls, opens, fills, toasts, models, writes, focuses, clock, get state() { return state }, get workTrails() { return workTrails },
    get comments() { return comments },
    setPrompt(text: string) { prompt = text },
    failPromptRead() { promptReadFails = true },
    get prompt() { return prompt },
    changeSession(nextId: string, nextCwd = '/fixture') { sessionId = nextId; cwd = nextCwd },
    changeTask(changed: Task, focus = false) {
      live = { ...live, tasks: live.tasks.map(item => item.taskId === changed.taskId ? changed : item), ...(focus ? { focus: { task: changed, revision: live.focus.revision + 1 } } : {}) }
      state = { ...state, snapshot: live, focus: live.focus }; version += 1
    },
    changeQueue(value: 'run' | 'paused') { live = { ...live, queue: value } },
    setRuntimeFocus(task: Task) { live = { ...live, tasks: [task], focus: { task, revision: live.focus.revision + 1 } } } }
}

test('INPUT-2: тестовый хост доставляет явно заданную строку в onKey, отдельно от prompt.edit', async ($, on) => {
  taskHost(on)
  const edits = promptEditHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'new' })
  await pane.pointer({ in: 'new-task', type: 'down', x: 2, y: 1, button: 'left' })
  await pane.key({ in: 'new-task', key: 'Явно переданная строка\n🙂' })
  expect(drawnText(await pane.drawn({ in: 'new-task' }))).toContain('Явно переданная строка')
  expect(edits).toEqual([])
  const event = { ...pasted('x'), key: { key: 'x' } }
  expect(await $.prompt.edit(event)).toEqual({ text: 'Оснxовная строка', cursor: 4 })
  expect(edits).toEqual([event])
  expect(drawnText(await pane.drawn({ in: 'new-task' }))).not.toContain('Оснxовная строка')
  expect((await pane.find({ key: 'new-task' }))?.props?.props?.value).toBe('Явно переданная строка\n🙂')
})

test('INPUT-2: вставка через prompt.edit после щелчка идёт в новую задачу и сохраняет основную строку', async ($, on) => {
  taskHost(on)
  const edits = promptEditHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'new' })
  await pane.pointer({ in: 'new-task', type: 'down', x: 2, y: 1, button: 'left' })
  const event = pasted('Вставленный текст\nВторая строка')
  expect(await $.prompt.edit(event)).toEqual({ text: event.text, cursor: event.cursor })
  expect(edits).toEqual([])
  expect(drawnText(await pane.drawn({ in: 'new-task' }))).toContain('Вставленный текст')
  expect((await pane.find({ key: 'new-task' }))?.props?.props?.value).toBe(event.inputText)
})

for (const surface of ['terminal', 'desktop'] as const) for (const field of ['new', 'comment', 'description'] as const)
  test(`INPUT-2: вставка, середина, повтор, каретка и сохранение: ${field}, ${surface}`, { options: { glyphs: 'plain' } }, async ($, on) => {
    const fixture = taskHost(on)
    const edits = promptEditHost(on)
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'tasks', props: PANE })
    if (field === 'new') await pane.press({ key: 'new' })
    else { await pane.press({ key: 'open' }); if (field === 'description') await pane.press({ key: 'page-description-edit' }); else await pageTab(pane, 'comments') }
    const key = field === 'new' ? 'new-task' : `page-${field}:${CARD.taskId}`
    await pane.key({ in: key, key: 'a', ctrl: true })
    const first = pasted('Текст🙂\r\n\tВторая строка')
    expect(await $.prompt.edit(first)).toEqual({ text: first.text, cursor: first.cursor })
    const normalized = first.inputText.replace(/\r\n/gu, '\n')
    expect((await pane.find({ key }))?.props?.props?.value).toBe(normalized)
    expect(drawnText(await pane.drawn({ in: key }))).toContain('Вторая строка')
    await pane.key({ in: key, key: 'home', ctrl: true })
    await pane.key({ in: key, key: 'right' })
    const middle = pasted('ВСТАВКА')
    expect(await $.prompt.edit(middle)).toEqual({ text: middle.text, cursor: middle.cursor })
    expect(await $.prompt.edit(pasted(' ещё'))).toEqual({ text: first.text, cursor: first.cursor })
    await pane.key({ in: key, key: '!' })
    const expected = normalized.slice(0, 1) + 'ВСТАВКА ещё!' + normalized.slice(1)
    // Обычная клавиша отвечает клиенту без перерисовки панели: текст хука читается после явной отрисовки.
    await pane.redraw()
    expect((await pane.find({ key }))?.props?.props?.value).toBe(expected)
    expect(edits).toEqual([])
    await pane.key({ in: key, key: 'return' })
    const request = fixture.calls.filter(call => call.op === (field === 'new' ? 'task.create' : field === 'description' ? 'task.edit' : 'task.comment.add')).at(-1)
    expect(request?.args).toMatchObject(field === 'new' ? { title: expected } : field === 'description' ? { description: expected } : { text: expected })
    const ordinary = pasted('Теперь основная строка')
    expect(await $.prompt.edit(ordinary)).toEqual({ text: ordinary.text.slice(0, 3) + ordinary.inputText + ordinary.text.slice(3), cursor: 3 + ordinary.inputText.length })
    expect(edits).toEqual([ordinary])
  })

for (const field of ['new', 'comment', 'description'] as const)
  test(`INPUT-2: 5000 знаков, переносы, табуляция, кириллица и эмодзи сохраняются в поле: ${field}`, { options: { glyphs: 'plain' } }, async ($, on) => {
    taskHost(on)
    promptEditHost(on)
    const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
    if (field === 'new') await pane.press({ key: 'new' })
    else { await pane.press({ key: 'open' }); if (field === 'description') await pane.press({ key: 'page-description-edit' }); else await pageTab(pane, 'comments') }
    const key = field === 'new' ? 'new-task' : `page-${field}:${CARD.taskId}`
    await pane.key({ in: key, key: 'a', ctrl: true })
    const text = [...'Кириллица🙂\tстрока\n'.repeat(500)].slice(0, 4995).join('') + 'КОНЕЦ'
    expect([...text]).toHaveLength(5000)
    const event = pasted(text)
    expect(await $.prompt.edit(event)).toEqual({ text: event.text, cursor: event.cursor })
    expect((await pane.find({ key }))?.props?.props?.value).toBe(text)
    expect(drawnText(await pane.drawn({ in: key }))).toContain('КОНЕЦ')
    await pane.key({ in: key, key: '!' })
    await pane.redraw()
    expect((await pane.find({ key }))?.props?.props?.value).toBe(text + '!')
  })

for (const condition of ['main-key', 'tab', 'submit', 'cancel', 'timeout', 'escape'] as const)
  test(`INPUT-2: после снятия признака вставка остаётся в основной строке: ${condition}`, { options: { glyphs: 'plain' } }, async ($, on) => {
    const fixture = taskHost(on)
    const edits = promptEditHost(on)
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
    await pane.press({ key: 'new' })
    await pane.pointer({ in: 'new-task', type: 'down', x: 2, y: 1, button: 'left' })
    const initial = pasted('Черновик')
    expect(await $.prompt.edit(initial)).toEqual({ text: initial.text, cursor: initial.cursor })
    if (condition === 'main-key') await $.prompt.edit({ ...pasted('x'), key: { key: 'x' } })
    if (condition === 'tab') { await pane.press({ key: 'tab-backlog' }); await pane.press({ key: 'tab-agent' }) }
    if (condition === 'submit') await pane.key({ in: 'new-task', key: 'return' })
    if (condition === 'cancel') await pane.press({ key: 'new-task-cancel' })
    if (condition === 'timeout') await fixture.clock.advance(EDITOR_FOCUS_TTL_MS + 1)
    if (condition === 'escape') await $.ui.focus({ plugin: 'cockpit', component: 'Pane', requestId: 'tasks', origin: { kind: 'person' } })
    const event = pasted('Обычная вставка')
    const before = edits.length
    expect(await $.prompt.edit(event)).toEqual({ text: 'ОснОбычная вставкаовная строка', cursor: 3 + event.inputText.length })
    expect(edits.slice(before)).toEqual([event])
    if (await pane.find({ key: 'new-task' })) expect((await pane.find({ key: 'new-task' }))?.props?.props?.value).toBe('Черновик')
  })

for (const closed of [false, true]) test(`INPUT-2: вставка без действия в редакторе не перехватывается, панель закрыта=${closed}`, async ($, on) => {
  taskHost(on)
  const edits = promptEditHost(on)
  if (!closed) {
    const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
    await pane.press({ key: 'new' })
  }
  const event = pasted('Текст для Claude Code')
  expect(await $.prompt.edit(event)).toEqual({ text: 'Осн' + event.inputText + 'овная строка', cursor: 3 + event.inputText.length })
  expect(edits).toEqual([event])
})

test('INPUT-2: пустая правка без key не перехватывается и не меняет черновик редактора', async ($, on) => {
  taskHost(on)
  const edits = promptEditHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'new' })
  await pane.pointer({ in: 'new-task', type: 'down', x: 2, y: 1, button: 'left' })
  const event = { ...pasted(''), end: 4 }
  expect(await $.prompt.edit(event)).toEqual({ text: 'Оснвная строка', cursor: 3 })
  expect(edits).toEqual([event])
  expect((await pane.find({ key: 'new-task' }))?.props?.props?.value).toBe('')
  const next = pasted('После пустой правки')
  expect(await $.prompt.edit(next)).toEqual({ text: next.text, cursor: next.cursor })
})

for (const field of ['comment', 'new'] as const) for (const refocus of [false, true])
  test(`INPUT-2: вставка во время сохранения не теряется и не дублируется: ${field}, новый щелчок=${refocus}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const operation = field === 'new' ? 'task.create' : 'task.comment.add'
  const fixture = taskHost(on, CARD, { pauseWrite: request => request.op === operation ? gate : Promise.resolve() })
  const edits = promptEditHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: field === 'new' ? 'new' : 'open' })
  if (field === 'comment') await pageTab(pane, 'comments')
  const key = field === 'new' ? 'new-task' : `page-comment:${CARD.taskId}`
  await inputEditor(pane, { key, text: 'Отправленный текст', kind: 'change' })
  const saving = pane.key({ in: key, key: 'return' })
  const event = pasted('\nДобавление во время сохранения🙂')
  try {
    await fixture.clock.settle()
    expect(fixture.calls.filter(call => call.op === operation)).toHaveLength(1)
    if (refocus) await pane.pointer({ in: key, type: 'down', x: 2, y: 1, button: 'left' })
    expect(await $.prompt.edit(event)).toEqual(refocus ? { text: event.text, cursor: event.cursor }
      : { text: 'Осн' + event.inputText + 'овная строка', cursor: 3 + event.inputText.length })
  } finally { release!() }
  await saving
  await fixture.clock.settle()
  if (field === 'comment') expect(fixture.comments.map(comment => comment.text)).toEqual(['Отправленный текст'])
  else {
    expect(fixture.toasts).toContain('Задача добавлена.')
    expect(fixture.state.snapshot?.tasks.find(task => task.taskId === 'task-new')?.title).toBe('Отправленный текст')
  }
  expect(fixture.calls.filter(call => call.op === operation)).toHaveLength(1)
  // После успешной отправки в поле остаётся только добавленное позже: отправленное начало убрано.
  expect((await pane.find({ key }))?.props?.props?.value).toBe(refocus ? event.inputText.trimStart() : field === 'new' ? undefined : '')
  expect(edits).toHaveLength(refocus ? 0 : 1)
  })

const START = { cwd: '/fixture', surface: 'terminal', isInteractive: true } as const
const STARTUP_HINT = 'Панель «Задачи» не размещена: нет места. Расширь окно и повтори /tasks.'
function startupHost(on: On, options: Parameters<typeof taskHost>[2] = {}, attempted = false, task: Task | null = null) {
  const world = taskHost(on, task, options)
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__cockpit__${e.name}` } }))
  on('session.root', () => ({ value: '/fixture' }))
  const statuses: string[] = []
  let version = attempted ? 1 : 0
  let known: readonly UiPane[] | null = null
  on('state.get', { plugin: 'cockpit', key: 'autoOpenAttempted' }, () => ({ value: { value: attempted, version } }))
  on('state.set', { plugin: 'cockpit', key: 'autoOpenAttempted' }, (_$, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    attempted = e.value; version += 1
    return { value: { isSet: true, version } }
  })
  const panes = (): readonly UiPane[] => known ?? [...new Map(world.opens.map(pane => [pane.id, {
    id: pane.id, title: pane.title ?? pane.id, isPlaced: options.openMode !== 'unplaced', isShown: true, isFocused: false,
  }])).values()]
  on('ui.panes', () => ({ value: panes() }))
  on('ui.status', (_$, e) => { if (e.text !== undefined) statuses.push(e.text); return { value: undefined } })
  return { ...world, statuses, get prompt() { return world.prompt }, get panes() { return panes() }, setPanes(panes: readonly UiPane[]) { known = panes } }
}

test('HANDOFF-2: старт интерактивной сессии открывает задачи по умолчанию без фокуса и изменения ввода', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = startupHost(on)
  world.setPrompt('Незавершённая реплика')
  expect(await $.session.start(START)).toEqual({ cwd: '/fixture' })
  expect(world.opens).toEqual([{ id: 'tasks', title: 'Задачи' }])
  expect(world.fills).toEqual([])
  expect(world.focuses).toEqual([])
  expect(world.prompt).toBe('Незавершённая реплика')
  expect(world.toasts).toEqual([])
})

test('HANDOFF-2: autoOpen=false отключает открытие даже при восстановлении задачи с контрольной точкой', { options: { autoOpen: false, glyphs: 'plain' } }, async ($, on) => {
  const world = startupHost(on, {}, false, { ...CARD, lastCheckpoint: CHECKPOINT })
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'resume', cwd: '/fixture', session_id: 'fixture-session' })
  expect(world.opens).toEqual([])
  expect(world.statuses).toEqual([])
  expect(world.toasts).toEqual([])
  expect(world.calls.some(call => call.op === 'session.rebind')).toBe(true)
  await $.command.run(taskCommand())
  expect(world.opens).toEqual([{ id: 'tasks', title: 'Задачи', focus: true }])
})

test('HANDOFF-2: восстановление задачи и оба события старта открывают одну панель', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = startupHost(on, {}, false, { ...CARD, lastCheckpoint: CHECKPOINT })
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  await $.session.start(START)
  world.changeSession('next-session')
  await $.session.start(START)
  expect(world.opens).toEqual([{ id: 'tasks', title: 'Задачи' }])
  expect(world.fills).toEqual([])
})

test('HANDOFF-2: параллельные события старта не открывают панель дважды', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = startupHost(on)
  await Promise.all([$.session.start(START), $.session.start(START)])
  expect(world.opens).toEqual([{ id: 'tasks', title: 'Задачи' }])
})

test('HANDOFF-2: запись открытой панели движка переживает загрузку нового контроллера', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = startupHost(on)
  world.setPanes([{ id: 'tasks', title: 'Задачи', isPlaced: true, isShown: true, isFocused: false }])
  await $.session.start(START)
  expect(world.opens).toEqual([])
  expect(world.statuses.filter(Boolean)).toEqual([])
})

test('HANDOFF-2: отметка попытки переживает перезагрузку и не возвращает закрытую человеком панель', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = startupHost(on, {}, true)
  world.setPanes([])
  await $.session.start(START)
  expect(world.opens).toEqual([])
  expect(world.statuses).toEqual([])
})

test('HANDOFF-2: узкий терминал оставляет одну подсказку без ошибки, фокуса и повторного открытия', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = startupHost(on, { openMode: 'unplaced' })
  await $.session.start(START)
  await $.session.start(START)
  expect(world.opens).toEqual([{ id: 'tasks', title: 'Задачи' }])
  expect(world.panes[0]?.isPlaced).toBe(false)
  expect(world.statuses).toEqual([STARTUP_HINT])
  expect(world.statuses[0]).not.toMatch(/[\r\n]/u)
  expect(world.toasts).toEqual([])
  expect(world.fills).toEqual([])
})

test('HANDOFF-2: отказ размещения не прерывает старт и не повторяется при перезагрузке', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = startupHost(on, { openMode: 'throw' })
  expect(await $.session.start(START)).toEqual({ cwd: '/fixture' })
  await $.session.start(START)
  expect(world.opens).toEqual([{ id: 'tasks', title: 'Задачи' }])
  expect(world.statuses).toEqual(['Панель «Задачи» не открыта: размещение недоступно. Повтори /tasks.'])
  expect(world.toasts).toEqual([])
})

test('HANDOFF-2: запуск без интерактивной поверхности не открывает панель и не расходует следующий интерактивный старт', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = startupHost(on)
  await $.session.start({ cwd: '/fixture', surface: null, isInteractive: false })
  expect(world.opens).toEqual([])
  expect(world.statuses).toEqual([])
  await $.session.start(START)
  expect(world.opens).toEqual([{ id: 'tasks', title: 'Задачи' }])
})

test('HANDOFF-2: ручная команда сохраняет порядок «Задачи», «Файлы», «Проект», «Машина»', { options: { glyphs: 'plain' } }, async ($, on) => {
  const world = taskHost(on)
  on('command.list', () => ({ value: ['cockpit', 'filetree', 'github', 'machine'].map(name => ({ name, description: '' })) }))
  on('ui.panes', () => ({ value: [] }))
  await $.command.run(taskCommand('', 'cockpit'))
  expect(world.opens).toEqual([
    { id: 'tasks', title: 'Задачи' }, { id: 'filetree', title: 'Файлы' },
    { id: 'github', title: 'Проект' }, { id: 'machine', title: 'Машина' },
    { id: 'tasks', title: 'Задачи', focus: true },
  ])
})

test('Открыть и Enter заменяют список страницей задачи; q возвращает прежний курсор', async ($, on) => {
  taskHost(on, CARD, { tasks: [CARD, QUEUED] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ key: 'down', in: 'rows' })
  await pane.press({ key: 'open' })
  expect(await pane.find({ type: 'Box', key: `task-page:${QUEUED.taskId}` })).toBeDefined()
  expect(await pane.find({ type: 'Client', key: 'rows' })).toBeUndefined()
  await pane.press({ key: 'page-back' })
  const rows = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  expect(rows.rows.find(row => row.kind === 'card' && row.selected)?.taskId).toBe(QUEUED.taskId)
  await pane.key({ key: 'return', in: 'rows' })
  expect(await pane.find({ type: 'Box', key: `task-page:${QUEUED.taskId}` })).toBeDefined()
  await pane.key({ key: 'q', in: 'page-content' })
  expect(await pane.find({ type: 'Client', key: 'rows' })).toBeDefined()
  await pane.unmount()
})

test('Пустая в простое полоса перечитывает фокус после появления текущей задачи без хода и панели', async ($, on) => {
  const fixture = taskHost(on, null)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Text } = $.ui.resolve(e); return <Text>Соседняя полоса</Text> })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const band = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Client', key: 'task-band' })).toBeUndefined()
  fixture.setRuntimeFocus(CARD)
  await fixture.clock.advance(30_000)
  expect(await band.find({ type: 'Client', key: 'task-band' })).toBeDefined()
  expect(drawnText(await band.drawn({ in: 'task-band' }))).toContain(CARD.title)
  expect(drawnText(await band.drawn())).toContain('Соседняя полоса')
  await band.unmount()
})

test('Survey скрывает полосу с текущей задачей, сохраняет соседний мод и не выключает перечитывание', async ($, on) => {
  const fixture = taskHost(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Text } = $.ui.resolve(e); return <Text>Соседняя полоса</Text> })
  const band = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
  expect(fixture.state.focus?.task?.taskId).toBe(CARD.taskId)
  expect(await band.find({ type: 'Client', key: 'task-band' })).toBeUndefined()
  expect(drawnText(await band.drawn())).toContain('Соседняя полоса')
  const reads = fixture.calls.filter(call => call.op === 'snapshot').length
  await fixture.clock.advance(30_000)
  expect(fixture.calls.filter(call => call.op === 'snapshot').length).toBeGreaterThan(reads)
  expect(await band.find({ type: 'Client', key: 'task-band' })).toBeUndefined()
  await band.unmount()
})

for (const width of [40, 60, 100]) test(`Кандидатов нет в панели, её значки не принимают и не отклоняют их: ${width}`, async ($, on) => {
  const candidate: Task = { ...CARD, taskId: 'candidate-first', title: 'Исправить предложение', stage: 'candidate', adoptedBy: null, dismissReason: null, dismissedAt: null, queuePosition: null, lastCheckpoint: null, activeSince: null, description: 'Описание предложения', certainty: 'inferred', certaintySource: 'provider', certaintyProvenance: 'panel' }
  const second: Task = { ...candidate, taskId: 'candidate-second', title: 'Второе предложение' }
  const fixture = taskHost(on, null, { candidates: [candidate, second] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  expect(drawnText(await pane.drawn({ in: 'panel-header' }))).not.toContain('предложено')
  const tree = await pane.drawn({ in: 'rows' })
  expect(drawnText(tree)).not.toContain('ПРЕДЛОЖЕНО')
  expect(drawnText(tree)).not.toContain(candidate.title)
  expect(drawnText(tree)).not.toContain('·')
  expect(elements(tree).filter(node => node.type === 'Button')).toHaveLength(0)
  for (const element of elements(tree)) if (element.type === 'Box' && typeof element.props?.width === 'number') expect(element.props?.width).toBeLessThanOrEqual(width)
  // Неприменимое действие не рисуется вовсе: нажимать и наводить не на что.
  expect(((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions.some(item => item.key === 'current')).toBe(false)
  expect(fixture.calls.some(call => call.op === 'candidate.adopt' || call.op === 'task.action')).toBe(false)
  await pane.key({ key: 'home', in: 'rows' })
  expect(((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions.map(item => item.key)).toEqual(['new'])
  await pane.key({ key: 'x', in: 'rows' }); await pane.key({ key: 'x', in: 'rows' })
  expect(fixture.calls.some(call => call.op === 'candidate.dismiss')).toBe(false)
  expect(drawnText(await pane.drawn())).not.toContain('ПРЕДЛОЖЕНО')
  await pane.unmount()
})

test('/tasks открывает задачи; /cockpit продолжает цепочку и в конце открывает задачи с фокусом', async ($, on) => {
  const fixture = taskHost(on)
  on('command.run', { command: 'cockpit' }, () => ({}))
  expect(await $.command.run(taskCommand())).toEqual({})
  expect(await $.command.run(taskCommand('', 'cockpit'))).toEqual({})
  expect(fixture.opens).toEqual([{ id: 'tasks', title: 'Задачи', focus: true }, { id: 'tasks', title: 'Задачи' }, { id: 'tasks', title: 'Задачи', focus: true }])
  expect(fixture.models).toHaveLength(0)
})

for (const origin of [{ kind: 'composer' }, { kind: 'bridge' }] as const) test(`/cockpit от ${origin.kind}: открывает панели установленных модов по id, последним — задачи с фокусом`, async ($, on) => {
  const fixture = taskHost(on)
  // Установлены машина и github; дерева файлов нет — его панель не открывается.
  on('command.list', () => ({ value: [{ name: 'cockpit', description: '' }, { name: 'machine', description: '' }, { name: 'github', description: '' }] }))
  const input = { ...taskCommand(origin.kind === 'bridge' ? ' \t ' : '', 'cockpit'), origin }
  expect(await $.command.run(input)).toEqual({})
  expect(fixture.opens).toEqual([
    { id: 'tasks', title: 'Задачи' },
    { id: 'github', title: '\u{f09b} Проект' }, { id: 'machine', title: '\u{f048b} Машина' },
    { id: 'tasks', title: 'Задачи', focus: true },
  ])
  expect(fixture.toasts).toEqual([])
})

test('/tasks, /cockpit takeover и /cockpit add не передают открытие чужих панелей в next', async ($, on) => {
  const fixture = taskHost(on, null)
  const continued: CommandRunInput[] = []
  on('command.run', { command: ['tasks', 'cockpit'] as const }, (_$, e) => { continued.push(e); return {} })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  expect(await $.command.run(taskCommand())).toEqual({})
  expect(fixture.opens).toEqual([{ id: 'tasks', title: 'Задачи', focus: true }])
  const before = fixture.opens.length
  expect(await $.command.run(taskCommand('takeover', 'cockpit'))).toEqual({})
  expect(fixture.toasts).toContain('Теперь ты можешь менять задачи в этой панели.')
  expect(await $.command.run(taskCommand('add Новая карточка', 'cockpit'))).toEqual({})
  expect(fixture.calls.find(call => call.op === 'task.create')?.args).toMatchObject({ title: 'Новая карточка' })
  expect(await $.command.run(taskCommand('unknown', 'cockpit'))).toEqual({})
  expect(fixture.opens).toHaveLength(before); expect(continued).toEqual([])
})

for (const openMode of ['throw', 'unplaced'] as const) test(`/cockpit: ${openMode} задач не создаёт тост и не мешает открыть остальные панели`, async ($, on) => {
  const fixture = taskHost(on, CARD, { openMode })
  on('command.list', () => ({ value: [{ name: 'machine', description: '' }] }))
  expect(await $.command.run(taskCommand('', 'cockpit'))).toEqual({})
  expect(fixture.toasts).toEqual([])
  if (openMode === 'unplaced') expect(fixture.opens.map(open => open.id)).toEqual(['tasks', 'machine', 'tasks'])
})

for (const shown of [false, true]) test(`Добавление командой: уведомление только при скрытой панели, видимость=${shown}`, async ($, on) => {
  const fixture = taskHost(on, null)
  on('ui.panes', () => ({ value: [{ id: 'tasks', title: 'Задачи', isPlaced: true, isShown: shown, isFocused: shown }] }))
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  expect(await $.command.run(taskCommand('add Новая карточка'))).toEqual({})
  expect(fixture.calls.filter(call => call.op === 'task.create')).toHaveLength(1)
  expect(fixture.calls.find(call => call.op === 'task.create')?.args).toMatchObject({ title: 'Новая карточка' })
  expect(fixture.toasts).toEqual(shown ? [] : ['Задача добавлена.'])
})

for (const origin of [{ kind: 'sdk' }, { kind: 'plugin', name: 'fixture' }] as const) test(`/cockpit от ${origin.kind} не открывает панели`, async ($, on) => {
  const fixture = taskHost(on)
  on('command.run', { command: 'cockpit' }, () => ({}))
  expect(await $.command.run({ ...taskCommand('', 'cockpit'), origin })).toEqual({})
  expect(fixture.opens).toEqual([]); expect(fixture.toasts).toEqual([])
})

for (const surface of ['terminal', 'desktop', 'mobile', 'vscode'] as const) {
  test(`Пустая панель без прежних вкладок на ${surface}`, async ($, on) => {
    const fixture = taskHost(on, null)
    const pane = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'tasks', props: PANE })
    const tree = JSON.stringify(await pane.drawn())
    expect(tree).not.toContain('inbox-tab'); expect(tree).not.toContain('files-tab'); expect(tree).not.toContain('focus-tab')
    if (surface === 'terminal' || surface === 'desktop') {
      expect(await pane.find({ type: 'Client', key: 'new-task' })).toBeDefined()
      expect(tree).not.toContain('Первая задача:')
    } else {
      expect(tree).toContain('Здесь задачи агента и вопросы к вам.')
      expect(tree).toContain('Первая задача: /tasks add <текст>.')
    }
    if (surface !== 'terminal' && surface !== 'desktop') {
      expect(await pane.find({ type: 'Button', key: 'new', text: '+' })).toBeDefined()
      await pane.press({ key: 'new' })
      expect(drawnText(await pane.drawn())).toContain('/tasks add <текст>')
      expect(await pane.find({ type: 'Client', key: 'new-task' })).toBeUndefined()
      expect(fixture.calls.filter(call => call.op === 'task.create')).toHaveLength(0)
    }
    await pane.unmount()
  })
}

for (const surface of ['mobile', 'vscode'] as const) {
  test(`Минимальная карточка без Client сохраняет текст и скрывает служебные поля на ${surface}`, async ($, on) => {
    const fixture = taskHost(on)
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'tasks', props: PANE })
    const card = await pane.find({ type: 'Box', key: `card:${CARD.taskId}` })
    expect(drawnText(asTree(card))).toContain(CARD.title)
    expect(elements(asTree(card)).filter(node => node.type === 'Button')).toHaveLength(0)
    expect(drawnText(asTree(card))).not.toContain('Проверить тему')
    expect(fixture.calls.filter(call => call.op === 'task.action')).toHaveLength(0)
    expect(fixture.state.focus?.task?.steps).toEqual(CARD.steps)
    await pane.unmount()
  })
}

test('Карточка содержит только название, пробел сохраняет список, Enter открывает страницу', async ($, on) => {
  taskHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const client = await pane.drawn({ in: 'rows' })
  expect(client.type).toBe('Box')
  const rows = 'children' in client ? client.children?.map(drawnText) ?? [] : []
  for (const text of ['В РАБОТЕ', CARD.title, '▶ 1']) expect(rows.join('\n')).toContain(text)
  expect(rows.join('\n')).not.toContain('агент')
  for (const text of ['ОЧЕРЕДЬ', 'ЖДЁТ ВАС', 'Собрать ряды', 'шаги', 'P2', 'мин', '▍']) expect(rows.join('\n')).not.toContain(text)
  await pane.key({ key: 'space', in: 'rows' })
  expect(await pane.drawn({ in: 'rows' })).toEqual(client)
  await pane.key({ key: 'return', in: 'rows' })
  expect(await pane.find({ type: 'Box', key: `task-page:${CARD.taskId}` })).toBeDefined()
  expect(await pane.find({ type: 'Client', key: 'rows' })).toBeUndefined()
  await pane.unmount()
})

const QUEUED: Task = { ...CARD, taskId: 'queued', title: 'Подготовить следующую задачу', steps: [], lastCheckpoint: null, queuePosition: 2, certainty: 'confirmed', certaintySource: 'user' }
const WAITING: Task = { ...QUEUED, taskId: 'waiting', title: 'Выбрать вариант', needsDecision: true, queuePosition: 3 }
const FINISHED: Task = { ...QUEUED, taskId: 'finished', title: 'Завершённая задача', status: 'done', queuePosition: 4 }

for (const width of [40, 60, 100]) test(`CARDS-1: действия каждой карточки на нижней рамке, в шапке поиск и новая задача: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = taskHost(on, CARD, { tasks: [CARD, QUEUED] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  const props = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  const header = elements(await pane.drawn({ in: 'panel-header' })).filter(node => node.type === 'Button')
  expect(header.map(node => node.type === 'Button' ? node.props.key : '')).toEqual(['new'])
  // Значки стоят на нижней линии рамки внутри слота своей карточки: отдельно от неё они сдвинуться не могут.
  const drawn = elements(await pane.drawn({ in: 'rows' }))
  for (const row of props.rows) {
    if (row.kind === 'card') {
      const slot = drawn.find(node => node.type === 'Box' && node.props?.key === `card-slot:${row.taskId}`)
      expect(slot?.props).toMatchObject({ height: row.height })
      const frame = elements(asTree(slot)).find(node => node.type === 'Box' && node.props?.key === `card-action-frame-${row.taskId}`)
      expect(frame?.props).toMatchObject({ position: 'absolute', top: row.height - 1, height: 1 })
      expect(Number(frame?.props.left) + Number(frame?.props.width)).toBeLessThanOrEqual(row.width - 1)
      expect(elements(asTree(frame)).some(node => node.type === 'Button')).toBe(true)
    }
  }
  expect(elements(await pane.drawn()).some(node => String(node.props?.key).startsWith('card-action-frame-'))).toBe(false)
  await pane.press({ key: 'card-queued-current' })
  expect(fixture.calls.filter(call => call.op === 'task.action').at(-1)?.args).toMatchObject({ taskId: QUEUED.taskId, action: 'current' })
})

const COMMENTS: OwnerComment[] = [
  { commentId: 'comment-first', text: 'Первое сообщение владельца', revision: 0, createdAt: '2026-10-04T14:00:00.000001Z', updatedAt: '2026-10-04T14:00:00.000001Z' },
  { commentId: 'comment-second', text: 'Второе сообщение владельца', revision: 2, createdAt: '2026-10-05T02:00:00.000001Z', updatedAt: '2026-10-05T03:00:00.000001Z' },
]

for (const surface of ['terminal', 'desktop'] as const) test(`Страница: общий редактор, комментарии полные, выбранное сообщение с акцентом: ${surface}`, async ($, on) => {
  taskHost(on, { ...CARD, description: 'Полное описание' }, { comments: COMMENTS })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface, component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  const field = await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` })
  expect(field?.props?.props?.placeholder).toBe('Комментарий агенту')
  expect((await findEditor(pane, { type: 'Box', key: 'page-comment-frame' }))?.props?.borderStyle).toBe('round')
  expect(elements(await pane.drawn({ in: 'page-content' })).some(node => node.type === 'Input')).toBe(false)
  const content = drawnText(await pane.drawn({ in: 'page-content' }))
  expect(await pane.find({ type: 'Box', key: 'page-title' })).toBeUndefined()
  for (const text of [...COMMENTS.map(comment => comment.text), 'изм.']) expect(content).toContain(text)
  expect(content).not.toContain('Комментарии:')
  expect(content).not.toContain('·')
  for (const key of ['page-comment-edit', 'page-comment-delete', 'caption-page-comment-edit', 'caption-page-comment-delete']) expect(await findEditor(pane, { key })).toBeUndefined()
  await pane.key({ key: 'j', in: 'page-content' })
  expect((await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props).toMatchObject({ selected: COMMENTS[0]!.commentId })
  const selectedMarks = elements(await pane.drawn({ in: 'page-content' })).filter(node => node.type === 'Text' && node.props?.color === roleColors(DEFAULT_THEME).accent && drawnText(node) === '┃')
  expect(selectedMarks.length).toBeGreaterThan(0)
  for (const mark of selectedMarks) expect(mark.type === 'Text' ? mark.props?.color : null).toBe(roleColors(DEFAULT_THEME).accent)
  const actions = (await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps
  expect(actions.actions.map(action => action.key)).toEqual(['page-back', 'page-comment-edit', 'page-comment-delete'])
  for (const action of actions.actions) {
    expect(cellWidth(action.label)).toBe(1)
    expect(action.dimColor).not.toBe(true)
    const button = await pane.find({ in: 'panel-header', type: 'Button', key: action.key })
    const caption = await pane.find({ in: 'panel-header', type: 'Box', key: `caption-${action.key}` })
    expect(caption?.props?.display).toBe('none')
    expect((caption?.props as { hover?: { scope?: string } })?.hover?.scope).toBe((button?.props as { hover?: { scope?: string } })?.hover?.scope)
  }
  for (const [key, id] of [['down', COMMENTS[1]!.commentId], ['up', COMMENTS[0]!.commentId], ['j', COMMENTS[1]!.commentId], ['k', COMMENTS[0]!.commentId]] as const) {
    await pane.key({ key, in: 'page-content' })
    expect((await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props).toMatchObject({ selected: id })
  }
  await pane.unmount()
})

test('Комментарий отправляется аттестованным владельцем, поле очищается и окно показывает новую запись', async ($, on) => {
  const fixture = taskHost(on, CARD, { comments: Array.from({ length: 20 }, (_, index) => ({ ...COMMENTS[0]!, commentId: `comment-${index}`, text: `Сообщение ${index}` })) })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, scroll: { offset: 0, bodyRows: 14 } } })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Новый комментарий\nВторой абзац', kind: 'submit' })
  const request = fixture.calls.find(call => call.op === 'task.comment.add')
  expect(request?.args).toEqual({ taskId: CARD.taskId, text: 'Новый комментарий\nВторой абзац' })
  expect(request?.actor).toBe('owner')
  expect(request?.panelSecret).toBe(fixture.calls.find(call => call.op === 'session.attest')?.panelSecret)
  expect((await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` }))?.props?.props?.value).toBe('')
  expect(drawnText(await pane.drawn({ in: 'page-content' }))).toContain('Новый комментарий')
  const props = (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  expect(props.offset).toBeGreaterThan(0)
  expect(props.selected).toBe(fixture.comments.at(-1)?.commentId)
  for (const written of fixture.writes) expect(written).not.toContain(request?.panelSecret ?? 'fixture-secret')
  await pane.unmount()
})

test('Правка сообщения использует ревизию сообщения, сохраняет порядок и черновик нового комментария', async ($, on) => {
  const fixture = taskHost(on, CARD, { comments: COMMENTS })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Следующий комментарий', kind: 'change' })
  await pane.key({ key: 'k', in: 'page-content' })
  await pane.press({ key: 'page-comment-edit' })
  expect(drawnText(await pane.drawn({ in: `page-comment:${CARD.taskId}` }))).toContain('Изменение сообщения')
  expect((await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` }))?.props?.props?.value).toBe(COMMENTS[1]!.text)
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Изменённый текст', kind: 'submit' })
  const request = fixture.calls.find(call => call.op === 'task.comment.edit')
  expect(request?.args).toEqual({ taskId: CARD.taskId, commentId: COMMENTS[1]!.commentId, expectedRevision: COMMENTS[1]!.revision, text: 'Изменённый текст' })
  expect(request?.actor).toBe('owner')
  expect(request?.panelSecret).toMatch(/^[a-f0-9]{64}$/u)
  expect(fixture.comments.map(comment => comment.commentId)).toEqual(COMMENTS.map(comment => comment.commentId))
  expect(fixture.comments[1]?.createdAt).toBe(COMMENTS[1]!.createdAt)
  expect(fixture.comments[1]?.revision).toBe(3)
  expect((await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` }))?.props?.props?.value).toBe('Следующий комментарий')
  expect(drawnText(await pane.drawn({ in: 'page-content' }))).toContain('Изменённый текст')
  await pane.unmount()
})

for (const operation of ['edit', 'delete'] as const) test(`Конфликт комментария перечитывает task.get и сохраняет черновик: ${operation}`, async ($, on) => {
  const fixture = taskHost(on, CARD, { comments: COMMENTS, commentConflicts: 1 })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Не потерять текст', kind: 'change' })
  await pane.key({ key: 'j', in: 'page-content' })
  const before = fixture.calls.filter(call => call.op === 'task.get').length
  if (operation === 'edit') {
    await pane.press({ key: 'page-comment-edit' })
    await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Мой черновик', kind: 'submit' })
  } else {
    await pane.press({ key: 'page-comment-delete' })
    expect(fixture.calls.filter(call => call.op === 'task.comment.delete')).toHaveLength(0)
    await pane.press({ key: 'page-comment-delete' })
  }
  expect(fixture.calls.filter(call => call.op === `task.comment.${operation}`)).toHaveLength(1)
  expect(fixture.calls.filter(call => call.op === 'task.get').length).toBeGreaterThan(before)
  expect(fixture.toasts.at(-1)).toBe(operation === 'edit' ? 'Комментарий изменился; не сохранён. Проверь черновик и повтори сохранение.' : 'Сообщение изменилось; не удалено. Проверь его и повтори удаление.')
  expect((await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` }))?.props?.props?.value).toBe(operation === 'edit' ? 'Мой черновик' : 'Не потерять текст')
  if (operation === 'edit') {
    await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Мой черновик', kind: 'submit' })
    expect(fixture.calls.filter(call => call.op === 'task.comment.edit').at(-1)?.args.expectedRevision).toBe(1)
    expect(fixture.comments[0]?.text).toBe('Мой черновик')
  }
  await pane.unmount()
})

test('Удаление сообщения требует два последовательных нажатия; выбор и истечение отменяют подтверждение', async ($, on) => {
  const fixture = taskHost(on, CARD, { comments: COMMENTS })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments'); await pane.key({ key: 'j', in: 'page-content' })
  await pane.press({ key: 'page-comment-delete' })
  await fixture.clock.advance(5001)
  await pane.press({ key: 'page-comment-delete' })
  expect(fixture.calls.filter(call => call.op === 'task.comment.delete')).toHaveLength(0)
  await pane.key({ key: 'j', in: 'page-content' })
  await pane.press({ key: 'page-comment-delete' })
  expect(fixture.calls.filter(call => call.op === 'task.comment.delete')).toHaveLength(0)
  await pane.press({ key: 'page-comment-delete' })
  const request = fixture.calls.find(call => call.op === 'task.comment.delete')
  expect(request?.args).toEqual({ taskId: CARD.taskId, commentId: COMMENTS[1]!.commentId, expectedRevision: COMMENTS[1]!.revision })
  expect(request?.actor).toBe('owner')
  expect(request?.panelSecret).toMatch(/^[a-f0-9]{64}$/u)
  expect(fixture.comments).toHaveLength(1)
  await pane.press({ key: 'page-comment-delete' }); await pane.press({ key: 'page-comment-delete' })
  for (const key of ['page-comment-edit', 'page-comment-delete', 'caption-page-comment-edit', 'caption-page-comment-delete']) expect(await findEditor(pane, { key })).toBeUndefined()
  await pane.unmount()
})

for (const conflicts of [0, 1, 3]) test(`Описание правится на месте, использует свежую ревизию и сохраняет черновик: ${conflicts}`, async ($, on) => {
  const fixture = taskHost(on, { ...CARD, description: 'Исходное описание' }, { editConflicts: conflicts })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ key: 'o', in: 'rows' }); await pane.key({ key: 'e', in: 'page-content' })
  const key = `page-description:${CARD.taskId}`
  expect((await pane.find({ type: 'Client', key }))?.props?.props?.value).toBe('Исходное описание')
  expect(elements(await pane.drawn({ in: 'page-content' })).some(node => node.type === 'Input')).toBe(false)
  await inputEditor(pane, { key, text: 'Описание целиком', kind: 'change' })
  await pane.redraw()
  expect((await pane.find({ type: 'Client', key }))?.props?.props?.value).toBe('Описание целиком')
  await inputEditor(pane, { key, text: 'Описание целиком', kind: 'submit' })
  const requests = fixture.calls.filter(call => call.op === 'task.edit')
  expect(requests).toHaveLength(conflicts === 3 ? 3 : conflicts + 1)
  expect(requests.map(call => call.args.expectedRevision)).toEqual(Array.from({ length: requests.length }, (_, index) => CARD.revision + index))
  for (const request of requests) {
    expect(request.actor).toBe('owner')
    expect(request.panelSecret).toMatch(/^[a-f0-9]{64}$/u)
    expect(request.args.description).toBe('Описание целиком')
  }
  if (conflicts < 3) {
    expect(fixture.state.focus?.task?.description).toBe('Описание целиком')
    expect(await pane.find({ type: 'Client', key })).toBeUndefined()
  } else {
    expect((await pane.find({ type: 'Client', key }))?.props?.props?.value).toBe('Описание целиком')
    expect(fixture.toasts.at(-1)).toBe('Описание изменилось; не сохранено. Проверь черновик и повтори сохранение.')
  }
  await pane.unmount()
})

test('Esc через событие фокуса отменяет описание и правку сообщения, затем возвращает список', async ($, on) => {
  const fixture = taskHost(on, CARD, { comments: COMMENTS })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pane.press({ key: 'page-description-edit' })
  await inputEditor(pane, { key: `page-description:${CARD.taskId}`, text: 'Отменить описание', kind: 'change' })
  await $.ui.focus({ plugin: 'cockpit', component: 'Pane', requestId: 'tasks', origin: { kind: 'person' } })
  expect(await pane.find({ type: 'Client', key: `page-description:${CARD.taskId}` })).toBeUndefined()
  expect(await pane.find({ type: 'Box', key: `task-page:${CARD.taskId}` })).toBeDefined()
  // Событие фокуса — это и Esc, и щелчок мимо поля: набранное не пропадает, а возвращается при следующей правке.
  expect(fixture.toasts.at(-1)).toBe('Правка описания отложена. Твой черновик вернётся, когда откроешь правку.')
  expect(fixture.calls.filter(call => call.op === 'task.edit')).toHaveLength(0)
  await pane.press({ key: 'page-description-edit' })
  expect((await pane.find({ type: 'Client', key: `page-description:${CARD.taskId}` }))?.props?.props?.value).toBe('Отменить описание')
  // Явная отмена значком набранное выбрасывает: следующая правка начинается с сохранённого описания.
  await pane.press({ key: 'page-cancel-edit' })
  await pane.press({ key: 'page-description-edit' })
  expect((await pane.find({ type: 'Client', key: `page-description:${CARD.taskId}` }))?.props?.props?.value).toBe(CARD.description ?? '')
  // Правка без изменений закрывается молча.
  const toasts = fixture.toasts.length
  await $.ui.focus({ plugin: 'cockpit', component: 'Pane', requestId: 'tasks', origin: { kind: 'person' } })
  expect(fixture.toasts).toHaveLength(toasts)
  expect(await pane.find({ type: 'Client', key: `page-description:${CARD.taskId}` })).toBeUndefined()
  await pageTab(pane, 'comments'); await pane.key({ key: 'j', in: 'page-content' }); await pane.key({ key: 'a', in: 'page-content' })
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Отменить сообщение', kind: 'change' })
  await pane.key({ key: 'escape', in: 'page-content' })
  expect((await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` }))?.props?.props?.value).toBe('')
  await $.ui.focus({ plugin: 'cockpit', component: 'Pane', requestId: 'tasks', origin: { kind: 'person' } })
  expect(await pane.find({ type: 'Client', key: 'rows' })).toBeDefined()
  expect(fixture.calls.some(call => call.op === 'task.edit' || call.op.startsWith('task.comment.'))).toBe(false)
  await pane.unmount()
})

test('PAGE-64: редакторы страницы не предлагают перенос в основную строку', async ($, on) => {
  const fixture = taskHost(on)
  fixture.setPrompt('Обычная реплика')
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  expect(await findEditor(pane, { key: 'page-comment-long' })).toBeUndefined()
  await pageTab(pane, 'description'); await pane.press({ key: 'page-description-edit' })
  expect(await findEditor(pane, { key: 'page-description-long' })).toBeUndefined()
  expect(fixture.prompt).toBe('Обычная реплика')
  await pane.unmount()
})

for (const kind of ['composer', 'bridge'] as const) test(`Многострочный комментарий сохраняется в панели; основная реплика проходит: ${kind}`, async ($, on) => {
  const fixture = taskHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  fixture.setPrompt('Обычная реплика')
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Начало\nМногострочное уточнение', kind: 'submit' })
  expect(fixture.calls.filter(call => call.op === 'task.comment.add').at(-1)?.args.text).toBe('Начало\nМногострочное уточнение')
  expect(fixture.calls.some(call => ['capture.prompt', 'tasks.extract'].includes(call.op))).toBe(false)
  expect(fixture.prompt).toBe('Обычная реплика')
  expect((await $.prompt.submit({ text: 'Обычная реплика', origin: { kind }, wait: false })).drop).toBeUndefined()
  await pane.unmount()
})

for (const kind of ['sdk', 'task-notification', 'scheduled-trigger', 'peer', 'channel', 'auto-continuation', 'unclassified'] as const) test(`Чужой источник не отправляет черновик комментария: ${kind}`, async ($, on) => {
  const fixture = taskHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Черновик', kind: 'change' })
  const text = 'Чужое уведомление'
  expect(await $.prompt.submit({ text, origin: { kind } as import('claude-code').PromptSubmitInput['origin'], wait: false })).toEqual({ text, context: undefined })
  expect(fixture.calls.filter(call => call.op.startsWith('task.comment.'))).toHaveLength(0)
  await pane.redraw()
  expect((await pane.find({ key: `page-comment:${CARD.taskId}` }))?.props.props.value).toBe('Черновик')
  await pane.unmount()
})

test('Закрытие страницы сохраняет локальный черновик и не меняет основную строку', async ($, on) => {
  const fixture = taskHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  fixture.setPrompt('Прежняя реплика')
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Уточнение\nПродолжение', kind: 'change' })
  await pane.press({ key: 'page-back' }); await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  expect(fixture.prompt).toBe('Прежняя реплика')
  expect((await pane.find({ key: `page-comment:${CARD.taskId}` }))?.props.props.value).toBe('Уточнение\nПродолжение')
  expect(fixture.calls.some(call => call.op.startsWith('task.comment.'))).toBe(false)
  await pane.unmount()
})

test('INPUT-3: комментарий владельца с путём к снимку экрана уходит без удержания, с ключом рядом с путём — удерживается', { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = taskHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  const key = `page-comment:${CARD.taskId}`
  const shot = "'/var/folders/yg/hdqrsp2j56nc32v3_2cthtxr0000gn/T/TemporaryItems/NSIRD_screencaptureui_DaEa1F/Снимок экрана — 2026-10-07 в 13.56.38.png' рамка съедена"
  await inputEditor(pane, { key, text: shot, kind: 'submit' })
  expect(fixture.comments.map(comment => comment.text)).toEqual([shot])
  expect(await pane.find({ type: 'Box', key: 'page-secret-warning' })).toBeUndefined()
  // Учебный ключ из документации AWS, собран из частей.
  const slashed = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/') // gitleaks:allow
  await inputEditor(pane, { key, text: `лежит в /tmp/notes.txt ${slashed}`, kind: 'submit' })
  expect(fixture.comments).toHaveLength(1)
  expect(await pane.find({ type: 'Box', key: 'page-secret-warning' })).toBeDefined()
  await pane.unmount()
})

test('Похожий на секрет комментарий удерживается до явного подтверждения, черновик не пишется в state', async ($, on) => {
  const fixture = taskHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  // Синтетический образец собран из частей, как в privacy-fixtures.ts; значение не меняется.
  const secret = ['sk_live_', '51', 'HxAbCdEfGhIjKlMnOp'].join('') // gitleaks:allow
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: secret, kind: 'submit' })
  expect(fixture.calls.some(call => call.op === 'task.comment.add')).toBe(false)
  expect(await findEditor(pane, { type: 'Button', key: 'page-comment-confirm', text: '!' })).toBeDefined()
  await pane.redraw()
  expect((await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` }))?.props?.props?.value).toBe(secret)
  for (const written of fixture.writes) expect(written).not.toContain(secret)
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: secret, kind: 'submit' })
  expect(fixture.calls.some(call => call.op === 'task.comment.add')).toBe(false)
  await pane.press({ key: 'page-comment-confirm' })
  expect(fixture.calls.filter(call => call.op === 'task.comment.add')).toHaveLength(1)
  expect(fixture.comments).toHaveLength(1)
  await pane.unmount()
})

test('Лимит комментария считает Unicode: пустой и 4001 знак отклоняются, 4000 принимаются', async ($, on) => {
  const fixture = taskHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  for (const text of ['  \n ', 'я'.repeat(4001)]) {
    await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text, kind: 'submit' })
    expect(fixture.calls.filter(call => call.op === 'task.comment.add')).toHaveLength(0)
    expect((await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` }))?.props?.props?.value).toBe(text)
  }
  const text = '😀' + 'я'.repeat(3999)
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text, kind: 'submit' })
  expect(fixture.calls.filter(call => call.op === 'task.comment.add')).toHaveLength(1)
  await pane.unmount()
})

test('Неизвестный исход добавления повторяется тем же requestId без второго комментария', async ($, on) => {
  const fixture = taskHost(on, CARD, { unknownComment: true })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  const key = `page-comment:${CARD.taskId}`
  await inputEditor(pane, { key, text: 'Единственный комментарий', kind: 'submit' })
  expect((await pane.find({ type: 'Client', key }))?.props?.props?.value).toBe('Единственный комментарий')
  await inputEditor(pane, { key, text: 'Единственный комментарий', kind: 'submit' })
  const requests = fixture.calls.filter(call => call.op === 'task.comment.add')
  expect(requests).toHaveLength(2)
  expect(requests[0]?.requestId).toBe(requests[1]?.requestId)
  expect(fixture.comments).toHaveLength(1)
  expect((await pane.find({ type: 'Client', key }))?.props?.props?.value).toBe('')
  await pane.unmount()
})

test('Черновики переживают перечитывание страницы и смену текущей задачи; возврат сохраняет курсор списка', async ($, on) => {
  const another = { ...QUEUED, taskId: 'another-current', title: 'Другая текущая задача', queuePosition: 3 }
  const fixture = taskHost(on, CARD, { tasks: [CARD, QUEUED, another], comments: COMMENTS })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ key: 'down', in: 'rows' }); await pane.press({ key: 'open' })
  await pageTab(pane, 'comments')
  await inputEditor(pane, { key: `page-comment:${QUEUED.taskId}`, text: 'Сохранить черновик', kind: 'change' })
  await pageTab(pane, 'description')
  await pane.press({ key: 'page-description-edit' })
  await inputEditor(pane, { key: `page-description:${QUEUED.taskId}`, text: 'Моё описание', kind: 'change' })
  fixture.changeTask({ ...QUEUED, revision: QUEUED.revision + 1, description: 'Чужая редакция' })
  fixture.changeTask(another, true)
  await fixture.clock.advance(30_000)
  expect((await pane.find({ type: 'Client', key: `page-description:${QUEUED.taskId}` }))?.props?.props?.value).toBe('Моё описание')
  await pageTab(pane, 'comments')
  expect((await pane.find({ type: 'Client', key: `page-comment:${QUEUED.taskId}` }))?.props?.props?.value).toBe('Сохранить черновик')
  await pageTab(pane, 'description')
  await inputEditor(pane, { key: `page-description:${QUEUED.taskId}`, text: 'Моё описание', kind: 'submit' })
  expect(fixture.calls.filter(call => call.op === 'task.edit').at(-1)?.args.expectedRevision).toBe(QUEUED.revision + 1)
  await pane.press({ key: 'page-back' })
  const rows = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  expect(rows.rows.find(row => row.kind === 'card' && row.selected)?.taskId).toBe(QUEUED.taskId)
  await pane.press({ key: 'open' })
  await pageTab(pane, 'comments')
  expect((await pane.find({ type: 'Client', key: `page-comment:${QUEUED.taskId}` }))?.props?.props?.value).toBe('Сохранить черновик')
  await pane.unmount()
})

test('Открытая страница перечитывает комментарии даже без изменения ревизии задачи; старые Client-сообщения отвергаются', async ($, on) => {
  const fixture = taskHost(on, CARD, { comments: COMMENTS })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  const before = (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  fixture.comments[0]!.text = 'Изменение в рантайме'; fixture.comments[0]!.revision += 1
  fixture.comments[0]!.updatedAt = '2026-10-05T03:00:00.000001Z'
  await fixture.clock.advance(30_000)
  expect(drawnText(await pane.drawn({ in: 'page-content' }))).toContain('Изменение в рантайме')
  for (const data of [{ taskId: 'another-task', generation: before.generation }, { taskId: before.taskId, generation: before.generation - 1 }]) {
    await pane.post({ ...data, key: 'q' }, { in: 'page-content' })
    expect(await pane.find({ type: 'Box', key: `task-page:${CARD.taskId}` })).toBeDefined()
  }
  await pane.unmount()
})

test('Локальный комментарий с префиксом ответа вкладке Мне остаётся комментарием', async ($, on) => {
  const fixture = taskHost(on)
  let ownerTasks: readonly OwnerTask[] = [{ id: 1, title: 'Ответь на вопрос', why: 'Нужен ответ владельца', kind: 'answer',
    state: 'open', update: 'none', sessionId: 'fixture-session', createdMs: 0, updatedMs: 0 }]
  let ownerVersion = 1
  on('state.get', { plugin: 'cockpit', key: 'ownerTasks' }, () => ({ value: { value: ownerTasks, version: ownerVersion } }))
  on('state.set', { plugin: 'cockpit', key: 'ownerTasks' }, (_$, e) => {
    ownerTasks = e.value; ownerVersion += 1
    return { value: { isSet: true, version: ownerVersion } }
  })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  const text = '↳ Ответ на #1: Это текст комментария'
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text, kind: 'submit' })
  expect(fixture.calls.filter(call => call.op === 'task.comment.add').at(-1)?.args.text).toBe(text)
  expect(ownerTasks[0]?.state).toBe('open')
  await pane.unmount()
})

test('Секрет в локальном комментарии удерживается до явного подтверждения', async ($, on) => {
  const fixture = taskHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  // Синтетический образец собран из частей, как в privacy-fixtures.ts; значение не меняется.
  const secret = ['sk_live_', '51', 'HxAbCdEfGhIjKlMnOp'].join('') // gitleaks:allow
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: secret, kind: 'submit' })
  expect(fixture.calls.filter(call => call.op === 'task.comment.add')).toHaveLength(0)
  expect((await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` }))?.props?.props?.value).toBe(secret)
  await pane.press({ key: 'page-comment-confirm' })
  expect(fixture.calls.filter(call => call.op === 'task.comment.add')).toHaveLength(1)
  await pane.unmount()
})

test('Смена сессии отклоняет сообщение от старого редактора', async ($, on) => {
  const fixture = taskHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  const field = await pane.find({ key: `page-comment:${CARD.taskId}` })
  const props = field?.props.props as EditorProps
  fixture.changeSession('another-session')
  await pane.redraw()
  await pane.post({ kind: 'submit', id: props.id, epoch: props.epoch, version: props.version + 1, submit: 1, text: 'Старый комментарий' }, { in: `page-comment:${CARD.taskId}` })
  expect(fixture.calls.some(call => call.op.startsWith('task.comment.') || call.op === 'capture.prompt')).toBe(false)
  await pane.unmount()
})

test('Сбой чтения основной строки не мешает локальному комментарию', async ($, on) => {
  const fixture = taskHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  fixture.failPromptRead()
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Комментарий при сбое строки ввода', kind: 'submit' })
  expect(fixture.calls.filter(call => call.op === 'task.comment.add')).toHaveLength(1)
  expect(fixture.calls.some(call => call.op === 'capture.prompt')).toBe(false)
  await pane.unmount()
})

test('Возврат и ввод текста прерывают два нажатия удаления сообщения', async ($, on) => {
  const fixture = taskHost(on, CARD, { comments: COMMENTS })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments'); await pane.key({ key: 'j', in: 'page-content' })
  await pane.press({ key: 'page-comment-delete' })
  await pane.press({ key: 'page-back' }); await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  await pane.press({ key: 'page-comment-delete' })
  expect(fixture.calls.filter(call => call.op === 'task.comment.delete')).toHaveLength(0)
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Новый текст', kind: 'change' })
  await pane.press({ key: 'page-comment-delete' })
  expect(fixture.calls.filter(call => call.op === 'task.comment.delete')).toHaveLength(0)
  await pane.unmount()
})

test('Панель только для чтения открывает страницу, скрывает все поля и значки записи', async ($, on) => {
  const fixture = taskHost(on, CARD, { comments: COMMENTS, readOnly: true })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  // Действие одно — «Открыть». Запись счётчиков исполнителей несёт одну подпись, клавиши у неё нет.
  expect(((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions.map(action => [action.key, action.shortcut ?? null]))
    .toEqual([['open', 'o'], [`card-${CARD.taskId}-workers`, null]])
  // Клавиша новой задачи не открывает поле: его сообщения в этом режиме не принимаются, и Enter остался бы без ответа.
  await pane.key({ key: 'n', in: 'rows' })
  expect(await pane.find({ type: 'Client', key: 'new-task' })).toBeUndefined()
  expect((await pane.findAll({ type: 'Client' })).filter(node => node.props.module === 'hooks/editor.tsx')).toHaveLength(0)
  await pane.press({ key: 'open' }); await pane.key({ key: 'j', in: 'page-content' })
  expect(((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions.map(action => action.key)).toEqual(['page-back'])
  for (const key of ['page-description-edit', 'page-comment-edit', 'page-comment-delete', 'caption-page-description-edit', 'caption-page-comment-edit', 'caption-page-comment-delete', 'page-comment-long']) expect(await findEditor(pane, { key })).toBeUndefined()
  expect(elements(await pane.drawn()).some(node => node.type === 'Input')).toBe(false)
  for (const key of ['e', 'a', 'x', 'x']) await pane.key({ key, in: 'page-content' })
  expect((await pane.findAll({ type: 'Client' })).filter(node => node.props.module === 'hooks/editor.tsx')).toHaveLength(0)
  expect(fixture.calls.some(call => call.op === 'session.attest' || call.op === 'task.edit' || call.op.startsWith('task.comment.'))).toBe(false)
  await pane.unmount()
})

for (const width of [40, 60, 100]) for (const rows of [6, 10, 24]) test(`Страница укладывается в бюджет, колесо и клавиши оставляют поле снизу: ${width}x${rows}`, async ($, on) => {
  taskHost(on, { ...CARD, description: 'Длинное описание для прокрутки\n'.repeat(40).trim() }, { comments: COMMENTS })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width, scroll: { offset: 0, bodyRows: rows } } })
  // При высоте 6 нижняя рамка карточки вне окна; прежняя клавиша открытия остаётся доступна.
  if (rows === 6) { expect(await pane.find({ key: 'open', type: 'Button' })).toBeUndefined(); await pane.key({ key: 'o', in: 'rows' }) }
  else await pane.press({ key: 'open' })
  const tree = await pane.drawn()
  const direct = tree.type === 'Box' ? tree.children : []
  expect((Array.isArray(direct) ? direct : [direct]).reduce((sum, child) => sum + (isElement(child) && (child.type === 'Box' || child.type === 'Client') ? Number(child.props?.height ?? 0) : 0), 0)).toBe(rows)
  const page = await pane.find({ type: 'Box', key: `task-page:${CARD.taskId}` })
  expect(page?.props?.height).toBe(rows - 3)
  for (const node of elements(asTree(page))) if (node.type === 'Box' && typeof node.props?.width === 'number') expect(node.props.width).toBeLessThanOrEqual(width)
  const footer = await pane.find({ type: 'Box', key: 'page-composer' })
  const props = (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 3, bodyRows: rows, contentRows: rows, origin: { kind: 'person' } })
  const scrolled = (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  expect(scrolled.offset).toBe(props.offset + 3)
  await pane.key({ key: 'pagedown', in: 'page-content' })
  expect(((await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps).offset).toBeGreaterThan(scrolled.offset)
  await pane.key({ key: 'end', in: 'page-content' })
  const end = (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  expect(end.offset).toBe(end.total - end.height)
  expect((await pane.find({ type: 'Box', key: 'page-composer' }))?.props).toEqual(footer?.props)
  for (const node of elements(await pane.drawn({ in: 'page-content' }))) if (node.type === 'Box' && typeof node.props?.top === 'number') expect(node.props.top).toBeGreaterThanOrEqual(0)
  await pane.unmount()
})

for (const width of [40, 60, 100]) test(`Правка и удержанный секрет соблюдают бюджет; уменьшение панели сохраняет черновики: ${width}`, async ($, on) => {
  const fixture = taskHost(on, { ...CARD, title: 'Название целиком с переносом по словам '.repeat(6), description: 'Описание' }, { comments: COMMENTS })
  const target = { plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width, scroll: { offset: 0, bodyRows: 15 } } } as const
  let pane = await $.ui.mount(target)
  await pane.press({ key: 'open' })
  await pane.press({ key: 'page-description-edit' })
  const editor = await pane.find({ type: 'Box', key: 'page-description-editor' })
  const body = await pane.find({ type: 'Box', key: 'page-body' })
  expect(editor?.props?.top).toBeGreaterThanOrEqual(0)
  expect(Number(editor?.props?.top) + Number(editor?.props?.height)).toBeLessThanOrEqual(Number(body?.props?.height))
  expect(await pane.find({ type: 'Client', key: `page-description:${CARD.taskId}` })).toBeDefined()
  await pane.press({ key: 'page-cancel-edit' })
  await pageTab(pane, 'comments')
  await pane.key({ key: 'j', in: 'page-content' })
  await pane.press({ key: 'page-comment-edit' })
  expect((await findEditor(pane, { type: 'Box', key: 'page-comment-frame' }))?.props?.height).toBe(3)
  // Синтетический образец собран из частей, как в privacy-fixtures.ts; значение не меняется.
  const secret = ['sk_live_', '51', 'HxAbCdEfGhIjKlMnOp'].join('') // gitleaks:allow
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: secret, kind: 'submit' })
  const content = await pane.find({ type: 'Box', key: 'page-body' })
  const footer = await pane.find({ type: 'Box', key: 'page-composer' })
  const rule = await pane.find({ type: 'Box', key: 'page-rule' })
  expect(Number(content?.props?.height) + Number(footer?.props?.height) + Number(rule?.props?.height) + 1).toBe(12)
  expect(Number(content?.props?.height)).toBeGreaterThanOrEqual(1)
  // Предупреждение переносится по ширине панели и видно целиком: вторая его часть говорит, как отправить.
  const warning = await pane.find({ type: 'Box', key: 'page-secret-warning' })
  expect(warning?.props?.height).toBe(width === 40 ? 3 : 2)
  const warningBox = elements(await pane.drawn()).find(node => node.type === 'Box' && node.props?.key === 'page-secret-warning')
  const warningLines = (warningBox && 'children' in warningBox ? elements(warningBox.children) : []).filter(node => node.type === 'Text').map(drawnText)
  expect(warningLines).toHaveLength(Number(warning?.props?.height))
  expect(warningLines.every(line => cellWidth(line) <= width)).toBe(true)
  expect(warningLines.join(' ')).toBe('Не отправлено: в тексте строка, похожая на ключ. Отправить как есть — значок ! на рамке.')
  for (const key of ['page-description-edit', 'page-comment-edit', 'page-comment-delete']) expect(await findEditor(pane, { key })).toBeUndefined()
  const buttons = await pane.findAll({ type: 'Button', in: `page-comment:${CARD.taskId}` })
  expect(buttons.map(button => button.props.label)).toEqual(['!', '×', '⏎ Сохранить'])
  expectEditorHover((await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` }))?.props.props as EditorProps)
  await pane.unmount()
  pane = await $.ui.mount({ ...target, props: { ...target.props, scroll: { offset: 0, bodyRows: 8 } } })
  expect(elements(await pane.drawn()).some(node => node.type === 'Input')).toBe(false)
  expect((await pane.findAll({ type: 'Client' })).filter(node => node.props.module === 'hooks/editor.tsx')).toHaveLength(0)
  expect(drawnText(await pane.drawn())).toContain('Увеличьте панель для ввода')
  expect(((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions.map(action => action.key)).toEqual(['page-back'])
  await pane.unmount()
  pane = await $.ui.mount(target)
  expect((await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` }))?.props?.props?.value).toBe(secret)
  expect(await findEditor(pane, { type: 'Button', key: 'page-comment-confirm' })).toBeDefined()
  expect(fixture.calls.some(call => call.op.startsWith('task.comment.'))).toBe(false)
  await pane.unmount()
})

for (const width of [40, 60, 100]) test(`Карточки не содержат кнопок, приоритета, времени или источника: ${width}`, async ($, on) => {
  const paused = { ...QUEUED, taskId: 'paused', status: 'paused' as const }
  taskHost(on, CARD, { tasks: [CARD, QUEUED, paused] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width, scroll: { offset: 0, bodyRows: 60 } } })
  const tree = await pane.drawn({ in: 'rows' })
  for (const id of [CARD.taskId, QUEUED.taskId, 'paused']) {
    const card = elements(tree).find(node => node.type === 'Box' && node.props?.key === `card:${id}`)
    expect(elements(asTree(card)).filter(node => node.type === 'Button')).toHaveLength(0)
    for (const text of ['P0', 'P1', 'P2', 'P3', 'шаги', 'мин', '▍', '\u{f06a9}', '\u{f02c7}']) expect(drawnText(asTree(card))).not.toContain(text)
  }
  const props = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  for (const row of props.rows) if (row.kind === 'card') {
    expect(row.actions).toEqual([])
    expect(row.height).toBe(2 + row.titleLines.length + row.context.length)
    for (const line of row.lines) expect(cellWidth(line)).toBeLessThanOrEqual(row.innerWidth)
  }
  await pane.unmount()
})

test('Страница показывает критерии и ограничения разделами, служебные поля скрыты, исходные данные сохраняются', async ($, on) => {
  const task = { ...CARD, description: 'Первая строка\nВторая строка', acceptance: ['Проверки зелёные'], constraints: ['Рантайм'], assignee: 'codex' as const, priority: 1 as const, priorityPinned: false }
  const fixture = taskHost(on, task)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, scroll: { offset: 0, bodyRows: 60 } } })
  await pane.key({ key: 'return', in: 'rows' })
  const text = drawnText(await pane.drawn({ in: 'page-content' }))
  for (const phrase of ['Задача:', 'Первая строка', 'Вторая строка', 'Приёмка:', 'Проверки зелёные', 'Ограничения:', 'Рантайм']) expect(text).toContain(phrase)
  for (const phrase of ['Готово, когда', 'Не трогать', 'Исполнитель: codex', 'Исходная фраза', 'Источник:', 'P1']) expect(text).not.toContain(phrase)
  expect(fixture.calls.filter(call => call.op === 'task.edit')).toHaveLength(0)
  expect(fixture.state.focus?.task?.priority).toBe(1)
  expect(fixture.state.focus?.task?.steps).toEqual(CARD.steps)
  expect(fixture.state.focus?.task?.acceptance).toEqual(task.acceptance)
  expect(fixture.state.focus?.task?.constraints).toEqual(task.constraints)
  expect(fixture.state.focus?.task?.assignee).toBe('codex')
  await pane.unmount()
})

for (const width of [40, 60, 100]) test(`Нативные карточки, рамки и две свободные ячейки: ${width}`, async ($, on) => {
  taskHost(on, CARD, { tasks: [CARD, QUEUED, WAITING, FINISHED] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  const tree = await pane.drawn({ in: 'rows' })
  const nodes = elements(tree)
  for (const task of [CARD, QUEUED, WAITING]) {
    const box = nodes.find(node => node.type === 'Box' && node.props?.key === `card:${task.taskId}`)
    expect(box?.type === 'Box' ? box.props?.borderStyle : null).toBe('round')
    expect(box?.type === 'Box' ? box.props?.width : null).toBe(width - 2)
    const roles = roleColors(DEFAULT_THEME)
    const color = task === CARD ? roles.work : roles.muted
    expect(box?.type === 'Box' ? box.props?.borderColor : null).toBe(color)
    expect(box?.type === 'Box' ? box.props?.borderDimColor : null).toBe(task !== CARD)
    expect(box?.type === 'Box' ? box.props?.backgroundColor : null).toBeUndefined()
    const interior = elements(asTree(box)).find(node => node.type === 'Box' && node.props?.key === `interior:${task.taskId}`)
    expect(interior?.type === 'Box' ? interior.props?.backgroundColor : null).toBeUndefined()
    expect(interior?.type === 'Box' ? interior.props?.width : null).toBe(width - 4)
    const children = box && 'children' in box ? elements(box.children) : []
    expect(children.filter(node => node.type === 'Button')).toHaveLength(0)
  }
  // Текст карточек без знаков дерева; значки действий — кнопки на рамке, в текст они не входят.
  const text = nodes.filter(node => node.type === 'Text').map(drawnText).join('')
  for (const glyph of ['\u{f07b}', '\u{f07c}', '\u{f114}', '\u{f115}', '▸', '▾', '', '']) expect(text).not.toContain(glyph)
  expect(nodes.filter(node => node.type === 'Button' && node.props?.key.startsWith('task:finished:'))).toHaveLength(0)
  expect(nodes.filter(node => node.type === 'Text' && node.props?.bold).length).toBeGreaterThan(0)
  await pane.unmount()
})

test('Значки действуют на выбранную карточку, прежние клавиши сохраняются', async ($, on) => {
  const fixture = taskHost(on, CARD, { tasks: [CARD, QUEUED, FINISHED] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ key: 'down', in: 'rows' })
  for (const action of ['current', 'defer']) await pane.press({ key: action })
  await pane.key({ key: 'home', in: 'rows' })
  await pane.key({ key: 'd', in: 'rows' })
  const actions = fixture.calls.filter(call => call.op === 'task.action')
  expect(actions.map(call => call.args)).toEqual(['current', 'defer', 'done'].map(action => ({ taskId: action === 'done' ? CARD.taskId : QUEUED.taskId,
    expectedRevision: QUEUED.revision, expectedFocusRevision: fixture.state.focus?.revision, action })))
  const witness = fixture.calls.find(call => call.op === 'session.attest')?.panelSecret
  for (const call of actions) expect(call.panelSecret).toBe(witness)
  await pane.key({ key: 'h', in: 'rows' })
  await pane.key({ key: 'end', in: 'rows' })
  await pane.key({ key: 'r', in: 'rows' })
  expect(fixture.calls.filter(call => call.op === 'task.action')).toHaveLength(3)
  expect(((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions.map(action => action.key)).toEqual(['open'])
  await pane.unmount()
})

test('Готовых нет во вкладке агента; история показывает все доступные карточки без действий и прежнего предела десять', async ($, on) => {
  const done = Array.from({ length: 12 }, (_, index) => ({ ...FINISHED, taskId: `finished-${index}`, title: `Готовая ${index}` }))
  taskHost(on, CARD, { tasks: [CARD, ...done] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, scroll: { offset: 0, bodyRows: 80 } } })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain('ГОТОВО')
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain('Готовая 0')
  await pane.key({ key: 'h', in: 'rows' })
  const tree = await pane.drawn({ in: 'rows' })
  expect(drawnText(tree)).not.toContain('+2 ещё')
  for (const task of done) {
    const box = elements(tree).find(node => node.type === 'Box' && node.props?.key === `card:${task.taskId}`)
    expect(box?.type === 'Box' ? box.props?.borderStyle : null).toBe('round')
    expect(box?.type === 'Box' ? box.props?.height : null).toBe(3)
    expect(elements(asTree(box)).filter(node => node.type === 'Button')).toHaveLength(0)
  }
  expect(drawnText(tree)).toContain('Готовая 10')
  await pane.key({ key: 'b', in: 'rows' })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain('Готовая 0')
  await pane.unmount()
})

test('↑↓ и j/k выбирают карточки, выбранная рамка имеет цвет текста', async ($, on) => {
  taskHost(on, CARD, { tasks: [CARD, { ...QUEUED, steps: CARD.steps }, WAITING] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  for (const [key, id] of [['down', QUEUED.taskId], ['j', WAITING.taskId], ['up', QUEUED.taskId], ['k', CARD.taskId]] as const) {
    await pane.key({ key, in: 'rows' })
    const box = elements(await pane.drawn({ in: 'rows' })).find(node => node.type === 'Box' && node.props?.key === `card:${id}`)
    expect(box?.type === 'Box' ? box.props?.borderDimColor : null).toBe(false)
    if (id === QUEUED.taskId) {
      expect(box?.type === 'Box' ? box.props?.borderColor : null).toBe(DEFAULT_THEME.fg || 'text')
      expect(box?.type === 'Box' ? box.props?.borderStyle : null).toBe('round')
    }
  }
  await pane.key({ key: 'down', in: 'rows' })
  await pane.key({ key: 'return', in: 'rows' })
  expect(elements(await pane.drawn({ in: 'page-content' })).some(node => node.type === 'Button')).toBe(false)
  await pane.key({ key: 'q', in: 'page-content' })
  await pane.key({ key: 'space', in: 'rows' })
  expect(elements(await pane.drawn({ in: 'rows' })).some(node => node.type === 'Button' && node.props?.key === `step:${QUEUED.taskId}:1`)).toBe(false)
  await pane.unmount()
})

test('Карточка обрезает длинное название, страница показывает его целиком под номером', async ($, on) => {
  const task = { ...CARD, title: 'Проверить длинный заголовок карточки со словами и контекстом, который нельзя вместить в четыре короткие строки. '.repeat(3),
    steps: Array.from({ length: 9 }, (_, position) => ({ position, title: `Шаг ${position}`, status: 'pending' as const })) }
  taskHost(on, task)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: 40 } })
  const tree = await pane.drawn({ in: 'rows' })
  const title = elements(tree).filter(node => node.type === 'Box' && String(node.props?.key).startsWith(`title:${task.taskId}:`))
  expect(title).toHaveLength(4)
  for (const row of title) expect(cellWidth(drawnText(row))).toBeLessThanOrEqual(36)
  expect(drawnText(asTree(title[3]))).toMatch(/…$/)
  await pane.key({ key: 'return', in: 'rows' })
  expect(await pane.find({ type: 'Box', key: 'page-title' })).toBeUndefined()
  const opened = (await pane.find({ type: 'Client', key: 'page-content' }))?.props.props as TaskPageProps
  expect(opened.lines[0]?.kind).toBe('title')
  expect(((await pane.find({ type: 'Client', key: 'panel-header' }))?.props.props as PanelActionsProps).title).toBe(` #${task.alias.slice(5)}`)
  const titleLines = opened.lines.filter(line => line.kind === 'title').map(line => line.text)
  expect(titleLines.length).toBeGreaterThan(2)
  expect(titleLines.join(' ')).toBe(task.title.trim())
  for (const line of titleLines) expect(cellWidth(line)).toBeLessThanOrEqual(36)
  await pane.key({ key: 'q', in: 'page-content' })
  // Значки действий теперь внутри модуля карточек: номер обработчика кнопки движок выдаёт на каждую отрисовку заново.
  const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === 'handle' ? undefined : item))
  expect(stable(await pane.drawn({ in: 'rows' }))).toEqual(stable(tree))
  await pane.unmount()
})

test('Без фокуса выбирается первая задача очереди; недоступные значки не рисуются', { options: { glyphs: 'nerd' } }, async ($, on) => {
  const paused = { ...WAITING, status: 'paused' as const, taskId: 'paused', queuePosition: 0 }
  const fixture = taskHost(on, null, { tasks: [paused, QUEUED, { ...QUEUED, taskId: 'second', queuePosition: 4 }] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const props = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  expect(props.rows.find(row => row.kind === 'card' && row.selected)?.taskId).toBe(QUEUED.taskId)
  const header = (await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps
  expect(header.actions.filter(item => item.shortcut).map(item => item.label.codePointAt(0))).toEqual([0xf0208, 0xf040a, 0xf120e, 0xf0045, 0xf01b4, 0xf0415])
  expect(header.actions.some(item => item.key === 'append')).toBe(false)
  expect(header.actions.some(item => item.dimColor)).toBe(false)
  await pane.key({ key: 'u', in: 'rows' })
  expect(fixture.calls.filter(call => call.op === 'task.action')).toHaveLength(0)
  await pane.press({ key: 'down' })
  await pane.key({ key: 'down', in: 'rows' })
  await pane.press({ key: 'up' })
  expect(fixture.calls.filter(call => call.op === 'task.action').map(call => call.args)).toEqual([
    { taskId: QUEUED.taskId, expectedRevision: QUEUED.revision, expectedFocusRevision: 0, action: 'down' },
    { taskId: 'second', expectedRevision: QUEUED.revision, expectedFocusRevision: 0, action: 'up' },
  ])
  await pane.key({ key: 'end', in: 'rows' })
  const before = fixture.calls.filter(call => call.op === 'task.action').length
  const last = (await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps
  expect(last.actions.some(item => item.key === 'defer')).toBe(true)
  expect(last.actions.some(item => item.key === 'down')).toBe(false)
  await pane.key({ key: 'p', in: 'rows' })
  expect(fixture.calls.filter(call => call.op === 'task.action')).toHaveLength(before + 1)
  expect(fixture.calls.filter(call => call.op === 'task.action').at(-1)?.args).toMatchObject({ taskId: 'second', action: 'defer' })
  await pane.unmount()
})

for (const width of [40, 60, 100]) test(`HANDOFF-2: новый проект сразу показывает поле новой задачи: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  taskHost(on, null)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  const field = await pane.find({ type: 'Client', key: 'new-task' })
  expect(field?.props.props).toMatchObject({ value: '', width, height: 3, placeholder: 'Новая задача', focused: false })
  const box = await pane.find({ in: 'new-task', type: 'Box', key: 'new-task-frame' })
  expect(box?.props).toMatchObject({ borderStyle: 'round', width, height: 3 })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain('Первая задача:')
  expect(await pane.find({ in: 'rows', type: 'Button' })).toBeUndefined()
  await pane.unmount()
})

test('Блик меняет только название во время хода, вне хода неподвижен', async ($, on) => {
  taskHost(on, CARD, { tasks: [CARD, QUEUED, WAITING] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const idle = await pane.drawn({ in: 'rows' })
  expect(drawnText(idle)).toContain('В РАБОТЕ')
  await pane.advance(180)
  expect(await pane.drawn({ in: 'rows' })).toEqual(idle)
  await $.turn.start({ text: 'Работай', turnId: 'shine-turn' })
  const before = await pane.drawn({ in: 'rows' })
  expect(drawnText(before)).toContain('В РАБОТЕ')
  expect(drawnText(before)).not.toContain('ждёт агента')
  await pane.advance(180)
  const after = await pane.drawn({ in: 'rows' })
  expect(after).not.toEqual(before)
  const titleColors = (tree: RenderChildren) => {
    const title = elements(tree).find(node => node.type === 'Box' && node.props?.key === `title:${CARD.taskId}:0`)
    return elements(asTree(title)).filter(node => node.type === 'Text').map(node => node.type === 'Text' ? node.props?.color : null)
  }
  const beforeColors = titleColors(before)
  const afterColors = titleColors(after)
  expect(afterColors).not.toEqual(beforeColors)
  await $.turn.complete({ turnId: 'shine-turn', answer: '', reason: 'answer', durationMs: 180, isAborted: false })
  const stopped = await pane.drawn({ in: 'rows' })
  expect(drawnText(stopped)).toContain('▶ 1')
  await pane.advance(180)
  expect(await pane.drawn({ in: 'rows' })).toEqual(stopped)
  await pane.unmount()
})

// Движок перезагружает мод посреди хода (смена plugin.json при раскладке, смена настройки, /reload-plugins).
// Новая загрузка не видела turn.start: о ходе ей сообщает движок через isWorking полосы над вводом.
test('WORK-1: блик идёт и после перезагрузки мода посреди хода, пока движок сообщает о ходе', async ($, on) => {
  const fixture = taskHost(on, CARD, { tasks: [CARD, QUEUED, WAITING] })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('▶ 1')
  const band = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, isWorking: true } })
  await fixture.clock.settle()
  const running = await pane.drawn({ in: 'rows' })
  expect(drawnText(running)).toContain('В РАБОТЕ')
  expect(drawnText(running)).not.toContain('ждёт агента')
  const strip = (await band.find({ type: 'Client', key: 'task-band' }))?.props?.props as { rows: { left: { spin?: boolean; sh?: string }[] }[] }
  expect(strip.rows[0]!.left.some(seg => seg.spin)).toBe(true)
  expect(strip.rows[0]!.left.filter(seg => seg.sh)).toHaveLength(1)
  await pane.advance(180)
  expect(await pane.drawn({ in: 'rows' })).not.toEqual(running)
  // Конец хода, начало которого эта загрузка не видела: событие приходит с незнакомым ей turnId.
  await $.turn.complete({ turnId: 'before-reload', answer: '', reason: 'answer', durationMs: 180, isAborted: false })
  const stopped = await pane.drawn({ in: 'rows' })
  expect(drawnText(stopped)).toContain('▶ 1')
  await pane.advance(180)
  expect(await pane.drawn({ in: 'rows' })).toEqual(stopped)
  await pane.unmount(); await band.unmount()
})

test('WORK-1: конец хода, который мод не увидел, гасит блик по сообщению движка; прежнее значение движка ход не отменяет', async ($, on) => {
  const fixture = taskHost(on, CARD, { tasks: [CARD, QUEUED, WAITING] })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const band = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  // Событие начала хода опережает отрисовку: полоса ещё рисуется с прежним isWorking: false, и ход от этого не гаснет.
  await $.turn.start({ text: 'Работай', turnId: 'live-turn' })
  await band.redraw({ ...BAND, isWorking: false })
  await fixture.clock.settle()
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('В РАБОТЕ')
  expect(((await pane.find({ type: 'Client', key: 'rows' }))?.props.props as TaskCardsProps).rows.filter(row => row.kind === 'card' && row.shimmer)).toHaveLength(1)
  await band.redraw({ ...BAND, isWorking: true })
  await fixture.clock.settle()
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('В РАБОТЕ')
  // Событие конца хода не пришло (мод перезагружался): движок сообщает, что ход закончился.
  await band.redraw({ ...BAND, isWorking: false })
  await fixture.clock.settle()
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('▶ 1')
  expect(((await pane.find({ type: 'Client', key: 'rows' }))?.props.props as TaskCardsProps).rows.filter(row => row.kind === 'card' && row.shimmer)).toHaveLength(0)
  expect(await band.find({ type: 'Client', key: 'task-band' })).toBeDefined()
  const strip = (await band.find({ type: 'Client', key: 'task-band' }))?.props?.props as { rows: { left: { spin?: boolean }[] }[] }
  expect(strip.rows[0]!.left.some(seg => seg.spin)).toBe(false)
  await pane.unmount(); await band.unmount()
})

// Ход побочного запроса начинается без agentId, а завершается с ним: признак хода снимает тот же turnId.
test('WORK-1: завершение побочного хода с agentId не оставляет блик гореть', async ($, on) => {
  taskHost(on, CARD, { tasks: [CARD, QUEUED, WAITING] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await $.turn.start({ text: '', turnId: 'side' })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('В РАБОТЕ')
  expect(((await pane.find({ type: 'Client', key: 'rows' }))?.props.props as TaskCardsProps).rows.filter(row => row.kind === 'card' && row.shimmer)).toHaveLength(1)
  await $.turn.complete({ turnId: 'side', answer: '', reason: 'answer', durationMs: 10, isAborted: false, agentId: 'side-request' })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('▶ 1')
  expect(((await pane.find({ type: 'Client', key: 'rows' }))?.props.props as TaskCardsProps).rows.filter(row => row.kind === 'card' && row.shimmer)).toHaveLength(0)
  // Завершение хода субагента с другим turnId идущий ход главного агента не гасит.
  await $.turn.start({ text: 'Работай', turnId: 'main' })
  await $.turn.complete({ turnId: 'child', answer: '', reason: 'answer', durationMs: 10, isAborted: false, agentId: 'child-agent' })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('В РАБОТЕ')
  expect(((await pane.find({ type: 'Client', key: 'rows' }))?.props.props as TaskCardsProps).rows.filter(row => row.kind === 'card' && row.shimmer)).toHaveLength(1)
  await $.turn.complete({ turnId: 'main', answer: '', reason: 'answer', durationMs: 10, isAborted: false })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('▶ 1')
  expect(((await pane.find({ type: 'Client', key: 'rows' }))?.props.props as TaskCardsProps).rows.filter(row => row.kind === 'card' && row.shimmer)).toHaveLength(0)
  await pane.unmount()
})

test('В низком окне переходы держат выбранную карточку целиком видимой', async ($, on) => {
  const tasks = Array.from({ length: 15 }, (_, index) => ({ ...QUEUED, taskId: `queue-${index}`, queuePosition: index + 2 }))
  taskHost(on, CARD, { tasks: [CARD, ...tasks] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, scroll: { offset: 0, bodyRows: 10 } } })
  for (const [key, id] of [['', CARD.taskId], ['down', 'queue-0'], ['end', 'queue-14'], ['up', 'queue-13'], ['home', CARD.taskId]] as const) {
    if (key) await pane.key({ key, in: 'rows' })
    const tree = await pane.drawn({ in: 'rows' })
    const window = elements(tree).find(node => node.type === 'Box' && node.props?.key === 'card-window')
    expect(window?.type).toBe('Box')
    let top = window?.type === 'Box' && typeof window.props?.top === 'number' ? window.props?.top : 0
    let found = false
    for (const node of window && 'children' in window ? window.children ?? [] : []) {
      const height = isElement(node) && node.type === 'Box' && typeof node.props?.height === 'number' ? node.props?.height : 1
      if (isElement(node) && node.type === 'Box' && node.props?.key === `card-slot:${id}`) {
        found = true
        expect(top).toBeGreaterThanOrEqual(0)
        expect(top + height).toBeLessThanOrEqual(6)
      }
      top += height
    }
    expect(found).toBe(true)
    expect(tree.type === 'Box' ? tree.props?.height : null).toBe(6)
  }
  await pane.unmount()
})

test('Изменение ширины сохраняет выбранную карточку в окне', async ($, on) => {
  const tasks = Array.from({ length: 15 }, (_, index) => ({ ...QUEUED, taskId: `queue-${index}`, queuePosition: index + 2,
    title: 'Проверить перенос заголовка выбранной карточки в узком окне' }))
  taskHost(on, CARD, { tasks: [CARD, ...tasks] })
  const wide = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 } } })
  await wide.key({ key: 'end', in: 'rows' })
  await wide.unmount()
  const narrow = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: 40, scroll: { offset: 0, bodyRows: 10 } } })
  expect(await narrow.find({ in: 'rows', type: 'Box', key: 'card:queue-14' })).toBeDefined()
  await narrow.unmount()
})

for (const width of [40, 60, 100]) test(`Последняя рамка помещается в бюджет панели ${width}`, async ($, on) => {
  const tasks = Array.from({ length: 23 }, (_, index) => ({ ...QUEUED, taskId: `budget-${index}`, queuePosition: index + 2,
    title: 'Полная формулировка задачи '.repeat(16), description: 'Контекст владельца '.repeat(24) }))
  taskHost(on, CARD, { tasks: [CARD, ...tasks] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width, scroll: { offset: 0, bodyRows: 20 } } })
  await pane.key({ key: 'end', in: 'rows' })
  const root = await pane.drawn()
  expect(root.type === 'Box' ? root.props?.height : null).toBe(20)
  const viewport = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  expect(viewport.height + 1).toBeLessThanOrEqual(20)
  const last = viewport.rows.find(row => row.taskId === tasks[22]!.taskId)
  if (!last) throw new Error('Последняя карточка отсутствует')
  const top = viewport.top + viewport.rows.slice(0, viewport.rows.indexOf(last)).reduce((sum, row) => sum + row.height, 0)
  expect(top).toBeGreaterThanOrEqual(0)
  expect(top + last.height).toBeLessThanOrEqual(viewport.height)
  const box = await pane.find({ in: 'rows', type: 'Box', key: `card:${tasks[22]!.taskId}` })
  expect(box?.type === 'Box' ? box.props?.height : null).toBe(last.height)
  expect(box?.type === 'Box' ? box.props?.borderStyle : null).toBe('round')
  await pane.unmount()
})

test('Ползунок двигает окно карточек мышью без модификаторов', async ($, on) => {
  const tasks = Array.from({ length: 15 }, (_, index) => ({ ...QUEUED, taskId: `queue-${index}`, queuePosition: index + 2 }))
  taskHost(on, CARD, { tasks: [CARD, ...tasks] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, scroll: { offset: 0, bodyRows: 10 } } })
  await pane.resize({ columns: 80, rows: 9, in: 'rows' })
  await pane.pointer({ type: 'down', x: 79, y: 8, button: 'left', in: 'rows' })
  const client = await pane.find({ type: 'Client', key: 'rows' })
  const props = client?.props?.props as TaskCardsProps
  expect(props.offset).toBe(props.totalHeight - props.height)
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain(tasks[14]!.title)
  await pane.pointer({ type: 'up', x: 79, y: 8, in: 'rows' })
  await pane.unmount()
})

test('Колесо двигает окно карточек по их высоте', async ($, on) => {
  const tasks = Array.from({ length: 15 }, (_, index) => ({ ...QUEUED, taskId: `queue-${index}`, queuePosition: index + 2 }))
  taskHost(on, CARD, { tasks: [CARD, ...tasks] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, scroll: { offset: 0, bodyRows: 10 } } })
  const readOffset = async () => ((await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps).offset
  const before = await readOffset()
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 12, bodyRows: 10, contentRows: 10, origin: { kind: 'person' } })
  expect(await readOffset()).toBe(before + 12)
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: -12, bodyRows: 10, contentRows: 10, origin: { kind: 'person' } })
  expect(await readOffset()).toBe(before)
  await pane.unmount()
})

test('Нажатие тела выбирает карточку, номер стоит на верхней линии рамки', async ($, on) => {
  const fixture = taskHost(on, CARD, { tasks: [CARD, { ...QUEUED, steps: CARD.steps }] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const clickBody = async () => {
    const props = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
    const index = props.rows.findIndex(row => row.taskId === QUEUED.taskId)
    const y = props.top + props.rows.slice(0, index).reduce((sum, row) => sum + row.height, 0) + 2
    await pane.pointer({ type: 'down', x: 8, y, button: 'left', in: 'rows' })
    await pane.pointer({ type: 'up', x: 8, y, button: 'left', in: 'rows' })
    await fixture.clock.advance(1000) // следующее нажатие — новый выбор, а не двойное
  }
  await clickBody()
  const selected = await pane.find({ in: 'rows', type: 'Box', key: `card:${QUEUED.taskId}` })
  expect(selected?.type === 'Box' ? selected.props?.borderColor : null).toBe(DEFAULT_THEME.fg || 'text')
  const cardTree = await pane.drawn({ in: 'rows' })
  const numberNode = elements(cardTree).find(node => node.type === 'Box' && node.props?.key === `number-frame:${QUEUED.taskId}`)
  expect(drawnText(asTree(numberNode))).toBe(' #1 ')
  // Номер выбранной карточки темнеет вместе с её рамкой.
  const numberText = elements(asTree(numberNode)).find(node => node.type === 'Text')
  expect(numberText?.type === 'Text' ? numberText.props?.color : null).toBe(DEFAULT_THEME.fg || 'text')
  expect(numberNode !== undefined && 'props' in numberNode ? numberNode.props : undefined).toMatchObject({ position: 'absolute', top: 0, left: 2 })
  expect(drawnText(asTree(await pane.find({ in: 'rows', type: 'Box', key: `number-frame:${CARD.taskId}` })))).toBe(' #1 ')
  for (const task of [CARD, QUEUED]) {
    const gutter = await pane.find({ in: 'rows', type: 'Box', key: `gutter:${task.taskId}:0` })
    expect(gutter).toBeUndefined()
  }
  await clickBody()
  expect(await pane.find({ in: 'rows', type: 'Button', key: `step:${QUEUED.taskId}:1` })).toBeUndefined()
  await pane.unmount()
})

test('Кнопки пишут только после аттестации; удаление требует два нажатия', async ($, on) => {
  const fixture = taskHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ key: 'd', in: 'rows' })
  expect(fixture.calls.filter(call => call.op === 'task.action')).toHaveLength(0)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  await pane.key({ key: 'space', in: 'rows' })
  await pane.press({ key: 'delete' })
  expect(fixture.calls.filter(call => call.op === 'task.action')).toHaveLength(0)
  await pane.press({ key: 'delete' })
  const action = fixture.calls.find(call => call.op === 'task.action')
  expect(action?.args).toMatchObject({ taskId: CARD.taskId, expectedRevision: CARD.revision, action: 'delete' })
  expect(action?.panelSecret).toMatch(/^[a-f0-9]{64}$/)
  for (const written of fixture.writes) expect(written).not.toContain(action?.panelSecret ?? 'fixture-secret')
  await pane.unmount()
})

test('Добавление через общий редактор и команда add используют аттестованный task.create', async ($, on) => {
  const fixture = taskHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'new' }); await inputEditor(pane, { key: 'new-task', text: 'Новая карточка', kind: 'submit' })
  expect(await $.command.run(taskCommand('add Вторая карточка'))).toEqual({})
  const created = fixture.calls.filter(call => call.op === 'task.create')
  expect(created.map(call => call.args)).toEqual([{ title: 'Новая карточка' }, { title: 'Вторая карточка' }])
  const witness = fixture.calls.find(call => call.op === 'session.attest')?.panelSecret
  expect(witness).toMatch(/^[a-f0-9]{64}$/)
  for (const call of created) {
    expect(call.panelSecret).toBe(witness)
    for (const written of fixture.writes) expect(written).not.toContain(call.panelSecret ?? 'fixture-secret')
  }
  await pane.unmount()
})

test('Продолжить дописывает короткий черновик без отправки; compact открывает восстановленную задачу', async ($, on) => {
  const fixture = taskHost(on)
  await $.classic.SessionStart({ source: 'compact', cwd: '/fixture', session_id: 'fixture-session' })
  expect(fixture.opens[0]).toEqual({ id: 'tasks', title: 'Задачи' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ key: 'c', in: 'rows' })
  expect(fixture.fills).toHaveLength(1); expect(fixture.fills[0]?.mode).toBe('append')
  for (const text of [CARD.title, 'Собрать ряды', CHECKPOINT.text, 'Проверить тему']) expect(fixture.fills[0]?.text).toContain(text)
  expect(fixture.models).toHaveLength(0)
  await pane.unmount()
})

for (const active of [true, false]) {
  test(`AbovePrompt сохраняет дерево другого мода, активная=${active}`, async ($, on) => {
    taskHost(on, active ? CARD : null)
    let lower = 0
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => { lower += 1; const { Text } = $.ui.resolve(e); return <Text>Соседняя полоса</Text> })
    const band = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: 'Соседняя полоса' })).toBeDefined()
    const tree = JSON.stringify(await band.drawn())
    expect(tree.includes('task-band')).toBe(active); expect(lower).toBe(1)
    await band.unmount()
  })
}

for (const width of [36, 60, 120]) test(`Полоса текущей задачи: клиентский Брайль, глиняный блик, «в очереди N» без времени: ${width}`, async ($, on) => {
  taskHost(on, CARD, { tasks: [CARD, QUEUED, { ...QUEUED, taskId: 'next-two' }] })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  const band = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: width } })
  const client = await band.find({ type: 'Client', key: 'task-band' })
  const props = client?.props?.props as { rows: { left: { t: string; spin?: boolean; sh?: string }[]; right: { t: string }[] }[] }
  const row = props.rows[0]!
  const text = row.left.map(seg => seg.t).join('') + row.right.map(seg => seg.t).join('')
  expect(text).toContain('в очереди 2')
  expect(text).not.toContain('1 мин')
  expect(text).not.toContain('▣')
  expect(text).not.toContain('далее:')
  expect(text).not.toContain(QUEUED.title)
  expect(text).not.toContain('·')
  expect(cellWidth(text)).toBeLessThanOrEqual(width)
  expect(row.left.some(seg => seg.spin || seg.sh)).toBe(false)
  // В простое перед названием стоит знак паузы, а не слово. Задача в работе окрашена своим цветом и без блика.
  expect(row.left[0]).toEqual({ t: '⧖ ', c: roleColors(DEFAULT_THEME).work })
  expect((row.left as { t: string; b?: boolean; c?: string }[])[1]).toMatchObject({ b: true, c: roleColors(DEFAULT_THEME).work })
  expect(row.left.map(seg => seg.t).join('')).not.toContain('ждёт')
  await $.turn.start({ text: 'Работай', turnId: 'band-turn' })
  const active = (await band.find({ type: 'Client', key: 'task-band' }))?.props?.props as typeof props
  expect(active.rows[0]!.left.filter(seg => seg.sh)).toHaveLength(1)
  expect(active.rows[0]!.left[0]).toMatchObject({ t: '', spin: true, c: roleColors(DEFAULT_THEME).work })
  const before = await band.drawn({ in: 'task-band' })
  expect(drawnText(before)).toContain('⠋')
  await band.advance(90)
  const after = await band.drawn({ in: 'task-band' })
  expect(drawnText(after)).toContain('⠙')
  expect(cellWidth(drawnText(after))).toBeLessThanOrEqual(width)
  await $.turn.complete({ turnId: 'band-turn', answer: '', reason: 'answer', durationMs: 90, isAborted: false })
  expect(drawnText(await band.drawn({ in: 'task-band' }))).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u)
  await band.unmount()
})

test('В шапке списка задач нет действия append и оно отсутствует среди кнопок', async ($, on) => {
  const fixture = taskHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const header = await pane.drawn({ in: 'panel-header' })
  const nodes = elements(header)
  const buttons = nodes.filter(node => node.type === 'Button')
  expect(buttons.some(node => node.props?.key === 'append')).toBe(false)
  expect(await pane.find({ key: 'append' })).toBeUndefined()
  expect(await pane.find({ key: 'caption-append' })).toBeUndefined()
  const headerClient = await pane.find({ key: 'panel-header', type: 'Client' })
  if (headerClient) {
    const actions = (headerClient.props?.props as PanelActionsProps).actions
    expect(actions.some(action => action.key === 'append')).toBe(false)
  }
  await pane.unmount()
})

test('Клавиша a в списке задач ничего не открывает и список карточек остаётся на экране', async ($, on) => {
  const fixture = taskHost(on, CARD, { tasks: [CARD, QUEUED] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ key: 'a', in: 'rows' })
  expect(await pane.find({ type: 'Client', key: `append:${CARD.taskId}` })).toBeUndefined()
  expect(await pane.find({ type: 'Box', key: `editor:${CARD.taskId}` })).toBeUndefined()
  expect(elements(await pane.drawn()).filter(isFieldInput)).toHaveLength(0)
  expect((await pane.findAll({ type: 'Client' })).filter(node => node.props.module === 'hooks/editor.tsx')).toHaveLength(0)
  expect(await pane.find({ type: 'Client', key: 'rows' })).toBeDefined()
  await pane.key({ key: 'down', in: 'rows' })
  await pane.key({ key: 'a', in: 'rows' })
  expect(await pane.find({ type: 'Client', key: `append:${QUEUED.taskId}` })).toBeUndefined()
  expect(await pane.find({ type: 'Box', key: `editor:${QUEUED.taskId}` })).toBeUndefined()
  expect(elements(await pane.drawn()).filter(isFieldInput)).toHaveLength(0)
  expect((await pane.findAll({ type: 'Client' })).filter(node => node.props.module === 'hooks/editor.tsx')).toHaveLength(0)
  expect(await pane.find({ type: 'Client', key: 'rows' })).toBeDefined()
  expect(fixture.calls.filter(call => call.op === 'task.edit')).toHaveLength(0)
  await pane.unmount()
})

test('Дополнение описания выполняется со страницы задачи: открытие по o, правка по e, сохранение по submit', async ($, on) => {
  const fixture = taskHost(on, { ...CARD, description: 'Исходный контекст' })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ key: 'o', in: 'rows' })
  expect(await pane.find({ type: 'Box', key: `task-page:${CARD.taskId}` })).toBeDefined()
  await pane.key({ key: 'e', in: 'page-content' })
  const key = `page-description:${CARD.taskId}`
  expect((await pane.find({ type: 'Client', key }))?.props?.props?.value).toBe('Исходный контекст')
  await inputEditor(pane, { key, text: 'Исходный контекст\n\nДополненная строка', kind: 'change' })
  await inputEditor(pane, { key, text: 'Исходный контекст\n\nДополненная строка', kind: 'submit' })
  const writes = fixture.calls.filter(call => call.op === 'task.edit')
  expect(writes).toHaveLength(1)
  expect(writes[0]?.args.description).toBe('Исходный контекст\n\nДополненная строка')
  expect(writes[0]?.actor).toBe('owner')
  expect(fixture.state.focus?.task?.description).toBe('Исходный контекст\n\nДополненная строка')
  expect(await pane.find({ type: 'Client', key })).toBeUndefined()
  await pane.unmount()
})

test('Панель автоматически перечитывает snapshot без кнопки обновления', async ($, on) => {
  const fixture = taskHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  fixture.changeTask({ ...CARD, title: 'Обновлённая задача' }, true)
  await fixture.clock.advance(30_000)
  expect(fixture.calls.filter(call => call.op === 'snapshot').length).toBeGreaterThan(0)
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('Обновлённая задача')
  expect(await pane.find({ type: 'Button', key: 'refresh' })).toBeUndefined()
  await pane.unmount()
})

test('Обычные вопросы и подтверждения обходятся без малой модели и сохраняют контекст', async ($, on) => {
  const fixture = taskHost(on)
  for (const text of ['Да', 'Продолжай', 'Как устроена панель задач?']) {
    const result = await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false, context: ['Прежний контекст'] })
    expect(result.text).toBe(text)
    expect(result.context?.[0]).toBe('Прежний контекст')
    expect(result.context?.[1]).toContain(`Текущая #1: ${CARD.title}`)
    expect(result.context).toHaveLength(2)
  }
  await fixture.clock.settle()
  expect(fixture.models).toHaveLength(0)
})

test('Фоновый захват сохраняет запрос и контекст без создания задачи', async ($, on) => {
  const fixture = taskHost(on, null)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const before = fixture.toasts.length
  const text = 'Исправить панель задач и проверить тему'
  expect(await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false, context: ['Прежний контекст'] })).toEqual({ text, context: ['Прежний контекст'] })
  await fixture.clock.settle()
  expect(fixture.calls.filter(call => call.op === 'capture.prompt')).toHaveLength(1)
  expect(fixture.calls.filter(call => ['inbox.material', 'tasks.extract', 'extraction.report'].includes(call.op))).toHaveLength(0)
  expect(fixture.models).toHaveLength(0)
  expect(fixture.state.snapshot?.tasks).toEqual([])
  expect(fixture.state.focus?.task).toBeNull()
  expect(fixture.toasts).toHaveLength(before)
})

test('Агенту разрешены только tasks.agent.create, task.agent.action, tasks.context и чтения; аттестация панели и прочие записи закрыты', async ($, on) => {
  const fixture = taskHost(on)
  for (const command of ['cockpitctl rpc', 'cockpitctl confirm task-1', 'sqlite3 cockpit.db .dump',
    'cockpitctl rpc task.comment.add', 'cockpitctl rpc task.comment.edit', 'cockpitctl rpc task.comment.delete']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeDefined()
  }
  expect(fixture.calls).toHaveLength(0)
  const session = { sessionId: 'fixture-session', cwd: '/fixture' }
  const proof = 'ab'.repeat(32) // gitleaks:allow
  expect(buildRequest('tasks.agent.create', 'agent-add', session, { tasks: [{ title: 'Проверить задачи' }] }, proof, 'agent').actor).toBe('agent')
  expect(buildRequest('task.agent.action', 'agent-done', session, { taskId: TASK.taskId, expectedRevision: 3, expectedFocusRevision: 2, action: 'done' }, proof, 'agent').actor).toBe('agent')
  for (const op of ['tasks.context', 'snapshot', 'focus.get', 'task.get', 'inbox.get', 'inbox.material', 'checkpoint.list', 'config.get', 'doctor'] as const) {
    expect(buildRequest(op, 'agent-read', session, {} as never, proof, 'agent').actor).toBe('agent')
  }
  for (const op of [...HUMAN_WRITES, 'session.attest', 'capture.prompt', 'task.bind', 'session.rebind', 'session.end', 'gate.check'] as const) {
    expect(() => buildRequest(op, 'agent-forbidden', session, {} as never, proof, 'agent')).toThrow('Недопустимое свидетельство')
  }
})

test('Двойное нажатие карточки открывает её страницу; одиночное и медленное второе только выбирают', async ($, on) => {
  const fixture = taskHost(on, CARD, { tasks: [CARD, QUEUED] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const click = async () => {
    const props = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
    const index = props.rows.findIndex(row => row.taskId === QUEUED.taskId)
    const y = props.top + props.rows.slice(0, index).reduce((sum, row) => sum + row.height, 0) + 2
    await pane.pointer({ type: 'down', x: 8, y, button: 'left', in: 'rows' })
    await pane.pointer({ type: 'up', x: 8, y, button: 'left', in: 'rows' })
  }
  await click()
  expect(await pane.find({ type: 'Box', key: 'page-body' })).toBeUndefined()
  await fixture.clock.advance(2000)
  await click()
  expect(await pane.find({ type: 'Box', key: 'page-body' })).toBeUndefined()
  await click()
  expect(await pane.find({ type: 'Box', key: 'page-body' })).toBeDefined()
  expect(fixture.calls.some(call => call.op === 'task.get' && call.args.taskId === QUEUED.taskId)).toBe(true)
  await pane.unmount()
})

// Набор значков выбирается один раз и до первого кадра: смена знаков во время работы читалась как поломка.
test('GLYPHS-1: сбой проверки шрифта оставляет значки шрифта, проверка не повторяется и набор не меняется', { options: { glyphs: 'auto' } }, async ($, on) => {
  let probes = 0
  fontProbe = () => { probes += 1; throw new Error('timeout') }
  try {
    const fixture = taskHost(on, CARD, { tasks: [CARD, QUEUED] })
    const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
    const first = async () => ((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions[0]?.label.codePointAt(0)
    expect(await first()).toBe(0xf0208)
    await fixture.clock.advance(61_000)
    await pane.redraw(PANE)
    expect(probes).toBe(1)
    expect(await first()).toBe(0xf0208)
    await pane.unmount()
  } finally { fontProbe = null }
})

for (const variable of ['SSH_CONNECTION', 'SSH_TTY']) test(`GLYPHS-1: при входе по SSH шрифт на сервере не ищется, значки шрифта с первого кадра: ${variable}`, { options: { glyphs: 'auto' } }, async ($, on) => {
  let probes = 0
  fontProbe = () => { probes += 1; return 'missing' }
  try {
    taskHost(on, CARD, { tasks: [CARD, QUEUED], env: { [variable]: variable === 'SSH_TTY' ? '/dev/pts/3' : '192.0.2.10 50000 192.0.2.1 22' } })
    const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
    expect(((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions[0]?.label.codePointAt(0)).toBe(0xf0208)
    expect(probes).toBe(0)
    await pane.unmount()
  } finally { fontProbe = null }
})

test('GLYPHS-1: местный терминал без шрифта получает запасные знаки с первого кадра, проверка одна', { options: { glyphs: 'auto' } }, async ($, on) => {
  let probes = 0
  fontProbe = () => { probes += 1; return 'missing' }
  try {
    const fixture = taskHost(on, CARD, { tasks: [CARD, QUEUED] })
    const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
    const first = async () => ((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions[0]?.label.codePointAt(0)
    expect(await first()).toBe('▾'.codePointAt(0))
    await fixture.clock.advance(61_000)
    await pane.redraw(PANE)
    expect(probes).toBe(1)
    expect(await first()).toBe('▾'.codePointAt(0))
    await pane.unmount()
  } finally { fontProbe = null }
})

test('Задача бэклога видна отдельной вкладкой; у агента только текущая и очередь', async ($, on) => {
  const paused = { ...QUEUED, status: 'paused' as const, taskId: 'paused', title: 'Проверить задачу бэклога' }
  taskHost(on, CARD, { tasks: [CARD, QUEUED, paused] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  const text = async () => drawnText(await pane.drawn({ in: 'rows' }))
  expect(await text()).toContain('ОЧЕРЕДЬ 1')
  expect(await text()).not.toContain('ЖДЁТ ВАС')
  expect(await text()).not.toContain(paused.title)
  await pane.press({ key: 'tab-backlog' })
  expect(await text()).toContain(paused.title)
  expect(await text()).not.toContain(CARD.title)
  expect(await text()).not.toContain(QUEUED.title)
  await pane.unmount()
})

const HISTORY_TASK: Task = { ...FINISHED, alias: 'TASK-42', title: 'Проверить историю', updatedAt: new Date(2026, 9, 5, 3, 27).toISOString().replace('.000Z', '.000000Z'),
  description: 'Владелец: Проверить закрытую задачу\n\nГотово, когда: Критерий на странице' }
const HISTORY_RESULT: AgentTaskNote = { noteId: 'history-result', taskId: HISTORY_TASK.taskId, kind: 'result', text: 'Проверил карточку и клавиши',
  createdAt: HISTORY_TASK.updatedAt, source: 'agent', provenance: 'tool' }

for (const width of [40, 60, 100]) test(`Бэклог: четыре счётчика, карточки #N, обсуждение и три действия без заливки: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const first: Task = { ...QUEUED, taskId: 'backlog-first', alias: 'TASK-3', title: 'Добавить выгрузку отчётов', status: 'paused' }
  const second: Task = { ...first, taskId: 'backlog-second', alias: 'TASK-4', title: 'Проверить доступ к архиву' }
  const note: AgentTaskNote = { ...HISTORY_RESULT, taskId: first.taskId, kind: 'note', text: 'Нужен формат отчёта.' }
  taskHost(on, CARD, { tasks: [CARD, QUEUED, first, second, HISTORY_TASK], comments: COMMENTS, agentNotes: [note] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  const tabs = (await pane.find({ type: 'Client', key: 'tabs' }))?.props?.props as TaskTabsProps
  expect(tabs.tabs.map(tab => tab.label)).toEqual(['Агенту 2', 'Мне 0', 'Бэклог 2', 'История 1'])
  const spans = tabSpans(tabs)
  expect(spans.at(-1)!.left + spans.at(-1)!.cells).toBeLessThanOrEqual(width)
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain(first.title)
  const left = spans.find(span => span.tab.id === 'backlog')!.left
  await pane.pointer({ type: 'move', x: left + 1, y: 0, in: 'tabs' })
  const backlogLabel = elements(await pane.drawn({ in: 'tabs' })).find(node => node.type === 'Text' && drawnText(node).includes('Бэклог 2'))
  expect(backlogLabel?.props).toMatchObject({ color: CARD_HOVER }); expect(backlogLabel?.props?.underline).toBeUndefined()
  await pane.pointer({ type: 'up', x: left + 1, y: 0, button: 'left', in: 'tabs' })
  const props = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  expect(props.rows.filter(row => row.kind === 'card').map(row => row.taskId)).toEqual([first.taskId, second.taskId])
  for (const row of props.rows) if (row.kind === 'card') {
    expect(row.number).toBe(row.taskId === first.taskId ? '#3' : '#4')
    // В бэклоге ни одна карточка не рисуется выбранной: рамка приглушена у всех, включая первую.
    expect(row.borderColor).toBe(DEFAULT_THEME.muted); expect(row.borderDimColor).toBe(true)
    expect(row.discussionCount).toBe(row.taskId === first.taskId ? COMMENTS.length + 1 : COMMENTS.length)
    expect(row.width).toBe(width - 2)
    for (const line of row.lines) expect(cellWidth(line)).toBeLessThanOrEqual(width - 4)
  }
  const header = (await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps
  expect(header.actions.filter(action => action.shortcut).map(action => [action.key, action.hint, action.shortcut])).toEqual([
    ['restore', 'Вернуть в очередь', 'r'], ['open', 'Открыть', 'o'], ['delete', 'Удалить', 'x'],
  ])
  const tree = elements(await pane.drawn())
  for (const node of tree) if (node.type === 'Box' || node.type === 'Text') expect(node.props?.backgroundColor).toBeUndefined()
  const controls = elements(await pane.drawn({ in: 'rows' })).filter(node => node.type === 'Button' && ['restore', 'open', 'delete'].includes(String(node.props.key)))
  expect(controls).toHaveLength(3)
  for (const button of controls) {
    const caption = elements(await pane.drawn({ in: 'panel-header' })).find(node => node.type === 'Box' && node.props?.key === `caption-${button.props.key}`)
    expect(caption && 'hover' in caption ? caption.hover?.scope : undefined).toBe('hover' in button ? button.hover?.scope : undefined)
    expect('hover' in button ? button.hover?.scope : undefined).toMatch(/^[a-z0-9-]+$/u)
  }
  await pane.press({ key: 'open' })
  expect(await pane.find({ type: 'Box', key: `task-page:${first.taskId}` })).toBeDefined()
  await pane.key({ key: 'q', in: 'page-content' })
  await pane.unmount()
})

for (const width of [40, 60, 100]) test(`Владелец отправляет в бэклог без причины и возвращает в очередь: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = taskHost(on, CARD, { tasks: [CARD, QUEUED] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  const header = (await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps
  expect(header.actions.find(action => action.key === 'defer')).toMatchObject({ hint: 'В бэклог', shortcut: 'p', label: '▣' })
  const revision = CARD.revision
  const focusRevision = fixture.state.focus!.revision
  await pane.press({ key: 'defer' })
  expect(fixture.calls.filter(call => call.op === 'task.action').map(call => call.args)).toEqual([
    { taskId: CARD.taskId, expectedRevision: revision, expectedFocusRevision: focusRevision, action: 'defer' },
  ])
  expect(elements(await pane.drawn()).some(isFieldInput)).toBe(false)
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain(CARD.title)
  expect((await pane.findAll({ type: 'Client' })).filter(node => node.props.module === 'hooks/editor.tsx')).toHaveLength(0)
  await pane.press({ key: 'tab-backlog' })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain(CARD.title)
  await pane.press({ key: 'restore' })
  expect(fixture.calls.filter(call => call.op === 'task.action').map(call => call.args)).toEqual([
    { taskId: CARD.taskId, expectedRevision: revision, expectedFocusRevision: focusRevision, action: 'defer' },
    { taskId: CARD.taskId, expectedRevision: revision + 1, expectedFocusRevision: focusRevision + 1, action: 'restore' },
  ])
  expect(fixture.state.focus?.task).toBeNull()
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('Бэклог пуст')
  await pane.press({ key: 'tab-agent' })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain(CARD.title)
  await pane.unmount()
})

for (const width of [40, 60, 100]) test(`CARDS-1: три записи обсуждения на верхней рамке, после комментария четыре, без лишних чтений: ${width}`, { options: { glyphs: 'nerd' } }, async ($, on) => {
  const note = { ...HISTORY_RESULT, taskId: CARD.taskId, kind: 'note' as const }
  const fixture = taskHost(on, { ...CARD, alias: 'TASK-108' }, { comments: COMMENTS, agentNotes: [note] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  const counter = await pane.find({ in: 'rows', key: `discussion-frame:${CARD.taskId}`, type: 'Box' })
  expect(counter?.props).toMatchObject({ position: 'absolute', top: 0, height: 1 })
  expect(drawnText(asTree(counter))).toBe(' \u{f0361} 3 ')
  expect(Number(counter?.props.left) + Number(counter?.props.width)).toBeLessThanOrEqual(width - 3)
  expect(Number(counter?.props.left)).toBeGreaterThanOrEqual(2 + cellWidth(' #108 '))
  expect(drawnText(asTree(await pane.find({ in: 'rows', key: `number-frame:${CARD.taskId}`, type: 'Box' })))).toBe(' #108 ')
  expect(fixture.calls.filter(call => call.op === 'task.get')).toHaveLength(1)
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  const reads = fixture.calls.filter(call => call.op === 'task.get').length
  await inputEditor(pane, { key: `page-comment:${CARD.taskId}`, text: 'Ещё один комментарий' })
  await pane.press({ key: 'page-back' })
  expect(drawnText(asTree(await pane.find({ in: 'rows', key: `discussion-frame:${CARD.taskId}`, type: 'Box' })))).toBe(' \u{f0361} 4 ')
  expect(fixture.calls.filter(call => call.op === 'task.get')).toHaveLength(reads)
})

for (const width of [40, 60, 100]) test(`CARDS-1: пустое обсуждение не рисует значок и ноль: ${width}`, { options: { glyphs: 'nerd' } }, async ($, on) => {
  taskHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  expect(await pane.find({ in: 'rows', key: `discussion-frame:${CARD.taskId}`, type: 'Box' })).toBeUndefined()
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain('\u{f0361}')
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain(' 0 ')
})

for (const width of [40, 60, 100]) test(`CARDS-1: история показывает счётчик владельца и агента на верхней рамке: ${width}`, { options: { glyphs: 'nerd' } }, async ($, on) => {
  const fixture = taskHost(on, CARD, { tasks: [CARD, HISTORY_TASK], comments: COMMENTS, agentNotes: [HISTORY_RESULT] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  await pane.key({ key: 'h', in: 'rows' })
  expect(drawnText(asTree(await pane.find({ in: 'rows', key: `discussion-frame:${HISTORY_TASK.taskId}`, type: 'Box' })))).toBe(' \u{f0361} 3 ')
  expect(fixture.calls.filter(call => call.op === 'task.get' && call.args.taskId === HISTORY_TASK.taskId)).toHaveLength(1)
})

for (const width of [40, 60, 100]) test(`История открывается клавишей и щелчком, сохраняет оформление и открывает страницу только для чтения: ${width}`, async ($, on) => {
  const fixture = taskHost(on, CARD, { tasks: [CARD, HISTORY_TASK], agentNotes: [HISTORY_RESULT], comments: COMMENTS })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width } })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).not.toContain(HISTORY_TASK.title)
  expect(drawnText(await pane.drawn({ in: 'panel-header' }))).not.toContain('Готово')
  expect(fixture.calls.some(call => call.op === 'task.get' && call.args.taskId === HISTORY_TASK.taskId)).toBe(false)
  await pane.key({ key: 'h', in: 'rows' })
  const tabs = (await pane.find({ type: 'Client', key: 'tabs' }))?.props?.props as TaskTabsProps
  expect(tabs.tabs.map(tab => [tab.id, tab.active])).toEqual([['agent', false], ['owner', false], ['backlog', false], ['history', true]])
  const view = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  const card = view.rows.find(row => row.kind === 'card')
  expect(card?.kind === 'card' ? card.number : null).toBe('#42')
  expect(card?.kind === 'card' ? card.details : null).toEqual([HISTORY_RESULT.text])
  expect(card?.kind === 'card' ? card.context : null).toEqual([])
  expect(card?.kind === 'card' ? card.closedTime : null).toBe('33 мин назад')
  await pane.key({ key: 'i', in: 'rows' })
  const tree = await pane.drawn({ in: 'rows' })
  for (const text of ['Сегодня', HISTORY_TASK.title, HISTORY_RESULT.text, '33 мин назад', '42']) expect(drawnText(tree)).toContain(text)
  const day = elements(tree).find(node => node.type === 'Text' && drawnText(node).endsWith(' Сегодня'))
  expect(day?.type === 'Text' ? day.props : null).toMatchObject({ color: DEFAULT_THEME.muted })
  expect(drawnText(day).length).toBeGreaterThan('Сегодня'.length + 1) // значок группы слева
  const frame = await pane.find({ in: 'rows', type: 'Box', key: `card:${HISTORY_TASK.taskId}` })
  expect(frame?.props).toMatchObject({ width: width - 2, borderStyle: 'round', borderColor: DEFAULT_THEME.fg || 'text' })
  expect(elements(asTree(frame)).filter(node => node.type === 'Button')).toHaveLength(0)
  // Время — на нижней линии рамки, соседом после неё, и красится её наведением.
  const time = await pane.find({ in: 'rows', type: 'Box', key: `time-frame:${HISTORY_TASK.taskId}` })
  expect(time?.props?.position).toBe('absolute')
  expect(time?.props?.top).toBe(3)
  // Значок окончания и когда закрыта, затем значок времени и сколько задача была в работе.
  expect(drawnText(asTree(time))).toMatch(/^ \S 33 мин назад {2}\S 1 мин $/u)
  for (const row of view.rows) if (row.kind === 'card') for (const line of row.lines) expect(cellWidth(line)).toBeLessThanOrEqual(width - 4)
  expect(((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions.map(action => action.key)).toEqual(['open'])
  await pane.key({ key: 'return', in: 'rows' })
  expect(await pane.find({ type: 'Box', key: `task-page:${HISTORY_TASK.taskId}` })).toBeDefined()
  expect(elements(await pane.drawn()).some(node => node.type === 'Input')).toBe(false)
  expect((await pane.findAll({ type: 'Client' })).filter(node => node.props.module === 'hooks/editor.tsx')).toHaveLength(0)
  expect(((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions.map(action => action.key)).toEqual(['page-back'])
  expect(drawnText(await pane.drawn({ in: 'page-content' }))).toContain('Приёмка:')
  expect(drawnText(await pane.drawn({ in: 'page-content' }))).not.toContain('Готово, когда')
  for (const key of ['e', 'a', 'x']) await pane.key({ key, in: 'page-content' })
  expect(fixture.calls.some(call => call.op === 'task.edit' || call.op.startsWith('task.comment.'))).toBe(false)
  await pane.key({ key: 'q', in: 'page-content' })
  await pane.key({ key: 'b', in: 'rows' })
  const left = tabSpans(tabs).find(span => span.tab.id === 'history')!.left
  await pane.pointer({ type: 'down', x: left + 2, y: 0, button: 'left', in: 'tabs' })
  await pane.pointer({ type: 'up', x: left + 2, y: 0, button: 'left', in: 'tabs' })
  expect(((await pane.find({ type: 'Client', key: 'tabs' }))?.props?.props as TaskTabsProps).tabs[3]?.active).toBe(true)
  const props = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  const index = props.rows.findIndex(row => row.taskId === HISTORY_TASK.taskId)
  const y = props.top + props.rows.slice(0, index).reduce((sum, row) => sum + row.height, 0) + 1
  const click = async () => {
    await pane.pointer({ type: 'down', x: 8, y, button: 'left', in: 'rows' })
    await pane.pointer({ type: 'up', x: 8, y, button: 'left', in: 'rows' })
  }
  await click(); expect(await pane.find({ type: 'Box', key: 'page-body' })).toBeUndefined()
  await click(); expect(await pane.find({ type: 'Box', key: 'page-body' })).toBeDefined()
  await pane.unmount()
})

test('История читает итог только видимой карточки, кэширует без таймера и сохраняет выбор отдельной вкладки', async ($, on) => {
  const done = Array.from({ length: 12 }, (_, index) => ({ ...HISTORY_TASK, taskId: `closed-${index}`, alias: `TASK-${index + 2}`,
    updatedAt: new Date(2026, 9, 4, 0, index * 5).toISOString().replace('.000Z', '.000000Z') }))
  const fixture = taskHost(on, CARD, { tasks: [CARD, QUEUED, ...done] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, scroll: { offset: 0, bodyRows: 10 } } })
  await pane.key({ key: 'down', in: 'rows' })
  await pane.key({ key: 'h', in: 'rows' })
  const reads = () => fixture.calls.filter(call => call.op === 'task.get' && call.args.taskId.startsWith('closed-'))
  // Карточки дня идут подряд: в шесть строк окна помещаются две.
  expect(reads().map(call => call.op === 'task.get' ? call.args.taskId : '')).toEqual(['closed-11', 'closed-10'])
  const contexts = fixture.calls.filter(call => call.op === 'tasks.context').length
  await pane.redraw(); await fixture.clock.advance(60_000)
  expect(reads()).toHaveLength(2)
  expect(fixture.calls.filter(call => call.op === 'tasks.context')).toHaveLength(contexts)
  await pane.key({ key: 'end', in: 'rows' })
  expect(reads().map(call => call.op === 'task.get' ? call.args.taskId : '')).toEqual(['closed-11', 'closed-10', 'closed-1', 'closed-0'])
  const last = (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  expect(last.rows.find(row => row.kind === 'card' && row.selected)?.taskId).toBe('closed-0')
  expect(last.offset).toBe(last.totalHeight - last.height)
  expect(last.bar).toBeDefined()
  await pane.pointer({ type: 'down', x: 79, y: 0, button: 'left', in: 'rows' })
  await pane.pointer({ type: 'up', x: 79, y: 0, button: 'left', in: 'rows' })
  expect(((await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps).offset).toBe(0)
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 6, bodyRows: 10, contentRows: 10, origin: { kind: 'person' } })
  expect(((await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps).offset).toBe(6)
  await pane.key({ key: 'home', in: 'rows' })
  await pane.key({ key: 'j', in: 'rows' })
  expect(((await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps).rows.find(row => row.kind === 'card' && row.selected)?.taskId).toBe('closed-10')
  await pane.key({ key: 'k', in: 'rows' })
  await pane.key({ key: 'b', in: 'rows' })
  expect(((await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps).rows.find(row => row.kind === 'card' && row.selected)?.taskId).toBe(QUEUED.taskId)
  await pane.unmount()
})

test('История дополняет ограниченный snapshot ссылками closed из контекста, отменённые и удалённые не показываются', async ($, on) => {
  const cancelled = { ...HISTORY_TASK, taskId: 'cancelled-history', alias: 'TASK-43', status: 'cancelled' as const, title: 'Отменённая история' }
  const deleted = { ...HISTORY_TASK, taskId: 'deleted-history', alias: 'TASK-44', deleted: true, title: 'Удалённая история' }
  const fixture = taskHost(on, CARD, { tasks: [CARD], closed: [HISTORY_TASK, cancelled, deleted] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ key: 'h', in: 'tabs' })
  // Ссылки контекста проверяются лениво: удалённые и отменённые исчезают после чтения.
  await fixture.clock.settle()
  await pane.redraw()
  await pane.key({ key: 'i', in: 'rows' })
  // Описание читается по раскрытию; ответ приходит после локального события Client.
  await fixture.clock.advance(250)
  await fixture.clock.settle()
  await pane.redraw()
  const text = drawnText(await pane.drawn({ in: 'rows' }))
  expect(text).toContain(HISTORY_TASK.title)
  expect(text).toContain('Проверить закрытую задачу')
  for (const phrase of [cancelled.title, deleted.title, 'Владелец:', 'Готово, когда:', 'Критерий на странице']) expect(text).not.toContain(phrase)
  expect(fixture.calls.some(call => call.op === 'tasks.context')).toBe(true)
  await pane.key({ key: 'return', in: 'rows' })
  expect(await pane.find({ type: 'Box', key: `task-page:${HISTORY_TASK.taskId}` })).toBeDefined()
  await pane.unmount()
})

test('Пустая история — одна приглушённая рамка, без значков записи', async ($, on) => {
  taskHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ key: 'h', in: 'tabs' })
  const empty = await pane.find({ in: 'rows', type: 'Box', key: 'history-empty' })
  expect(empty?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true, borderColor: DEFAULT_THEME.muted })
  expect(drawnText(asTree(empty))).toBe('Закрытых задач пока нет')
  expect(((await pane.find({ type: 'Client', key: 'panel-header' }))?.props?.props as PanelActionsProps).actions.map(action => action.key)).toEqual([])
  await pane.unmount()
})

for (const width of [40, 60, 100]) test(`Карточка и полоса показывают суть, страница — разделы, редактор — весь текст со словом «Приёмка»: ${width}`, async ($, on) => {
  const source = 'Владелец: Исправить панель\n\nГотово, когда: Проверить мышь'
  const task = { ...CARD, description: source, acceptance: ['Проверить клавиши'], constraints: ['Не менять рантайм'] }
  const note = { ...HISTORY_RESULT, taskId: CARD.taskId, kind: 'note' as const, text: 'Начал работу' }
  const fixture = taskHost(on, task, { comments: COMMENTS, agentNotes: [note] })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width, scroll: { offset: 0, bodyRows: 50 } } })
  const band = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: width } })
  await pane.key({ key: 'i', in: 'rows' })
  const cardText = drawnText(await pane.drawn({ in: 'rows' }))
  expect(cardText).toContain('Исправить панель')
  for (const hidden of ['Владелец:', 'Готово, когда', 'Проверить мышь', 'Проверить клавиши']) expect(cardText).not.toContain(hidden)
  // Полоса над вводом — одна строка с названием: ни сути, ни критерия в ней нет.
  expect(drawnText(await band.drawn({ in: 'task-band' }))).toBe('⧖ #1 Проверить мод')
  expect((await band.find({ type: 'Client', key: 'task-band' }))?.props.height).toBe(1)
  await pane.key({ key: 'return', in: 'rows' })
  const props = (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  expect(props.lines.filter(line => line.kind === 'heading').map(line => line.text)).toEqual(['Задача:', 'Приёмка:', 'Ограничения:'])
  const contentNodes = elements(await pane.drawn({ in: 'page-content' }))
  for (const heading of props.lines.filter(line => line.kind === 'heading')) {
    const text = contentNodes.find(node => node.type === 'Text' && drawnText(node) === heading.text)
    expect(text?.type === 'Text' ? text.props?.bold : null).toBe(true)
    expect(text?.type === 'Text' ? text.props?.color : null).toBe(roleColors(DEFAULT_THEME).fg)
  }
  const text = drawnText(await pane.drawn({ in: 'page-content' }))
  for (const content of ['Проверить клавиши', 'Проверить мышь', 'Не менять рантайм', 'Владелец:']) expect(text).toContain(content)
  // Пометка хранения на странице заменена разделом «Приёмка».
  expect(text).not.toContain('Готово, когда')
  await pageTab(pane, 'comments')
  expect(drawnText(await pane.drawn({ in: 'page-content' }))).toContain(note.text)
  await pageTab(pane, 'description')
  await pane.press({ key: 'page-description-edit' })
  // Редактор говорит теми же словами, что и страница: пометку хранения заменяет строка «Приёмка:», остальной текст на месте.
  const editable = 'Владелец: Исправить панель\n\nПриёмка:\nПроверить мышь'
  expect((await pane.find({ type: 'Client', key: `page-description:${CARD.taskId}` }))?.props?.props?.value).toBe(editable)
  const edited = editable.replace('Исправить панель', 'Исправить переносы')
  await inputEditor(pane, { key: `page-description:${CARD.taskId}`, text: edited, kind: 'submit' })
  expect(fixture.calls.filter(call => call.op === 'task.edit').at(-1)?.args.description).toBe(edited)
  expect(drawnText(await pane.drawn({ in: 'page-content' }))).toContain('Исправить переносы')
  await pane.unmount(); await band.unmount()
})

test('/cockpit без других модов ниже по цепочке: дно движка не роняет команду и не даёт тоста', async ($, on) => {
  const fixture = taskHost(on)
  expect(await $.command.run(taskCommand('', 'cockpit'))).toEqual({})
  expect(fixture.opens.at(-1)).toEqual({ id: 'tasks', title: 'Задачи', focus: true })
  expect(fixture.toasts).toEqual([])
})

test('Заголовок вкладки: со значком при nerd и без значка при plain', () => {
  expect(taskTabTitle('nerd')).toBe(`${TASK_ICON} Задачи`)
  expect(taskTabTitle('plain')).toBe('Задачи')
  expect(taskTabTitle('auto', false)).toBe(`${TASK_ICON} Задачи`)
  expect(taskTabTitle('auto', true)).toBe('Задачи')
  expect(taskTabTitle('auto', undefined)).toBe('Задачи')
})

test('/tasks открывает со значком при glyphs=nerd и без значка при glyphs=plain', { options: { glyphs: 'nerd' } }, async ($, on) => {
  const fixture = taskHost(on)
  expect(await $.command.run(taskCommand())).toEqual({})
  expect(fixture.opens).toEqual([{ id: 'tasks', title: `${TASK_ICON} Задачи`, focus: true }])
})

test('/tasks открывает без значка при glyphs=plain', { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = taskHost(on)
  expect(await $.command.run(taskCommand())).toEqual({})
  expect(fixture.opens).toEqual([{ id: 'tasks', title: 'Задачи', focus: true }])
})

test('При подтверждении шрифта заголовок вкладки обновляется один раз без кражи фокуса', { options: { glyphs: 'auto' } }, async ($, on) => {
  fontProbe = () => 'ok'
  try {
    const fixture = taskHost(on)
    expect(await $.command.run(taskCommand())).toEqual({})
    expect(fixture.opens).toEqual([{ id: 'tasks', title: 'Задачи', focus: true }])

    const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
    expect(fixture.opens).toEqual([
      { id: 'tasks', title: 'Задачи', focus: true },
      { id: 'tasks', title: `${TASK_ICON} Задачи` },
    ])

    await pane.redraw(PANE)
    expect(fixture.opens).toHaveLength(2)
    await pane.unmount()
  } finally {
    fontProbe = null
  }
})

test('/cockpit сохраняет заголовок дерева файлов и заново задаёт заголовок «Машины»', async ($, on) => {
  const fixture = taskHost(on)
  on('command.list', () => ({ value: [{ name: 'cockpit', description: '' }, { name: 'machine', description: '' }, { name: 'filetree', description: '' }] }))
  on('ui.panes', () => ({ value: [
    { id: 'machine', title: '\u{f048b} my-server', isPlaced: true, isShown: true, isFocused: false },
    { id: 'filetree', title: '\u{f024b} Файлы: my-project', isPlaced: true, isShown: true, isFocused: false },
  ] }))
  expect(await $.command.run(taskCommand('', 'cockpit'))).toEqual({})
  expect(fixture.opens).toEqual([
    { id: 'tasks', title: 'Задачи' },
    { id: 'filetree', title: '\u{f024b} Файлы: my-project' },
    { id: 'machine', title: '\u{f048b} Машина' },
    { id: 'tasks', title: 'Задачи', focus: true },
  ])
})

for (const width of [40, 60, 100]) test(`На странице задачи нет раздела «След» даже при накопленных сведениях: ${width}`, async ($, on) => {
  taskHost(on, CARD, { git: {}, workTrails: { [CARD.taskId]: { startRevision: START_REVISION, jobs: [{ jobId: '12345678-long-id', agent: 'codex', mode: 'implement' }] } } })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width, scroll: { offset: 0, bodyRows: 55 } } })
  await pane.press({ key: 'open' })
  const props = (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  // Сведения из git и задания исполнителей нужны агенту и приходят ему в контексте задачи, владельцу на странице они не показаны.
  const text = props.lines.map(line => line.text).join('\n')
  for (const absent of ['След:', 'Коммиты:', 'codex implement', 'ещё не бралась', 'Сведения git']) expect(text).not.toContain(absent)
  await pane.unmount()
})

test('«Запустить сейчас» ставит отметку, повторное взятие владельцем сохраняет её', async ($, on) => {
  const git: GitFixture = {}
  const world = taskHost(on, CARD, { tasks: [CARD, QUEUED], git, followCurrent: true })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.key({ key: 'down', in: 'rows' })
  await pane.press({ key: 'current' })
  expect(world.workTrails[QUEUED.taskId]?.startRevision).toBe(START_REVISION)
  git.head = LATER_REVISION
  await pane.key({ key: 'down', in: 'rows' }); await pane.press({ key: 'current' })
  expect(world.state.focus?.task?.taskId).toBe(CARD.taskId)
  expect(world.workTrails[CARD.taskId]?.startRevision).toBe(LATER_REVISION)
  await pane.key({ key: 'down', in: 'rows' }); await pane.press({ key: 'current' })
  expect(world.calls.filter(call => call.op === 'task.action' && call.args.action === 'current')).toHaveLength(3)
  expect(world.workTrails[QUEUED.taskId]?.startRevision).toBe(START_REVISION)
  await pane.unmount()
})

for (const width of [40, 60, 100]) test(`INPUT-1: описание из 600 символов, каретка и правка в середине: ${width}`, async ($, on) => {
  const source = 'Описание задачи '.repeat(40).slice(0, 600)
  const fixture = taskHost(on, { ...CARD, description: source })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width, scroll: { offset: 0, bodyRows: 40 } } })
  await pane.press({ key: 'open' }); await pane.press({ key: 'page-description-edit' })
  const key = `page-description:${CARD.taskId}`
  expect((await pane.find({ type: 'Client', key }))?.props.props.value).toBe(source)
  expect(elements(await pane.drawn()).some(node => node.type === 'Input')).toBe(false)
  await pane.key({ in: key, key: 'home', ctrl: true })
  await pane.key({ in: key, key: 'right' })
  await pane.key({ in: key, key: 'delete' })
  await pane.key({ in: key, key: 'ВСТАВКА' })
  const expected = source.slice(0, 1) + 'ВСТАВКА' + source.slice(2)
  await pane.redraw()
  expect((await pane.find({ type: 'Client', key }))?.props.props.value).toBe(expected)
  const drawing = elements(await pane.drawn({ in: key }))
  expect(drawing.filter(node => node.type === 'Text' && node.props?.inverse)).toHaveLength(1)
  for (const line of drawing.filter(node => node.type === 'Box' && String(node.props.key).startsWith('editor-line-'))) expect(cellWidth(drawnText(line))).toBeLessThanOrEqual(width - 5)
  await pane.key({ in: key, key: 'return' })
  expect(fixture.calls.filter(call => call.op === 'task.edit').at(-1)?.args.description).toBe(expected)
  expect(fixture.state.focus?.task?.description).toBe(expected)
  await pane.unmount()
})

test('INPUT-1: все поля используют один редактор и действия на рамке', { options: { glyphs: 'plain' } }, async ($, on) => {
  taskHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: 60, scroll: { offset: 0, bodyRows: 40 } } })
  await pane.press({ key: 'new' })
  await inputEditor(pane, { key: 'new-task', text: 'Длинное название '.repeat(20), kind: 'change' })
  const field = await pane.find({ type: 'Client', key: 'new-task' })
  expect(field?.props.module).toBe('hooks/editor.tsx')
  expect(field?.props.props.placeholder).toBe('Новая задача')
  expect(elements(await pane.drawn()).some(isFieldInput)).toBe(false)
  const controls = await pane.findAll({ type: 'Button', in: 'new-task' })
  expect(controls.map(button => button.props.label)).toEqual(['↗', '×', '⏎ Сохранить'])
  expectEditorHover(field?.props.props as EditorProps)
  await pane.press({ key: 'new-task-cancel' })
  await pane.press({ key: 'open' })
  await pageTab(pane, 'comments')
  const comment = await pane.find({ type: 'Client', key: `page-comment:${CARD.taskId}` })
  expect(comment?.props.module).toBe('hooks/editor.tsx')
  expect(comment?.props.props.placeholder).toBe('Комментарий агенту')
  expect(comment?.props.props.submitLabel).toBe('Отправить')
  const border = await findEditor(pane, { type: 'Box', key: 'page-comment-frame' })
  expect(border?.props.borderColor).toBe(roleColors(DEFAULT_THEME).muted)
  await pageTab(pane, 'description')
  await pane.press({ key: 'page-description-edit' })
  const description = await pane.find({ type: 'Client', key: `page-description:${CARD.taskId}` })
  expect(description?.props.module).toBe('hooks/editor.tsx')
  expect(description?.props.props.placeholder).toBe('Описание задачи')
  expect(description?.props.props.submitLabel).toBe('Сохранить')
  await pane.unmount()
})

test('INPUT-1: многострочное описание сохраняется локальным редактором без реплики агенту', async ($, on) => {
  const fixture = taskHost(on, { ...CARD, description: 'Исходное описание' })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pane.press({ key: 'page-description-edit' })
  fixture.setPrompt('Прежняя реплика')
  const text = 'Первая строка\n\n' + 'Вставленное описание '.repeat(30)
  await inputEditor(pane, { key: `page-description:${CARD.taskId}`, text, kind: 'submit' })
  expect(fixture.prompt).toBe('Прежняя реплика')
  expect(fixture.calls.filter(call => call.op === 'task.edit').at(-1)?.args.description).toBe(text)
  expect(fixture.calls.some(call => ['capture.prompt', 'tasks.extract'].includes(call.op))).toBe(false)
  await pane.unmount()
})

const progressNote = (index: number): AgentTaskNote => ({ noteId: `progress-${index}`, taskId: CARD.taskId, kind: 'note', source: 'agent', provenance: 'tool',
  text: `Запись ${index}`, createdAt: new Date(2026, 9, 5, 3, index).toISOString().replace('.000Z', '.000000Z') })

for (const width of [30, 60, 100]) test(`PAGE-2: 30 записей используют одну область; обновление сохраняет позицию и редактор: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const notes = Array.from({ length: 30 }, (_, index) => progressNote(index))
  const task = { ...CARD, description: 'Цель остаётся', lastCheckpoint: undefined }
  const fixture = taskHost(on, task, { agentNotes: notes, checkpoints: [] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks',
    props: { ...PANE, bodyColumns: width, scroll: { offset: 0, bodyRows: 26 } } })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  const props = async () => (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  const initial = await props()
  // Из 26 строк панели три занимает её шапка, по одной — разделитель и вкладки страницы, три — поле комментария.
  const height = 18, bottom = 89 - height
  expect(initial).toMatchObject({ width, height, total: 89, offset: bottom, tab: 'comments' })
  expect(initial.lines.slice(0, 2).map(line => line.text)).toEqual(['', 'а 03:24'])
  expect(initial.lines.at(-1)?.text).toBe('  Запись 29')
  const editor = (await pane.find({ type: 'Box', key: 'page-composer' }))?.props
  const calls = fixture.calls.length
  await pane.redraw()
  expect(fixture.calls).toHaveLength(calls)
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: -3, bodyRows: 26, contentRows: 26,
    origin: { kind: 'person' }, pointer: { column: width - 5, row: 7 } })
  expect((await props()).offset).toBe(bottom - 3)
  await pane.key({ key: 'pageup', in: 'page-content' })
  expect((await props()).offset).toBe(bottom - 3 - (height - 1))
  await pane.key({ key: 'home', in: 'page-content' })
  expect((await props()).offset).toBe(0)
  expect((await props()).lines[0]?.text).toBe('а 03:00')
  await pane.post({ taskId: task.taskId, generation: initial.generation, scrollTo: 2 }, { in: 'page-content' })
  expect((await props()).offset).toBe(bottom)
  // Тестовый хост передаёт захваченную протяжку; физическое попадание проверяется в терминале.
  await pane.pointer({ in: 'page-content', type: 'down', button: 'left', x: width - 1, y: 0 })
  expect((await props()).offset).toBe(0)
  await pane.pointer({ in: 'page-content', type: 'move', button: 'left', x: -5, y: initial.height + 5 })
  expect((await props()).offset).toBe(bottom)
  await pane.pointer({ in: 'page-content', type: 'up', button: 'left', x: -5, y: initial.height + 5 })
  notes.push(progressNote(30))
  await fixture.clock.advance(30_000)
  expect((await props()).lines.at(-1)?.text).toBe('  Запись 30')
  expect((await props()).offset).toBe(bottom + 3)
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: -4, bodyRows: 26, contentRows: 26, origin: { kind: 'person' } })
  const held = await props()
  notes.push(progressNote(31))
  await fixture.clock.advance(30_000)
  const refreshed = await props()
  expect(refreshed.offset).toBe(bottom + 3 - 4)
  expect(refreshed.lines[0]?.id).toBe(held.lines[0]?.id)
  expect(refreshed.lines.some(line => line.text === '  Запись 31')).toBe(false)
  expect((await pane.find({ type: 'Box', key: 'page-composer' }))?.props).toEqual(editor)
  for (const line of refreshed.lines) expect(cellWidth(line.text)).toBeLessThanOrEqual(width - 4)
  const bar = elements(await pane.drawn({ in: 'page-content' })).find(node => node.type === 'Box' && node.props.key === 'page-scrollbar')
  expect(bar?.props).toMatchObject({ top: 0, right: 0, width: 1, height })
  expect(await pane.find({ in: 'page-content', key: 'work-scrollbar' })).toBeUndefined()
  await pane.unmount()
})

test('PAGE-2: рантайм даёт источники отметок и виды изменений, состояние окрашено только одним словом', { options: { glyphs: 'plain' } }, async ($, on) => {
  const task = { ...CARD, lastCheckpoint: undefined }
  const marks: Checkpoint[] = [
    { ...CHECKPOINT, checkpointId: 'owner-mark', source: 'user', text: 'Правка владельца', createdAt: '2026-10-05T02:00:00.000000Z' },
    { ...CHECKPOINT, checkpointId: 'agent-mark', source: 'claude', text: 'Проверка исполнителя', createdAt: '2026-10-05T02:10:00.000000Z' },
    { ...CHECKPOINT, checkpointId: 'system-mark', kind: 'detour', source: 'user', text: 'Отход к TASK-2.', createdAt: '2026-10-05T02:20:00.000000Z' },
  ]
  const changes: TaskContext['ownerChanges'] = [
    { eventId: 1, taskId: task.taskId, action: 'edited', createdAt: '2026-10-05T02:30:00.000000Z' },
    { eventId: 2, taskId: task.taskId, action: 'completed', createdAt: '2026-10-05T02:40:00.000000Z' },
  ]
  const fixture = taskHost(on, task, { checkpoints: marks, ownerChanges: changes })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: 60, scroll: { offset: 0, bodyRows: 40 } } })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  const props = (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  const time = (timestamp: string) => new Date(timestamp).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', hour12: false })
  expect(props.lines.filter(line => line.kind === 'time').map(line => line.text)).toEqual([
    `я ${time(marks[0]!.createdAt)}`, `а ${time(marks[1]!.createdAt)} Claude`, `· ${time(marks[2]!.createdAt)}`,
    `· ${time(changes[1]!.createdAt)}`,
  ])
  const textNodes = elements(await pane.drawn({ in: 'page-content' })).filter(node => node.type === 'Text')
  expect(textNodes.filter(node => node.props.color === roleColors(DEFAULT_THEME).ok).map(drawnText)).toEqual(['закрыта'])
  expect(textNodes.filter(node => drawnText(node).startsWith('я ') || drawnText(node).startsWith('а ') || drawnText(node).startsWith('· ')).map(node => node.props.color))
    .toEqual(Array(4).fill(roleColors(DEFAULT_THEME).muted))
  expect(props.lines.some(line => line.text.includes('Задача изменена'))).toBe(false)
  expect(fixture.calls.filter(call => call.op === 'checkpoint.list').map(call => call.args)).toEqual([{ taskId: task.taskId, limit: 100 }])
  expect(fixture.calls.filter(call => call.op === 'tasks.context').map(call => call.args)).toEqual([{ cursor: 0 }])
  await fixture.clock.advance(30_000)
  const reread = (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  expect(reread.lines).toEqual(props.lines)
  expect(fixture.calls.filter(call => call.op === 'tasks.context').map(call => call.args)).toEqual([{ cursor: 0 }, { cursor: 2 }])
  await pane.unmount()
})

test('PAGE-2: отправка собственного комментария сохраняет ручную прокрутку вверх', { options: { glyphs: 'plain' } }, async ($, on) => {
  const task = { ...CARD, description: 'Цель остаётся', lastCheckpoint: undefined }
  const comments = Array.from({ length: 30 }, (_, index) => ({ ...COMMENTS[0]!, commentId: `held-${index}`, text: `Комментарий ${index}` }))
  const fixture = taskHost(on, task, { comments, checkpoints: [] })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks',
    props: { ...PANE, bodyColumns: 60, scroll: { offset: 0, bodyRows: 26 } } })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  const props = async () => (await pane.find({ type: 'Client', key: 'page-content' }))?.props?.props as TaskPageProps
  const initial = await props()
  await pane.post({ taskId: task.taskId, generation: initial.generation, scrollTo: 0 }, { in: 'page-content' })
  const held = await props()
  expect(held.offset).toBe(0)
  await inputEditor(pane, { key: `page-comment:${task.taskId}`, text: 'Добавление без скачка', kind: 'submit' })
  const saved = await props()
  expect(fixture.comments.at(-1)?.text).toBe('Добавление без скачка')
  expect((await pane.find({ type: 'Client', key: `page-comment:${task.taskId}` }))?.props?.props?.value).toBe('')
  expect(saved.offset).toBe(0)
  expect(saved.lines[0]?.id).toBe(held.lines[0]?.id)
  expect(saved.lines.some(line => line.text === '  Добавление без скачка')).toBe(false)
  expect(saved.offset).toBe(0)
  expect(saved.selected).toBe(null)
  await pane.unmount()
})

// INPUT-3. Жалоба с живого экрана: при наборе буквы пропадают. Хук принимал сообщение редактора (снимок уже новый),
// затем ждал часы и только после этого записывал черновик. Отрисовка в этом промежутке видела расхождение снимка
// и черновика, поднимала эпоху и возвращала клиенту прежний текст.
for (const field of ['new', 'comment', 'description'] as const)
  test(`INPUT-3: отрисовка между приёмом клавиши и записью черновика не сбрасывает поле: ${field}`, { options: { glyphs: 'plain' } }, async ($, on) => {
    // Часы теста обёрнуты: пока обработчик сообщения ждёт время, тест успевает перерисовать панель.
    let interleave: (() => Promise<unknown>) | null = null
    const held = ((name: string, ...rest: unknown[]) => {
      if (name !== 'clock.now') return (on as unknown as (...args: unknown[]) => unknown)(name, ...rest)
      const answer = rest.at(-1) as (...args: unknown[]) => unknown
      return (on as unknown as (...args: unknown[]) => unknown)(name, ...rest.slice(0, -1), async (...args: unknown[]) => {
        const render = interleave
        interleave = null
        if (render) await render()
        return answer(...args)
      })
    }) as unknown as On
    taskHost(held)
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
    if (field === 'new') await pane.press({ key: 'new' })
    else { await pane.press({ key: 'open' }); if (field === 'description') await pane.press({ key: 'page-description-edit' }); else await pageTab(pane, 'comments') }
    const key = field === 'new' ? 'new-task' : `page-${field}:${CARD.taskId}`
    await pane.pointer({ in: key, type: 'down', x: 2, y: 1, button: 'left' })
    await pane.key({ in: key, key: 'a', ctrl: true })
    await pane.key({ in: key, key: 'а' })
    const epoch = (await pane.find({ key }))?.props?.props?.epoch
    for (const char of ['б', 'в', 'г']) {
      // Явная отрисовка: обычная клавиша сама панель не перерисовывает.
      interleave = () => pane.redraw()
      await pane.key({ in: key, key: char })
      expect(interleave).toBeNull()
    }
    await pane.redraw()
    expect((await pane.find({ key }))?.props?.props?.value).toBe('абвг')
    expect((await pane.find({ key }))?.props?.props?.epoch).toBe(epoch)
    expect(drawnText(await pane.drawn({ in: key }))).toContain('абвг')
  })

for (const field of ['new', 'comment', 'description'] as const)
  test(`INPUT-3: обычная клавиша не перерисовывает панель; новая строка поля, отправка и первый щелчок перерисовывают: ${field}`, { options: { glyphs: 'plain' } }, async ($, on) => {
    const fixture = taskHost(on)
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
    if (field === 'new') await pane.press({ key: 'new' })
    else { await pane.press({ key: 'open' }); if (field === 'description') await pane.press({ key: 'page-description-edit' }); else await pageTab(pane, 'comments') }
    const key = field === 'new' ? 'new-task' : `page-${field}:${CARD.taskId}`
    // Дерево хука меняется только при отрисовке: по нему видно, была ли она.
    const drawnValue = async () => (await pane.find({ key }))?.props?.props?.value as string
    const drawnFocus = async () => (await pane.find({ key }))?.props?.props?.focused as boolean
    await pane.key({ in: key, key: 'a', ctrl: true })
    await pane.key({ in: key, key: 'backspace' })
    await pane.redraw()
    expect(await drawnValue()).toBe('')
    // Первый щелчок меняет поле с фокусом: панель перерисована.
    await pane.pointer({ in: key, type: 'down', x: 2, y: 1, button: 'left' })
    expect(await drawnFocus()).toBe(true)
    for (const char of 'привет') await pane.key({ in: key, key: char })
    // Набор в пределах одной строки: дерево хука прежнее, поле показывает набранное, хук набранное знает.
    expect(await drawnValue()).toBe('')
    expect(drawnText(await pane.drawn({ in: key }))).toContain('привет')
    await pane.key({ in: key, key: 'return', shift: true })
    // Поле стало на строку выше: панель перерисована, высота и текст новые.
    expect(await drawnValue()).toBe('привет\n')
    expect((await pane.find({ key }))?.props?.height).toBe(4)
    await pane.key({ in: key, key: 'backspace' })
    expect(await drawnValue()).toBe('привет')
    expect((await pane.find({ key }))?.props?.height).toBe(3)
    await pane.key({ in: key, key: '!' })
    expect(await drawnValue()).toBe('привет')
    await pane.key({ in: key, key: 'return' })
    const operation = field === 'new' ? 'task.create' : field === 'description' ? 'task.edit' : 'task.comment.add'
    expect(fixture.calls.filter(call => call.op === operation).at(-1)?.args).toMatchObject(field === 'new' ? { title: 'привет!' } : field === 'description' ? { description: 'привет!' } : { text: 'привет!' })
    await pane.unmount()
  })

test('INPUT-3: вставка, с которой текст превысил бы предел поля, остаётся в основной строке с уведомлением', { options: { glyphs: 'plain' } }, async ($, on) => {
  const fixture = taskHost(on)
  const edits = promptEditHost(on)
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  await pane.press({ key: 'open' }); await pageTab(pane, 'comments')
  const key = `page-comment:${CARD.taskId}`
  await pane.pointer({ in: key, type: 'down', x: 2, y: 1, button: 'left' })
  const fits = pasted('я'.repeat(19_990))
  expect(await $.prompt.edit(fits)).toEqual({ text: fits.text, cursor: fits.cursor })
  expect(fixture.toasts).toEqual([])
  const over = pasted('ю'.repeat(11))
  expect(await $.prompt.edit(over)).toEqual({ text: 'Осн' + over.inputText + 'овная строка', cursor: 3 + over.inputText.length })
  expect(edits).toEqual([over])
  expect(fixture.toasts).toEqual(['Текст длиннее поля «Задач»: вставлен в строку ввода. Сократи до 20 000 знаков.'])
  expect((await pane.find({ key }))?.props?.props?.value).toBe(fits.inputText)
  const rest = pasted('ю'.repeat(10))
  expect(await $.prompt.edit(rest)).toEqual({ text: rest.text, cursor: rest.cursor })
  expect(((await pane.find({ key }))?.props?.props?.value as string).length).toBe(20_000)
  await pane.unmount()
})

// LIST-1. Жалоба с живого экрана: в конце списка нижняя рамка последней карточки не видна, значки действий
// стоят на строку выше рамки. Снимок рантайма описаний не несёт: карточка получает их отдельным чтением и вырастает
// уже после того, как прокрутка упёрлась в прежний конец списка.
function withoutDescriptions(on: On): On {
  return ((name: string, ...rest: unknown[]) => {
    const filter = rest[0] as { key?: string } | undefined
    if (name !== 'state.get' || filter?.key !== 'projection') return (on as unknown as (...args: unknown[]) => unknown)(name, ...rest)
    const answer = rest.at(-1) as (...args: unknown[]) => { value: { value: Projection; version: number } }
    return (on as unknown as (...args: unknown[]) => unknown)(name, ...rest.slice(0, -1), (...args: unknown[]) => {
      const reply = answer(...args)
      const bare = <T extends { description?: string }>(task: T): T => ({ ...task, description: undefined })
      const state = reply.value.value
      return { value: { ...reply.value, value: { ...state, snapshot: state.snapshot ? { ...state.snapshot, tasks: state.snapshot.tasks.map(bare) } : state.snapshot,
        focus: state.focus?.task ? { ...state.focus, task: bare(state.focus.task) } : state.focus } } }
    })
  }) as unknown as On
}

for (const width of [60, 100]) test(`LIST-1: прокрутка в конец списка показывает последнюю карточку целиком и после догрузки описаний: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const long = 'Описание задачи в несколько строк, которое рантайм отдаёт только отдельным чтением карточки. '.repeat(4)
  const tasks = Array.from({ length: 12 }, (_, index) => ({ ...QUEUED, taskId: `queue-${index}`, alias: `TASK-${index + 2}`, title: `Задача очереди ${index + 1}`, description: long, queuePosition: index + 2 }))
  const fixture = taskHost(withoutDescriptions(on), { ...CARD, description: long }, { tasks: [{ ...CARD, description: long }, ...tasks] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: width, scroll: { offset: 0, bodyRows: 16 } } })
  const read = async () => (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  const scroll = (by: number) => $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by, bodyRows: 16, contentRows: 16, origin: { kind: 'person' } })
  // Один большой шаг колеса: прокрутка упирается в конец списка, каким он был до чтения нижних карточек.
  await scroll(1000)
  const end = await read()
  expect(fixture.calls.filter(call => call.op === 'task.get').length).toBeGreaterThan(0)
  expect(end.rows.at(-1)).toMatchObject({ kind: 'card', taskId: 'queue-11' })
  const last = end.rows.at(-1)!
  expect(last.height).toBe(2 + (last.kind === 'card' ? last.titleLines.length : 0))
  // Последняя строка окна — нижняя рамка последней карточки.
  expect(end.top + end.rows.reduce((sum, row) => sum + row.height, 0)).toBe(end.height)
  expect(end.offset).toBe(end.totalHeight - end.height)
  // Шаги назад и снова в конец: конец остаётся концом.
  await scroll(-4); await scroll(4)
  const again = await read()
  expect(again.offset).toBe(again.totalHeight - again.height)
  await pane.unmount()
})

test('LIST-1: значки едут вместе с карточкой на каждом шаге прокрутки, щелчок по значку не выбирает карточку', { options: { glyphs: 'plain' } }, async ($, on) => {
  const tasks = Array.from({ length: 10 }, (_, index) => ({ ...QUEUED, taskId: `queue-${index}`, alias: `TASK-${index + 2}`, title: `Задача очереди ${index + 1}`, queuePosition: index + 2 }))
  const fixture = taskHost(on, CARD, { tasks: [CARD, ...tasks] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, scroll: { offset: 0, bodyRows: 14 } } })
  const read = async () => (await pane.find({ type: 'Client', key: 'rows' }))?.props?.props as TaskCardsProps
  const scroll = (by: number) => $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by, bodyRows: 14, contentRows: 14, origin: { kind: 'person' } })
  let offsets = 0
  for (let step = 0; step < 60; step++) {
    const props = await read()
    const drawn = elements(await pane.drawn({ in: 'rows' }))
    for (const row of props.rows) if (row.kind === 'card') {
      const slot = drawn.find(node => node.type === 'Box' && node.props?.key === `card-slot:${row.taskId}`)
      const frame = elements(asTree(slot)).find(node => node.type === 'Box' && node.props?.key === `card-action-frame-${row.taskId}`)
      // Значки — потомки слота карточки на его последней строке: на любом смещении окна они на её нижней рамке.
      expect(frame?.props).toMatchObject({ position: 'absolute', top: row.height - 1 })
      expect(slot?.props).toMatchObject({ height: row.height })
    }
    // Хук поверх списка значков не рисует: расходиться с карточками нечему.
    expect(elements(await pane.drawn()).some(node => String(node.props?.key).startsWith('card-action-frame-'))).toBe(false)
    if (props.offset === props.totalHeight - props.height) break
    await scroll(1); offsets++
  }
  expect(offsets).toBeGreaterThan(5)
  const end = await read()
  expect(end.top + end.rows.reduce((sum, row) => sum + row.height, 0)).toBe(end.height)
  // Биение кадров модуля карточек не меняет рисунок и не роняет модуль.
  const before = JSON.stringify(await pane.drawn({ in: 'rows' }), (key, item) => key === 'handle' ? undefined : item)
  await pane.advance(1000)
  expect(JSON.stringify(await pane.drawn({ in: 'rows' }), (key, item) => key === 'handle' ? undefined : item)).toBe(before)
  // Щелчок по нижней рамке слева выбирает карточку; щелчок там же, где стоят значки, телу карточки не достаётся.
  const target = end.rows.filter(row => row.kind === 'card').at(-2)!
  let top = end.top
  for (const row of end.rows) { if (row === target) break; top += row.height }
  const y = top + target.height - 1
  const selected = async () => (await read()).rows.find(row => row.kind === 'card' && row.selected)?.taskId
  const chosen = await selected()
  expect(chosen).not.toBe(target.taskId)
  const calls = fixture.calls.length
  await pane.pointer({ type: 'down', x: target.width - 4, y, button: 'left', in: 'rows' })
  await pane.pointer({ type: 'up', x: target.width - 4, y, button: 'left', in: 'rows' })
  expect(await selected()).toBe(chosen)
  expect(fixture.calls.slice(calls).some(call => call.op === 'task.action')).toBe(false)
  await pane.pointer({ type: 'down', x: 3, y, button: 'left', in: 'rows' })
  await pane.pointer({ type: 'up', x: 3, y, button: 'left', in: 'rows' })
  expect(await selected()).toBe(target.taskId)
  // Значок выбранной карточки нажимается как кнопка модуля карточек и выполняет действие.
  await pane.press({ key: 'defer' })
  expect(fixture.calls.filter(call => call.op === 'task.action').at(-1)?.args).toMatchObject({ taskId: target.taskId, action: 'defer' })
  await pane.unmount()
})

// LIST-2. Меняем геометрию через props Pane, а не только размер клиентского модуля:
// именно bodyColumns и bodyRows определяют переносы карточек и доступное окно.
function resizeTasks(): Task[] {
  const titles = ['Короткая задача', 'Проверить нижнюю рамку последней карточки списка задач',
    'Сохранить положение окна при изменении ширины панели и переносе длинного названия на дополнительные строки',
    'Проверить описание и действия на рамке карточки после последовательного изменения размеров панели задач']
  return Array.from({ length: 20 }, (_, index) => ({ ...QUEUED, taskId: `resize-${index}`, alias: `TASK-${index + 1}`,
    queuePosition: index + 1, title: `${titles[index % titles.length]} ${index + 1}`,
    description: 'Цель: Сохранить нижнюю рамку и кнопки последней карточки при переносах названия и чтении полного описания задачи. '.repeat(index % 3 + 1) }))
}

type WindowFailure = { width: number; step: string; actual: string }
// Короткие блоки сохраняют каждый переход на одну колонку и укладываются в лимит теста 5 секунд с запасом:
// блок в 44 колонки шёл до 3,9 с, блок прокрутки в 11 колонок — 2 с и 5 с при параллельном прогоне исполнителя.
// Блоки вдвое короче проверяют те же ширины 24–200 и оставляют запас на замедление в два-три раза.
const WINDOW_WIDTHS = Array.from({ length: 8 }, (_, index) => [24 + index * 22, 24 + (index + 1) * 22] as const)
const SCROLL_WIDTHS = WINDOW_WIDTHS.flatMap(([low]) => [0, 6, 11, 17].map((start, index, starts) => [low + start, low + (starts[index + 1] ?? 22)] as const))

for (const width of [24, 60, 200]) test(`LIST-2: конец после временного размещения всего списка, ширина ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const tasks = resizeTasks()
  taskHost(withoutDescriptions(on), tasks[0]!, { tasks })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const propsAt = (bodyRows: number): RenderPropsOf['Pane'] => ({ ...PANE, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows } })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: propsAt(18) })
  const read = async () => (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 1000, bodyRows: 18, contentRows: 18, origin: { kind: 'person' } })
  const failures: WindowFailure[] = []
  checkWindowEnd(failures, width, 'исходное окно', await read())
  for (const bodyRows of [18, 12, 30]) {
    await pane.redraw(propsAt(256))
    const large = await read()
    expect(large.offset).toBe(0)
    expect(large.height).toBe(large.totalHeight)
    await pane.redraw(propsAt(bodyRows))
    checkWindowEnd(failures, width, `возвращение к высоте ${bodyRows}`, await read())
  }
  await pane.unmount()
  expect(windowReport(failures)).toBe('')
})

function windowReport(failures: WindowFailure[]): string {
  const steps = [...new Set(failures.map(failure => failure.step))]
  return steps.map(step => {
    const entries = failures.filter(failure => failure.step === step)
    const widths = [...new Set(entries.map(entry => entry.width))].sort((a, b) => a - b)
    const ranges: string[] = []
    for (let index = 0; index < widths.length; index++) {
      const start = widths[index]!
      let end = start
      while (widths[index + 1] === end + 1) end = widths[++index]!
      ranges.push(start === end ? String(start) : `${start}–${end}`)
    }
    return `${step}: ширины ${ranges.join(', ')}; первый отказ ${entries[0]!.width}: ${entries[0]!.actual}`
  }).join('\n')
}

function checkWindowEnd(failures: WindowFailure[], width: number, step: string, props: TaskCardsProps): void {
  const max = Math.max(0, props.totalHeight - props.height)
  const bottom = props.top + props.rows.reduce((sum, row) => sum + row.height, 0)
  if (props.offset !== max) failures.push({ width, step: `${step}, конец`, actual: `offset=${props.offset}, ожидается ${max}, total=${props.totalHeight}, height=${props.height}` })
  if (bottom !== props.height || props.rows.at(-1)?.taskId !== 'resize-19') failures.push({ width, step: `${step}, рамка`,
    actual: `нижняя строка=${bottom}, окно=${props.height}, последняя=${props.rows.at(-1)?.id}` })
}

for (const [low, high] of WINDOW_WIDTHS) for (const bodyRows of [12, 18, 30]) for (const direction of [1, -1]) test(`LIST-2: конец при изменении ширины ${low}–${high} по колонке, высота ${bodyRows}, направление ${direction}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const tasks = resizeTasks()
  const fixture = taskHost(withoutDescriptions(on), tasks[0]!, { tasks })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const failures: WindowFailure[] = []
  const start = direction === 1 ? low : high
  const propsAt = (width: number): RenderPropsOf['Pane'] => ({ ...PANE, placement: 'dock', bodyColumns: width, scroll: { offset: 0, bodyRows } })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: propsAt(start) })
  const read = async () => (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 1000, bodyRows, contentRows: bodyRows, origin: { kind: 'person' } })
  checkWindowEnd(failures, start, 'колесо до изменения', await read())
  for (let width = start + direction; width >= low && width <= high; width += direction) {
    await pane.redraw(propsAt(width))
    checkWindowEnd(failures, width, 'изменение ширины', await read())
    // Второй рендер дочитывает карточки, попавшие в окно после роста уже прочитанных.
    await pane.redraw()
    checkWindowEnd(failures, width, 'дочитывание описаний', await read())
    const heights = await Promise.all(['task-tabs', 'panel-header', 'new-task', 'rows'].map(async key => Number((await pane.find({ key }))?.props?.height ?? 0)))
    if (heights.reduce((sum, height) => sum + height, 0) > bodyRows) failures.push({ width, step: 'бюджет', actual: `${heights.join('+')}>${bodyRows}` })
  }
  expect(fixture.calls.filter(call => call.op === 'task.get').length).toBeGreaterThan(0)
  await pane.unmount()
  expect(windowReport(failures)).toBe('')
})

for (const width of [24, 40, 60, 100, 200]) for (const atEnd of [false, true]) test(`LIST-2: рост карточек и смена только высоты, ширина ${width}, в конце ${atEnd}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const tasks = resizeTasks().map(task => ({ ...task, description: 'Цель: Кратко' }))
  const fixture = taskHost(withoutDescriptions(on), tasks[0]!, { tasks })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const propsAt = (bodyRows: number): RenderPropsOf['Pane'] => ({ ...PANE, placement: 'dock', bodyColumns: width, scroll: { offset: 0, bodyRows } })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: propsAt(18) })
  const read = async () => (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: atEnd ? 1000 : 35, bodyRows: 18, contentRows: 18, origin: { kind: 'person' } })
  let before = await read()
  const failures: WindowFailure[] = []
  const check = (step: string, after: TaskCardsProps) => {
    if (atEnd) checkWindowEnd(failures, width, step, after)
    else if (after.rows[0]?.id !== before.rows[0]?.id || after.top !== before.top) failures.push({ width, step,
      actual: `${before.rows[0]?.id}@${before.top} → ${after.rows[0]?.id}@${after.top}` })
    before = after
  }
  // Меняется карточка выше окна: новый общий размер должен сравниваться с прежним концом.
  fixture.changeTask({ ...tasks[0]!, title: 'Расширенное название текущей задачи выше видимого окна '.repeat(12), revision: tasks[0]!.revision + 1 }, true)
  await pane.redraw()
  check('рост выше окна', await read())
  const target = tasks.find(task => task.taskId === before.rows.filter(row => row.kind === 'card').at(-1)?.taskId)!
  fixture.changeTask({ ...target, description: 'Цель: Полное описание поступает отдельным чтением и увеличивает высоту видимой карточки. '.repeat(8), revision: target.revision + 1 })
  await pane.redraw()
  check('рост описания в окне', await read())
  for (const bodyRows of [30, 12, 24, 18]) {
    await pane.redraw(propsAt(bodyRows))
    check(`высота ${bodyRows}`, await read())
    await pane.redraw()
    check(`дочитывание, высота ${bodyRows}`, await read())
  }
  await pane.unmount()
  expect(windowReport(failures)).toBe('')
})

for (const [low, high] of WINDOW_WIDTHS) for (const bodyRows of [12, 18, 30]) for (const direction of [1, -1]) test(`LIST-2: верхняя карточка при изменении ширины ${low}–${high} по колонке, высота ${bodyRows}, направление ${direction}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const tasks = resizeTasks()
  taskHost(withoutDescriptions(on), tasks[0]!, { tasks })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const start = direction === 1 ? low : high
  const propsAt = (width: number): RenderPropsOf['Pane'] => ({ ...PANE, placement: 'dock', bodyColumns: width, scroll: { offset: 0, bodyRows } })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: propsAt(start) })
  const read = async () => (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 35, bodyRows, contentRows: bodyRows, origin: { kind: 'person' } })
  await pane.redraw()
  let before = await read()
  expect(before.offset).toBeGreaterThan(0)
  expect(before.offset).toBeLessThan(before.totalHeight - before.height)
  expect(before.rows[0]?.kind).toBe('card')
  const failures: WindowFailure[] = []
  for (let width = start + direction; width >= low && width <= high; width += direction) {
    const anchor = before.rows[0]!
    const inset = -before.top
    await pane.redraw(propsAt(width))
    const after = await read()
    const same = after.rows.find(row => row.id === anchor.id)
    const expectedTop = -Math.min(inset, (same?.height ?? anchor.height) - 1)
    if (after.rows[0]?.id !== anchor.id || after.top !== expectedTop) failures.push({ width, step: 'верхняя карточка',
      actual: `${anchor.id}@${before.top} → ${after.rows[0]?.id}@${after.top}, ожидается ${anchor.id}@${expectedTop}` })
    await pane.redraw()
    const loaded = await read()
    if (loaded.rows[0]?.id !== after.rows[0]?.id || loaded.top !== after.top) failures.push({ width, step: 'верхняя карточка после чтения',
      actual: `${after.rows[0]?.id}@${after.top} → ${loaded.rows[0]?.id}@${loaded.top}` })
    before = loaded
  }
  await pane.unmount()
  expect(windowReport(failures)).toBe('')
})

for (const [low, high] of SCROLL_WIDTHS) for (const bodyRows of [12, 18, 30]) test(`LIST-2: колесо и протяжка достигают конца на каждой ширине ${low}–${high}, высота ${bodyRows}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const tasks = resizeTasks()
  taskHost(withoutDescriptions(on), tasks[0]!, { tasks })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: low, placement: 'dock', scroll: { offset: 0, bodyRows } } })
  const read = async () => (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  const scroll = (by: number) => $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by, bodyRows, contentRows: bodyRows, origin: { kind: 'person' } })
  const failures: WindowFailure[] = []
  for (let width = low; width <= high; width++) {
    await pane.redraw({ ...PANE, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows } })
    await scroll(-1000)
    await scroll(1000)
    checkWindowEnd(failures, width, 'колесо', await read())
    await pane.redraw()
    checkWindowEnd(failures, width, 'колесо после чтения', await read())
    await pane.resize({ in: 'rows', columns: width, rows: (await read()).height })
    await pane.pointer({ in: 'rows', type: 'down', button: 'left', x: width - 1, y: 0 })
    await pane.pointer({ in: 'rows', type: 'move', button: 'left', x: -2, y: (await read()).height + 2 })
    await pane.pointer({ in: 'rows', type: 'up', button: 'left', x: -2, y: (await read()).height + 2 })
    checkWindowEnd(failures, width, 'протяжка', await read())
    await pane.redraw()
    checkWindowEnd(failures, width, 'протяжка после чтения', await read())
  }
  await pane.unmount()
  expect(windowReport(failures)).toBe('')
})

// Направления разнесены по отдельным тестам: оба прохода в одном занимали до четырёх секунд из пяти под нагрузкой.
for (const [low, high] of WINDOW_WIDTHS) for (const adding of [false, true]) for (const direction of [1, -1]) test(`LIST-2: конец и бюджет при смене высоты и ширины ${low}–${high}, поле новой задачи ${adding}, направление ${direction}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const tasks = resizeTasks()
  taskHost(withoutDescriptions(on), tasks[0]!, { tasks })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: { ...PANE, bodyColumns: direction === 1 ? low : high, placement: 'dock', scroll: { offset: 0, bodyRows: 36 } } })
  if (adding) {
    await pane.press({ key: 'new' })
    await pane.key({ in: 'new-task', key: 'Название новой задачи с переносами по изменяемой ширине панели' })
  }
  const read = async () => (await pane.find({ type: 'Client', key: 'rows' }))!.props.props as TaskCardsProps
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 1000, bodyRows: 36, contentRows: 36, origin: { kind: 'person' } })
  const failures: WindowFailure[] = []
  for (let index = 0; index <= high - low; index++) {
    const width = direction === 1 ? low + index : high - index
    const bodyRows = [24, 30, 36][index % 3]!
    await pane.redraw({ ...PANE, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows } })
    checkWindowEnd(failures, width, 'смена размеров', await read())
    await pane.redraw()
    checkWindowEnd(failures, width, 'смена размеров после чтения', await read())
    const heights = await Promise.all(['task-tabs', 'panel-header', 'new-task', 'rows'].map(async key => Number((await pane.find({ key }))?.props?.height ?? 0)))
    if (heights.reduce((sum, height) => sum + height, 0) > bodyRows) failures.push({ width, step: 'бюджет с полем', actual: `${heights.join('+')}>${bodyRows}` })
    expect(Boolean(await pane.find({ key: 'new-task' }))).toBe(adding)
  }
  await pane.unmount()
  expect(windowReport(failures)).toBe('')
})

// Запоздавшее сообщение поля: пока обработчик старого сообщения ждёт часы, поле принимает более новое.
// Старое после ожидания не возвращает в черновик свой текст — раньше из набранного «абв» оставалось «аб».
for (const field of ['new', 'comment', 'description'] as const) test(`INPUT-OVERLAP: более новое сообщение поля не заменяется старым после ожидания часов: ${field}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  let overlap: (() => Promise<unknown>) | null = null
  const held = ((name: string, ...rest: unknown[]) => {
    if (name !== 'clock.now') return (on as unknown as (...args: unknown[]) => unknown)(name, ...rest)
    const answer = rest.at(-1) as (...args: unknown[]) => unknown
    return (on as unknown as (...args: unknown[]) => unknown)(name, ...rest.slice(0, -1), async (...args: unknown[]) => {
      const run = overlap
      overlap = null
      if (run) await run()
      return answer(...args)
    })
  }) as unknown as On
  taskHost(held)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount({ plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks', props: PANE })
  if (field === 'new') await pane.press({ key: 'new' })
  else { await pane.press({ key: 'open' }); if (field === 'description') await pane.press({ key: 'page-description-edit' }); else await pageTab(pane, 'comments') }
  const key = field === 'new' ? 'new-task' : `page-${field}:${CARD.taskId}`
  const props = (await pane.find({ key }))!.props.props as EditorProps
  const message = { id: props.id, epoch: props.epoch, version: props.version + 1, text: 'аб', kind: 'change', submit: 0, cursor: 2, selected: false, pasteSequence: props.pasteSequence ?? 0 }
  overlap = () => pane.post({ ...message, version: message.version + 1, text: 'абв', cursor: 3 }, { in: key })
  await pane.post({ ...message, activity: true }, { in: key })
  expect(overlap).toBeNull()
  await pane.redraw()
  expect((await pane.find({ key }))?.props.props.value).toBe('абв')
  expect((await pane.find({ key }))?.props.props.epoch).toBe(props.epoch)
  await pane.unmount()
})

import { expect, test } from 'claude-code/testing'
import { TASK } from './fixtures'
import { PANEL, taskPanelHost } from './task-panel-host'
import type { TaskCardsProps } from '../hooks/tasks'
import type { TaskTabsProps } from '../hooks/task-tabs'
import type { RenderChildren } from 'claude-code'

// Большой набор создаётся один раз на файл, а не на каждый сценарий.
const TASKS = Array.from({ length: 1000 }, (_, index) => ({ ...TASK, taskId: `page-${index + 1}`, alias: `TASK-${index + 1}`,
  stage: 'task' as const, certainty: 'confirmed' as const, certaintySource: 'user' as const, certaintyProvenance: 'panel' as const,
  title: `Проверить задачу ${index + 1}`, priority: 2 as const, queuePosition: index + 1 }))

test('История страниц: исключение отменённой и удалённой ссылки восстанавливает выбор и раскрытие', async ($, on) => {
  const closed = { ...TASK, taskId: 'closed-42', alias: 'TASK-42', status: 'done' as const, title: 'Проверить историю',
    description: 'Проверить закрытую задачу' }
  const host = taskPanelHost(on, { tasks: [TASK], focus: TASK, closed: [closed,
    { ...closed, taskId: 'cancelled-history', alias: 'TASK-43', status: 'cancelled', title: 'Отменённая история' },
    { ...closed, taskId: 'deleted-history', alias: 'TASK-44', deleted: true, title: 'Удалённая история' }] })
  const pane = await $.ui.mount(PANEL)
  await pane.key({ key: 'h', in: 'tabs' })
  await host.clock.settle()
  await pane.redraw()
  const props = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
  expect(props.rows.some(row => row.kind === 'card' && row.selected && row.taskId === closed.taskId)).toBe(true)
  await pane.key({ key: 'i', in: 'rows' })
  const text = (node: RenderChildren): string => typeof node === 'string' || typeof node === 'number' ? String(node)
    : Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && 'children' in node ? text(node.children) : ''
  expect(text(await pane.drawn({ in: 'rows' }))).toContain(closed.description)
  await pane.unmount()
})

test('Страницы панели: текущая тысяча вне первой страницы видна из фокуса, описание читается при раскрытии',
  { options: { glyphs: 'plain' } }, async ($, on) => {
    const host = taskPanelHost(on, { tasks: TASKS, focus: { ...TASKS[999]!, description: 'Описание по запросу' }, paging: true })
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount(PANEL)
    const props = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
    expect(props.rows.some(row => row.kind === 'card' && row.taskId === 'page-1000' && row.group === 'now')).toBe(true)
    expect(host.calls.filter(call => call.op === 'task.get')).toHaveLength(0)
    await pane.key({ in: 'rows', key: 'down' })
    await host.clock.advance(250)
    await pane.key({ in: 'rows', key: 'i' })
    await host.clock.settle()
    await pane.redraw()
    expect(host.calls.filter(call => call.op === 'task.get' && call.args.taskId === 'page-1')).toHaveLength(1)
    await pane.unmount()
  })

for (const count of [300, 1000]) test(`Страницы панели: открытие ${count} задач ограничено, клиент получает окно, конец дочитывается`,
  { options: { glyphs: 'plain' } }, async ($, on) => {
    const host = taskPanelHost(on, { tasks: TASKS.slice(0, count), paging: true })
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount(PANEL)
    console.log(JSON.stringify({ panelBaseline: count, rpc: host.calls.map(call => call.op), bytes: host.bytes.reduce((sum, n) => sum + n, 0) }))
    expect(host.calls.filter(call => call.op === 'snapshot').every(call => call.op === 'snapshot' && call.args.limits?.tasks !== undefined)).toBe(true)
    expect(host.calls.filter(call => call.op === 'tasks.page' && call.args.list === 'queue')).toHaveLength(1)
    expect(host.calls.filter(call => call.op === 'task.get')).toHaveLength(0)
    const props = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
    expect(props.rows.filter(row => row.kind === 'card').length).toBeLessThan(20)
    const tabs = (await pane.find({ key: 'tabs' }))!.props.props as TaskTabsProps
    expect(tabs.tabs[0]?.label).toBe(`Агенту ${count}`)
    await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 10000, bodyRows: 30, contentRows: 30, origin: { kind: 'person' } })
    await pane.redraw()
    expect(host.calls.filter(call => call.op === 'tasks.page' && call.args.offset === 50)).toHaveLength(1)
    await pane.unmount()
  })

for (const tab of ['backlog', 'history'] as const) test(`Страницы панели: ${tab} на тысяче задач, полные счётчики и дочитывание`,
  { options: { glyphs: 'plain' } }, async ($, on) => {
    const tasks = TASKS.map(task => ({ ...task, status: tab === 'backlog' ? 'paused' as const : 'done' as const }))
    const host = taskPanelHost(on, { tasks, paging: true })
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount(PANEL)
    await pane.press({ key: `tab-${tab}` })
    const list = tab === 'backlog' ? 'deferred' : 'closed'
    expect(host.calls.filter(call => call.op === 'tasks.page' && call.args.list === list)).toHaveLength(1)
    const tabs = (await pane.find({ key: 'tabs' }))!.props.props as TaskTabsProps
    expect(tabs.tabs.find(item => item.id === tab)?.label).toBe(`${tab === 'backlog' ? 'Бэклог' : 'История'} 1000`)
    const props = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
    expect(props.rows.filter(row => row.kind === 'card').length).toBeLessThan(20)
    await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 10000, bodyRows: 30, contentRows: 30, origin: { kind: 'person' } })
    await pane.redraw()
    expect(host.calls.filter(call => call.op === 'tasks.page' && call.args.list === list && call.args.offset === 50)).toHaveLength(1)
    await pane.unmount()
  })

test('Страницы панели: перестановка на границе дочитывает соседнюю страницу и сохраняет выбор при обновлении',
  { options: { glyphs: 'plain' } }, async ($, on) => {
    const host = taskPanelHost(on, { tasks: TASKS.slice(0, 300), paging: true })
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount(PANEL)
    await pane.key({ in: 'rows', key: 'end' })
    await pane.key({ in: 'rows', key: 'v' })
    await pane.redraw()
    expect(host.calls.some(call => call.op === 'task.action' && call.args.taskId === 'page-50' && call.args.action === 'down')).toBe(true)
    const props = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
    expect(props.rows.filter(row => row.kind === 'card' && row.selected).map(row => row.taskId)).toEqual(['page-50'])
    expect(host.calls.some(call => call.op === 'tasks.page' && call.args.offset === 50)).toBe(true)
    await pane.unmount()
  })

test('Страницы панели: поздний ответ дочитывания отбрасывается после обновления', { options: { glyphs: 'plain' } }, async ($, on) => {
  let release!: () => void, started!: () => void, once = true
  const ready = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const host = taskPanelHost(on, { tasks: TASKS.slice(0, 300), paging: true, pause: request => {
    if (request.op === 'tasks.page' && request.args.offset === 50 && once) { once = false; started(); return held }
    return Promise.resolve()
  } })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 10000, bodyRows: 30, contentRows: 30, origin: { kind: 'person' } })
  await ready
  await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: -10000, bodyRows: 30, contentRows: 30, origin: { kind: 'person' } })
  host.setTasks(TASKS.slice(0, 300).map(task => ({ ...task, title: `Обновлено ${task.alias}` })))
  await host.clock.advance(30000)
  release(); await pane.redraw()
  const props = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
  expect(props.rows.filter(row => row.kind === 'card').every(row => row.kind === 'card' && row.titleLines.join(' ').startsWith('Обновлено'))).toBe(true)
  expect(host.calls.filter(call => call.op === 'tasks.page' && call.args.offset === 50)).toHaveLength(1)
  await pane.unmount()
})

test('Страницы панели: ползунок читает последний блок напрямую, Home возвращает первую задачу', { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on, { tasks: TASKS, paging: true })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  const initial = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
  await pane.pointer({ in: 'rows', type: 'down', button: 'left', x: initial.width - 1, y: initial.height - 1 })
  await pane.pointer({ in: 'rows', type: 'up', button: 'left', x: initial.width - 1, y: initial.height - 1 })
  await host.clock.settle()
  await pane.redraw()
  const last = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
  expect(last.rows.some(row => row.kind === 'card' && row.taskId === 'page-1000')).toBe(true)
  expect(host.calls.filter(call => call.op === 'tasks.page').map(call => call.args.offset)).toEqual([0, 950])
  await pane.key({ in: 'rows', key: 'home' })
  await pane.redraw()
  const first = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
  expect(first.rows.some(row => row.kind === 'card' && row.taskId === 'page-1' && row.selected)).toBe(true)
  expect(host.calls.filter(call => call.op === 'tasks.page').map(call => call.args.offset)).toEqual([0, 950, 0])
  await pane.unmount()
})

// FALLBACK-220: снимок панели не несёт списка задач, поэтому отказ чтения страницы оставлял в списке одну
// текущую задачу. Теперь после отказа списки заполняются из снимка со всеми задачами, а чтение страницы
// повторяется при следующем обновлении.
const FEW = TASKS.slice(0, 4)
const shownCards = async (pane: { find(query: { key: string }): Promise<unknown> }) =>
  ((await pane.find({ key: 'rows' }) as { props: { props: TaskCardsProps } }).props.props).rows.flatMap(row => row.kind === 'card' ? [row.taskId] : [])

test('FALLBACK-220 отказ первого чтения страницы: очередь показана целиком, следующее обновление возвращает страницы', { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on, { tasks: FEW, focus: FEW[0]!, paging: true, failPages: 1 })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.settle(); await pane.redraw()
  expect(await shownCards(pane)).toEqual(FEW.map(task => task.taskId))
  // Список показан целиком, владельцу делать нечего: сообщения нет.
  expect(host.statuses).toEqual([])
  const snapshots = () => host.calls.filter(call => call.op === 'snapshot').map(call => call.args.limits?.tasks)
  // После отказа снимок запрошен со списком задач: предел числа задач не задан.
  expect(snapshots().at(-1)).toBeUndefined()
  // Действие владельца обновляет панель: страница читается снова, и снимок опять без списка.
  await pane.key({ in: 'rows', key: 'end' }); await pane.key({ in: 'rows', key: 'u' }); await host.clock.settle(); await pane.redraw()
  expect(host.calls.filter(call => call.op === 'tasks.page').length).toBeGreaterThanOrEqual(2)
  await pane.key({ in: 'rows', key: 'u' }); await host.clock.settle(); await pane.redraw()
  expect(snapshots().at(-1)).toBe(0)
  expect((await shownCards(pane)).slice().sort()).toEqual(FEW.map(task => task.taskId).sort())
  expect(host.statuses).toEqual([])
  await pane.unmount()
})

test('FALLBACK-220 страницы не читаются совсем: список полон после каждого обновления, запросы не зацикливаются', { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on, { tasks: FEW, focus: FEW[0]!, paging: true, failPages: 1000 })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.settle(); await pane.redraw()
  expect(await shownCards(pane)).toEqual(FEW.map(task => task.taskId))
  const before = host.calls.length
  for (let frame = 0; frame < 5; frame++) { await pane.redraw(); await host.clock.settle() }
  // Повторная отрисовка без события не порождает новых обращений к рантайму.
  expect(host.calls.length - before).toBeLessThanOrEqual(1)
  await pane.key({ in: 'rows', key: 'end' }); await pane.key({ in: 'rows', key: 'u' }); await host.clock.settle(); await pane.redraw()
  expect((await shownCards(pane)).slice().sort()).toEqual(FEW.map(task => task.taskId).sort())
  expect(host.calls.filter(call => call.op === 'snapshot').at(-1)!.args.limits?.tasks).toBeUndefined()
  await pane.unmount()
})

// Под нагрузкой срок запроса выходит и у страницы, и у запасного снимка. Агент при этом может долго не трогать
// задачи, и без повтора владелец видел одну текущую задачу до следующего действия агента (жалоба 08.10.2026).
test('RETRY-235 отказ страницы и запасного снимка: список читается снова сам, без действия агента; пауза между попытками растёт', { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on, { tasks: FEW, focus: FEW[0]!, paging: true, failPages: 2, failFull: 2 })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.settle(); await pane.redraw()
  expect(await shownCards(pane)).toEqual([FEW[0]!.taskId])
  expect(host.statuses.at(-1)).toBe('Список задач не прочитан: данные недоступны. Повторю чтение сам.')
  // До срока повтора отрисовка новых обращений не порождает.
  const before = host.calls.length
  for (let frame = 0; frame < 3; frame++) { await pane.redraw(); await host.clock.settle() }
  expect(host.calls.length).toBe(before)
  // Первая пауза — пять секунд; вторая попытка тоже неудачна, следующая пауза — десять.
  await host.clock.advance(5000); await host.clock.settle(); await pane.redraw(); await host.clock.settle()
  expect(await shownCards(pane)).toEqual([FEW[0]!.taskId])
  const second = host.calls.length
  expect(second).toBeGreaterThan(before)
  await host.clock.advance(5000); await host.clock.settle(); await pane.redraw(); await host.clock.settle()
  expect(host.calls.length).toBe(second)
  await host.clock.advance(5000); await host.clock.settle(); await pane.redraw(); await host.clock.settle(); await pane.redraw()
  expect(await shownCards(pane)).toEqual(FEW.map(task => task.taskId))
  await pane.unmount()
})

// Сторож очереди: счётчик говорит, что в очереди есть задачи, а принятый список пуст. Причина такого расхождения
// у владельца не установлена; признак воспроизводится ответом страницы без строк.
test('RETRY-235 сторож очереди: список пуст при непустом счётчике — мод перечитывает его сам и называет расхождение', { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on, { tasks: FEW, focus: FEW[0]!, paging: true, emptyPages: 1 })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.settle(); await pane.redraw(); await host.clock.settle(); await pane.redraw()
  // Первое расхождение лечится сразу, без ожидания: владелец пустую очередь не видит.
  expect(await shownCards(pane)).toEqual(FEW.map(task => task.taskId))
  expect(host.calls.filter(call => call.op === 'tasks.page' && call.args.list === 'queue').length).toBeGreaterThanOrEqual(2)
  expect(host.statuses.at(-1)).toBe(`Очередь перечитана: список пуст, а в очереди задач: ${FEW.length - 1}.`)
  await pane.unmount()
})

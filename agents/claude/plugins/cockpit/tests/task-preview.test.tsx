import { expect, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'
import type { On, ProcessRunInit } from 'claude-code'
import type { Task } from '../types'
import { TASK, snapshot } from './fixtures'
import { PANEL, taskPanelHost, drawnText } from './task-panel-host'
import type { TaskCardsProps } from '../hooks/tasks'
import type { TaskPageProps } from '../hooks/task-page-model'
import type { EditorProps } from '../hooks/editor'
import { buildRequest, parseResponse, type Request } from '../hooks/domain/rpc'
import { createController, transport } from '../hooks/register'

const task = (id: number, description: string): Task => ({ ...TASK, taskId: `preview-${id}`, alias: `TASK-${id}`,
  title: `Проверить описание ${id}`, certainty: 'confirmed', certaintySource: 'user', certaintyProvenance: 'panel', description })
const QUEUED = task(229, 'Описание очереди в первом кадре')
const WORKING = task(230, 'Описание работы в первом кадре')
const props = async (pane: Mounted<'terminal', 'Pane'>) => (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps

async function expand(pane: Mounted<'terminal', 'Pane'>, id: string, mode: 'hover' | 'i') {
  const rows = await props(pane)
  const index = rows.rows.findIndex(row => row.taskId === id)
  expect(index).toBeGreaterThanOrEqual(0)
  if (mode === 'i') {
    await pane.key({ in: 'rows', key: 'home' })
    const cards = rows.rows.filter(row => row.kind === 'card')
    for (let step = 0; step < cards.findIndex(row => row.taskId === id); step++) await pane.key({ in: 'rows', key: 'down' })
    await pane.key({ in: 'rows', key: 'i' })
  } else {
    const y = rows.top + rows.rows.slice(0, index).reduce((sum, row) => sum + row.height, 0) + 1
    await pane.pointer({ in: 'rows', type: 'move', x: 3, y })
    await pane.advance(200)
  }
}

// Исполнитель получает состояние через те же границы хоста, что и настоящий мод.
function peer(on: On, working: Task) {
  const jobId = 'c'.repeat(32), root = '/fixture-home/.local/state/agent-config/peer-agents'
  on('state.get', { plugin: 'cockpit', key: 'workTrails' }, () => ({ value: { version: 1,
    value: { [working.taskId]: { jobs: [{ jobId, agent: 'codex', mode: 'implement' }] } } } }))
  on('fs.stat', (_$, e) => ({ value: { kind: e.path === root ? 'dir' : 'file', isLink: false, realPath: e.path, size: 400, mtimeMs: 1 } }))
  on('fs.read', () => ({ value: JSON.stringify({ job_id: jobId, agent: 'codex', mode: 'implement', task_size: 'medium', status: 'running',
    source_cwd: '/fixture', created_at: 100, started_at: 110 }) }))
}

for (const mode of ['hover', 'i'] as const) for (const group of ['queue', 'working'] as const)
  test(`PREVIEW-229 ${group}/${mode}: первый кадр с текстом, ноль RPC при раскрытии`, { options: { glyphs: 'plain' } }, async ($, on) => {
    const chosen = group === 'queue' ? QUEUED : WORKING
    const host = taskPanelHost(on, { tasks: group === 'queue' ? [chosen] : [], workingTasks: group === 'working' ? [chosen] : [], paging: true,
      pause: request => request.op === 'task.get' ? host.clock.sleep(1000) : Promise.resolve() })
    if (group === 'working') peer(on, chosen)
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount(PANEL)
    await host.clock.settle(); await pane.redraw()
    const row = (await props(pane)).rows.find(row => row.kind === 'card' && row.taskId === chosen.taskId)!
    expect(row.group).toBe(group === 'queue' ? 'queue' : 'now')
    if (group === 'queue') expect(host.calls.find(call => call.op === 'tasks.page' && call.args.list === 'queue')?.args).toEqual({ list: 'queue', offset: 0, limit: 50, preview: 1200 })
    const before = host.calls.length
    await expand(pane, chosen.taskId, mode)
    const text = drawnText(await pane.drawn({ in: 'rows' }))
    expect(text).toContain(chosen.description!)
    expect(text).not.toContain('Загрузка')
    expect(host.calls.slice(before)).toHaveLength(0)
    expect(host.calls.filter(call => call.op === 'task.get')).toHaveLength(0)
    await pane.unmount()
  })

for (const tab of ['history', 'backlog'] as const)
  test(`PREVIEW-229 ${tab}: описания страниц остаются ленивыми`, { options: { glyphs: 'plain' } }, async ($, on) => {
    const chosen = { ...QUEUED, status: tab === 'history' ? 'done' as const : 'paused' as const }
    const host = taskPanelHost(on, { tasks: [chosen], paging: true, pause: request => request.op === 'task.get' ? host.clock.sleep(1000) : Promise.resolve() })
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount(PANEL)
    await pane.press({ key: `tab-${tab}` }); await host.clock.settle(); await pane.redraw()
    expect(host.calls.filter(call => call.op === 'task.get')).toHaveLength(0)
    const page = host.calls.find(call => call.op === 'tasks.page' && call.args.list === (tab === 'history' ? 'closed' : 'deferred'))!
    expect(page.args).not.toHaveProperty('preview')
    await expand(pane, chosen.taskId, 'hover')
    expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('Загрузка')
    await host.clock.advance(1000); await pane.redraw()
    expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain(chosen.description!)
    expect(host.calls.filter(call => call.op === 'task.get')).toHaveLength(1)
    await pane.unmount()
  })

test('PREVIEW-229 страница и редактор читают полный текст; прочитанная карточка важнее превью', { options: { glyphs: 'plain' } }, async ($, on) => {
  const full = 'Начало описания\n' + 'Подробности задачи '.repeat(90) + '\nПоследняя строка полного описания'
  const chosen = { ...QUEUED, description: full }
  const host = taskPanelHost(on, { tasks: [chosen], paging: true })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.settle(); await pane.redraw()
  const row = (await props(pane)).rows.find(row => row.kind === 'card')!
  expect(row.kind === 'card' && row.detailReady).toBe(true)
  expect(host.calls.filter(call => call.op === 'task.get')).toHaveLength(0)
  await pane.key({ in: 'rows', key: 'return' })
  expect(host.calls.filter(call => call.op === 'task.get' && call.args.taskId === chosen.taskId)).toHaveLength(1)
  await pane.key({ in: 'page-content', key: 'end' })
  const page = (await pane.find({ key: 'page-content' }))!.props.props as TaskPageProps
  expect(page.lines.map(line => line.text).join(' ')).toContain('Последняя строка полного описания')
  await pane.key({ in: 'page-content', key: 'e' })
  const editor = (await pane.find({ key: `page-description:${chosen.taskId}` }))!.props.props as EditorProps
  expect(editor.value).toBe(full)
  await pane.key({ in: `page-description:${chosen.taskId}`, key: 'escape' })
  await pane.press({ key: 'page-back' }); await pane.redraw()
  // Меняем начало только в превью: уже прочитанная полная карточка остаётся источником описания.
  host.setTasks([{ ...chosen, description: 'Новый текст превью' }])
  await host.clock.advance(30000); await pane.redraw()
  const after = (await props(pane)).rows.find(row => row.kind === 'card')!
  expect(after.kind === 'card' && after.details.join(' ')).toContain('Начало описания')
  expect(after.kind === 'card' && after.details.join(' ')).not.toContain('Новый текст превью')
  await pane.unmount()
})

test('PREVIEW-229 одновременные отказы параметра оба получают ограниченный откат', async () => {
  const controller = createController(), calls: Request[] = []
  let entered = 0, release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const bridge = { env: { get: async () => undefined }, fs: { exists: async () => false },
    process: { run: async (_argv: readonly string[], init?: ProcessRunInit) => {
      const request: Request = JSON.parse(init!.stdin!); calls.push(request)
      const extended = request.op === 'tasks.page' && request.args.preview !== undefined
      if (extended) { if (++entered === 2) release(); await ready }
      return { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
        stdout: JSON.stringify(extended ? { v: 1, ok: false, error: { code: 'INVALID_REQUEST', message: 'Неверный набор полей запроса.' } }
          : { v: 1, ok: true, result: { list: 'queue', offset: 0, total: 0, tasks: [] } }) }
    } } }
  const current = { sessionId: 'preview-session', cwd: '/fixture' }
  const results = await Promise.all(['preview-first', 'preview-second'].map(id => transport(bridge, controller,
    buildRequest('tasks.page', id, current, { list: 'queue', offset: 0, limit: 50, preview: 1200 }), Date.now() + 3000)))
  expect(results.map(result => result.kind)).toEqual(['page', 'page'])
  expect(calls.filter(call => call.op === 'tasks.page' && call.args.preview !== undefined)).toHaveLength(2)
  expect(calls.filter(call => call.op === 'tasks.page' && call.args.preview === undefined)).toHaveLength(2)
})

test('PREVIEW-229 неизвестный исход чтения с параметром не порождает повторов', async () => {
  let calls = 0
  const bridge = { env: { get: async () => undefined }, fs: { exists: async () => false },
    process: { run: async () => { calls++; return { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: 'Не завершено' } } } }
  const result = await transport(bridge, createController(), buildRequest('tasks.page', 'preview-unknown', { sessionId: 'preview-session', cwd: '/fixture' },
    { list: 'queue', offset: 0, limit: 50, preview: 1200 }), Date.now() + 3000)
  expect(result.kind).toBe('unknown')
  expect(calls).toBe(1)
})

test('PREVIEW-229 старый рантайм отклоняет параметр: повтор без превью, история остаётся доступна', { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on, { tasks: [QUEUED], paging: true, rejectPreview: true })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.settle(); await pane.redraw()
  expect((await props(pane)).rows.some(row => row.kind === 'card' && row.taskId === QUEUED.taskId)).toBe(true)
  const requests = host.calls.filter(call => call.op === 'snapshot' || call.op === 'session.rebind' || call.op === 'tasks.page')
  const extended = requests.filter(call => (call.op === 'snapshot' || call.op === 'session.rebind') && call.args.limits?.preview === 1200)
  expect(extended).toHaveLength(1)
  const rejected = extended[0]!
  const index = host.calls.indexOf(rejected)
  const fallback = host.calls[index + 1]!
  expect(fallback.op).toBe(rejected.op)
  expect(fallback.requestId).not.toBe(rejected.requestId)
  expect((fallback as typeof rejected).args.limits).toEqual({ tasks: 0, inbox: 10 })
  expect(host.calls.filter(call => call.op === 'tasks.page').every(call => call.op === 'tasks.page' && call.args.preview === undefined)).toBe(true)
  expect(host.statuses).toEqual([])
  await expand(pane, QUEUED.taskId, 'hover'); await host.clock.settle(); await pane.redraw()
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain(QUEUED.description!)
  expect(host.calls.filter(call => call.op === 'task.get')).toHaveLength(1)
  await pane.unmount()
})

test('PREVIEW-229 отказ только превью страницы: повторяет ту же страницу без параметра', { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on, { tasks: [QUEUED], paging: true, rejectPagePreview: true })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.settle(); await pane.redraw()
  expect((await props(pane)).rows.some(row => row.kind === 'card' && row.taskId === QUEUED.taskId)).toBe(true)
  expect(host.calls.filter(call => call.op === 'tasks.page').map(call => call.args)).toEqual([
    { list: 'queue', offset: 0, limit: 50, preview: 1200 }, { list: 'queue', offset: 0, limit: 50 },
  ])
  expect(host.statuses).toEqual([])
  await pane.unmount()
})

test('PREVIEW-229 RPC принимает безопасную строку страницы и workingTasks, неверные типы отклоняет', () => {
  const secret = 'gh' + 'p_' + 'q'.repeat(36)
  const description = `<pasted_content>Описание ${secret}</pasted_content>`
  const entry = { taskId: QUEUED.taskId, alias: QUEUED.alias, title: QUEUED.title, status: 'active', updatedAt: QUEUED.updatedAt, priorityPinned: false }
  const wire = (value: unknown) => JSON.stringify({ v: 1, ok: true, result: { list: 'queue', offset: 0, total: 1, tasks: [{ ...entry, description: value }] } })
  const parsed = parseResponse('tasks.page', wire(description), 0, false)
  expect(parsed.kind).toBe('page')
  const text = parsed.kind === 'page' ? parsed.page.tasks[0]!.description : ''
  expect(text).toContain('[REDACTED:')
  expect(text).not.toContain(secret)
  expect(text).not.toContain('pasted_content')
  for (const value of [null, 1200, {}, 'а'.repeat(2001)]) expect(parseResponse('tasks.page', wire(value), 0, false).kind).toBe('unknown')
  const working = parseResponse('snapshot', JSON.stringify({ v: 1, ok: true, result: { ...snapshot(null), workingTasks: [{ ...WORKING, description }] } }), 0, false)
  expect(working.kind).toBe('snapshot')
  const workingText = working.kind === 'snapshot' ? working.snapshot.workingTasks![0]!.description : ''
  expect(workingText).toContain('[REDACTED:')
  expect(workingText).not.toContain(secret)
  expect(workingText).not.toContain('pasted_content')
})

import type { On, RenderChildren, RenderElement, ToolSpec } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { OwnerTask, Projection, Task } from '../types'
import type { Request } from '../hooks/domain/rpc'
import { seeded, snapshot, reply, TASK } from './fixtures'
import { cellWidth } from '../hooks/layout'

export const PANEL = {
  plugin: 'cockpit', surface: 'terminal', component: 'Pane', requestId: 'tasks',
  props: { title: 'Задачи', isFocused: true, bodyColumns: 84, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// Узкий хост двух сценариев: настоящий редактор, отрисовка и запросы проходят через мод.
export function taskPanelHost(on: On, options: { tasks?: Task[]; focus?: Task | null; workingTasks?: Task[]; closed?: Task[]; readOnly?: boolean; paging?: boolean; rejectPreview?: boolean; rejectPagePreview?: boolean; failPages?: number; failFull?: number; emptyPages?: number; now?: number; pause?: (request: Request) => Promise<void>; rpc?: (request: Request) => string | undefined } = {}) {
  mock.store(on)
  mock.env(on, { HOME: '/fixture-home' })
  const clock = mock.clock(on, { now: options.now ?? 1_000_000 })
  let live = { ...snapshot(options.focus ?? null), tasks: options.tasks ?? [], storageSchemaVersion: 11, queue: 'run' as const,
    ...(options.paging ? { candidates: [], candidateCount: 0 } : {}) }
  let state: Projection = { ...seeded(options.focus ?? null), snapshot: live }
  let version = 1
  // Столько первых чтений страницы возвращают неразборчивый ответ, как при сбое или истёкшем сроке.
  let pageFailures = options.failPages ?? 0
  // Столько первых чтений запасного снимка со всеми задачами тоже не удаются: рантайм недоступен целиком.
  let fullFailures = options.failFull ?? 0
  // Столько первых страниц очереди приходят без строк при непустом счётчике снимка.
  let emptyPages = options.emptyPages ?? 0
  let ownerVersion = 1
  let owners: readonly OwnerTask[] = []
  const calls: Request[] = [], bytes: number[] = [], submitted: string[] = [], fills: string[] = [], tools: ToolSpec[] = []
  on('session.id', () => ({ value: 'fixture-session' }))
  on('session.cwd', () => ({ value: '/fixture' }))
  on('session.root', () => ({ value: '/fixture' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 200000 }, rateLimits: [] } }))
  on('state.get', { plugin: 'cockpit', key: 'projection' }, () => ({ value: { value: state, version } }))
  on('state.set', { plugin: 'cockpit', key: 'projection' }, (_$, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    state = e.value; version++
    return { value: { isSet: true, version } }
  })
  on('state.get', { plugin: 'cockpit', key: 'ownerTasks' }, () => ({ value: { value: owners, version: ownerVersion } }))
  on('state.set', { plugin: 'cockpit', key: 'ownerTasks' }, (_$, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== ownerVersion) return { value: { isSet: false, version: ownerVersion } }
    owners = e.value; ownerVersion++
    return { value: { isSet: true, version: ownerVersion } }
  })
  if (options.readOnly) on('state.get', { plugin: 'cockpit', key: 'attestations' }, () => ({ value: { version: 1, value: {
    [JSON.stringify(['fixture-session', '/fixture'])]: { ownerRoot: '/other-copy', loadId: 'other-load', epoch: 0, runtimeSessionId: 'fixture-session' },
  } } }))
  on('process.run', async (_$, e) => {
    const value = (stdout: string) => { if (e.init?.stdin) bytes.push(new TextEncoder().encode(stdout).length); return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } }
    if (!e.init?.stdin) return value('missing')
    const request: Request = JSON.parse(e.init.stdin); calls.push(request)
    const custom = options.rpc?.(request)
    if (custom !== undefined) return value(custom)
    await options.pause?.(request)
    const preview = request.op === 'tasks.page' ? (request.args as { preview?: number }).preview
      : request.op === 'snapshot' || request.op === 'session.rebind' ? (request.args.limits as { preview?: number } | undefined)?.preview : undefined
    if ((options.rejectPreview || options.rejectPagePreview && request.op === 'tasks.page') && preview !== undefined) return value(JSON.stringify({ v: 1, ok: false,
      error: { code: 'INVALID_REQUEST', message: 'Неверный набор полей запроса.' } }))
    const description = (task: Task) => typeof task.description !== 'string' || preview === undefined ? {}
      : { description: Array.from(task.description).length <= preview ? task.description : Array.from(task.description).slice(0, preview - 2).join('') + ' …' }
    let result: unknown
    if (request.op === 'snapshot' && options.paging && request.args.limits?.tasks === undefined && fullFailures-- > 0) return value('сбой чтения')
    if (request.op === 'snapshot' || request.op === 'session.rebind') {
      const count = live.tasks.filter(task => task.status === 'active').length
      const deferred = live.tasks.filter(task => task.status === 'paused').length
      const done = live.tasks.filter(task => task.status === 'done').length
      const limit = request.args.limits?.tasks
      result = options.paging ? { ...live, tasks: live.tasks.slice(0, limit ?? live.tasks.length), openTaskCount: count + deferred,
        tasksTruncated: limit !== undefined && limit < live.tasks.length,
        taskCounts: { active: count, deferred, done, queued: count - Number(live.focus.task?.status === 'active') },
        workingTasks: (options.workingTasks ?? []).map(task => ({ ...task, ...description(task) })) } : live
    }
    else if (request.op === 'tasks.page' && options.paging && pageFailures-- > 0) return value('сбой чтения')
    else if (request.op === 'tasks.page' && options.paging && request.args.list === 'queue' && emptyPages-- > 0) result = { list: 'queue', offset: request.args.offset, total: 0, tasks: [] }
    else if (request.op === 'tasks.page' && options.paging) {
      const tasks = live.tasks.filter(task => task.status === (request.args.list === 'queue' ? 'active' : request.args.list === 'deferred' ? 'paused' : 'done'))
        .filter(task => request.args.list !== 'queue' || task.taskId !== live.focus.task?.taskId)
      if (request.args.list === 'closed') tasks.sort((a, b) => Number(b.alias.slice(5)) - Number(a.alias.slice(5)))
      result = { list: request.args.list, offset: request.args.offset, total: tasks.length,
        tasks: tasks.slice(request.args.offset, request.args.offset + request.args.limit).map(task => ({
          taskId: task.taskId, alias: task.alias, title: task.title, status: task.status, updatedAt: task.updatedAt, priorityPinned: false,
          priority: task.priority ?? 2, queuePosition: task.queuePosition ?? 0, revision: task.revision, needsDecision: false,
          stepCounts: { total: 0, done: 0, active: 0 }, discussionCount: task.discussionCount ?? 0,
          ...(task.returnCount === undefined ? {} : { returnCount: task.returnCount }), ...(task.elapsedMs === undefined ? {} : { elapsedMs: task.elapsedMs }),
          ...(task.summary === undefined ? {} : { summary: task.summary }),
          ...description(task),
        })) }
    }
    else if (request.op === 'task.create') {
      const task: Task = { ...TASK, taskId: `new-${live.tasks.length + 1}`, title: request.args.title,
        certainty: 'confirmed', certaintySource: 'user', certaintyProvenance: 'panel', revision: 0 }
      live = { ...live, tasks: [...live.tasks, task] }; result = { task, focus: live.focus }
    } else if (request.op === 'task.action' && options.paging) {
      const index = live.tasks.findIndex(task => task.taskId === request.args.taskId)
      const tasks = [...live.tasks]
      let task = tasks[index]!
      if (request.args.action === 'up' || request.args.action === 'down') {
        const to = index + (request.args.action === 'up' ? -1 : 1)
        const other = tasks[to]!
        tasks[to] = { ...task, queuePosition: other.queuePosition, revision: task.revision + 1 }
        tasks[index] = { ...other, queuePosition: task.queuePosition, revision: other.revision + 1 }
        task = tasks[to]!
      } else if (request.args.action === 'defer') task = tasks[index] = { ...task, status: 'paused', revision: task.revision + 1 }
      else if (request.args.action === 'current') {
        task = tasks[index] = { ...task, status: 'active', revision: task.revision + 1 }
        live = { ...live, focus: { task, revision: live.focus.revision + 1 } }
      }
      live = { ...live, tasks }; result = { task, focus: live.focus }
    } else if (request.op === 'task.get') result = { task: [...live.tasks, ...(options.closed ?? [])].find(task => task.taskId === request.args.taskId) ?? TASK }
    else if (request.op === 'tasks.context') {
      const queue = live.tasks.filter(task => task.status === 'active'), deferred = live.tasks.filter(task => task.status === 'paused'), closed = options.closed ?? live.tasks.filter(task => task.status === 'done')
      result = { binding: live.binding, current: null, queue: queue.slice(0, 30).map(task => ({ ...task, description: task.description ?? '' })), deferred: deferred.slice(0, 10), closed: closed.slice(0, 10), ownerChanges: [], cursor: 0,
        counts: { total: live.tasks.length, open: queue.length + deferred.length, active: queue.length, queued: queue.length, deferred: deferred.length,
          done: closed.length, cancelled: 0, closedLast24h: closed.length, projectOpen: queue.length + deferred.length } }
    }
    else return value(reply(request))
    return value(JSON.stringify({ v: 1, ok: true, result }))
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'tasks', title: 'Задачи', isShown: true, isFocused: true, isPlaced: true }] }))
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  const statuses: string[] = []
  on('ui.status', (_$, e) => { if (e.text !== undefined) statuses.push(e.text); return { value: undefined } })
  on('tool.register', (_$, e) => { tools.push(e); return { value: { tool: `mcp__cockpit__${e.name}` } } })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.read', () => ({ value: { text: fills.at(-1) ?? '', cursor: 0 } }))
  on('prompt.fill', (_$, e) => { fills.push(e.text); return { isFilled: true } })
  on('prompt.submit', (_$, e) => {
    if (e.origin.kind === 'plugin') submitted.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('session.append', (_$, e, next) => next(e))
  return { clock, calls, bytes, submitted, fills, tools, statuses, get owners() { return owners },
    restoreProjection() { state = { ...seeded(null), snapshot: live }; version++ },
    setOwners(tasks: readonly OwnerTask[]) { owners = tasks; ownerVersion++ },
    changeTask(task: Task, focus = false) {
      live = { ...live, tasks: live.tasks.map(item => item.taskId === task.taskId ? task : item),
        ...(focus ? { focus: { task, revision: live.focus.revision + 1 } } : {}) }
      state = { ...state, snapshot: live, focus: live.focus }; version++
    },
    setTasks(tasks: Task[]) { live = { ...live, tasks } } }
}

export function drawnText(node: RenderChildren): string {
  if (Array.isArray(node)) return node.map(drawnText).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object' || !('type' in node)) return ''
  if (node.type === 'Box' && node.props?.display === 'none') return ''
  if (node.type === 'Button') return node.props?.label ?? ''
  if (node.type === 'Text' && 'text' in node && typeof node.text === 'string') return node.text
  return 'children' in node ? drawnText(node.children) : ''
}

export function elements(node: RenderChildren): RenderElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !('type' in node)) return []
  const children = 'children' in node ? elements(node.children) : []
  return 'props' in node && node.props ? [node, ...children] : children
}

// Текстовый вид берёт строки и накладки из настоящего дерева клиента, не из повторной модели карточки.
export function framePreview(slot: RenderChildren, key: string): string {
  const nodes = elements(slot)
  const frame = nodes.find(node => node.type === 'Box' && node.props.key === key)!
  const width = Number(frame.props.width), height = Number(frame.props.height), inset = Number(frame.props.paddingX ?? 0)
  const lines = ['╭' + '─'.repeat(width - 2) + '╮']
  const body = elements(frame).filter(node => node.type === 'Box' && node.props.height === 1 && node.props.position !== 'absolute')
  for (let index = 0; index < height - 2; index++) {
    const text = body[index] ? drawnText(body[index]!) : ''
    lines.push('│' + ' '.repeat(inset) + text + ' '.repeat(Math.max(0, width - 2 - 2 * inset - cellWidth(text))) + ' '.repeat(inset) + '│')
  }
  lines.push('╰' + '─'.repeat(width - 2) + '╯')
  for (const node of nodes) if (node.type === 'Box' && node.props.position === 'absolute') {
    const row = Number(node.props.top), left = Number(node.props.left), text = drawnText(node)
    if (!text || !Number.isFinite(left) || !lines[row]) continue
    lines[row] = lines[row]!.slice(0, left) + text + lines[row]!.slice(left + cellWidth(text))
  }
  return lines.join('\n')
}

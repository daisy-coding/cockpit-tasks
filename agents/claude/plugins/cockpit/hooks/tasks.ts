import type { AgentTaskNote, Projection, Task, TaskContextEntry, TaskSummary, TaskStep, TaskPage, TaskPageList } from '../types/index'
import type { RowSpec, Seg } from './rows'
import { SINGLE_CELL_TEXT, cellWidth, eachGrapheme, graphemes, truncateCells } from './layout.ts'
import { dayBefore, relativeTime, sameDay, twoDigits, wallTime } from './local-time.ts'

import { DEFAULT_THEME, roleColors, type Theme } from './theme.ts'
import { splitTaskText } from './domain/task-text.ts'
import { displayTaskNumber } from './domain/task-number.ts'
import { workAssignments, workerCaption, type PeerWork, type TaskWorker } from './domain/peer-work.ts'
import type { SearchDecoration } from './task-search-panel'
export { DEFAULT_THEME as THEME } from './theme.ts'
export const MARK = {
  active: '\u{f144}', // fa-circle_play
  pending: '\u{f10c}', // fa-circle_o
  done: '\u{f00c}', // fa-check
  paused: '\u{f04c}', // fa-pause
  blocked: '\u{f071}', // fa-exclamation_triangle
  cancelled: '\u{f05e}', // fa-ban
} as const
export type Group = 'now' | 'queue' | 'detours' | 'waiting'
export interface TaskView {
  cursor: string
  selectedTask?: TaskSummary
  expanded: Set<string>
  collapsed: Set<string>
  offset: number
  limit: number
  width?: number
  reveal?: boolean
  window?: { offset: number; atEnd: boolean; rowId?: string; inset: number }
  working?: boolean
  peers?: Map<string, PeerWork[]>
  glyphs?: 'nerd' | 'unicode'
  details?: Map<string, Task>
  notes?: Map<string, AgentTaskNote[]>
  ownerCommentCounts?: Map<string, number>
  drafts?: Map<string, string>
}
export type CardActionName = 'current' | 'done' | 'defer' | 'restore' | 'append' | 'up' | 'down' | 'priority' | 'delete' | 'save' | 'cancel'
export type CardAction = { name: CardActionName; label: string }
type Block = { id: string; width: number; height: number; taskId?: string; group?: Group }
// Псевдонимы типов, а не интерфейсы: свойства модуля Client обязаны укладываться в JsonValue.
export type TaskCard = Block & {
  kind: 'card' | 'compact'
  taskId: string
  task: Pick<TaskSummary, 'status' | 'needsDecision'>
  titleLines: string[]
  search?: SearchDecoration
  number: string
  context: string[]
  progress: Seg[]
  progressCount: string
  mark: string
  status: string
  running: boolean
  actions: CardAction[]
  actionWidth: number
  statusWidth: number
  innerWidth: number
  steps: Pick<TaskStep, 'position' | 'title' | 'status'>[]
  remainingSteps: number
  borderColor: string
  borderDimColor: boolean
  selected: boolean
  shimmer: boolean
  gutterWidth: number
  textWidth: number
  sourceIcon: string
  priorityColor: string
  priorityDim: boolean
  priorityLabel: string
  actionsBelow: boolean
  actionRows: CardAction[][]
  detailActions: CardAction[][]
  details: string[]
  detailReady?: boolean
  workers?: TaskWorker[]
  workerLabel?: string
  expanded: boolean
  draft?: string
  lines: string[]
  // Индикатор загрузки описания в раскрытой карточке: номер светящейся точки либо отметка, что срок чтения вышел.
  loader?: number | 'failed'
  closedTime?: string
  // Сколько задача была в работе; нет у задачи, закрытой без взятия в работу.
  closedSpent?: string
  discussionCount: number
  returnCount?: number
  // Значки действий на нижней линии рамки. Их рисует тот же модуль, что и карточку: значок, нарисованный хуком
  // поверх списка, на прокрутке расходился с рамкой своей карточки.
  controls: CardControl[]
}
export type CardControl = { key: string; label: string; hint: string; keyHint: string }
export type TaskRow = TaskCard
  | Block & { kind: 'heading'; group: Group; label: string; count: number; collapsed: boolean }
  | Block & { kind: 'day'; label: string }
  | Block & { kind: 'empty'; text: string; lines?: readonly string[] }
  | Block & { kind: 'gap' | 'more'; text: string }
export type TaskCardsProps = {
  rows: TaskRow[]; theme: Theme; width: number; height: number; top: number; totalHeight: number; offset: number
  viewportHeight?: number
  windowKey?: string
  /** Запасные знаки вместо значков Nerd Font у заголовков групп. */
  plain?: boolean
  bar?: { pos: number; size: number }
}
export const TASK_LIST_LIMIT = 50
export type TaskListPages = Record<TaskPageList, {
  rows: TaskSummary[]; total: number; base: number; next: number; sequence: number; ready: boolean; stale: boolean
  loading: Set<number>; unavailable: boolean; failed: boolean
  // Когда повторить чтение после отказа и страницы, и запасного снимка; число таких отказов подряд.
  retryAt?: number; failures?: number
  reading?: { sequence: number; work: Promise<void> }
}>
export function newTaskListPages(): TaskListPages {
  const empty = () => ({ rows: [], total: 0, base: 0, next: 0, sequence: 0, ready: false, stale: false, loading: new Set<number>(), unavailable: false, failed: false })
  return { queue: empty(), deferred: empty(), closed: empty() }
}
export function invalidateTaskLists(lists: TaskListPages): void {
  for (const list of Object.values(lists)) { list.sequence++; list.loading = new Set(); list.stale = true; list.failed = false; list.retryAt = undefined }
}
export function acceptTaskList(lists: TaskListPages, page: TaskPage, sequence: number): boolean {
  const list = lists[page.list]
  const replace = list.stale || !list.ready
  const before = !replace && page.offset < list.base && page.offset + page.tasks.length === list.base
  if (sequence !== list.sequence || (replace ? page.offset !== 0 && !list.loading.has(page.offset)
    : page.offset !== list.next && !before)) return false
  const rows = page.tasks.map((task, index) => ({ ...task, queuePosition: task.queuePosition ?? page.offset + index, revision: task.revision ?? -1,
    certainty: 'confirmed' as const, certaintySource: task.certaintySource ?? 'user', certaintyProvenance: 'panel' as const }))
  const held = new Map((replace ? [] : before ? [...rows, ...list.rows] : list.rows).map(task => [task.taskId, task]))
  for (const task of rows) held.set(task.taskId, task)
  list.rows = [...held.values()]
  if (replace || before) list.base = page.offset
  if (!before) list.next = page.offset + page.tasks.length
  list.total = page.total
  list.ready = true; list.stale = false
  return true
}
// Запасной путь при отказе страниц: три списка целиком из снимка со всеми задачами. Порядок — как в снимке.
export function acceptSnapshotLists(lists: TaskListPages, tasks: TaskSummary[], currentId?: string): void {
  const groups: Record<TaskPageList, TaskSummary[]> = {
    queue: tasks.filter(task => task.status === 'active' && task.taskId !== currentId),
    deferred: tasks.filter(task => task.status === 'paused'), closed: tasks.filter(task => task.status === 'done'),
  }
  for (const name of ['queue', 'deferred', 'closed'] as const) {
    const list = lists[name]
    list.rows = groups[name]; list.total = groups[name].length; list.base = 0; list.next = groups[name].length
    list.ready = true; list.stale = false
  }
}
export function listProjection(state: Projection, lists: TaskListPages, list: TaskPageList): Projection {
  if (!lists[list].ready || lists[list].unavailable || !state.snapshot) return state
  const tasks = [...lists[list].rows]
  if (list === 'queue') for (const task of state.snapshot.workingTasks ?? []) {
    if (!tasks.some(item => item.taskId === task.taskId)) tasks.push(task)
  }
  return { ...state, snapshot: { ...state.snapshot, tasks } }
}
export function visibleTask(task: TaskSummary): boolean {
  // bind стража берёт последнюю реплику; такая наблюдаемая запись ещё не задача человека.
  return task.stage !== 'candidate' && !task.deleted && !(task.certaintySource === 'engine' && task.certaintyProvenance === 'cli'
    && task.certainty !== 'confirmed' && !task.steps?.length)
}
export function taskList(state: Projection): TaskSummary[] {
  const tasks = [...(state.snapshot?.tasks ?? [])]
  const current = state.focus?.task
  if (current) {
    const at = tasks.findIndex(item => item.taskId === current.taskId)
    if (at < 0) tasks.unshift(current)
    else tasks[at] = current
  }
  return tasks.filter(visibleTask).sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2)
    || (a.queuePosition ?? 0) - (b.queuePosition ?? 0) || a.alias.localeCompare(b.alias, undefined, { numeric: true }))
}
export function queueTasks(state: Projection): TaskSummary[] {
  return taskList(state).filter(task => task.status === 'active' && task.taskId !== state.focus?.task?.taskId
    && !task.needsDecision && !state.snapshot?.focusStack.some(frame => frame.taskId === task.taskId))
}
export function backlogTasks(state: Projection): TaskSummary[] {
  return taskList(state).filter(task => task.status === 'paused')
}
export function taskActionEnabled(state: Projection, task: TaskSummary | undefined, action: string): boolean {
  if (action === 'new') return true
  if (!task) return false
  if (task.stage === 'candidate') return false
  if (action === 'delete') return true
  if (action === 'restore') return task.status === 'paused'
  if (action === 'current') return ['active', 'paused'].includes(task.status) && task.taskId !== state.focus?.task?.taskId
  if (action === 'append') return true
  if (action === 'defer') return task.status === 'active'
  const queued = queueTasks(state).filter(item => (item.priority ?? 2) === (task.priority ?? 2))
  const at = queued.findIndex(item => item.taskId === task.taskId)
  return action === 'up' ? at > 0 : action === 'down' ? at >= 0 && (at < queued.length - 1
    || Boolean(state.snapshot?.tasksTruncated && (state.snapshot.taskCounts?.queued ?? 0) > queueTasks(state).length)) : false
}
export function taskProgress(task: TaskSummary): { done: number; total: number; active: number; pending: number } | null {
  if (task.stepCounts) return task.stepCounts.total ? { ...task.stepCounts, pending: task.stepCounts.total - task.stepCounts.done - task.stepCounts.active } : null
  if (!task.steps?.length) return null
  const done = task.steps.filter(step => step.status === 'done').length
  const active = task.steps.filter(step => step.status === 'active').length
  return { done, active, total: task.steps.length, pending: task.steps.length - done - active }
}
// Перенос linear-tickets/linear-api.ts:286–297: остаток получает самая большая доля.
export function stacked(parts: readonly { n: number; glyph: string }[], width: number): { glyph: string; cells: number }[] {
  const total = parts.reduce((s, p) => s + p.n, 0)
  if (total === 0) return []
  const out = parts.map(p => ({ glyph: p.glyph, cells: Math.floor((p.n / total) * width), n: p.n }))
  let used = out.reduce((s, p) => s + p.cells, 0)
  for (const p of out) if (p.n > 0 && p.cells === 0 && used < width) (p.cells = 1), (used += 1)
  const largest = out.reduce((a, b) => (b.n > a.n ? b : a), out[0]!)
  largest.cells += width - used
  return out.filter(p => p.cells > 0).map(({ glyph, cells }) => ({ glyph, cells }))
}
export function progressSegments(task: TaskSummary, width = 12, theme: Theme = DEFAULT_THEME): Seg[] {
  const p = taskProgress(task)
  if (!p) return []
  const roles = roleColors(theme)
  return stacked([{ n: p.done, glyph: '━' }, { n: p.active, glyph: '╍' }, { n: p.pending, glyph: '─' }], width)
    .map(part => ({ t: part.glyph.repeat(part.cells), c: part.glyph === '━' ? roles.ok : part.glyph === '╍' ? roles.work : roles.muted }))
}
// Перенос todo-bar/hooks/board.ts:113–118.
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} сек`
  if (sec < 3600) return `${Math.floor(sec / 60)} мин`
  return `${Math.floor(sec / 3600)} ч ${Math.floor((sec % 3600) / 60)} мин`
}

function modelSource(task: TaskSummary): boolean {
  return Boolean(task.sourcePhrase) || ('source' in task && task.source !== null && typeof task.source === 'object')
    || ['provider', 'engine', 'agent', 'claude'].includes(task.certaintySource)
}

export function sourceIcon(task: TaskSummary, mode: 'nerd' | 'unicode' = 'nerd'): string {
  const model = modelSource(task)
  return model ? mode === 'nerd' ? '\u{f06a9}' : '⚙' : mode === 'nerd' ? '\u{f02c7}' : '☞' // md-robot, md-hand_pointing_right
}

function wrapText(value: string, width: number): string[] {
  return value.replace(/[\t\r]/gu, ' ').split('\n').flatMap(line => {
    const out: string[] = []
    let part = ''
    for (const cluster of graphemes(line)) {
      if (cellWidth(part + cluster) > width && part) { out.push(part); part = '' }
      part += cellWidth(cluster) > width ? '…' : cluster
    }
    return [...out, part]
  })
}
export function elapsed(task: TaskSummary, at: number): number {
  const start = task.activeSince ? Date.parse(task.activeSince) : Number.NaN
  return (task.elapsedMs ?? 0) + (Number.isFinite(start) ? Math.max(0, at - start) : 0)
}
export function age(task: TaskSummary, at: number): string {
  const created = task.createdAt ? Date.parse(task.createdAt) : Number.NaN
  return Number.isFinite(created) ? formatDuration(Math.max(0, at - created)) : ''
}

// Перенос по словам; длинное слово режется только по целым графемам.
export function wordLines(value: string, width: number, limit: number): string[] {
  const lines: string[] = []
  const paragraphs = value.replace(/[\t\r]/gu, ' ').trim().split('\n')
  for (let index = 0; index < paragraphs.length; index += 1) {
    let rest = paragraphs[index]!.replace(/ +/gu, ' ').trim()
    // Абзац из одноячеечных знаков режется по индексам; прочий — по графемам, но без разбора всего остатка
    // на каждую строку: описание и комментарии в тысячи знаков переносятся на каждую отрисовку.
    const simple = SINGLE_CELL_TEXT.test(rest)
    do {
      if (lines.length === limit) {
        // Обрезке хватает начала остатка: дальше ширины строки она не смотрит.
        lines[limit - 1] = truncateCells(lines[limit - 1]! + ' ' + (simple ? rest.slice(0, width + 1) : rest) + ' …', width)
        return lines
      }
      let prefix = ''
      if (simple) {
        if (rest.length <= width) { lines.push(rest); break }
        prefix = rest.slice(0, Math.max(0, width))
      } else {
        let prefixWidth = 0
        let fits = true
        for (const cluster of eachGrapheme(rest)) {
          const cells = cellWidth(cluster)
          if (prefixWidth + cells > width) { fits = false; break }
          prefix += cluster
          prefixWidth += cells
        }
        if (fits) { lines.push(rest); break }
      }
      const boundary = prefix.lastIndexOf(' ')
      const cut = boundary > 0 ? boundary : Math.max(1, prefix.length)
      lines.push(rest.slice(0, cut).trimEnd())
      rest = rest.slice(cut).trimStart()
    } while (rest)
  }
  return lines
}
const STATUS = { active: 'в работе', paused: 'в бэклоге', done: 'готово', cancelled: 'отменена' } as const
function cardActions(task: TaskSummary, running: boolean, width: number): CardAction[] {
  const actions: CardAction[] = task.status === 'done' || task.status === 'cancelled'
    ? [{ name: 'restore', label: 'Вернуть' }]
    : task.status === 'paused' ? [{ name: 'restore', label: 'В очередь' }, { name: 'append', label: 'Открыть' }, { name: 'delete', label: 'Удалить' }]
    : running ? [{ name: 'done', label: 'Готово' }, { name: 'defer', label: 'В бэклог' }, { name: 'append', label: 'Дополнить' }]
    : [{ name: 'current', label: 'В работу' }, { name: 'append', label: 'Дополнить' }, { name: 'defer', label: 'В бэклог' }]
  const full = actions.reduce((sum, action) => sum + cellWidth(action.label) + 4, 0) + actions.length - 1
  if (full <= width) return actions
  const compact: Partial<Record<CardActionName, string>> = { defer: 'В бэклог', append: '+ текст' }
  return actions.map(action => ({ ...action, label: compact[action.name] ?? action.label }))
}

export function taskRows(state: Projection, view: TaskView, width: number, at: number, theme: Theme = DEFAULT_THEME, tab: 'agent' | 'backlog' = 'agent'): TaskRow[] {
  const tasks = tab === 'backlog' ? backlogTasks(state) : taskList(state).filter(task => task.status === 'active')
  const cells = Math.max(1, width - 2)
  const inner = Math.max(1, cells - 2)
  const roles = roleColors(theme)
  if (tab === 'agent' && state.snapshot?.tasks.length === 0 && !state.focus?.task) {
    const lines = ['Здесь задачи агента и вопросы к вам.', 'Первая задача: /tasks add <текст>.'].map(line => truncateCells(line, inner))
    return [{ kind: 'empty', id: 'tasks-empty', width: cells, height: 2, lines, text: lines.join('\n') }]
  }
  if (!tasks.length) return [{ kind: 'empty', id: 'tasks-empty', width: cells, height: 3,
    text: truncateCells(state.snapshot ? tab === 'backlog' ? 'Бэклог пуст' : 'Задач пока нет  + Задача' : 'Панель временно недоступна', inner) }]
  const card = (summary: TaskSummary, running = false) => {
    const detail = view.details?.get(summary.taskId)
    const task = detail ? { ...detail, ...summary, description: detail.description, acceptance: detail.acceptance, constraints: detail.constraints } : summary
    const { goal } = splitTaskText(task.description, task.acceptance)
    const context = task.summary || goal
    return taskCard(task, view, width, theme, running, context ? wordLines(context, inner, 8) : [], undefined, roles)
  }
  if (tab === 'backlog') return tasks.map(task => card(task))
  const current = state.focus?.task?.status === 'active' ? state.focus.task.taskId : undefined
  const assignments = workAssignments(tasks, current, view.peers ?? new Map(), at, view.working)
  const inWork = new Set(assignments.map(item => item.taskId))
  const groups: { id: Group; label: string; items: TaskSummary[] }[] = [
    // Задача самого агента стоит первой: по счётчикам её от задач исполнителей не отличить.
    { id: 'now', label: 'В РАБОТЕ', items: [...tasks.filter(task => task.taskId === current && inWork.has(task.taskId)),
      ...tasks.filter(task => task.taskId !== current && inWork.has(task.taskId))] },
    { id: 'queue', label: 'Очередь', items: tasks.filter(task => !inWork.has(task.taskId)) },
  ]
  const rows: TaskRow[] = []
  // ContextSaver/cardBlock + compactRow; заголовки групп из linear-tickets без дерева.
  for (const group of groups) {
    if (!group.items.length) continue
    if (rows.length) rows.push({ kind: 'gap', id: `gap:${group.id}`, width: cells, height: 1, text: '' })
    rows.push({ kind: 'heading', id: `group:${group.id}`, group: group.id, label: group.label,
      width: cells, height: 1, count: group.id === 'queue' ? state.snapshot?.taskCounts?.queued ?? group.items.length : group.items.length, collapsed: false })
    group.items.forEach(summary => {
      const row = card(summary, group.id === 'now')
      row.group = group.id
      row.workers = assignments.find(item => item.taskId === summary.taskId)?.workers ?? []
      // На рамке стоят счётчики значками; кто именно занят, владелец читает в подписи при наведении на них.
      row.workerLabel = workerCaption(row.workers, formatDuration)
      row.shimmer = row.workers.some(worker => worker.state === 'running')
      rows.push(row)
    })
  }
  return rows
}

function taskCard(task: TaskSummary, view: TaskView, width: number, theme: Theme, running: boolean, context: string[], closedTime: string | undefined, roles: ReturnType<typeof roleColors>): TaskCard {
  const cells = Math.max(1, width - 2)
  const inner = Math.max(1, cells - 2)
  const selected = view.cursor === `task:${task.taskId}`
  // На рамке — единое обозначение задачи.
  const number = displayTaskNumber(task.alias)
  const titles = wordLines(task.title.replace(/\s+/gu, ' ').trim(), inner, 4)
  const time = closedTime ? truncateCells(closedTime, inner) : undefined
  // Время закрытия стоит на нижней линии рамки и в высоту карточки не входит; до ширины его обрезает отрисовка.
  const lines = [...titles]
  return { kind: 'card', id: `task:${task.taskId}`, taskId: task.taskId, task: { status: task.status, needsDecision: Boolean(task.needsDecision) },
    discussionCount: task.discussionCount ?? (view.ownerCommentCounts?.get(task.taskId) ?? 0) + (view.notes?.get(task.taskId)?.length ?? 0),
    returnCount: task.returnCount ?? 0,
    width: cells, innerWidth: inner, height: 2 + lines.length, titleLines: titles, number, context: [], lines, ...(time ? { closedTime: time } : {}),
    progress: [], progressCount: '', running, mark: '', status: '', actions: [], actionWidth: 0, statusWidth: inner, steps: [], remainingSteps: 0,
    // В бэклоге выбранной карточки на вид нет: действия стоят на рамке каждой, рамку красит только наведение.
    borderColor: running ? roles.work : selected && task.status !== 'paused' ? theme.fg || 'text' : roles.muted, borderDimColor: !running && !(selected && task.status !== 'paused'),
    selected, shimmer: running && Boolean(view.working), gutterWidth: 0, textWidth: inner, sourceIcon: '',
    priorityColor: roles.muted, priorityDim: true, priorityLabel: '', actionsBelow: false, actionRows: [], detailActions: [],
    details: context, detailReady: typeof task.description === 'string', expanded: false, controls: [] }
}

export function historyList(state: Projection, view: TaskView, closed: TaskContextEntry[] = []): TaskSummary[] {
  const tasks = new Map((state.snapshot?.tasks ?? []).map(task => [task.taskId, task]))
  if (state.focus?.task) tasks.set(state.focus.task.taskId, state.focus.task)
  // Контекст несёт только ссылки: до ленивого task.get статус и дата ещё неизвестны.
  for (const entry of closed) if (!tasks.has(entry.taskId)) tasks.set(entry.taskId, view.details?.get(entry.taskId) ?? {
    ...entry, status: 'done', revision: -1, certainty: 'verified', certaintySource: 'agent', certaintyProvenance: 'tool',
  })
  return [...tasks.values()].map(task => {
    const detail = view.details?.get(task.taskId)
    return detail ? { ...task, ...(detail.revision >= task.revision ? detail : {}), description: detail.description } : task
  }).filter(task => task.status === 'done' && task.stage !== 'candidate' && !task.deleted)
    .sort((a, b) => closedAt(b) - closedAt(a) || b.alias.localeCompare(a.alias, undefined, { numeric: true }))
}

function closedAt(task: TaskSummary): number {
  if (task.revision === -1) return Number.MAX_SAFE_INTEGER
  const at = Date.parse(task.closedAt ?? task.updatedAt ?? '')
  return Number.isFinite(at) ? at : 0
}

function dayLabel(date: Date, now: number): string {
  const day = wallTime(date), today = wallTime(now)
  return sameDay(day, today) ? 'Сегодня' : sameDay(day, dayBefore(today)) ? 'Вчера' : `${twoDigits(day.day)}.${twoDigits(day.month)}.${day.year}`
}

export function historyRows(state: Projection, view: TaskView, width: number, at: number, theme: Theme = DEFAULT_THEME, closed: TaskContextEntry[] = []): TaskRow[] {
  const tasks = historyList(state, view, closed)
  const cells = Math.max(1, width - 2)
  const inner = Math.max(1, cells - 2)
  const roles = roleColors(theme)
  if (!tasks.length) return [{ kind: 'empty', id: 'history-empty', width: cells, height: 3, text: truncateCells('Закрытых задач пока нет', inner) }]
  const rows: TaskRow[] = []
  let day = ''
  for (const task of tasks) {
    if (task.revision === -1) {
      rows.push({ kind: 'empty', id: `task:${task.taskId}`, taskId: task.taskId, width: cells, height: 3, text: truncateCells('Загрузка задачи…', inner) })
      continue
    }
    const date = new Date(task.closedAt ?? task.updatedAt ?? '')
    const valid = Number.isFinite(date.getTime())
    const label = valid ? dayLabel(date, at) : 'Дата неизвестна'
    if (day !== label) {
      // Плотность как в списке задач: пустая строка только между днями, карточки внутри дня идут подряд.
      if (rows.length) rows.push({ kind: 'gap', id: `gap:${label}`, width: cells, height: 1, text: '' })
      day = label; rows.push({ kind: 'day', id: `day:${label}`, width: cells, height: 1, label })
    }
    const result = (view.notes?.get(task.taskId) ?? []).filter(note => note.kind === 'result').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    const fallback = task.summary || splitTaskText(task.description, task.acceptance).goal
    const context = result?.text.trim() || fallback
    const row = taskCard(task, view, width, theme, false, context ? wordLines(context, inner, 8) : [], valid ? relativeTime(date, at) : undefined, roles)
    if (valid && (task.elapsedMs ?? 0) >= 1000) row.closedSpent = formatDuration(task.elapsedMs!)
    rows.push(row)
  }
  return rows
}
// Переносы и догрузка меняют положение рядов. Сохраняем конец либо верхний ряд и его срез;
// явное изменение offset колесом или клавишами отменяет прежнее закрепление.
export function restoreWindow(rows: TaskRow[], view: TaskView): void {
  const window = view.window
  if (!window || window.offset !== view.offset) return
  if (window.atEnd) {
    view.offset = Math.max(0, rows.reduce((sum, row) => sum + row.height, 0) - view.limit)
    return
  }
  const index = rows.findIndex(row => row.id === window.rowId)
  if (index >= 0) view.offset = rows.slice(0, index).reduce((sum, row) => sum + row.height, 0)
    + Math.min(window.inset, Math.max(0, rows[index]!.height - 1))
}

export function rowsProps(rows: TaskRow[], view: TaskView, theme: Theme = DEFAULT_THEME, plain = false): TaskCardsProps {
  const totalHeight = rows.reduce((sum, row) => sum + row.height, 0)
  view.offset = Math.max(0, Math.min(view.offset, Math.max(0, totalHeight - view.limit)))
  const height = Math.min(view.limit, totalHeight)
  let start = 0
  const visible = rows.filter(row => {
    const intersects = start + row.height > view.offset && start < view.offset + height
    start += row.height
    return intersects
  })
  const first = rows.indexOf(visible[0]!)
  const before = rows.slice(0, Math.max(0, first)).reduce((sum, row) => sum + row.height, 0)
  const max = totalHeight - height
  const size = Math.max(1, Math.round(height * height / Math.max(1, totalHeight)))
  // Снимок обновляется и при прокрутке: восстановление относится к фактически показанному окну.
  // Если весь список временно поместился, помним прежний конец для обратного уменьшения окна.
  const atEnd = max > 0 ? view.offset === max : Boolean(view.window?.atEnd)
  view.window = { offset: view.offset, atEnd, rowId: visible[0]?.id, inset: view.offset - before }
  // Окно режет целый Box, а не его рамку/детали по отдельности.
  return { rows: visible, width: (rows[0]?.width ?? 0) + 2, height, viewportHeight: view.limit, theme, ...(plain ? { plain } : {}), top: before - view.offset, totalHeight, offset: view.offset,
    ...(max > 0 ? { bar: { pos: Math.round(view.offset / max * (height - size)), size } } : {}) }
}
export function moveCursor(rows: TaskRow[], view: TaskView, key: string): void {
  const choices = rows.filter(row => row.taskId)
  if (!choices.length) return
  let index = choices.findIndex(row => row.id === view.cursor)
  const direction = ['up', 'k', 'pageup'].includes(key) ? -1 : 1
  index = key === 'home' || key === 'g' ? 0 : key === 'end' || key === 'G' ? choices.length - 1
    : Math.max(0, Math.min(choices.length - 1, index + direction))
  if (key.startsWith('page')) {
    let crossed = choices[index]!.height
    while (crossed < view.limit && index + direction >= 0 && index + direction < choices.length) {
      index += direction; crossed += choices[index]!.height
    }
  }
  view.cursor = choices[index]!.id
  revealCursor(rows, view)
}
export function revealCursor(rows: TaskRow[], view: TaskView): void {
  const chosen = rows.find(row => row.id === view.cursor)
  if (!chosen) return
  const at = rows.slice(0, rows.indexOf(chosen)).reduce((sum, row) => sum + row.height, 0)
  const height = chosen.height
  if (at < view.offset || height > view.limit) view.offset = at
  else if (at + height > view.offset + view.limit) view.offset = at + height - view.limit
}
export function keepCursorInWindow(rows: TaskRow[], view: TaskView): void {
  const window = rowsProps(rows, view)
  if (window.rows.some(row => row.taskId && row.id === view.cursor)) return
  let top = 0
  const full = rows.find(row => {
    const visible = row.taskId && top >= view.offset && top + row.height <= view.offset + view.limit
    top += row.height
    return visible
  })
  const first = full ?? window.rows.find(row => row.taskId)
  view.cursor = first?.id ?? ''
}

// Кадры лоадера и блика считает клиентский движок рядов.
// pause — знак простоя перед названием: значок шрифта или запасной символ, без слова.
export function bandRow(state: Projection, width: number, at: number, theme: Theme = DEFAULT_THEME, working = false, pause = '⧖'): RowSpec | null {
  const current = state.focus?.task
  if (!current || current.status !== 'active' || !visibleTask(current)) return null
  const queued = state.snapshot?.taskCounts?.queued ?? taskList(state).filter(task => task.taskId !== current.taskId && task.status === 'active' && !task.needsDecision
    && !state.snapshot?.focusStack.some(frame => frame.taskId === task.taskId)).length
  const waiting = working ? '' : truncateCells(`${pause} `, Math.max(0, width - 1))
  const right = queued ? truncateCells(`  в очереди ${queued}`, Math.max(1, width - (working ? 3 : cellWidth(waiting) + 1))) : ''
  const available = Math.max(1, width - cellWidth(right) - (working ? 2 : cellWidth(waiting)))
  const roles = roleColors(theme)
  // Цвет «в работе» — у текущей задачи всегда; блик — только пока идёт ход. Так же окрашены карточки группы «В РАБОТЕ».
  return { id: '', left: [...(working ? [{ t: '', spin: true, c: roles.work }, { t: ' ' }] : []),
    ...(working ? [] : [{ t: waiting, c: roles.work }]),
    { t: truncateCells(`${displayTaskNumber(current.alias)} ${current.title.replace(/\s+/gu, ' ').trim()}`, available), b: true, ...(working ? { sh: 'task' } : { c: roles.work }) }],
    right: [{ t: right, c: roles.muted }] }
}

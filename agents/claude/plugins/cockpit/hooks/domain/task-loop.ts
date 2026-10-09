import type { TaskContext, TaskContextEntry, TaskLoopState } from '../../types/index'
import { redactSecrets, stripPastedContent } from './privacy'
import { validId } from './rpc'
import { splitTaskText } from './task-text.ts'
import { clean, cleanOwnerBody, ownerBodyError, plain } from '../owner/text'
import { looksSecret } from '../owner/tasks'
import { workerName, type WorkAssignment } from './peer-work'
import { displayTaskNumber, taskAliasFor } from './task-number.ts'

export interface TaskLoop {
  cursor?: number
  // Текущая задача, которую агент видел последней; undefined — ещё не видел никакой.
  shown?: string | null
  comments: Map<string, number>
  ownerNotes: Set<string>
  turn: string | null
  worked: boolean
  updated: boolean
  reminder: string | null
  reminded: boolean
  // Состав или содержание задач изменились после последней перестановки: порядок очереди пора сверить.
  rankDue?: boolean
}

export function newTaskLoop(saved?: unknown): TaskLoop {
  const loop: TaskLoop = { comments: new Map(), ownerNotes: new Set(), turn: null, worked: false, updated: false, reminder: null, reminded: false }
  const revision = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (!record(saved) || Object.keys(saved).some(key => !['cursor', 'shown', 'comments', 'ownerNotes', 'updated'].includes(key))
    || (saved.cursor !== undefined && !revision(saved.cursor))
    || (saved.shown !== undefined && saved.shown !== null && (typeof saved.shown !== 'string' || !validId(saved.shown)))
    || !Array.isArray(saved.comments) || !saved.comments.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && validId(pair[0]) && revision(pair[1]))
    || new Set(saved.comments.map(pair => pair[0])).size !== saved.comments.length
    || !Array.isArray(saved.ownerNotes) || !saved.ownerNotes.every(id => typeof id === 'string' && validId(id))
    || typeof saved.updated !== 'boolean') return loop
  loop.cursor = saved.cursor as number | undefined
  loop.shown = saved.shown as string | null | undefined
  loop.comments = new Map(saved.comments as [string, number][])
  loop.ownerNotes = new Set(saved.ownerNotes as string[])
  loop.updated = saved.updated
  return loop
}

export function taskLoopState(loop: TaskLoop): TaskLoopState {
  return { ...(loop.cursor === undefined ? {} : { cursor: loop.cursor }), ...(loop.shown === undefined ? {} : { shown: loop.shown }),
    comments: [...loop.comments], ownerNotes: [...loop.ownerNotes], updated: loop.updated }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function cleanTaskText(text: string): string { return redactSecrets(stripPastedContent(text)).trim() }
function text(value: unknown, limit: number): string | null {
  return typeof value === 'string' && [...value.trim()].length > 0 && [...value.trim()].length <= limit ? cleanTaskText(value) : null
}

export function parseTaskAdd(raw: Record<string, unknown>): { tasks: { title: string; description?: string; place?: 'top' | 'bottom' }[]; start?: true } | { error: string } {
  // start относится к вызову, а не к задаче: в рантайм он не уходит.
  const { start, ...args } = raw
  if (start !== undefined && typeof start !== 'boolean') return { error: 'start: true или false.' }
  const input = args.tasks === undefined ? [args] : args.tasks
  if (!Array.isArray(input) || input.length < 1 || input.length > 20 || (args.tasks !== undefined && ['title', 'description', 'acceptance', 'place'].some(key => args[key] !== undefined))) {
    return { error: 'Передай одну задачу через title или пачку tasks из 1–20 задач. Остальные поручения запиши следующей пачкой.' }
  }
  const tasks: { title: string; description?: string; place?: 'top' | 'bottom' }[] = []
  for (const item of input) {
    if (!record(item)) return { error: 'Каждая задача должна содержать title и, при необходимости, description и acceptance.' }
    if (item.place !== undefined && item.place !== 'top' && item.place !== 'bottom') return { error: 'place: top или bottom; по умолчанию bottom.' }
    const title = text(item.title, 80)
    if (!title || /[\r\n]/u.test(title) || [...title].length > 80) return { error: 'Название должно содержать 1–80 знаков одной строкой, в повелительном наклонении.' }
    const description = item.description === undefined ? '' : text(item.description, 4000)
    const acceptance = item.acceptance === undefined ? '' : text(item.acceptance, 1000)
    if (description === null || acceptance === null) return { error: 'Описание должно содержать до 4000 знаков, критерий готовности — до 1000; передавай непустой текст без секретов.' }
    const combined = [description, acceptance ? `Готово, когда: ${acceptance}` : ''].filter(Boolean).join('\n\n')
    if ([...combined].length > 4000) return { error: 'Описание вместе с критерием готовности должно помещаться в 4000 знаков. Сократи текст.' }
    tasks.push({ title, ...(combined ? { description: combined } : {}), ...(item.place === undefined ? {} : { place: item.place }) })
  }
  return { tasks, ...(start ? { start: true as const } : {}) }
}

export function parseTaskRank(args: Record<string, unknown>): { order: string[] } | { error: string } {
  if (!Array.isArray(args.order) || args.order.length < 1 || args.order.length > 30
    || !args.order.every(item => typeof item === 'string' && (validId(item) || taskAliasFor(item) !== null)) || new Set(args.order).size !== args.order.length) {
    return { error: 'order: от 1 до 30 разных taskId или номеров #N открытых задач очереди, от самых важных. Текущую и задачи бэклога не переставляй.' }
  }
  return { order: [...args.order] }
}

export type AgentCommand = 'task_start' | 'task_done' | 'task_defer' | 'task_note'
export function parseTaskAction(command: AgentCommand, args: Record<string, unknown>): { target?: string; note?: string; next?: string; review?: string; result?: string } | { error: string } {
  const next = command !== 'task_done' || args.next === undefined ? undefined : typeof args.next === 'string' ? args.next.trim() : ''
  if (next !== undefined && !validId(next) && taskAliasFor(next) === null) return { error: 'next: taskId или номер #N следующей задачи.' }
  const target = args.taskId === undefined ? undefined : typeof args.taskId === 'string' ? args.taskId.trim() : ''
  if ((target !== undefined && !validId(target) && taskAliasFor(target) === null) || (command === 'task_start' && target === undefined)) return { error: 'Укажи taskId или номер #N из mcp__cockpit__task_list.' }
  let review: string | undefined
  let result: string | undefined
  if (command === 'task_done') {
    if (args.result !== undefined) {
      if (typeof args.result !== 'string' || !args.result.trim() || [...args.result.trim()].length > 60 || /[\r\n]/u.test(args.result)) {
        return { error: 'result: что сделано, 1–60 знаков одной строкой.' }
      }
      result = clean(args.result)
      if (!result || !plain(result) || looksSecret(args.result)) return { error: 'result: допустимый текст карточки без секретов.' }
    }
    if (typeof args.review !== 'string' || args.review.trim() === '') {
      return { error: 'Укажи обязательный параметр review: что проверить владельцу (до 300 знаков) или "none", если проверка не нужна.' }
    }
    const rawReview = args.review.trim()
    if (rawReview === 'none') {
      review = 'none'
    } else {
      const cleaned = text(args.review, 300)
      if (cleaned === null) {
        return { error: 'review: непустой текст до 300 знаков (что проверить владельцу) или "none", если проверка не нужна.' }
      }
      const error = ownerBodyError(cleaned, 'review')
      if (error) return { error }
      review = cleanOwnerBody(cleaned)
    }
  }
  const field = command === 'task_done' ? 'summary' : command === 'task_defer' ? 'reason' : 'note'
  const note = command === 'task_start' || (command === 'task_done' && args.summary === undefined) ? undefined : text(args[field], command === 'task_done' ? 500 : 1000)
  if (note === null) return { error: command === 'task_done' ? 'summary: одна-две строки до 500 знаков.' : `${field}: нужен непустой текст до 1000 знаков.` }
  return { ...(target === undefined ? {} : { target }), ...(note === undefined ? {} : { note }), ...(next === undefined ? {} : { next }), ...(review === undefined ? {} : { review }), ...(result === undefined ? {} : { result }) }
}

export function resolveTask(context: TaskContext, target?: string): string | null {
  if (target === undefined) return context.current?.taskId ?? null
  const entries = [context.current, ...context.queue, ...context.deferred, ...context.closed]
  const alias = taskAliasFor(target)
  const entry = entries.find(item => item?.taskId === target) ?? entries.find(item => item && item.alias === alias)
  return entry?.taskId ?? (alias !== null || /^TASK-/iu.test(target) || target.startsWith('#') ? null : target)
}

export function clipWords(value: string, limit: number): string {
  const clean = cleanTaskText(value).replace(/\s+/gu, ' ')
  if (clean.length <= limit) return clean
  const prefix = clean.slice(0, Math.max(0, limit - 1))
  const boundary = prefix.lastIndexOf(' ')
  return (boundary > 0 ? prefix.slice(0, boundary) : prefix.replace(/[\uD800-\uDBFF]$/u, '')).trimEnd() + '…'
}

const CHANGE_LABELS: Record<TaskContext['ownerChanges'][number]['action'], string> = {
  created: 'поставлена', edited: 'изменена', reordered: 'переставлена', deferred: 'в бэклоге', deleted: 'удалена', reopened: 'открыта снова', noted: 'заметка владельца', completed: 'закрыта', current: 'взята в работу', restored: 'возвращена', step: 'изменён шаг', commented: 'новый комментарий', 'comment-edited': 'правка комментария', 'comment-deleted': 'комментарий удалён',
}

// Реплика, которой мод продолжает работу после ручного сжатия. Она уходит от имени мода, а не словами владельца:
// продолжение не должно читаться как его согласие на то, что ждало решения или подтверждения.
// Свободного текста задач в ней нет: название пишут и агент, и чужие данные, а реплику агент читает как указание.
// Обозначение задачи строится лишь из проверенного псевдонима с ограниченной длиной номера.
export function compactResume(alias: string): string {
  const task = /^TASK-[1-9]\d{0,8}$/u.test(alias) ? ` ${displayTaskNumber(alias)}` : ''
  return `Сжатие контекста завершено. По настройке владельца работа идёт дальше без его реплики: продолжай текущую задачу${task} с того места, где остановился. `
    + 'Это сообщение мода Cockpit, а не владельца: оно ничего не разрешает и не отвечает на вопрос, которого ты ждал; отклонённое владельцем действие в прежнем виде не повторяй.'
}
// Сколько мод ждёт после сжатия, прежде чем продолжить работу сам. Движок, закончив сжатие, разбирает очередь:
// реплика, набранная владельцем за время сжатия, или уведомление фоновой команды начинают ход через 0,2–3 с
// (журнал сессии 06–07.10.2026, восемь ручных сжатий). Реплика мода, отправленная сразу, вставала за ними,
// висела в очереди весь ход, а после него продолжала уже закрытую задачу.
export const RESUME_SETTLE_MS = 10_000
// Уведомление владельцу о том, что мод продолжил работу: одна короткая строка, обозначение по тому же правилу, что в реплике.
export function compactResumeToast(alias: string): string {
  return `Сжатие завершено, продолжаю ${/^TASK-[1-9]\d{0,8}$/u.test(alias) ? displayTaskNumber(alias) : 'текущую задачу'}.`
}

export const RANK_DUE = 'Задачи изменились: сверь порядок очереди с важностью и вызови mcp__cockpit__task_rank в этом же ходе — даже если порядок остаётся прежним.'

export function taskDigest(context: TaskContext, loop: TaskLoop, full = false, work: WorkAssignment[] = []): { text: string; cursor?: number; comments: [string, number][]; notes: string[]; current: string | null } {
  const limit = full ? 6000 : 1500
  const lines: string[] = []
  if (!full && loop.reminder) lines.push(clipWords(loop.reminder, 180))
  const inWork = work.filter(item => displayTaskNumber(item.alias)).map(item => `${displayTaskNumber(item.alias)} ${item.workers.map(worker =>
    `${workerName(worker.agent)} ${worker.state === 'running' ? 'идёт' : worker.agent === 'agent' ? 'ждёт хода' : 'ждёт сверки'}`).join(', ')}`)
  if (inWork.length) lines.push(`В работе: ${clipWords(inWork.join('; '), full ? 1200 : 400)}`)
  const current = context.current
  if (current) {
    const { goal, criteria } = splitTaskText(current.description, current.acceptance)
    lines.push(`Текущая ${displayTaskNumber(current.alias)}: ${clipWords(current.title, 90)}`)
    if ((current.returnCount ?? 0) > 0) lines.push(`Возвратов: ${current.returnCount}.`)
    if (goal) lines.push(`Описание: ${clipWords(goal, full ? 900 : 190)}`)
    if (criteria.length) lines.push(`Готово: ${clipWords(criteria.join('; '), full ? 700 : 160)}`)
    if (current.constraints.length) lines.push(`Ограничения: ${clipWords(current.constraints.join('; '), 120)}`)
  }
  const entries: TaskContextEntry[] = [current, ...context.queue, ...context.deferred, ...context.closed].filter((item): item is TaskContextEntry => item !== null)
  const ownerLines: { line: string; eventId: number }[] = context.ownerChanges.slice(0, full ? 100 : 3).map(change => ({
    line: `Владелец: ${displayTaskNumber(entries.find(item => item.taskId === change.taskId)?.alias ?? '') || change.taskId} — ${CHANGE_LABELS[change.action]}.`, eventId: change.eventId,
  }))
  const comments = (current?.ownerComments ?? []).filter(comment => loop.comments.get(comment.commentId) !== comment.revision)
    .slice(0, full ? 100 : 2).map(comment => ({ line: `Комментарий владельца: ${clipWords(comment.text, full ? 700 : 150)}`, id: comment.commentId, revision: comment.revision }))
  const notes = (current?.ownerNotes ?? []).filter(note => !loop.ownerNotes.has(note.checkpointId)).slice(0, full ? 100 : 1)
    .map(note => ({ line: `Заметка владельца: ${clipWords(note.text, full ? 500 : 100)}`, id: note.checkpointId }))
  lines.push(...comments.map(item => item.line), ...notes.map(item => item.line), ...ownerLines.map(item => item.line))
  const queueLines = context.queue.slice(0, full ? 30 : 5).map(item => `${displayTaskNumber(item.alias)}: ${clipWords(item.title, full ? 100 : 65)}${item.priorityPinned ? ' (закреплена)' : ''}${(item.returnCount ?? 0) > 0 ? ` (возвратов: ${item.returnCount})` : ''}`)
  if (queueLines.length) lines.push('Очередь:', ...queueLines)
  // Любое изменение задач, кроме самой перестановки, может поменять порядок: напоминание держится, пока агент не переставит очередь.
  if (context.ownerChanges.some(change => change.action !== 'reordered')) loop.rankDue = true
  const rankReminder = loop.rankDue && context.queue.length > 1 ? RANK_DUE : ''
  if (full && context.closed.length) lines.push('Недавно закрыты:', ...context.closed.map(item => `${displayTaskNumber(item.alias)}: ${clipWords(item.title, 90)}`))
  const countsLine = context.counts.total || loop.reminder || context.ownerChanges.length
    ? `Открыто: ${context.counts.open} (в проекте ${context.counts.projectOpen}); в очереди: ${context.counts.queued}; в бэклоге: ${context.counts.deferred}; закрыто за сутки: ${context.counts.closedLast24h}.` : ''
  const moreLine = (shown: number) => `Ещё ${context.counts.queued - shown} в очереди: mcp__cockpit__task_list({ show: "queue", offset: ${shown} }).`
  // Счётчики и напоминание о порядке не теряются за длинными новостями. Переход к следующей странице очереди стоит
  // только в полной сводке: в напоминании на каждую реплику он повторял бы строку счётчиков.
  const reserved = [rankReminder, countsLine, full && context.counts.queued ? moreLine(0) : ''].filter(Boolean).join('\n').length + 3
  const bodyLimit = limit - reserved
  // Строки новостей, не поместившиеся целиком, остаются непрочитанными.
  let output = ''
  const visible = new Set<string>()
  for (const line of lines) {
    const room = bodyLimit - output.length - (output ? 1 : 0)
    if (room <= 1) break
    const shown = line.length <= room ? line : clipWords(line, room)
    output += (output ? '\n' : '') + shown
    if (shown === line) visible.add(line)
    else break
  }
  const shownQueue = queueLines.filter(line => visible.has(line)).length
  const footer = [rankReminder, countsLine, full && context.counts.queued > shownQueue ? moreLine(shownQueue) : ''].filter(Boolean).join('\n')
  if (footer) output += (output ? '\n' : '') + footer
  const shownEvents = ownerLines.filter(item => visible.has(item.line))
  return { text: output, cursor: context.ownerChanges.length === 0 ? context.cursor : shownEvents.at(-1)?.eventId ?? loop.cursor,
    comments: comments.filter(item => visible.has(item.line)).map(item => [item.id, item.revision]), notes: notes.filter(item => visible.has(item.line)).map(item => item.id),
    current: current?.taskId ?? null }
}

export function acceptDigest(loop: TaskLoop, digest: ReturnType<typeof taskDigest>, consumeReminder = true): void {
  loop.cursor = digest.cursor
  loop.shown = digest.current
  for (const [id, revision] of digest.comments) loop.comments.set(id, revision)
  for (const id of digest.notes) loop.ownerNotes.add(id)
  if (consumeReminder) loop.reminder = null
}

export function completeTaskTurn(loop: TaskLoop, current: TaskContext['current']): void {
  if (!loop.worked || loop.updated) {
    loop.reminded = false
    if (loop.updated) loop.reminder = null
    return
  }
  if (loop.reminded) return
  loop.reminder = current ? `Текущая задача «${clipWords(current.title, 80)}» не обновлялась за прошлый ход: закрой, отправь в бэклог или оставь заметку.` : 'Работа шла без задачи: запиши её mcp__cockpit__task_add.'
  loop.reminded = true
}

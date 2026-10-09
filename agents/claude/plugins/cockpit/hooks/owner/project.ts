// Слоты сессий и принятие задач перенесены из Human in the loop.
import type { OwnerTask as Task } from '../../types'
import { isShown, looksSecret, MAX_TITLE, MAX_REASON, sameAsk } from './tasks'
import { clean, mixesScripts, plain } from './text'

export const HEARTBEAT_MS = 60_000

export const STALE_MS = 3 * 60_000

export type Slot = {
  tasks: Task[]
  seenMs: number
  endedMs?: number
}

export type Stored = { nextId: number; sessions: Record<string, Slot> }

export function storedOf(raw: unknown): Stored {
  const value = (raw ?? {}) as { nextId?: unknown; sessions?: unknown; tasks?: unknown }
  const nextId = typeof value.nextId === 'number' && Number.isSafeInteger(value.nextId) && value.nextId >= 1 ? value.nextId : 1

  const sessions: Record<string, Slot> = {}

  if (value.sessions !== null && typeof value.sessions === 'object' && !Array.isArray(value.sessions)) {
    // Слот неверной формы отбрасывается целиком: его задачи некому показать.
    for (const [id, slot] of Object.entries(value.sessions as Record<string, unknown>)) {
      if (slot === null || typeof slot !== 'object') continue
      const raw = slot as { tasks?: unknown; seenMs?: unknown; endedMs?: unknown }
      if (!Array.isArray(raw.tasks) || typeof raw.seenMs !== 'number') continue
      sessions[id] = { tasks: raw.tasks as Task[], seenMs: raw.seenMs, ...(typeof raw.endedMs === 'number' ? { endedMs: raw.endedMs } : {}) }
    }
    return { nextId, sessions }
  }

  for (const task of Array.isArray(value.tasks) ? (value.tasks as unknown[]) : []) {
    if (task === null || typeof task !== 'object' || typeof (task as { sessionId?: unknown }).sessionId !== 'string') continue
    const slot = (sessions[(task as Task).sessionId] ??= { tasks: [], seenMs: 0, endedMs: 0 })
    slot.tasks.push(task as Task)
  }

  return { nextId, sessions }
}

export function isGone(slot: Slot, nowMs: number): boolean {
  return slot.endedMs !== undefined || nowMs - slot.seenMs > STALE_MS
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

// Хранилище — файл на диске, его может записать любой процесс пользователя. Форма записи
// проверяется, а ответ и отказ из файла не считаются данными владельцем: задача снова открыта.
function restored(value: unknown): { task: Task; draft?: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || raw.id < 1 || typeof raw.sessionId !== 'string') return null
  if (raw.kind !== 'do' && raw.kind !== 'answer' && raw.kind !== 'choose') return null
  if (raw.state !== 'open' && raw.state !== 'done' && raw.state !== 'rejected') return null
  // Сначала очистка, потом проверка: иначе после очистки остаётся пустая или недопустимая строка.
  const field = (source: unknown, max: number) => {
    const cleaned = typeof source === 'string' ? clean(source) : ''
    return text(cleaned, max) && plain(cleaned) ? cleaned : null
  }
  const title = field(raw.title, MAX_TITLE)
  const why = field(raw.why, 300)
  const doneWhen = raw.doneWhen === undefined ? undefined : field(raw.doneWhen, 300)
  const taskAlias = raw.taskAlias === undefined ? undefined : field(raw.taskAlias, 30)
  const taskTitle = raw.taskTitle === undefined ? undefined : field(raw.taskTitle, 300)
  const result = raw.result === undefined ? undefined : field(raw.result, 60)
  if (title === null || why === null || doneWhen === null || taskAlias === null || taskTitle === null || result === null
    || raw.result !== undefined && (typeof raw.result !== 'string' || /[\r\n]/u.test(raw.result) || looksSecret(raw.result))) return null
  const options = raw.kind !== 'choose' ? [] : Array.isArray(raw.options) && raw.options.length >= 2 && raw.options.length <= 4
    ? raw.options.map(option => field(option, 60)) : [null]
  if (options.some((option, i) => option === null || mixesScripts(option) || options.some((other, j) => j < i && other !== null && sameAsk(option, other)))) return null
  const stamp = (at: unknown) => typeof at === 'number' && Number.isFinite(at) ? at : 0
  const task: Task = {
    id: raw.id, title, why, kind: raw.kind, state: 'open', update: 'none', sessionId: raw.sessionId,
    createdMs: stamp(raw.createdMs), updatedMs: stamp(raw.updatedMs),
    ...(doneWhen === undefined ? {} : { doneWhen }),
    ...(taskAlias === undefined ? {} : { taskAlias }),
    ...(taskTitle === undefined ? {} : { taskTitle }),
    ...(result === undefined ? {} : { result }),
    ...(raw.kind === 'choose' ? { options: options.filter((option): option is string => option !== null) } : {}),
  }
  // Прежняя причина остаётся черновиком ответа, если владелец ещё не набрал ответ.
  const draft = typeof raw.answer === 'string' && raw.answer.trim() !== '' ? raw.answer.slice(0, 20000)
    : typeof raw.reason === 'string' && raw.reason.trim() !== '' ? raw.reason.slice(0, MAX_REASON) : undefined
  return { task, ...(draft === undefined ? {} : { draft }) }
}

export function adopt(stored: Stored, sessionId: string, nowMs: number): { adopted: Task[]; drafts: Map<number, string>; stored: Stored } {
  const adopted: Task[] = []
  const drafts = new Map<number, string>()
  const sessions: Record<string, Slot> = {}

  for (const [id, slot] of Object.entries(stored.sessions)) {
    if (id === sessionId || isGone(slot, nowMs)) {
      for (const entry of Array.isArray(slot.tasks) ? slot.tasks : []) {
        const read = restored(entry)
        if (read === null || adopted.some(task => task.id === read.task.id)) continue
        adopted.push(read.task)
        if (read.draft !== undefined) drafts.set(read.task.id, read.draft)
      }
    } else {
      sessions[id] = slot
    }
  }

  adopted.sort((a, b) => a.id - b.id)

  // Счётчик номеров не отстаёт от принятых задач: иначе новая задача получит уже занятый номер.
  const nextId = adopted.reduce((max, task) => Math.max(max, task.id + 1), stored.nextId)
  return { adopted, drafts, stored: { ...stored, nextId, sessions } }
}

export function withSlot(stored: Stored, sessionId: string, tasks: readonly Task[], nowMs: number): Stored {
  const sessions = { ...stored.sessions }
  const shown = tasks.filter(isShown)

  if (shown.length === 0) {
    delete sessions[sessionId]
  } else {
    sessions[sessionId] = { tasks: shown, seenMs: nowMs }
  }

  return { ...stored, sessions }
}

export function endSlot(stored: Stored, sessionId: string, nowMs: number): Stored {
  const slot = stored.sessions[sessionId]

  return slot === undefined ? stored : { ...stored, sessions: { ...stored.sessions, [sessionId]: { ...slot, endedMs: nowMs } } }
}

export function elsewhereIn(stored: Stored, sessionId: string, nowMs: number): number {
  return Object.entries(stored.sessions)
    .filter(([id, slot]) => id !== sessionId && !isGone(slot, nowMs))
    .reduce((sum, [, slot]) => sum + slot.tasks.filter(task => restored(task) !== null && isShown(task)).length, 0)
}

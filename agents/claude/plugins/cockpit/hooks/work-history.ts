import type { AgentTaskNote, Checkpoint, OwnerComment, Task, TaskContext } from '../types'

export type WorkAuthor = 'owner' | 'agent' | 'system'
export type WorkState = { word: string; role: 'ok' | 'fail' }
export type WorkEntry = {
  id: string; kind: string; source?: string; executor?: string; text: string; createdAt: string
  revision?: number; commentId?: string; state?: WorkState
}
export type OwnerChange = TaskContext['ownerChanges'][number]

export const WORK_GLYPHS = {
  owner: { nerd: '\u{f0004}', plain: 'я' }, // md-account
  agent: { nerd: '\u{f06a9}', plain: 'а' }, // md-robot
  system: { nerd: '\u{f0493}', plain: '·' }, // md-cog
} as const

// Вид автоматической записи важнее источника действия, запустившего переход.
export function workAuthor(entry: Pick<WorkEntry, 'kind' | 'source'>): WorkAuthor {
  if (['state', 'completed', 'cancelled', 'deferred', 'deleted', 'reopened', 'restored', 'current', 'detour', 'return', 'step', 'reordered'].includes(entry.kind)) return 'system'
  if (!['comment', 'answer', 'edit', 'edited', 'created', 'note', 'result', 'commit', 'tests-passed', 'noted', 'comment-edited', 'comment-deleted'].includes(entry.kind)) return 'system'
  if (entry.source === 'user') return 'owner'
  if (entry.source === 'agent' || entry.source === 'claude') return 'agent'
  if (entry.source !== undefined) return 'system'
  return ['comment', 'answer', 'edit', 'edited', 'created', 'comment-edited', 'comment-deleted'].includes(entry.kind) ? 'owner' : 'agent'
}

// Удаляем терминальные команды целиком, затем управляющие коды; абзацы сохраняются.
export function cleanWorkText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/\t/gu, ' ')
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c|$)/gu, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b[ -/]*[@-~]/gu, '')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, char => char === '\n' ? char : '')
}

const CHANGE_TEXT: Record<OwnerChange['action'], string> = {
  created: 'Задача создана', edited: 'Задача изменена', reordered: 'Порядок задачи изменён',
  deferred: 'Задача перенесена в бэклог', deleted: 'Задача удалена', reopened: 'Задача открыта снова',
  noted: 'Добавлена заметка владельца', completed: 'Задача закрыта', current: 'Задача взята в работу',
  restored: 'Задача возвращена в очередь', step: 'Состояние шага изменено',
  commented: 'Добавлен комментарий', 'comment-edited': 'Комментарий изменён', 'comment-deleted': 'Комментарий удалён',
}

export function workEntries(task: Task, comments: OwnerComment[], notes: AgentTaskNote[], checkpoints: Checkpoint[], changes: OwnerChange[]): WorkEntry[] {
  const entries: WorkEntry[] = comments.map(comment => ({ id: `comment:${comment.commentId}`, kind: 'comment', source: 'user',
    text: comment.text, createdAt: comment.createdAt, revision: comment.revision, commentId: comment.commentId }))
  for (const note of notes.filter(note => note.taskId === task.taskId)) {
    entries.push({ id: `note:${note.noteId}`, kind: note.kind, source: note.source, text: note.text, createdAt: note.createdAt })
    // Рантайм создаёт result только внутри подтверждённого закрытия агентом.
    if (note.kind === 'result') entries.push({ id: `completed:${note.noteId}`, kind: 'completed', text: 'Задача закрыта',
      createdAt: note.createdAt, state: { word: 'закрыта', role: 'ok' } })
  }
  const marks = new Map(checkpoints.filter(mark => mark.taskId === task.taskId).map(mark => [mark.checkpointId, mark]))
  if (task.lastCheckpoint?.taskId === task.taskId && !marks.has(task.lastCheckpoint.checkpointId)) marks.set(task.lastCheckpoint.checkpointId, task.lastCheckpoint)
  for (const mark of marks.values()) entries.push({ id: `checkpoint:${mark.checkpointId}`, kind: mark.kind, source: mark.source,
    ...(mark.source === 'claude' ? { executor: 'Claude' } : {}), text: mark.text, createdAt: mark.createdAt })
  for (const change of changes.filter(change => change.taskId === task.taskId)) {
    // Правки приходят агенту через ownerChanges; пустая запись о них в обсуждении не нужна.
    // Сам комментарий и контрольная точка уже несут текст и время добавления.
    if (change.action === 'edited' || change.action === 'commented' || change.action === 'noted' && [...marks.values()].some(mark => mark.source === 'user' && mark.createdAt === change.createdAt)) continue
    entries.push({ id: `change:${change.eventId}`, kind: change.action, source: 'user',
      text: CHANGE_TEXT[change.action], createdAt: change.createdAt,
      ...(change.action === 'completed' ? { state: { word: 'закрыта', role: 'ok' as const } } : {}) })
  }
  // В снимке есть текущее состояние, но нет времени всех прошлых переходов.
  // Подпись говорит о состоянии на updatedAt, не выдумывает историю закрытий.
  const stateKind = task.status === 'done' ? 'completed' : task.status === 'paused' ? 'deferred' : task.status === 'cancelled' ? 'cancelled' : null
  if (stateKind && !entries.some(entry => entry.kind === stateKind)) entries.push({ id: `state:${task.status}:${task.updatedAt}`, kind: 'state',
    text: `Состояние задачи: ${task.status === 'done' ? 'закрыта' : task.status === 'cancelled' ? 'отклонена' : 'в бэклоге'}`, createdAt: task.updatedAt,
    ...(task.status === 'paused' ? {} : { state: { word: task.status === 'done' ? 'закрыта' : 'отклонена', role: task.status === 'done' ? 'ok' as const : 'fail' as const } }) })
  return entries.map(entry => ({ ...entry, text: cleanWorkText(entry.text), ...(entry.executor ? { executor: cleanWorkText(entry.executor).replace(/\n/gu, ' ') } : {}) }))
    .filter(entry => entry.text.trim()).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

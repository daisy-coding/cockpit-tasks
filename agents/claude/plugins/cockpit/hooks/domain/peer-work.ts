import type { TaskSummary, WorkJob } from '../../types/index'

// Проверки состояния и source_cwd адаптированы из leitstand/hooks/peer-jobs.ts.
// Текст задания, описание, ошибки и пути worktree в модель задач не попадают.
export const PEER_STATE_BYTES = 128 * 1024
export const PEER_POLL_MS = 1000
export const validPeerId = (id: string): boolean => /^[0-9a-f]{32}$/u.test(id)
export type PeerStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled'
export type PeerWork = WorkJob & { status: PeerStatus; createdAt: number; startedAt?: number; completedAt?: number }
export type TaskWorker = { agent: 'agent' | WorkJob['agent']; state: 'running' | 'review'; elapsedMs?: number }
export type WorkAssignment = { taskId: string; alias: string; workers: TaskWorker[] }
const STATUSES: readonly string[] = ['queued', 'running', 'completed', 'failed', 'timed_out', 'cancelled']

export function normalizePeerCwd(path: string): string | null {
  if (!path.startsWith('/') || path.length > 4096 || /[\p{C}\u2028\u2029]/u.test(path)) return null
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return '/' + parts.join('/')
}
export function peerBelongsTo(source: string, cwd: string): boolean {
  const project = normalizePeerCwd(cwd)
  const path = normalizePeerCwd(source)
  return project !== null && path !== null && (path === project || path.startsWith(project === '/' ? '/' : project + '/'))
}
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000

export function parsePeerWork(text: string, job: WorkJob, cwd: string): PeerWork | null {
  if (!validPeerId(job.jobId) || new TextEncoder().encode(text).length > PEER_STATE_BYTES) return null
  try {
    const state: unknown = JSON.parse(text)
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null
    const value = state as Record<string, unknown>
    if (value.job_id !== job.jobId || value.agent !== job.agent || value.mode !== job.mode
      || typeof value.task_size !== 'string' || !['small', 'medium', 'large', 'huge'].includes(value.task_size)
      || typeof value.status !== 'string' || !STATUSES.includes(value.status)
      || !timestamp(value.created_at) || value.started_at != null && !timestamp(value.started_at)
      || value.completed_at != null && !timestamp(value.completed_at)
      || typeof value.source_cwd !== 'string' || !peerBelongsTo(value.source_cwd, cwd)) return null
    return { ...job, status: value.status as PeerStatus, createdAt: value.created_at * 1000,
      ...(timestamp(value.started_at) ? { startedAt: value.started_at * 1000 } : {}),
      ...(timestamp(value.completed_at) ? { completedAt: value.completed_at * 1000 } : {}) }
  } catch { return null }
}
export function peerRunning(job: PeerWork): boolean { return job.status === 'queued' || job.status === 'running' }
// Завершённое задание ждёт сверки, пока агент о нём не узнал: с его конца не начинался ход главной ленты и агент
// не забирал результат сам. Дальше результат у агента, и задача либо у него в работе, либо снова в очереди.
// Отменённое задание сверки не ждёт: его остановил сам агент.
export function awaitingReview(job: PeerWork, seenAt: number, picked: ReadonlySet<string>): boolean {
  return !peerRunning(job) && job.status !== 'cancelled' && job.completedAt !== undefined && job.completedAt > seenAt && !picked.has(job.jobId)
}
// Задания, по которым сейчас что-то происходит: идут либо ждут сверки.
export function livePeers(peers: Map<string, PeerWork[]>, seenAt: number, picked: ReadonlySet<string>): Map<string, PeerWork[]> {
  return new Map([...peers].map(([taskId, jobs]) => [taskId, jobs.filter(job => peerRunning(job) || awaitingReview(job, seenAt, picked))] as const)
    .filter(([, jobs]) => jobs.length > 0))
}
export function workerName(agent: TaskWorker['agent']): string { return agent === 'agent' ? 'агент' : agent === 'codex' ? 'Codex' : 'Antigravity' }

// Счётчики на рамке карточки: сколько исполнителей заняты задачей и сколько результатов ждут сверки.
// Агент считается занятым своей текущей задачей и между ходами; идёт ли работа прямо сейчас, показывает блик названия.
export const WORKER_ICONS = {
  busy: { nerd: String.fromCodePoint(0xf06a9), plain: '▶' }, // md-robot
  review: { nerd: String.fromCodePoint(0xf08a8), plain: '✓' }, // md-clipboard_check_outline
} as const
export function workerCounts(workers: readonly TaskWorker[]): { busy: number; review: number } {
  return { busy: workers.filter(worker => worker.agent === 'agent' || worker.state === 'running').length,
    review: workers.filter(worker => worker.agent !== 'agent' && worker.state === 'review').length }
}
export function workerCounters(workers: readonly TaskWorker[], plain = false): string {
  const { busy, review } = workerCounts(workers)
  const glyph = (name: keyof typeof WORKER_ICONS) => plain ? WORKER_ICONS[name].plain : WORKER_ICONS[name].nerd
  return [busy ? `${glyph('busy')} ${busy}` : '', review ? `${glyph('review')} ${review}` : ''].filter(Boolean).join('  ')
}
// Подпись счётчиков словами: кто занят и чьи результаты ждут сверки. Показывается при наведении на счётчики.
export function workerCaption(workers: readonly TaskWorker[], duration: (ms: number) => string): string {
  const busy = workers.filter(worker => worker.agent === 'agent' || worker.state === 'running')
    .map(worker => worker.agent === 'agent' ? worker.state === 'running' ? 'агент' : 'агент ждёт хода' : `${workerName(worker.agent)} ${duration(worker.elapsedMs ?? 0)}`)
  const review = workers.filter(worker => worker.agent !== 'agent' && worker.state === 'review').map(worker => workerName(worker.agent))
  return [busy.length ? `В работе: ${busy.join(', ')}` : '', review.length ? `${review.length === 1 ? 'Ждёт' : 'Ждут'} сверки: ${review.join(', ')}` : ''].filter(Boolean).join('; ')
}

export function workAssignments(tasks: TaskSummary[], current: string | undefined, peers: Map<string, PeerWork[]>, at: number, working = false): WorkAssignment[] {
  return tasks.filter(task => task.status === 'active' && task.stage !== 'candidate' && !task.deleted).flatMap(task => {
    const workers: TaskWorker[] = [
      ...(task.taskId === current ? [{ agent: 'agent' as const, state: working ? 'running' as const : 'review' as const }] : []),
      ...(peers.get(task.taskId) ?? []).map(job => ({ agent: job.agent, state: peerRunning(job) ? 'running' as const : 'review' as const,
        ...(peerRunning(job) ? { elapsedMs: Math.max(0, at - (job.startedAt ?? job.createdAt)) } : {}) })),
    ]
    return workers.length ? [{ taskId: task.taskId, alias: task.alias, workers }] : []
  })
}

import { expect, test } from 'claude-code/testing'
import { delegateTaskNumbers, gitTrail, trailBlock } from '../hooks/domain/work-trail'
import { awaitingReview, livePeers, parsePeerWork, peerBelongsTo, workAssignments, workerCaption, workerCounters, WORKER_ICONS, PEER_STATE_BYTES, type PeerWork, type TaskWorker } from '../hooks/domain/peer-work'
import type { WorkJob } from '../types/index'
import { TASK } from './fixtures'

const JOB: WorkJob = { jobId: 'c'.repeat(32), agent: 'codex', mode: 'implement' }
const STATE = { job_id: JOB.jobId, agent: JOB.agent, mode: JOB.mode, task_size: 'medium', status: 'running',
  source_cwd: '/fixture', created_at: 100, started_at: 110 }

test('JOBS-7: связь читает отдельную строку с номерами, неверную явную строку не подменяет текущей', () => {
  for (const input of [undefined, {}, 'Проверь #159 и #182', 'В тексте есть Задача: #159']) expect(delegateTaskNumbers(input)).toBe(null)
  expect(delegateTaskNumbers('Задачи: #159, #182, #159\nОстальные числа #999 не относятся к связи.')).toEqual([159, 182])
  expect(delegateTaskNumbers('  Задача: #182\r\nЗадание')).toEqual([182])
  for (const input of ['Задачи: #0', 'Задача: #1; #2', 'Задачи: #1, текст', 'Задача: #999999999999999999999', 'Задача:']) expect(delegateTaskNumbers(input)).toEqual([])
})

test('JOBS-8: шесть состояний, время в секундах и граница проекта; свободные поля в модель не идут', () => {
  for (const status of ['queued', 'running', 'completed', 'failed', 'timed_out', 'cancelled']) {
    const parsed = parsePeerWork(JSON.stringify({ ...STATE, status, completed_at: 120, task: 'Не хранить', error: 'Не показывать', description: 'Не показывать' }), JOB, '/fixture')
    expect(parsed).toEqual({ ...JOB, status, createdAt: 100_000, startedAt: 110_000, completedAt: 120_000 })
    expect(JSON.stringify(parsed)).not.toContain('Не ')
  }
  expect(peerBelongsTo('/fixture/child/../checkout', '/fixture/')).toBe(true)
  for (const source of ['/fixture-other', '/other', 'fixture', '/fixture/' + String.fromCharCode(0x200b)]) expect(peerBelongsTo(source, '/fixture')).toBe(false)
  for (const patch of [{ job_id: 'd'.repeat(32) }, { agent: 'antigravity' }, { mode: 'review' }, { created_at: -1 }, { started_at: '110' }]) expect(parsePeerWork(JSON.stringify({ ...STATE, ...patch }), JOB, '/fixture')).toBe(null)
  expect(parsePeerWork(' '.repeat(PEER_STATE_BYTES + 1), JOB, '/fixture')).toBe(null)
})

for (const field of ['status', 'task_size']) test(`JOBS-9: поле ${field} должно быть строкой, массив не приводится к строке`, () => {
  expect(parsePeerWork(JSON.stringify({ ...STATE, [field]: [STATE[field as keyof typeof STATE]] }), JOB, '/fixture')).toBe(null)
})

test('JOBS-10: агент и два задания одной задачи занимают одну карточку; закрытые и отложенные исключены', () => {
  const running = parsePeerWork(JSON.stringify(STATE), JOB, '/fixture')!
  const review: PeerWork = { ...running, jobId: 'd'.repeat(32), agent: 'antigravity', status: 'completed' }
  const peers = new Map([[TASK.taskId, [running, review]]])
  expect(workAssignments([TASK], TASK.taskId, peers, 200_000, true)).toEqual([{ taskId: TASK.taskId, alias: TASK.alias, workers: [
    { agent: 'agent', state: 'running' }, { agent: 'codex', state: 'running', elapsedMs: 90_000 }, { agent: 'antigravity', state: 'review' },
  ] }])
  for (const status of ['done', 'paused', 'cancelled'] as const) expect(workAssignments([{ ...TASK, status }], TASK.taskId, peers, 200_000, true)).toEqual([])
  expect(trailBlock(TASK.alias, gitTrail({ jobs: [JOB] }, '', '', ''))).toContain('Задания: codex implement cccccccc')
})

test('JOBS-15: сверки ждёт только результат, о котором агент ещё не знает; отменённое задание её не ждёт', () => {
  const job = (status: PeerWork['status'], completedAt?: number): PeerWork => ({ ...JOB, status, createdAt: 100_000, startedAt: 110_000, ...(completedAt === undefined ? {} : { completedAt }) })
  const none = new Set<string>()
  // Задание кончилось после начала последнего хода: агент о нём не знает.
  for (const status of ['completed', 'failed', 'timed_out'] as const) expect(awaitingReview(job(status, 300_000), 200_000, none)).toBe(true)
  // Ход начался после конца задания либо агент сам забрал результат.
  expect(awaitingReview(job('completed', 300_000), 300_000, none)).toBe(false)
  expect(awaitingReview(job('completed', 300_000), 200_000, new Set([JOB.jobId]))).toBe(false)
  expect(awaitingReview(job('cancelled', 300_000), 200_000, none)).toBe(false)
  // Без времени конца ждать нечего; идущее задание сверки не ждёт, но задачу в работе держит.
  expect(awaitingReview(job('completed'), 200_000, none)).toBe(false)
  expect(awaitingReview(job('running'), 200_000, none)).toBe(false)
  const peers = new Map([['running', [job('running')]], ['fresh', [job('failed', 300_000)]], ['known', [job('completed', 150_000)]], ['mixed', [job('queued'), job('completed', 150_000)]]])
  expect([...livePeers(peers, 200_000, none)].map(([taskId, jobs]) => [taskId, jobs.map(item => item.status)])).toEqual([['running', ['running']], ['fresh', ['failed']], ['mixed', ['queued']]])
})

test('JOBS-16: на рамке счётчики значками, слова — в подписи; агент считается занятым своей задачей и между ходами', () => {
  const workers: TaskWorker[] = [{ agent: 'agent', state: 'review' }, { agent: 'codex', state: 'running', elapsedMs: 90_000 },
    { agent: 'antigravity', state: 'running', elapsedMs: 30_000 }, { agent: 'codex', state: 'review' }, { agent: 'antigravity', state: 'review' }]
  expect(workerCounters(workers, true)).toBe('▶ 3  ✓ 2')
  expect(workerCounters(workers)).toBe(`${WORKER_ICONS.busy.nerd} 3  ${WORKER_ICONS.review.nerd} 2`)
  expect(workerCounters([{ agent: 'agent', state: 'running' }], true)).toBe('▶ 1')
  expect(workerCounters([{ agent: 'codex', state: 'review' }], true)).toBe('✓ 1')
  expect(workerCounters([])).toBe('')
  const duration = (ms: number) => `${Math.round(ms / 1000)} с`
  expect(workerCaption(workers, duration)).toBe('В работе: агент ждёт хода, Codex 90 с, Antigravity 30 с; Ждут сверки: Codex, Antigravity')
  expect(workerCaption([{ agent: 'agent', state: 'running' }], duration)).toBe('В работе: агент')
  expect(workerCaption([{ agent: 'codex', state: 'review' }], duration)).toBe('Ждёт сверки: Codex')
  expect(workerCaption([], duration)).toBe('')
})

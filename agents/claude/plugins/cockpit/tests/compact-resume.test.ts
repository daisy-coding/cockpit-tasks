import { expect, test } from 'claude-code/testing'
import { TRACE_LIMIT, cutByCompact, cutCandidates, newResumeTracker, resumeRefusal, traced, turnCompleted, turnStarted, type ResumeTrace } from '../hooks/domain/compact-resume'

const HERE = 'session:/fixture'

test('RESUME-1: ход с текстом — работа главной ленты; ход без текста ничего не решает, пока не известен его вид', () => {
  const tracker = newResumeTracker()
  expect(turnStarted(tracker, 'main', 'go')).toBe('main')
  expect(tracker.mainTurns).toBe(1)
  expect(turnCompleted(tracker, 'main', undefined, 'aborted', HERE)).toBe('main')
  expect(tracker.mark).toBe(HERE)
  // Побочный запрос: начало без текста, конец с agentId. Отметка и счёт ходов прежние.
  expect(turnStarted(tracker, 'side', '')).toBe('unknown')
  expect(tracker.mark).toBe(HERE)
  expect(turnCompleted(tracker, 'side', 'side-request', 'answer', HERE)).toBe('side')
  expect([tracker.mark, tracker.mainTurns, tracker.open.size]).toEqual([HERE, 1, 0])
  // Ход без текста, закончившийся без agentId, был продолжением главной ленты: он считается начавшимся.
  turnStarted(tracker, 'continued', '   ')
  expect(turnCompleted(tracker, 'continued', undefined, 'answer', HERE)).toBe('main')
  expect([tracker.mark, tracker.mainTurns]).toEqual([null, 2])
  // Новый ход с текстом снимает прежнее прерывание сразу.
  turnCompleted(tracker, 'unseen', undefined, 'aborted', HERE)
  turnStarted(tracker, 'next', 'дальше')
  expect(tracker.mark).toBe(null)
})

test('RESUME-2: ход, шедший в момент запроса сжатия, оборван, если не закончился ответом', () => {
  // Конец хода не пришёл вовсе: ход оборван сжатием и больше не идёт.
  const silent = newResumeTracker()
  turnStarted(silent, 'cut', 'go')
  const running = cutCandidates(silent, undefined)
  expect(running).toEqual(['cut'])
  expect(cutByCompact(silent, running)).toBe(true)
  expect(silent.open.size).toBe(0)
  // Конец пришёл за время сжатия: «прерван» — оборван, «ответ» — владелец его не прерывал.
  for (const [reason, cut] of [['aborted', true], ['answer', false], ['error', false]] as const) {
    const tracker = newResumeTracker()
    turnStarted(tracker, 'turn', 'go')
    const candidates = cutCandidates(tracker, undefined)
    turnCompleted(tracker, 'turn', undefined, reason, HERE)
    expect(cutByCompact(tracker, candidates)).toBe(cut)
  }
  // Ход без текста — кандидат, только пока движок сообщает о работе главной ленты; побочный запрос оборванным не считается.
  const side = newResumeTracker()
  turnStarted(side, 'side', '')
  expect(cutCandidates(side, false)).toEqual([])
  expect(cutCandidates(side, undefined)).toEqual([])
  const candidates = cutCandidates(side, true)
  expect(candidates).toEqual(['side'])
  turnCompleted(side, 'side', 'side-request', 'aborted', HERE)
  expect(cutByCompact(side, candidates)).toBe(false)
  expect(cutByCompact(newResumeTracker(), [])).toBe(false)
})

test('RESUME-3: причина отказа названа словами, след ограничен и обрезает подробности', () => {
  for (const reason of ['self-ended', 'no-task', 'unread', 'not-sent'] as const) {
    expect(resumeRefusal(reason)).toMatch(/^После сжатия не продолжаю: .+\. Напиши «продолжи»\.$/u)
  }
  const trace: ResumeTrace[] = []
  for (let index = 0; index < TRACE_LIMIT + 5; index += 1) traced(trace, index, 'turn-start', 'x'.repeat(200))
  expect(trace).toHaveLength(TRACE_LIMIT)
  expect(trace[0]!.at).toBe(5)
  expect(trace[0]!.detail).toHaveLength(80)
  traced(trace, 99, 'compact')
  expect('detail' in trace.at(-1)!).toBe(false)
})

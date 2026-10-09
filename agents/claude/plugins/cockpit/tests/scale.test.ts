import { expect, test } from 'claude-code/testing'
import { buildRequest, parseResponse } from '../hooks/domain/rpc'
import { snapshot } from './fixtures'
import { newTaskLoop, taskDigest } from '../hooks/domain/task-loop'
import type { TaskContext } from '../types/index'

test('Парсер проверяет и очищает тысячу строк снимка и сохраняет признак усечения', () => {
  const result = snapshot(null)
  result.tasks = Array.from({ length: 1000 }, (_, index) => ({ taskId: `scale-${index + 1}`, alias: `TASK-${index + 1}`,
    title: '<pasted_content>Проверить обмен данными</pasted_content>', status: 'active' as const, revision: 0,
    certainty: 'inferred' as const, certaintySource: 'agent' as const, certaintyProvenance: 'tool' as const }))
  const wire = JSON.stringify({ v: 1, ok: true, result: { ...result, openTaskCount: 5000, tasksTruncated: true } })
  const samples: number[] = []
  for (let index = 0; index < 7; index += 1) {
    const start = Date.now()
    const parsed = parseResponse('snapshot', wire)
    samples.push(Date.now() - start)
    expect(parsed.kind).toBe('snapshot')
    if (parsed.kind !== 'snapshot') return
    expect(parsed.snapshot.tasks.length).toBe(1000)
    expect(parsed.snapshot.tasks[999]?.title).toBe('Проверить обмен данными')
    expect(parsed.snapshot.openTaskCount).toBe(5000)
    expect(parsed.snapshot.tasksTruncated).toBe(true)
  }
  expect(samples.length).toBe(7)
  expect(parseResponse('snapshot', wire, 0, true).kind).toBe('unknown')
})

test('Договор чтения принимает страницы и номер задачи вне контекста', () => {
  const session = { sessionId: 'fixture-session', cwd: '/fixture' }
  expect(buildRequest('tasks.page', 'page-request', session, { list: 'queue', offset: 990, limit: 30 }).op).toBe('tasks.page')
  const item = { taskId: 'scale-1000', alias: 'TASK-1000', title: 'Проверить дальнюю задачу', status: 'active',
    updatedAt: '2026-10-07T00:00:00.000000Z', priorityPinned: false }
  expect(parseResponse('tasks.page', JSON.stringify({ v: 1, ok: true, result: { list: 'queue', offset: 990, total: 1000, tasks: [item] } })).kind).toBe('page')
  const enriched = { ...item, priority: 1, queuePosition: 999, revision: 2, needsDecision: true,
    stepCounts: { total: 4, done: 2, active: 1 }, discussionCount: 7 }
  const rich = parseResponse('tasks.page', JSON.stringify({ v: 1, ok: true, result: { list: 'queue', offset: 990, total: 1000, tasks: [enriched] } }))
  expect(rich.kind === 'page' ? rich.page.tasks : []).toEqual([enriched])
  for (const fields of [{ revision: -1 }, { priority: 4 }, { needsDecision: 'yes' }, { stepCounts: { total: 1, done: 1, active: 1 } }]) {
    expect(parseResponse('tasks.page', JSON.stringify({ v: 1, ok: true, result: { list: 'queue', offset: 0, total: 1, tasks: [{ ...enriched, ...fields }] } })).kind).toBe('unknown')
  }
  expect(parseResponse('task.resolve', JSON.stringify({ v: 1, ok: true, result: { ...item, revision: 0 } })).kind).toBe('resolved')
  expect(parseResponse('tasks.page', JSON.stringify({ v: 1, ok: true, result: { list: 'queue', offset: 0, total: 1, tasks: Array(51).fill(item) } })).kind).toBe('unknown')
  for (const list of ['deferred', 'closed']) {
    const entry = { ...item, status: list === 'deferred' ? 'paused' : 'done' }
    expect(parseResponse('tasks.page', JSON.stringify({ v: 1, ok: true, result: { list, offset: 0, total: 1, tasks: [entry] } })).kind).toBe('page')
  }
})

test('Парсер отвергает противоречивые и неполные счётчики большого снимка', () => {
  const result = snapshot(null)
  for (const fields of [{ openTaskCount: -1, tasksTruncated: false }, { openTaskCount: 1, tasksTruncated: false },
    { openTaskCount: 0, tasksTruncated: 'false' }, { openTaskCount: 0 }]) {
    expect(parseResponse('snapshot', JSON.stringify({ v: 1, ok: true, result: { ...result, ...fields } })).kind).toBe('unknown')
  }
})

test('Полная очередь ранжирования больше тридцати идентификаторов принимается', () => {
  const order = Array.from({ length: 1000 }, (_, index) => `scale-${index}`)
  expect(parseResponse('tasks.agent.rank', JSON.stringify({ v: 1, ok: true, result: { order, pinned: order } })).kind).toBe('agent-ranked')
})

test('Сводка и напоминание ограничены; вызов для остатка очереди называет только полная сводка', () => {
  const context: TaskContext = { binding: { projectId: 'p', worktreeId: 'w', sessionId: 's' }, current: null,
    queue: Array.from({ length: 30 }, (_, index) => ({ taskId: `task-${index}`, alias: `TASK-${index + 1}`, title: 'Проверить подробное поручение '.repeat(10), description: '' })),
    deferred: [], closed: [], counts: { total: 1000, open: 1000, active: 1000, queued: 1000, deferred: 0, done: 0, cancelled: 0, closedLast24h: 0, projectOpen: 1000 },
    ownerChanges: [], cursor: 0 }
  for (const full of [false, true]) {
    const output = taskDigest(context, newTaskLoop(), full).text
    expect(output.length).toBeLessThanOrEqual(full ? 6000 : 1500)
    // Напоминание приходит на каждую реплику: число очереди в нём уже есть в строке счётчиков.
    expect(output).toContain('в очереди: 1000')
    expect(output.includes('Ещё 970')).toBe(full)
    expect(output.includes('mcp__cockpit__task_list')).toBe(full)
    expect(output).not.toContain('/30')
  }
})

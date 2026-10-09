import { expect, mock, test } from 'claude-code/testing'
import type { FsStat, On } from 'claude-code'
import type { GateMode, GateReason } from '../types/index'
import type { Request } from '../hooks/domain/rpc'
import { parseResponse } from '../hooks/domain/rpc'
import { isStaleRead } from '../hooks/domain/gate'
import { reduceProjection } from '../hooks/domain/projection'
import { gateSummary, OBSERVATION, reply, seeded, snapshot, TASK } from './fixtures'

const EDIT = { tool: 'Edit' as const, file_path: '/fixture/file.ts', old_string: 'old', new_string: 'new' }
function host(on: On, options: { mode?: GateMode; empty?: boolean; block?: boolean; fail?: string; failedRead?: boolean; throwRun?: boolean } = {}) {
  let state = seeded(options.empty ? null : TASK, options.mode ?? 'observe')
  let version = 1
  let sessionId = 'fixture-session'
  let summary = gateSummary(options.mode ?? 'observe')
  const stats = new Map<string, FsStat>()
  const calls: Request[] = []
  const fsCalls: string[] = []
  const writes: string[] = []
  const tools: string[] = []
  const cached = new Map<string, string>()
  on('session.id', () => ({ value: sessionId }))
  on('session.cwd', () => ({ value: '/fixture' }))
  on('state.get', { plugin: 'cockpit', key: 'projection' }, () => ({ value: { value: state, version } }))
  on('state.set', { plugin: 'cockpit', key: 'projection' }, (_$, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    state = e.value
    version += 1
    writes.push(JSON.stringify(state))
    return { value: { isSet: true, version } }
  })
  on('fs.stat', (_$, e) => {
    fsCalls.push(e.path)
    expect(e.resolve).toBe(true)
    return { value: stats.get(e.path) ?? { kind: 'file', size: 3, mtimeMs: 100, isLink: false, realPath: e.path } }
  })
  on('process.run', (_$, e) => {
    const request: Request = JSON.parse(e.init?.stdin ?? '{}')
    calls.push(request)
    expect(e.init?.timeoutMs).toBeGreaterThan(0)
    expect(e.init?.timeoutMs).toBeLessThanOrEqual(3000)
    if (options.throwRun) throw new Error('Process timed out PRIVATE')
    if (options.fail) return { value: { exitCode: 0, stdout: options.fail, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    let stdout = cached.get(request.requestId)
    if (!stdout) {
      if (request.op === 'gate.check') {
        const bound = state.focus?.task ? 'existing' : 'created'
        const reasons: GateReason[] = []
        if (options.block) reasons.push('foreign-lease')
        if (request.args.staleRead) reasons.push('stale-read')
        const outcome = reasons.length ? 'BLOCK' : bound === 'existing' ? 'ALLOW' : 'BIND'
        summary = { ...summary, counts: { ...summary.counts, [outcome]: summary.counts[outcome] + 1 }, blockReasons: { ...summary.blockReasons } }
        for (const reason of reasons) summary.blockReasons[reason] += 1
        stdout = JSON.stringify({ v: 1, ok: true, result: { bound, task: TASK, focusRevision: 2, gate: summary,
          observation: { ...OBSERVATION, observationId: Object.values(summary.counts).reduce((sum, count) => sum + count, 0), outcome, reasons, sessionId: request.session.sessionId } } })
      } else if (request.op === 'session.rebind' || request.op === 'snapshot') stdout = JSON.stringify({ v: 1, ok: true, result: snapshot(TASK, options.mode ?? 'observe') })
      else stdout = reply(request)
      cached.set(request.requestId, stdout)
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_$, e) => {
    tools.push(e.tool)
    return { result: { ok: true }, context: ['Прежний контекст'], ...(e.tool === 'Read' && options.failedRead ? { isError: true } : {}) }
  })
  on('classic.SessionStart', () => ({}))
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 200000 }, rateLimits: [] } }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  return { calls, fsCalls, tools, writes, stats, get state() { return state }, setSession(id: string) { sessionId = id } }
}

test('observe делает ровно один gate.check на Edit, Write и NotebookEdit, даже при фокусе', async ($, on) => {
  const fixture = host(on, { empty: true })
  const inputs = [EDIT, { tool: 'Write' as const, file_path: '/fixture/new', content: 'PRIVATE-CONTENT' },
    { tool: 'NotebookEdit' as const, notebook_path: '/fixture/notebook.ipynb', new_source: 'PRIVATE-CELL' }]
  for (const input of inputs) {
    const before = fixture.calls.length
    expect(await $.tool.call(input)).toEqual({ result: { ok: true }, context: ['Прежний контекст'] })
    expect(fixture.calls.length).toBe(before + 1)
  }
  expect(fixture.calls.map(call => call.op)).toEqual(['gate.check', 'gate.check', 'gate.check'])
  expect(fixture.calls.map(call => call.args)).toEqual([
    { resourcePath: '/fixture/file.ts', staleRead: false }, { resourcePath: '/fixture/new', staleRead: false }, { resourcePath: '/fixture/notebook.ipynb', staleRead: false },
  ])
  expect(new Set(fixture.calls.map(call => call.requestId)).size).toBe(3)
  for (const written of fixture.writes) expect(written).not.toContain('PRIVATE')
})

test('off не создаёт карточку по правке файла; чтение и мутации без stat и RPC', async ($, on) => {
  const fixture = host(on, { mode: 'off', empty: true })
  await $.tool.call({ tool: 'Read', file_path: EDIT.file_path })
  await $.tool.call(EDIT)
  await $.tool.call({ tool: 'Write', file_path: '/fixture/new', content: 'text' })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/fixture/notebook.ipynb', new_source: 'text' })
  expect(fixture.calls).toHaveLength(0)
  expect(fixture.fsCalls).toHaveLength(0)
})

test('Read не вызывает рантайм; изменение mtime или размера после чтения даёт stale-read', async ($, on) => {
  const fixture = host(on)
  await $.tool.call({ tool: 'Read', file_path: EDIT.file_path })
  expect(fixture.calls).toHaveLength(0)
  fixture.stats.set(EDIT.file_path, { kind: 'file', size: 3, mtimeMs: 101, isLink: false, realPath: EDIT.file_path })
  expect((await $.tool.call(EDIT)).result).toEqual({ ok: true })
  expect(fixture.calls[0]?.args).toEqual({ resourcePath: EDIT.file_path, staleRead: true })
  expect(fixture.state.gate?.counts.BLOCK).toBe(1)
  await $.tool.call({ tool: 'Read', file_path: EDIT.file_path })
  await $.tool.call(EDIT)
  expect(fixture.calls[1]?.args).toEqual({ resourcePath: EDIT.file_path, staleRead: false })
  fixture.stats.set(EDIT.file_path, { kind: 'file', size: 4, mtimeMs: 101, isLink: false, realPath: EDIT.file_path })
  await $.tool.call(EDIT)
  expect(fixture.calls[2]?.args).toEqual({ resourcePath: EDIT.file_path, staleRead: true })
})

test('Не читавшийся файл и неудачный Read не дают stale-read', async ($, on) => {
  const fixture = host(on, { failedRead: true })
  await $.tool.call({ tool: 'Read', file_path: EDIT.file_path })
  fixture.stats.set(EDIT.file_path, { kind: 'file', size: 200, mtimeMs: 500, isLink: false, realPath: EDIT.file_path })
  await $.tool.call(EDIT)
  expect(fixture.calls[0]?.args).toEqual({ resourcePath: EDIT.file_path, staleRead: false })
  await $.tool.call({ ...EDIT, file_path: '/fixture/unread' })
  expect(fixture.calls[1]?.args).toEqual({ resourcePath: '/fixture/unread', staleRead: false })
})

test('Отпечаток Read через симлинк сравнивается при правке канонического пути', async ($, on) => {
  const fixture = host(on)
  fixture.stats.set('/fixture/link', { kind: 'file', size: 3, mtimeMs: 100, isLink: true, realPath: EDIT.file_path })
  await $.tool.call({ tool: 'Read', file_path: '/fixture/link' })
  fixture.stats.set(EDIT.file_path, { kind: 'file', size: 3, mtimeMs: 200, isLink: false, realPath: EDIT.file_path })
  await $.tool.call(EDIT)
  expect(fixture.calls[0]?.args).toEqual({ resourcePath: EDIT.file_path, staleRead: true })
  await $.tool.call({ tool: 'Read', file_path: EDIT.file_path })
  fixture.stats.set('/fixture/link', { kind: 'file', size: 3, mtimeMs: 200, isLink: true, realPath: EDIT.file_path })
  await $.tool.call({ ...EDIT, file_path: '/fixture/link' })
  expect(fixture.calls[1]?.args).toEqual({ resourcePath: '/fixture/link', staleRead: false })
})

test('BLOCK выполняет инструмент без deny и сохраняет его результат и контекст', async ($, on) => {
  const fixture = host(on, { block: true })
  const result = await $.tool.call(EDIT)
  expect(result).toEqual({ result: { ok: true }, context: ['Прежний контекст'] })
  expect(fixture.tools).toEqual(['Edit'])
  expect(fixture.state.gate?.counts.BLOCK).toBe(1)
  expect(fixture.state.gate?.blockReasons['foreign-lease']).toBe(1)
})

for (const fail of ['not-json PRIVATE', '{"v":1,"ok":false,"error":{"code":"DB_UNAVAILABLE","message":"PRIVATE"}}']) {
  test('Сбой gate.check пропускает исходный инструмент и сохраняет связь', async ($, on) => {
    const fixture = host(on, { fail })
    expect(await $.tool.call(EDIT)).toEqual({ result: { ok: true }, context: ['Прежний контекст'] })
    expect(fixture.tools).toEqual(['Edit'])
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.state.connection.status).toBe('ready')
    for (const written of fixture.writes) expect(written).not.toContain('PRIVATE')
  })
}

test('Параллельные мутации получают отдельные gate.check', async ($, on) => {
  const fixture = host(on)
  const first = { ...EDIT, tool_use_id: 'call-1' }
  await Promise.all([$.tool.call(first), $.tool.call({ ...EDIT, file_path: '/fixture/second', tool_use_id: 'call-2' })])
  expect(fixture.calls).toHaveLength(2)
  expect(new Set(fixture.calls.map(call => call.requestId)).size).toBe(2)
})

test('Неизвестный исход повторяется тем же envelope только для того же tool_use_id', async ($, on) => {
  const fixture = host(on, { fail: 'not-json' })
  const input = { ...EDIT, tool_use_id: 'stable-call' }
  await $.tool.call(input)
  await $.tool.call(input)
  await $.tool.call({ ...EDIT, tool_use_id: 'new-call' })
  expect(fixture.calls[0]).toEqual(fixture.calls[1])
  expect(fixture.calls[2]?.requestId).not.toBe(fixture.calls[0]?.requestId)
  expect(fixture.tools).toHaveLength(3)
})

test('Исключение транспорта не меняет результат инструмента и не запускает второй RPC', async ($, on) => {
  const fixture = host(on, { throwRun: true })
  expect(await $.tool.call(EDIT)).toEqual({ result: { ok: true }, context: ['Прежний контекст'] })
  expect(fixture.calls).toHaveLength(1)
  expect(fixture.tools).toHaveLength(1)
  expect(fixture.state.connection.status).toBe('ready')
})

test('session.end освобождает аренду в одном ограниченном вызове и продолжает событие', async ($, on) => {
  const fixture = host(on)
  const input = { reason: 'prompt_input_exit' as const, sessionId: 'fixture-session', resume: { id: 'fixture-session' } }
  expect(await $.session.end(input)).toEqual({ sessionId: input.sessionId })
  expect(fixture.calls.map(call => call.op)).toEqual(['session.end'])
})

test('session.end при off останавливает часы текущей задачи одним вызовом', async ($, on) => {
  const fixture = host(on, { mode: 'off' })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture-session', resume: { id: 'fixture-session' } })
  expect(fixture.calls.map(call => call.op)).toEqual(['session.end'])
})

test('Новый sessionId сбрасывает карту чтений', async ($, on) => {
  const fixture = host(on)
  mock.clock(on, { now: 1000 })
  await $.tool.call({ tool: 'Read', file_path: EDIT.file_path })
  fixture.stats.set(EDIT.file_path, { kind: 'file', size: 100, mtimeMs: 900, isLink: false, realPath: EDIT.file_path })
  fixture.setSession('new-session')
  await $.classic.SessionStart({ source: 'clear', cwd: '/fixture', session_id: 'new-session' })
  await $.tool.call(EDIT)
  expect(fixture.calls.at(-1)?.args).toEqual({ resourcePath: EDIT.file_path, staleRead: false })
})

test('Фильтрация парсера и счётчики повторов не раскрывают лишние данные', () => {
  const gate = gateSummary('observe')
  gate.counts.BLOCK = 2
  gate.blockReasons['stale-read'] = 2
  const result = { bound: 'existing', task: TASK, focusRevision: 2, gate, observation: { ...OBSERVATION, outcome: 'BLOCK', reasons: ['stale-read'] } }
  const wire = (value: unknown) => JSON.stringify({ v: 1, ok: true, result: value })
  const parsed = parseResponse('gate.check', wire({ ...result, private: 'PRIVATE', gate: { ...gate, text: 'PRIVATE' }, observation: { ...result.observation, contents: 'PRIVATE' } }))
  expect(parsed.kind).toBe('gated')
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE')
  const state = reduceProjection(seeded(), parsed)
  const oldGate = gateSummary('observe')
  expect(reduceProjection(state, { kind: 'gated', bound: 'existing', task: { ...TASK, revision: 1 }, focusRevision: 1, gate: oldGate, observation: OBSERVATION }).gate?.counts.BLOCK).toBe(2)
  expect(state.gate?.counts.BLOCK).toBe(2)
  expect(seeded().gate?.mode).toBe('off')
  for (const reasons of [['unknown'], ['stale-read', 'stale-read'], []]) expect(parseResponse('gate.check', wire({ ...result, observation: { ...result.observation, reasons } }))).toEqual({ kind: 'unknown' })
  expect(parseResponse('gate.check', wire({ ...result, gate: { ...gate, mode: 'enforce' } }))).toEqual({ kind: 'unknown' })
  expect(isStaleRead(undefined, { kind: 'missing' })).toBe(false)
  const read = { kind: 'file' as const, size: 1, mtimeMs: 1 }
  expect(isStaleRead(read, { kind: 'missing' })).toBe(true)
  expect(isStaleRead(read, { kind: 'unknown' })).toBe(false)
  expect(isStaleRead({ ...read, realPath: '/fixture/file' }, { kind: 'known', stamp: read })).toBe(false)
})

import { expect, test } from 'claude-code/testing'
import type { ProcessRunInit } from 'claude-code'
import { createController, transport } from '../hooks/register'
import { buildRequest } from '../hooks/domain/rpc'
import { initialProjection, reduceProjection } from '../hooks/domain/projection'
import { statusText } from '../hooks/domain/text'

function bridgeFixture(scenario: 'missing' | 'fallback' | 'timeout' | 'fallback-timeout' | 'both-missing') {
  const calls: string[][] = []
  const timeouts: number[] = []
  const paths: string[] = []
  // Изолированный транспорт: ни одной операции хоста. Настоящий process.run
  // в тестах событий подменяется через on('process.run') в hooks.test.ts.
  const bridge = {
    env: { get: async () => '/fixture-home' },
    fs: { exists: async (path: string) => { paths.push(path); return scenario !== 'missing' } },
    process: { run: async (argv: readonly string[], init?: ProcessRunInit) => {
      calls.push([...argv])
      timeouts.push(init?.timeoutMs ?? 0)
      if (scenario === 'timeout' || (scenario === 'fallback-timeout' && argv[0] !== 'cockpitctl')) throw new Error('PRIVATE-TIMEOUT')
      if (argv[0] === 'cockpitctl' || scenario === 'both-missing') throw Object.assign(new Error('PRIVATE'), { code: 'ENOENT' })
      return { exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false, stderr: '',
        stdout: '{"v":1,"ok":true,"result":{"captured":true,"inboxId":"inbox-1","captureMode":"full-local"}}' }
    } },
  }
  const current = { sessionId: 'fixture-session', cwd: '/fixture' }
  const request = buildRequest('capture.prompt', 'bridge-request', current, { text: 'PRIVATE-PROMPT', kind: 'prompt' })
  return { bridge, calls, timeouts, paths, request }
}

test('Отсутствие бинаря даёт unavailable с подсказкой установки', async () => {
  const fixture = bridgeFixture('missing')
  const result = await transport(fixture.bridge, createController(), fixture.request, Date.now() + 3000)
  expect(result.kind).toBe('unavailable')
  expect(fixture.calls).toEqual([['cockpitctl', 'rpc']])
  const state = reduceProjection(initialProjection(), result)
  expect(state.connection.status).toBe('unavailable')
  expect(statusText(state)).toContain('sh install.sh')
  expect(statusText(state)).not.toContain('agentctl')
  expect(JSON.stringify(state)).not.toContain('PRIVATE')
})

test('Fallback запускает абсолютный путь после ENOENT и сохраняет лимит', async () => {
  const fixture = bridgeFixture('fallback')
  const result = await transport(fixture.bridge, createController(), fixture.request, Date.now() + 3000)
  expect(result.kind).toBe('captured')
  expect(fixture.calls).toEqual([['cockpitctl', 'rpc'], ['/fixture-home/.local/bin/cockpitctl', 'rpc']])
  expect(fixture.paths).toEqual(['/fixture-home/.local/bin/cockpitctl'])
  for (const ms of fixture.timeouts) { expect(ms).toBeGreaterThan(0); expect(ms).toBeLessThanOrEqual(3000) }
  expect(fixture.timeouts[1]).toBeLessThanOrEqual(fixture.timeouts[0] ?? 0)
})

test('Нетипизированный таймаут означает degraded и не запускает fallback', async () => {
  const fixture = bridgeFixture('timeout')
  const result = await transport(fixture.bridge, createController(), fixture.request, Date.now() + 3000)
  expect(result.kind).toBe('unknown')
  expect(fixture.calls).toEqual([['cockpitctl', 'rpc']])
  const state = reduceProjection(initialProjection(), result)
  expect(state.connection.status).toBe('degraded')
  expect(JSON.stringify(state)).not.toContain('PRIVATE')
})

test('Таймаут абсолютного бинаря даёт degraded, а не unavailable', async () => {
  const fixture = bridgeFixture('fallback-timeout')
  const result = await transport(fixture.bridge, createController(), fixture.request, Date.now() + 3000)
  expect(result.kind).toBe('unknown')
  expect(fixture.calls.length).toBe(2)
})

test('Если оба запуска невозможны, состояние unavailable', async () => {
  const fixture = bridgeFixture('both-missing')
  const result = await transport(fixture.bridge, createController(), fixture.request, Date.now() + 3000)
  expect(result.kind).toBe('unavailable')
  expect(fixture.calls.length).toBe(2)
})

test('Копия только для чтения пропускает tasks.page и task.resolve в транспорт', async () => {
  const controller = createController()
  controller.readOnly = true
  let calls = 0
  const bridge = { env: { get: async () => undefined }, fs: { exists: async () => false },
    process: { run: async () => {
      calls += 1
      return { exitCode: 0, stdout: '{"v":1,"ok":false,"error":{"code":"NOT_FOUND","message":"Не найдено"}}',
        stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    } } }
  const session = { sessionId: 'read-session', cwd: '/fixture' }
  for (const request of [buildRequest('tasks.page', 'read-page', session, { list: 'queue', offset: 100, limit: 30 }),
    buildRequest('task.resolve', 'read-resolve', session, { alias: 'TASK-1000' })]) {
    expect(await transport(bridge, controller, request, Date.now() + 3000)).toEqual({ kind: 'error', code: 'NOT_FOUND' })
  }
  expect(calls).toBe(2)
})

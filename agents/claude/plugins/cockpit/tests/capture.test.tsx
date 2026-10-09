import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HUMAN_WRITES, type Request } from '../hooks/domain/rpc'
import { createController, guardWitnessWrite } from '../hooks/register'
import type { RuntimeWitness, RuntimeWitnesses, Projection, Snapshot } from '../types/index'
import { reply, seeded, snapshot, TASK } from './fixtures'

const OWNER = 'Супер, да, ты сделал. Смотри, теперь смотри, тебе нужно добавить функционал, чтобы я, например, выбрал файл…'
const LEGACY_SECRET = 'ab'.repeat(32) // gitleaks:allow
const SESSION_KEY = '["capture-session","/fixture"]'

function host(on: On, options: { conflict?: boolean; conflictFirst?: boolean; saved?: boolean; otherCopy?: boolean; legacy?: boolean; previousOwner?: RuntimeWitness; liveSnapshot?: Snapshot } = {}) {
  mock.env(on, { HOME: '/fixture-home' })
  const clock = mock.clock(on, { now: 1 })
  const calls: Request[] = []; const models: unknown[] = []; const toasts: string[] = []
  const secrets = new Map<string, string>(); let inbox = 0
  if (options.saved) secrets.set(options.previousOwner?.runtimeSessionId ?? 'capture-session', LEGACY_SECRET)
  let witnesses: RuntimeWitnesses | undefined; let version = 0; let witnessWrites = 0
  const stateWrites: string[] = []; const storeWrites: string[] = []; const logs: string[] = []
  let state: Projection | undefined = options.liveSnapshot ? { ...seeded(), snapshot: options.liveSnapshot, focus: options.liveSnapshot.focus } : undefined
  let stateVersion = state ? 1 : 0
  on('state.set', async (_$, e, next) => { stateWrites.push(JSON.stringify(e.value)); return next(e) })
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_$, e) => { storeWrites.push(JSON.stringify(e.value)); return { value: undefined } })
  on('ui.log', (_$, e) => { logs.push(e.text); return { value: undefined } })
  on('state.get', { plugin: 'cockpit', key: 'projection' }, () => ({ value: { value: state, version: stateVersion } }))
  on('state.set', { plugin: 'cockpit', key: 'projection' }, (_$, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== stateVersion) return { value: { isSet: false, version: stateVersion } }
    state = e.value; stateVersion += 1
    return { value: { isSet: true, version: stateVersion } }
  })
  on('state.get', { plugin: 'cockpit', key: 'attestations' }, () => {
    if (witnesses === undefined && (options.saved || options.otherCopy)) {
      const owner = options.previousOwner ?? { runtimeSessionId: 'capture-session', epoch: 0,
        ownerRoot: options.otherCopy ? '/other-copy' : new URL('../', (import.meta as ImportMeta & { url: string }).url).pathname.replace(/\/$/u, ''), loadId: 'previous-load' }
      witnesses = { [SESSION_KEY]: options.legacy ? ({ ...owner, secret: LEGACY_SECRET } as typeof owner) : owner }
      version = 1
    }
    return { value: { value: witnesses, version } }
  })
  on('state.set', { plugin: 'cockpit', key: 'attestations' }, (_$, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    witnesses = e.value; version += 1; witnessWrites += 1
    return { value: { isSet: true, version } }
  })
  on('session.id', () => ({ value: 'capture-session' }))
  on('session.cwd', () => ({ value: '/fixture' }))
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 200000 }, rateLimits: [] } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('classic.SessionStart', () => ({}))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('process.run', (_$, e) => {
    const request: Request = JSON.parse(e.init?.stdin ?? '{}'); calls.push(request)
    let stdout = reply(request)
    if (request.op === 'session.rebind' || request.op === 'snapshot') {
      const live = options.liveSnapshot ?? snapshot(null)
      stdout = JSON.stringify({ v: 1, ok: true, result: { ...live, binding: { ...live.binding, sessionId: request.session.sessionId } } })
    }
    if (request.op === 'capture.prompt') stdout = JSON.stringify({ v: 1, ok: true, result: { captured: true, captureMode: 'full-local', inboxId: `capture-inbox-${++inbox}` } })
    if (request.op === 'session.attest') {
      const secret = secrets.get(request.session.sessionId)
      if (options.conflict || (options.conflictFirst && request.session.sessionId === 'capture-session') || (secret && secret !== request.panelSecret)) stdout = JSON.stringify({ v: 1, ok: false, error: { code: 'ATTESTATION_CONFLICT' } })
      else { if (request.panelSecret) secrets.set(request.session.sessionId, request.panelSecret); stdout = JSON.stringify({ v: 1, ok: true, result: { attested: true } }) }
    }
    if (request.op === 'task.create') stdout = JSON.stringify({ v: 1, ok: true, result: {
      task: { ...TASK, title: request.args.title, certainty: 'confirmed', certaintySource: 'user', certaintyProvenance: 'panel' },
      focus: { task: null, revision: 0 },
    } })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', (_$, e) => {
    models.push(e)
    throw new Error('Захват реплики не должен обращаться к модели')
  })
  return { calls, models, toasts, clock, stateWrites, storeWrites, logs, witnessWrites: () => witnessWrites, witnesses: () => witnesses, projection: () => state }
}

for (const origin of ['composer', 'bridge'] as const) test('Первый запрос без SessionStart и панели получает свидетельство: ' + origin, async ($, on) => {
  const fixture = host(on)
  expect(await $.prompt.submit({ text: OWNER, origin: { kind: origin }, wait: false })).toEqual({ text: OWNER, context: undefined })
  await fixture.clock.settle()
  expect(fixture.calls.filter(call => call.op === 'session.attest')).toHaveLength(1)
  expect(fixture.calls.filter(call => call.op === 'capture.prompt')).toHaveLength(1)
})

test('Секрет остаётся только в памяти и stdin, полная сериализация состояния его не содержит', async ($, on) => {
  const fixture = host(on)
  await $.prompt.submit({ text: OWNER, origin: { kind: 'composer' }, wait: false }); await fixture.clock.settle()
  const secret = fixture.calls.find(call => call.op === 'session.attest')?.panelSecret
  expect(secret).toMatch(/^[a-f0-9]{64}$/)
  await $.command.run({ command: 'tasks', args: 'add Проверить сохранность свидетельства', origin: { kind: 'composer' } } as Parameters<typeof $.command.run>[0])
  expect(fixture.calls.find(call => call.op === 'task.create')?.panelSecret).toBe(secret)
  const serialized = JSON.stringify(fixture.witnesses())
  expect(serialized).not.toMatch(/[a-f0-9]{64}/i)
  expect(serialized).not.toContain('"secret"')
  expect(Object.keys(fixture.witnesses()?.[SESSION_KEY] ?? {}).sort()).toEqual(['epoch', 'heartbeatAt', 'loadId', 'ownerRoot', 'runtimeSessionId'])
  for (const value of [...fixture.stateWrites, ...fixture.storeWrites, ...fixture.toasts, ...fixture.logs, JSON.stringify(fixture.projection())]) {
    expect(value).not.toContain(secret ?? 'невыданное свидетельство')
  }
})

test('Страж state.set отклоняет secret до записи, сохраняя прежнее значение и версию', () => {
  const previous = { [SESSION_KEY]: { ownerRoot: '/fixture-copy', loadId: 'load', epoch: 0, runtimeSessionId: 'capture-session' } }
  let held: unknown = previous; let version = 1; let writes = 0
  for (const poisoned of [{ ...previous, [SESSION_KEY]: { ...previous[SESSION_KEY], secret: LEGACY_SECRET } },
    { secret: LEGACY_SECRET }, { nested: { deeper: { secret: null } } }]) {
    const result = guardWitnessWrite(poisoned, () => { held = poisoned; version += 1; writes += 1; return { isSet: true, version } },
      () => ({ isSet: false, version }))
    expect(result).toEqual({ isSet: false, version: 1 })
    expect(held).toEqual(previous)
  }
  expect(writes).toBe(0)
  expect(guardWitnessWrite(previous, () => ({ isSet: true, version: 2 }), () => ({ isSet: false, version }))).toEqual({ isSet: true, version: 2 })
})

test('Сохранённая отметка владения после загрузки сразу меняет эпоху без отказа', async ($, on) => {
  const fixture = host(on, { saved: true })
  await $.classic.SessionStart({ source: 'resume', cwd: '/fixture', session_id: 'capture-session' })
  await $.prompt.submit({ text: OWNER, origin: { kind: 'composer' }, wait: false }); await fixture.clock.settle()
  const registrations = fixture.calls.filter(call => call.op === 'session.attest')
  expect(registrations).toHaveLength(1)
  expect(registrations[0]?.panelSecret).toMatch(/^[a-f0-9]{64}$/)
  expect(registrations[0]?.session.sessionId).toMatch(/^capture-session\.cockpit-1-[a-f0-9]{8}$/)
  expect(fixture.toasts).toHaveLength(0)
  await $.command.run({ command: 'tasks', args: 'add Проверить сохранность свидетельства', origin: { kind: 'composer' } } as Parameters<typeof $.command.run>[0])
  expect(fixture.calls.find(call => call.op === 'task.create')?.panelSecret).toBe(registrations[0]?.panelSecret)
  expect(fixture.witnesses()?.[SESSION_KEY]?.epoch).toBe(1)
  await $.classic.SessionStart({ source: 'resume', cwd: '/fixture', session_id: 'capture-session' })
  expect(fixture.calls.filter(call => call.op === 'session.attest')).toHaveLength(1)
  expect(fixture.witnesses()?.[SESSION_KEY]?.epoch).toBe(1)
  expect(fixture.toasts).toEqual(['Задача добавлена.'])
})

test('Новый контроллер с прежней отметкой сохраняет задачи, порядок и фокус на первом запросе', async ($, on) => {
  const previousController = createController()
  const previousOwner: RuntimeWitness = { ownerRoot: new URL('../', (import.meta as ImportMeta & { url: string }).url).pathname.replace(/\/$/u, ''),
    loadId: previousController.loadId, epoch: 3, runtimeSessionId: 'capture-session.cockpit-3-old' }
  previousController.storedWitnesses.set(SESSION_KEY, { ...previousOwner, secret: LEGACY_SECRET })
  const current = { ...TASK, certainty: 'confirmed' as const, certaintySource: 'user' as const, queuePosition: 1 }
  const before = snapshot(current)
  const summary = { ...before.tasks[0]!, queuePosition: 1 }
  const queued = { ...summary, taskId: 'task-2', alias: 'TASK-2', title: 'Следующая задача', queuePosition: 2 }
  const live = { ...before, storageSchemaVersion: 6 as const, tasks: [summary, queued] }
  const fixture = host(on, { saved: true, previousOwner, liveSnapshot: live })
  expect(await $.prompt.submit({ text: 'Как устроена очередь?', origin: { kind: 'composer' }, wait: false })).toEqual({ text: 'Как устроена очередь?', context: undefined })
  await fixture.clock.settle()
  expect(fixture.calls.map(call => call.op)).toEqual(['snapshot', 'tasks.context', 'session.rebind', 'session.attest', 'capture.prompt'])
  const registration = fixture.calls.find(call => call.op === 'session.attest')
  expect(registration?.session.sessionId).toMatch(/^capture-session\.cockpit-4-[a-f0-9]{8}$/)
  expect(registration?.panelSecret).not.toBe(LEGACY_SECRET)
  expect(fixture.witnesses()?.[SESSION_KEY]?.loadId).not.toBe(previousController.loadId)
  expect(fixture.witnesses()?.[SESSION_KEY]?.epoch).toBe(4)
  expect(fixture.projection()?.snapshot?.tasks).toEqual(live.tasks)
  expect(fixture.projection()?.focus).toEqual(live.focus)
  expect(fixture.calls.find(call => call.op === 'capture.prompt')?.session.sessionId).toBe(registration?.session.sessionId)
  expect(fixture.projection()?.attestationStatus).toBe('confirmed')
  expect(fixture.models).toHaveLength(0)
  expect(fixture.toasts).toHaveLength(0)
})

for (const otherCopy of [false, true]) test('Состояние 0.9.1 очищается при первом чтении, чужая копия=' + otherCopy, async ($, on) => {
  const fixture = host(on, { saved: true, legacy: true, otherCopy })
  await $.classic.SessionStart({ source: 'resume', cwd: '/fixture', session_id: 'capture-session' })
  const serialized = JSON.stringify(fixture.witnesses())
  expect(serialized).not.toContain('"secret"')
  expect(serialized).not.toMatch(/[a-f0-9]{64}/i)
  expect(fixture.calls.filter(call => call.op === 'session.attest')).toHaveLength(otherCopy ? 0 : 1)
  if (!otherCopy) expect(fixture.calls.find(call => call.op === 'session.attest')?.panelSecret).not.toBe(LEGACY_SECRET)
  else expect(fixture.witnesses()?.[SESSION_KEY]?.loadId).toBe('previous-load')
  expect(fixture.toasts).toHaveLength(0)
})

test('Утерянный ключ после конфликта меняет эпоху и повторяет свидетельство один раз', async ($, on) => {
  const fixture = host(on, { conflictFirst: true })
  await $.prompt.submit({ text: OWNER, origin: { kind: 'composer' }, wait: false }); await fixture.clock.settle()
  const registrations = fixture.calls.filter(call => call.op === 'session.attest')
  expect(registrations).toHaveLength(2)
  expect(registrations[1]?.session.sessionId).toMatch(/^capture-session\.cockpit-1-[a-f0-9]{8}$/)
  expect(registrations[1]?.panelSecret).not.toBe(registrations[0]?.panelSecret)
  const capture = fixture.calls.find(call => call.op === 'capture.prompt')
  expect(capture?.session.sessionId).toBe(registrations[1]?.session.sessionId)
  expect(fixture.calls.filter(call => call.op === 'capture.prompt')).toHaveLength(1)
  expect(fixture.toasts).toHaveLength(0)
})

test('Отказ обеих эпох даёт понятный текст один раз и сохраняет локальный захват', async ($, on) => {
  const fixture = host(on, { conflict: true })
  await $.prompt.submit({ text: OWNER, origin: { kind: 'composer' }, wait: false }); await fixture.clock.settle()
  expect(fixture.calls.filter(call => call.op === 'session.attest')).toHaveLength(2)
  expect(fixture.calls.filter(call => call.op === 'capture.prompt')).toHaveLength(1)
  expect(fixture.calls.some(call => HUMAN_WRITES.includes(call.op))).toBe(false)
  expect(fixture.models).toHaveLength(0)
  expect(fixture.toasts).toEqual(['Задачи не сохранены: доступ не подтверждён. Перезапусти сессию.'])
})

test('Вторая копия читает snapshot, не пишет и не меняет чужую эпоху', async ($, on) => {
  const fixture = host(on, { otherCopy: true })
  await $.classic.SessionStart({ source: 'resume', cwd: '/fixture', session_id: 'capture-session' })
  await $.prompt.submit({ text: OWNER, origin: { kind: 'bridge' }, wait: false }); await fixture.clock.settle()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'capture-session', resume: { id: 'capture-session' } })
  expect(fixture.calls.map(call => call.op)).toEqual(['snapshot', 'snapshot', 'tasks.page', 'tasks.context'])
  expect(fixture.models).toHaveLength(0)
  expect(fixture.witnessWrites()).toBe(0)
  expect(fixture.witnesses()?.['["capture-session","/fixture"]']?.loadId).toBe('previous-load')
  expect(fixture.toasts).toHaveLength(0)
})

test('Параллельные запросы при конфликте разделяют одну смену эпохи', async ($, on) => {
  const fixture = host(on, { conflictFirst: true })
  await Promise.all([$.prompt.submit({ text: OWNER, origin: { kind: 'composer' }, wait: false }),
    $.prompt.submit({ text: OWNER, origin: { kind: 'bridge' }, wait: false })])
  await fixture.clock.settle()
  expect(fixture.calls.filter(call => call.op === 'session.attest')).toHaveLength(2)
  const captures = fixture.calls.filter(call => call.op === 'capture.prompt')
  expect(captures).toHaveLength(2)
  expect(captures[0]?.session.sessionId).toBe(captures[1]?.session.sessionId)
  expect(fixture.calls.filter(call => call.op === 'capture.prompt')).toHaveLength(2)
  expect(fixture.toasts).toHaveLength(0)
})

test('Команда владельца takeover передаёт запись этой копии: отметка владения меняется, панель аттестуется', async ($, on) => {
  const fixture = host(on, { otherCopy: true })
  await $.classic.SessionStart({ source: 'resume', cwd: '/fixture', session_id: 'capture-session' })
  expect(fixture.witnesses()?.['["capture-session","/fixture"]']?.ownerRoot).toBe('/other-copy')
  expect(await $.command.run({ command: 'cockpit', args: 'takeover', origin: { kind: 'composer' } } as Parameters<typeof $.command.run>[0])).toEqual({})
  const owner = fixture.witnesses()?.['["capture-session","/fixture"]']
  expect(owner?.ownerRoot).not.toBe('/other-copy'); expect(owner?.loadId).not.toBe('previous-load')
  expect(fixture.toasts).toContain('Теперь ты можешь менять задачи в этой панели.')
  await $.prompt.submit({ text: OWNER, origin: { kind: 'bridge' }, wait: false }); await fixture.clock.settle()
  expect(fixture.calls.some(call => call.op === 'session.attest' || call.op === 'session.rebind')).toBe(true)
})

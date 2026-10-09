import { expect, test } from 'claude-code/testing'
import { TASK } from './fixtures'
import { PANEL, taskPanelHost, drawnText } from './task-panel-host'
import type { Task } from '../types'
import type { TaskCardsProps } from '../hooks/tasks'
import type { EditorProps } from '../hooks/editor'

const description = 'Исправить перенос строк в карточке задачи. '.repeat(12)
const summary = 'Исправить перенос строк в карточке задачи.'
const chosen: Task = { ...TASK, taskId: 'summary-task', alias: 'TASK-2', title: 'Исправить перенос строк', description,
  stage: 'task', certainty: 'confirmed', certaintySource: 'user', certaintyProvenance: 'panel' }

function fixture(on: Parameters<typeof taskPanelHost>[0], output: string | null = summary, initial = chosen) {
  let live = initial, calls = 0
  const prompts: string[] = []
  const claimed = new Set<number>()
  const host = taskPanelHost(on, { focus: live, tasks: [live], paging: true, rpc(request) {
    const result = (value: unknown) => JSON.stringify({ v: 1, ok: true, result: value })
    if (request.op === 'task.summary.claim') {
      if (claimed.has(live.revision) || [...(live.description ?? '')].length <= 300) return result({ claimed: false })
      claimed.add(live.revision)
      return result({ claimed: true, descriptionHash: String(live.revision).padStart(64, '0'), description: live.description })
    }
    if (request.op === 'task.summary.report') return result({ summary: request.args.summary && [...request.args.summary].length <= 300 && request.args.summary.includes('перенос') ? request.args.summary : null })
    return undefined
  } })
  on('model.complete', (_$, e) => {
    calls++
    prompts.push(e.prompt)
    expect(e.model).toBe('haiku'); expect(e.maxTokens).toBe(256); expect(e.timeoutMs).toBe(8000); expect(e.effort).toBe('low')
    const usage = { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: output === null ? { isAnswered: false, reason: 'aborted', usage } : { isAnswered: true, text: output, usage } }
  })
  return { ...host, prompts, models: () => calls, edit(text: string) { live = { ...live, revision: live.revision + 1, description: text }; host.changeTask(live, true) } }
}

test('SUMMARY-233: одна модель на редакцию, ноль из render/hover/i, полный текст на странице', { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = fixture(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.settle(); await pane.redraw()
  expect(host.models()).toBe(0)
  await host.clock.advance(1000); await host.clock.settle(); await pane.redraw()
  expect(host.calls.map(call => call.op)).toContain('task.summary.claim')
  expect(host.models()).toBe(1)
  expect(host.calls.find(call => call.op === 'task.summary.report')?.args.metrics).toEqual({
    durationMs: 0, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 })
  const props = (await pane.find({ key: 'rows', type: 'Client' }))?.props.props as TaskCardsProps
  const card = props.rows.find(row => row.kind === 'card' && row.taskId === chosen.taskId)
  expect(card?.kind === 'card' && card.details?.join(' ')).toBe(summary)
  await pane.key({ in: 'rows', key: 'i' })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain(summary)
  await pane.pointer({ in: 'rows', type: 'move', x: 3, y: 2 }); await pane.advance(200)
  await host.clock.advance(3000); await pane.redraw()
  expect(host.models()).toBe(1)
  await pane.key({ in: 'rows', key: 'return' })
  await pane.key({ in: 'page-content', key: 'e' })
  const editor = (await pane.find({ key: `page-description:${chosen.taskId}` }))?.props.props as EditorProps
  expect(editor.value).toBe(description)
  await pane.key({ in: `page-description:${chosen.taskId}`, key: 'escape' })
  await pane.press({ key: 'page-back' })
  host.edit('Добавить поиск комментариев в списке задач. '.repeat(12))
  await host.clock.advance(1000); await host.clock.settle()
  expect(host.models()).toBe(2)
  await pane.unmount()
})

test('SUMMARY-233: секрет маскируется до модельного вызова, исходник для страницы сохраняется', async ($, on) => {
  const secret = 'gh' + 'p_' + 'q'.repeat(36)
  const host = fixture(on, summary, { ...chosen, description: description + secret })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.advance(1000); await host.clock.settle()
  expect(host.models()).toBe(1)
  expect(host.prompts[0]).not.toContain(secret)
  expect(host.prompts[0]).toContain('[REDACTED:')
  await pane.unmount()
})

for (const limit of [0, 300]) test(`SUMMARY-233: описание ${limit} знаков не вызывает модель`, async ($, on) => {
  const host = fixture(on, summary, { ...chosen, description: 'а'.repeat(limit) })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.advance(5000)
  expect(host.models()).toBe(0)
  expect(host.calls.filter(call => call.op === 'task.summary.claim')).toHaveLength(0)
  await pane.unmount()
})

test('SUMMARY-233: вкладка Мне не запускает пересказ поручений и приёмки', async ($, on) => {
  const host = fixture(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await pane.press({ key: 'tab-owner' })
  await host.clock.advance(5000)
  expect(host.models()).toBe(0)
  expect(host.calls.filter(call => call.op === 'task.summary.claim')).toHaveLength(0)
  await pane.unmount()
})

for (const working of [false, true]) test(`SUMMARY-233: кеш в ${working ? 'workingTasks' : 'queue'} сразу раскрывается без модели и task.get`, async ($, on) => {
  const saved = { ...chosen, summary }
  const host = taskPanelHost(on, { tasks: working ? [] : [saved], workingTasks: working ? [saved] : [], paging: true })
  on('model.complete', () => { throw new Error('Готовая сводка не вызывает модель') })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.settle(); await pane.redraw()
  const props = (await pane.find({ key: 'rows', type: 'Client' }))?.props.props as TaskCardsProps
  const card = props.rows.find(row => row.kind === 'card')
  expect(card?.kind === 'card' && card.details).toEqual([summary])
  const before = host.calls.length
  await pane.key({ in: 'rows', key: 'i' }); await host.clock.advance(1000); await pane.redraw()
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain(summary)
  expect(host.calls.slice(before).filter(call => call.op === 'task.get' || call.op.startsWith('task.summary'))).toHaveLength(0)
  await pane.unmount()
})

for (const output of [null, '', 'а'.repeat(301), 'Погода на море прекрасная.']) test(`SUMMARY-233: отказ (${output === null ? 'недоступна' : output.length}) оставляет начало и не повторяется`, async ($, on) => {
  const host = fixture(on, output)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.settle(); await host.clock.advance(1000); await host.clock.settle()
  await host.clock.advance(4000); await pane.redraw()
  expect(host.models()).toBe(1)
  const props = (await pane.find({ key: 'rows', type: 'Client' }))?.props.props as TaskCardsProps
  const card = props.rows.find(row => row.kind === 'card')
  expect(card?.kind === 'card' && card.details?.join(' ').length).toBeGreaterThan(summary.length)
  await pane.unmount()
})

test('SUMMARY-233: настройка false запрещает даже захват для модели', { options: { summarizeDescriptions: false } }, async ($, on) => {
  const host = fixture(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const pane = await $.ui.mount(PANEL)
  await host.clock.advance(5000)
  expect(host.models()).toBe(0)
  expect(host.calls.filter(call => call.op === 'task.summary.claim')).toHaveLength(0)
  await pane.unmount()
})

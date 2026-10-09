import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Task, OwnerTask } from '../types'
import type { Request } from '../hooks/domain/rpc'
import { parseResponse } from '../hooks/domain/rpc'
import { taskPanelHost, PANEL, drawnText, elements } from './task-panel-host'
import { TASK } from './fixtures'
import { inputEditor } from './editor-driver'
import { cellWidth } from '../hooks/layout'

const REVIEW: OwnerTask = { id: 23, title: 'Проверить результат', why: 'Проверь панель.', kind: 'choose',
  options: ['Принято', 'Есть замечания'], taskAlias: 'TASK-1', state: 'open', update: 'none',
  sessionId: 'fixture-session', createdMs: 1, updatedMs: 1 }

function returnHost(on: On, count = 0, unavailable = false) {
  let task = { ...TASK, stage: 'task' as const, certaintySource: 'agent' as const, status: 'done' as const,
    returnCount: count, ...(count ? { status: 'active', returnContext: { result: 'Прежний итог', ownerComment: 'Ширина неверна' } } : {}) } as Task
  const mutations: Request[] = []
  const comments: string[] = []
  const world = taskPanelHost(on, { tasks: [task], paging: true, rpc: request => {
    const wire = (result: unknown, missing = false) => JSON.stringify(missing
      ? { v: 1, ok: false, error: { code: 'NOT_FOUND', message: 'Нет задачи' } } : { v: 1, ok: true, result })
    if (request.op === 'task.resolve') return wire({ ...task }, unavailable)
    if (request.op === 'task.get') return wire({ task, comments: [], agentNotes: [] }, unavailable)
    if (request.op === 'focus.get') return wire({ task: null, revision: 0 })
    if (request.op === 'tasks.agent.create') return wire({ tasks: [{ taskId: task.taskId, alias: task.alias, title: task.title, revision: task.revision, duplicate: true }] })
    if (request.op === 'task.reopen') {
      mutations.push(request)
      const args = request.args as typeof request.args & { place?: string; comment?: string }
      if (args.comment) comments.push(args.comment)
      task = { ...task, status: 'active', revision: task.revision + 1, returnCount: count + 1,
        returnContext: { result: 'Прежний итог', ownerComment: args.comment || null } } as Task
      world.setTasks([task]); return wire({ task, focus: { task: null, revision: 0 } })
    }
    if (request.op === 'task.agent.action') {
      mutations.push(request)
      task = { ...task, status: request.args.action === 'done' ? 'done' : 'active', revision: task.revision + 1 }
      world.setTasks([task])
      return wire({ task, focus: { task: request.args.action === 'done' ? null : task, revision: 1 }, note: null })
    }
    return undefined
  } })
  return { world, mutations, comments, get task() { return task } }
}

for (const comment of ['Графики сбросились', '']) test(`RETURN-231: замечание возвращает ту же задачу одним запросом: ${comment || 'пустое'}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = returnHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  host.world.setOwners([REVIEW])
  const pane = await $.ui.mount(PANEL)
  await pane.press({ key: 'tab-owner' }); await pane.press({ key: 'owner-reject' })
  await inputEditor(pane, { key: 'owner-answer-input', text: comment })
  await host.world.clock.advance(1000); await host.world.clock.settle()
  expect(host.mutations).toHaveLength(1)
  expect(host.mutations[0]).toMatchObject({ op: 'task.reopen', actor: 'owner', args: { taskId: TASK.taskId, place: 'top', comment } })
  expect(host.task.status).toBe('active')
  expect(host.comments).toEqual(comment ? [comment] : [])
  expect(host.world.owners[0]?.state).toBe('rejected')
  expect(host.world.submitted[0]).toContain('Задача #1 возвращена в очередь с замечанием')
  expect(host.world.submitted[0]).toContain('task_start')
  expect(host.world.submitted[0]).toContain('новую задачу не заводи')
  expect(host.world.submitted[0]).not.toContain('новой задачей')
  await pane.unmount()
})

for (const verdict of ['accepted', 'unavailable'] as const) test(`RETURN-231: прежнее поведение: ${verdict}`, async ($, on) => {
  const host = returnHost(on, 0, verdict === 'unavailable')
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  host.world.setOwners([REVIEW])
  const pane = await $.ui.mount(PANEL)
  await pane.press({ key: 'tab-owner' })
  if (verdict === 'accepted') await pane.press({ key: 'owner-done' })
  else { await pane.press({ key: 'owner-reject' }); await inputEditor(pane, { key: 'owner-answer-input', text: 'Нет задачи' }) }
  await host.world.clock.advance(1000); await host.world.clock.settle()
  expect(host.mutations).toEqual([])
  expect(host.world.owners[0]?.state).toBe(verdict === 'accepted' ? 'done' : 'rejected')
  expect(host.world.submitted[0]).toContain(verdict === 'accepted' ? '«Принято» — ничего не делать' : 'новой задачей')
  await pane.unmount()
})

for (const count of [0, 1, 2]) test(`RETURN-231: task_start сообщает прежнюю попытку только после возврата ${count}`, async ($, on) => {
  returnHost(on, count)
  const response = await $.tool.call({ tool: 'mcp__cockpit__task_start', taskId: 'TASK-1' })
  if (!count) expect(response.result).not.toContain('Уже пробовали')
  else {
    expect(response.result).toContain(`Уже пробовали — возврат ${count}`)
    expect(response.result).toContain('Прежний итог агента: Прежний итог')
    expect(response.result).toContain('Замечание владельца: Ширина неверна')
  }
})

test('RETURN-231: task_add со start берёт существующую возвращённую задачу и даёт контекст', async ($, on) => {
  const host = returnHost(on, 2)
  const response = await $.tool.call({ tool: 'mcp__cockpit__task_add', title: TASK.title, start: true })
  expect(response.result).toContain('Отброшено как дубль: 1')
  expect(response.result).toContain('Уже пробовали — возврат 2')
  expect(host.mutations).toHaveLength(1)
  expect(host.mutations[0]).toMatchObject({ op: 'task.agent.action', args: { taskId: TASK.taskId, action: 'current' } })
})

test('RETURN-231: повторное закрытие создаёт новую карточку приёмки', async ($, on) => {
  const host = returnHost(on, 1)
  await $.tool.call({ tool: 'mcp__cockpit__task_start', taskId: 'TASK-1' })
  await $.tool.call({ tool: 'mcp__cockpit__task_list' })
  const response = await $.tool.call({ tool: 'mcp__cockpit__task_done', taskId: 'TASK-1', note: 'Исправлена ширина', review: 'Проверь новую ширину.' })
  expect(response.deny).toBeUndefined()
  expect(response.result).toContain('Проверка передана владельцу')
  expect(host.world.owners).toHaveLength(1)
  expect(host.world.owners[0]).toMatchObject({ taskAlias: 'TASK-1', state: 'open', options: ['Принято', 'Есть замечания'] })
})

for (const width of [14, 40, 100]) for (const count of [0, 1, 2]) for (const list of ['queue', 'closed'] as const) {
  test(`RETURN-231: отметка на рамке ${width}, ${count}, ${list}`, { options: { glyphs: 'plain' } }, async ($, on) => {
    const task = { ...TASK, stage: 'task' as const, certaintySource: 'agent' as const, status: list === 'closed' ? 'done' as const : 'active' as const,
      returnCount: count, discussionCount: 2 } as Task
    const world = taskPanelHost(on, { tasks: [task], paging: true })
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, bodyColumns: width } })
    if (list === 'closed') await pane.press({ key: 'tab-history' })
    const tree = await pane.drawn({ in: 'rows' })
    const nodes = elements(tree)
    const badge = nodes.find(node => node.props.key === `return-frame:${task.taskId}`)
    expect(drawnText(nodes.find(node => node.props.key === `number-frame:${task.taskId}`))).toContain('#1')
    if (!count) expect(badge).toBeUndefined()
    else if (width >= 40) { expect(drawnText(badge)).toContain(`↶ ${count}`); expect(badge?.props.top).toBe(0); expect(badge?.props.height).toBe(1) }
    const frame = nodes.find(node => node.props.key === `card-slot:${task.taskId}`)!
    for (const node of nodes.filter(node => /^(number|return|discussion)-frame:/u.test(String(node.props.key)))) {
      expect(Number(node.props.left) + cellWidth(drawnText(node))).toBeLessThanOrEqual(Number(frame.props.width))
    }
    expect(world.calls.some(request => request.op === 'tasks.page')).toBe(true)
    await pane.unmount()
  })
}

test('RETURN-231: протокол отклоняет неверный счётчик и маскирует прежние тексты', () => {
  const secret = 'sk' + '-' + 'Q'.repeat(25)
  const response = (returnCount: unknown) => JSON.stringify({ v: 1, ok: true, result: { task: { ...TASK, returnCount,
    returnContext: { result: secret, ownerComment: secret } }, comments: [], agentNotes: [] } })
  expect(parseResponse('task.get', response(-1)).kind).toBe('unknown')
  expect(parseResponse('task.get', response(true)).kind).toBe('unknown')
  const result = parseResponse('task.get', response(2))
  expect(result.kind).toBe('task'); expect(JSON.stringify(result)).not.toContain(secret)
})

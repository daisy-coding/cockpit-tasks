// Прибор замера, а не проверка поведения: время зависит от нагрузки машины, поэтому имя файла не входит в набор тестов.
// Запуск — scripts/panel-benchmark.py --tests panel-metrics.test.tsx.
// Поведение страниц проверяют tests/tasks-pages.test.tsx и tests/task-list-pages.test.ts.
import { expect, test } from 'claude-code/testing'
import { TASK } from '../tests/fixtures'
import { PANEL, taskPanelHost } from '../tests/task-panel-host'
import type { TaskCardsProps } from '../hooks/tasks'

const tasksFor = (count: number) => Array.from({ length: count }, (_, index) => ({ ...TASK, taskId: `page-${index + 1}`, alias: `TASK-${index + 1}`,
  stage: 'task' as const, certainty: 'confirmed' as const, certaintySource: 'user' as const, certaintyProvenance: 'panel' as const,
  title: `Проверить задачу ${index + 1}`, priority: 2 as const, queuePosition: index + 1 }))

for (const count of [100, 500, 1000]) test(`Время панели ${count}: открытие, прокрутка и действие`,
  { options: { glyphs: 'plain' } }, async ($, on) => {
    const host = taskPanelHost(on, { tasks: tasksFor(count), paging: true })
    let at = performance.now(), calls = 0, bytes = 0
    const record = async (stage: string) => {
      const elapsedMs = performance.now() - at
      const props = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
      const totalBytes = host.bytes.reduce((sum, size) => sum + size, 0)
      console.log(JSON.stringify({ panelMeasure: true, count, stage, elapsedMs, bytes: totalBytes - bytes,
        rpc: host.calls.length - calls, operations: host.calls.slice(calls).map(call => call.op), clientRows: props.rows.length }))
      expect(props.rows.length).toBeLessThan(20)
      at = performance.now(); calls = host.calls.length; bytes = totalBytes
    }
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    await $.command.run({ command: 'tasks', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 84 } })
    const pane = await $.ui.mount(PANEL)
    await record('open')
    const paged = host.calls.some(call => call.op === 'tasks.page')
    for (let page = 0; page < (paged ? count / 50 - 1 : 1); page++) {
      const previous = host.calls.filter(call => call.op === 'tasks.page').length
      await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 10000, bodyRows: 30, contentRows: 30, origin: { kind: 'person' } })
      await host.clock.settle()
      expect(host.calls.filter(call => call.op === 'tasks.page').length - previous).toBeLessThanOrEqual(1)
    }
    await pane.key({ in: 'rows', key: 'end' })
    await host.clock.settle()
    await record('scrollEnd')
    const actionStart = host.calls.length
    await pane.key({ in: 'rows', key: 'u' })
    await record('action')
    if (paged) {
      expect(host.calls.slice(actionStart).filter(call => call.op === 'tasks.page').length).toBeLessThanOrEqual(2)
      const props = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
      expect(props.rows.some(row => row.kind === 'card' && row.selected && row.taskId === `page-${count}`)).toBe(true)
    }
    await pane.unmount()
  })

for (const count of [100, 500, 1000]) test(`Время панели ${count}: повторная отрисовка`,
  { options: { glyphs: 'plain' } }, async ($, on) => {
    const host = taskPanelHost(on, { tasks: tasksFor(count), paging: true })
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    const pane = await $.ui.mount(PANEL)
    const samplesMs: number[] = [], held = host.calls.length
    for (let sample = 0; sample < 10; sample++) {
      const started = performance.now()
      await pane.redraw()
      samplesMs.push(performance.now() - started)
    }
    expect(host.calls.length).toBe(held)
    console.log(JSON.stringify({ panelMeasure: true, count, stage: 'render', samplesMs }))
    await pane.unmount()
  })

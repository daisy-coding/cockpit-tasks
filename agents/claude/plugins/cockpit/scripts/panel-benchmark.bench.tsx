// Прибор замера, а не проверка поведения: время зависит от нагрузки машины, поэтому имя файла не входит в набор тестов.
// Запуск — scripts/panel-benchmark.py: он кладёт файл в отдельную копию мода под именем теста.
import { expect, test } from 'claude-code/testing'
import { TASK } from '../tests/fixtures'
import { PANEL, taskPanelHost } from '../tests/task-panel-host'
import type { TaskCardsProps } from '../hooks/tasks'

const tasks = Array.from({ length: 1000 }, (_, index) => ({ ...TASK, taskId: `page-${index + 1}`, alias: `TASK-${index + 1}`,
  stage: 'task' as const, certainty: 'confirmed' as const, certaintySource: 'user' as const, certaintyProvenance: 'panel' as const,
  title: `Проверить задачу ${index + 1}`, priority: 2 as const, queuePosition: index + 1 }))

for (const count of [100, 500, 1000]) test(`Замер панели ${count}: открытие, весь список и одно действие`,
  { options: { glyphs: 'plain' } }, async ($, on) => {
    const host = taskPanelHost(on, { tasks: tasks.slice(0, count), paging: true })
    let calls = 0, bytes = 0
    const record = async (stage: string) => {
      const props = (await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps
      const totalBytes = host.bytes.reduce((sum, n) => sum + n, 0)
      console.log(JSON.stringify({ panelMeasure: true, count, stage, rpc: host.calls.length - calls, bytes: totalBytes - bytes,
        operations: host.calls.slice(calls).map(call => call.op), clientRows: props.rows.length }))
      calls = host.calls.length; bytes = totalBytes
      expect(props.rows.length).toBeLessThan(20)
    }
    await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
    await $.command.run({ command: 'tasks', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 84 } })
    const pane = await $.ui.mount(PANEL)
    await record('open')
    const paged = host.calls.some(call => call.op === 'tasks.page')
    for (let page = 0; page < (paged ? count / 50 - 1 : 1); page++) {
      await $.ui.scroll({ component: 'Pane', requestId: 'tasks', offset: 0, by: 10000, bodyRows: 30, contentRows: 30, origin: { kind: 'person' } })
      await host.clock.settle()
    }
    await pane.key({ in: 'rows', key: 'end' })
    await host.clock.settle()
    if (paged) expect(host.calls.filter(call => call.op === 'tasks.page' && call.args.limit === 50)).toHaveLength(count / 50)
    await record('scrollEnd')
    await pane.key({ in: 'rows', key: 'u' })
    await record('action')
    expect(host.calls.some(call => call.op === 'task.action')).toBe(true)
    await pane.unmount()
  })

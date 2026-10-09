import { expect, test } from 'claude-code/testing'
import type { EditorProps } from '../hooks/editor'
import { editorRows } from '../hooks/editor'
import { PANEL, taskPanelHost, elements, drawnText, framePreview } from './task-panel-host'
import { inputEditor, pasted, promptEditHost } from './editor-driver'
import { TASK } from './fixtures'

for (const width of [40, 84]) test(`EMPTY-EDITOR: поле сразу видно без фокуса, верхняя линия пуста: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  taskPanelHost(on)
  const pane = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, bodyColumns: width } })
  const field = await pane.find({ key: 'new-task', type: 'Client' })
  expect(field).toBeDefined()
  const props = field!.props.props as EditorProps
  expect(props).toMatchObject({ placeholder: 'Новая задача', value: '', height: 3, focused: false })
  const tree = await pane.drawn({ in: 'new-task' })
  expect(drawnText(tree)).toContain('Новая задача')
  expect(drawnText(tree)).not.toContain('[Enter]')
  const title = elements(tree).find(node => node.type === 'Box' && node.props.position === 'absolute' && node.props.top === 0 && node.props.left === 2 && !node.props.key)
  expect(title).toBeDefined()
  expect(drawnText(title!)).toBe('')
  const rows = await pane.drawn({ in: 'rows' })
  expect(drawnText(rows)).not.toContain('Задач пока нет')
  expect(drawnText(rows)).not.toContain('Первая задача:')
  const idle = framePreview(tree, 'new-task-frame')
  await inputEditor(pane, { key: 'new-task', text: 'Проверить значки вкладок панели и перенос длинного названия новой задачи на узком экране', kind: 'change' })
  const typed = framePreview(await pane.drawn({ in: 'new-task' }), 'new-task-frame')
  console.log(`EMPTY-PREVIEW ${width} idle\n${idle}\nEMPTY-PREVIEW ${width} typed\n${typed}\nEND-EMPTY-PREVIEW`)
  await pane.unmount()
})

for (const width of [40, 84]) test(`EMPTY-EDITOR: переносы, каретка, вставка и Enter создают первую задачу: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on)
  const edits = promptEditHost(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  host.restoreProjection()
  const pane = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, bodyColumns: width } })
  expect(await pane.find({ key: 'new-task', type: 'Client' })).toBeDefined()
  await pane.pointer({ in: 'new-task', type: 'down', x: 2, y: 1, button: 'left' })
  const text = 'Проверить значки вкладок панели и длинные названия на узком экране '.repeat(2).trim()
  await inputEditor(pane, { key: 'new-task', text, kind: 'change' })
  expect(editorRows(text, width - 5).length).toBeGreaterThan(1)
  await pane.key({ in: 'new-task', key: 'home', ctrl: true })
  const paste = pasted('Новая строка\n')
  expect(await $.prompt.edit(paste)).toEqual({ text: paste.text, cursor: paste.cursor })
  expect(edits).toHaveLength(0)
  const field = (await pane.find({ key: 'new-task', type: 'Client' }))!.props.props as EditorProps
  expect(field.value).toBe(paste.inputText + text)
  await pane.key({ in: 'new-task', key: 'return' })
  expect(host.calls.filter(call => call.op === 'task.create')).toHaveLength(1)
  expect(host.calls.find(call => call.op === 'task.create')!.args).toMatchObject({ title: paste.inputText + text })
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('Проверить значки')
  await pane.press({ key: 'new' })
  expect(((await pane.find({ key: 'new-task', type: 'Client' }))!.props.props as EditorProps).value).toBe('')
  await pane.unmount()
})

test('EMPTY-EDITOR: режим только чтения оставляет прежний пустой вид', { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on, { readOnly: true, tasks: [{ ...TASK, status: 'paused' }] })
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  host.restoreProjection()
  const pane = await $.ui.mount(PANEL)
  expect(await pane.find({ key: 'new-task', type: 'Client' })).toBeUndefined()
  expect(drawnText(await pane.drawn({ in: 'rows' }))).toContain('Задач пока нет')
  expect(host.calls.some(call => call.op === 'task.create')).toBe(false)
  await pane.unmount()
})

test('EMPTY-EDITOR: бэклог не открывает поле, плюс в непустом списке работает как прежде', { options: { glyphs: 'plain' } }, async ($, on) => {
  taskPanelHost(on, { tasks: [{ ...TASK, certainty: 'confirmed', certaintySource: 'user', certaintyProvenance: 'panel' }] })
  const pane = await $.ui.mount(PANEL)
  expect(await pane.find({ key: 'new-task', type: 'Client' })).toBeUndefined()
  await pane.press({ key: 'new' })
  expect(await pane.find({ key: 'new-task', type: 'Client' })).toBeDefined()
  await pane.press({ key: 'new' })
  expect(await pane.find({ key: 'new-task', type: 'Client' })).toBeUndefined()
  await pane.press({ key: 'tab-backlog' })
  expect(await pane.find({ key: 'new-task', type: 'Client' })).toBeUndefined()
  await pane.unmount()
})

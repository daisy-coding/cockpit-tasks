import { expect, test } from 'claude-code/testing'
import type { OwnerTask } from '../types'
import { ownerLayout, parseAsk } from '../hooks/owner/tasks'
import type { OwnerCardsProps } from '../hooks/owner/cards'
import type { PanelActionsProps } from '../hooks/panel-actions'
import { actionCaption } from '../hooks/panel-actions'
import { cellWidth, SINGLE_CELL_TEXT } from '../hooks/layout'
import { DEFAULT_THEME, roleColors } from '../hooks/theme'
import { ownerShownTitle, savedCardOf, savedTitle, savedTone } from '../hooks/owner/saved-cards'
import { PANEL, taskPanelHost, elements, drawnText, framePreview } from './task-panel-host'

const OPEN: OwnerTask = { id: 4, title: 'Значки вкладок панели', why: 'Проверь значки вкладок и переносы строк. '.repeat(5).trim(),
  kind: 'do', state: 'open', update: 'none', sessionId: 'fixture-session', createdMs: 1, updatedMs: 1 }
const SAVED: OwnerTask[] = [
  { ...OPEN, id: 1, title: 'Проверить: длинное описание результата', taskTitle: 'Исправить: значки вкладок съезжают', taskAlias: 'TASK-86', result: 'Значки вкладок выровнены',
    state: 'done', answer: 'Принято', update: 'pending' },
  { ...OPEN, id: 2, title: 'Переносы строк', state: 'rejected', reason: 'Есть замечания', update: 'pending' },
  { ...OPEN, id: 3, title: 'Результаты тестов на Mac', kind: 'answer', state: 'done', answer: 'Проверка выполнена', update: 'pending' },
]

test('SAVED-CARDS: три сохранённых ответа занимают девять строк', () => {
  const layout = ownerLayout(SAVED, null, null, 30, 84, 30, OPEN.sessionId, true, false, null, true, 0, true)
  expect(layout.saved).toHaveLength(3)
  expect(layout.height).toBe(9)
})

for (const width of [40, 84]) test(`SAVED-RESERVE: тридцать ответов оставляют восемь строк раскрытию: ${width}`, () => {
  const saved = Array.from({ length: 30 }, (_, index) => ({ ...SAVED[0]!, id: index + 10 }))
  const layout = ownerLayout([OPEN, ...saved], OPEN.id, null, 20, width, 20, OPEN.sessionId, true, false, null, true, 0, true)
  const reserve = Math.min(8, layout.cards[0]!.details!.length)
  const count = Math.floor((20 - layout.cardsHeight - reserve - 1) / 3)
  expect(layout.saved).toHaveLength(count)
  expect(layout.hiddenSaved).toBe(30 - count)
  expect(layout.more).toBe(true)
  expect(layout.cardsHeight + reserve + layout.saved.length * 3 + 1).toBeLessThanOrEqual(20)
})

for (const width of [40, 84]) for (const glyphs of ['plain', 'nerd'] as const)
  test(`SAVED-CARDS: рамка, исход, название и отправка в общем клиенте: ${width}, ${glyphs}`, { options: { glyphs } }, async ($, on) => {
    const host = taskPanelHost(on)
    await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
    host.setOwners(SAVED)
    const pane = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, bodyColumns: width } })
    await pane.press({ key: 'tab-owner' })
    const props = (await pane.find({ key: 'owner-cards', type: 'Client' }))!.props.props as OwnerCardsProps
    expect(props.cards).toHaveLength(3)
    const tree = await pane.drawn({ in: 'owner-cards' })
    const nodes = elements(tree)
    const roles = roleColors(DEFAULT_THEME)
    for (const [index, task] of SAVED.entries()) {
      const frame = nodes.find(node => node.props.key === `owner-saved-${task.id}`)!
      expect(frame.type).toBe('Box')
      expect(frame.props).toMatchObject({ borderStyle: 'round', height: 3 })
      const numberFrame = nodes.find(node => node.props.key === `owner-number-frame-${task.id}`)!
      const number = elements(numberFrame).find(node => node.type === 'Text')!
      const mark = glyphs === 'plain' ? ['✓', '×', '…'][index] : ['\u{f05e0}', '\u{f0159}', '\u{f0188}'][index] // md-check_circle, md-close_circle, md-comment_text
      expect(drawnText(number)).toBe(` ${mark}${task.taskAlias ? ' #86' : ''} `)
      expect(number.props.color).toBe([roles.ok, roles.fail, roles.muted][index])
      const action = nodes.find(node => node.props.key === `owner-send-${task.id}`)!
      expect(action.type).toBe('Button')
      expect(action.props.label).toBe(glyphs === 'plain' ? '>' : '\u{f048a}') // md-send
      if (glyphs === 'plain') { expect(SINGLE_CELL_TEXT.test(String(action.props.label))).toBe(true); expect(cellWidth(String(action.props.label))).toBe(1) }
      const body = elements(frame).filter(node => node.type === 'Text')
      expect(body).toHaveLength(1)
      expect(body[0]!.props.color).toBe(roles.fg)
      expect(cellWidth(drawnText(body[0]!))).toBeLessThanOrEqual(width - 4)
    }
    // TITLE-217: ответ владельца носит то же название, что и карточка приёмки, — итог агента, а не название задачи.
    expect(drawnText(nodes.find(node => node.props.key === 'owner-saved-1')!)).toBe('Значки вкладок выровнены')
    expect(drawnText(tree)).not.toContain('не отправлен')
    expect(drawnText(tree)).not.toContain('Исправить:')
    const header = (await pane.find({ type: 'Client', key: 'panel-header' }))!.props.props as PanelActionsProps
    const send = header.actions.find(action => action.key === 'owner-send-1')!
    expect(send.hidden).toBe(true)
    expect(actionCaption(send)).toBe(`${send.label} Отправить`)
    await pane.press({ key: 'owner-send-1' })
    expect(host.submitted).toHaveLength(1)
    expect(host.owners.every(task => task.update === 'delivered')).toBe(true)
    await pane.unmount()
  })

for (const width of [40, 84]) test(`SAVED-HOVER: ответы не отнимают раскрытие и не дают согласие без показа: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  host.setOwners([OPEN, ...Array.from({ length: 30 }, (_, index) => ({ ...SAVED[0]!, id: index + 10 }))])
  const pane = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, bodyColumns: width, scroll: { offset: 0, bodyRows: 23 } } })
  await pane.press({ key: 'tab-owner' })
  const props = (await pane.find({ key: 'owner-cards', type: 'Client' }))!.props.props as OwnerCardsProps
  const active = props.cards.find(card => card.id === OPEN.id)!
  const rest = props.cards.reduce((sum, card) => sum + card.height, 0)
  const idle = ownerPreview(props, await pane.drawn({ in: 'owner-cards' }))
  expect(props.height - rest).toBeGreaterThanOrEqual(Math.min(8, active.details!.length))
  expect(await pane.find({ in: 'owner-cards', key: 'owner-read', type: 'Button' })).toBeUndefined()
  await pane.press({ key: 'owner-done' })
  expect(host.owners.find(task => task.id === OPEN.id)!.state).toBe('open')
  await pane.pointer({ in: 'owner-cards', type: 'move', x: 3, y: 1 })
  await pane.advance(200)
  expect(drawnText(await pane.drawn({ in: 'owner-cards' }))).toContain('Проверь значки вкладок')
  const more = await pane.find({ key: 'owner-more', type: 'Button' })
  console.log(`OWNER-PREVIEW ${width} thirty-idle\n${idle}\n${more?.props.label ?? ''}\nOWNER-PREVIEW ${width} thirty-hover\n${ownerPreview(props, await pane.drawn({ in: 'owner-cards' }))}\n${more?.props.label ?? ''}\nEND-OWNER-PREVIEW`)
  await pane.press({ key: 'owner-done' })
  expect(host.owners.find(task => task.id === OPEN.id)!.state).toBe('done')
  await pane.unmount()
})

test('TITLE-217: приёмка и ответ на неё показывают одно название — при согласии и при отказе', () => {
  const review: OwnerTask = { ...OPEN, id: 9, title: 'Проверить: Крестик открывает поле причины', taskAlias: 'TASK-212',
    taskTitle: 'Исправить: при отказе нет поля причины', result: 'Крестик открывает поле причины' }
  for (const answered of [{ ...review, state: 'done' as const, answer: 'Принято' }, { ...review, state: 'done' as const, answer: 'Есть замечания', reason: 'Не то' }, { ...review, state: 'rejected' as const }]) {
    expect(savedCardOf(answered, 60).titleLines).toEqual([ownerShownTitle(review)])
    expect(savedCardOf(answered, 60).titleLines).toEqual(['Крестик открывает поле причины'])
  }
  // Прежняя карточка без итога агента показывает название задачи; самостоятельное поручение — своё название.
  expect(savedCardOf({ ...review, result: undefined, state: 'done', answer: 'Принято' }, 60).titleLines).toEqual(['Исправить: при отказе нет поля причины'])
  expect(savedCardOf({ ...OPEN, state: 'done' }, 60).titleLines).toEqual(['Значки вкладок панели'])
})

test('SAVED-TITLE: описание инструмента просит короткое имя, прежние 80 знаков принимаются', async ($, on) => {
  const host = taskPanelHost(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  const spec = host.tools.find(tool => tool.name === 'assign_task')
  expect(JSON.stringify(spec)).toContain('50')
  expect(JSON.stringify(spec)).toContain('Значки вкладок панели')
  expect(parseAsk({ title: 'а'.repeat(80), why: 'Контекст', kind: 'do' })).not.toHaveProperty('error')
})

function ownerPreview(props: OwnerCardsProps, tree: Parameters<typeof elements>[0]): string {
  const nodes = elements(tree)
  const view = props.cards.map(card => framePreview(nodes.find(node => node.props.key === `owner-card-slot-${card.id}`)!, `owner-${card.saved ? 'saved' : 'task'}-${card.id}`)).join('\n')
  for (const line of view.split('\n')) expect(cellWidth(line)).toBeLessThanOrEqual(props.width)
  expect(view.split('\n').length).toBeLessThanOrEqual(props.height)
  return view
}

for (const width of [40, 84]) test(`SAVED-PREVIEW: три исхода рядом с поручением, покой и наведение: ${width}`, { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  host.setOwners([OPEN, ...SAVED])
  const pane = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, bodyColumns: width } })
  await pane.press({ key: 'tab-owner' })
  const props = (await pane.find({ key: 'owner-cards', type: 'Client' }))!.props.props as OwnerCardsProps
  const idle = ownerPreview(props, await pane.drawn({ in: 'owner-cards' }))
  await pane.pointer({ in: 'owner-cards', type: 'move', x: 3, y: 1 })
  await pane.advance(200)
  const hover = ownerPreview(props, await pane.drawn({ in: 'owner-cards' }))
  console.log(`OWNER-PREVIEW ${width} three-idle\n${idle}\nOWNER-PREVIEW ${width} three-hover\n${hover}\nEND-OWNER-PREVIEW`)
  await pane.unmount()
})

test('SAVED-TRANSITION: раскрытое поручение после ответа сразу становится плоской карточкой', { options: { glyphs: 'plain' } }, async ($, on) => {
  const host = taskPanelHost(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  host.setOwners([OPEN])
  const pane = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, bodyColumns: 40 } })
  await pane.press({ key: 'tab-owner' })
  await pane.key({ in: 'owner-cards', key: 'i' })
  await pane.press({ key: 'owner-done' })
  const frame = await pane.find({ in: 'owner-cards', key: `owner-saved-${OPEN.id}`, type: 'Box' })
  expect(host.owners[0]).toMatchObject({ state: 'done', update: 'pending' })
  expect(frame!.props.height).toBe(3)
  expect(drawnText(frame!)).toBe(OPEN.title)
  await pane.unmount()
})

test('SAVED-CELLS: обрезка по словам сохраняет целое последнее слово и ширину графем', () => {
  expect(savedTitle('Раз два три', 8)).toBe('Раз два…')
  expect(savedTitle('Значки вкладок панели', 12)).toBe('Значки…')
  expect(savedTitle('Длинноеслово', 7)).toBe('Длинно…')
  expect(savedTitle('Название', 1)).toBe('…')
  for (const title of ['界界界界界界', 'а' + String.fromCharCode(0x301) + 'бвгдежз']) {
    const text = savedTitle(title, 5)
    expect(text.endsWith('…')).toBe(true)
    expect(cellWidth(text)).toBeLessThanOrEqual(5)
  }
})

for (const width of [40, 60, 100]) test(`SAVED-KEYS: сохранённый отказ не мешает ответить оставшемуся поручению: ${width}`, async ($, on) => {
  const host = taskPanelHost(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  host.setOwners([OPEN, { ...OPEN, id: 5, kind: 'answer', title: 'Результаты тестов' }])
  const pane = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, bodyColumns: width } })
  await pane.press({ key: 'tab-owner' })
  await pane.pointer({ in: 'owner-cards', type: 'move', x: 2, y: 4 })
  // Первое нажатие открывает поле причины, второе отклоняет без причины.
  await pane.key({ in: 'panel-header', key: 'x' })
  expect(host.owners.find(task => task.id === 5)!.state).toBe('open')
  await pane.key({ in: 'panel-header', key: 'x' })
  expect(host.owners.find(task => task.id === 5)!.state).toBe('rejected')
  await pane.pointer({ in: 'owner-cards', type: 'leave', x: 0, y: 0 })
  await pane.key({ in: 'owner-cards', key: 'i' })
  await pane.key({ in: 'owner-cards', key: 'd' })
  expect(host.owners.find(task => task.id === OPEN.id)!.state).toBe('done')
  await pane.unmount()
})

test('SAVED-OUTCOME: сделано и принятая проверка зелёные, отказ красный, слова и выбор нейтральные', () => {
  expect(savedTone({ ...OPEN, state: 'done' })).toBe('ok')
  expect(savedTone(SAVED[0]!)).toBe('ok')
  expect(savedTone(SAVED[1]!)).toBe('fail')
  expect(savedTone({ ...SAVED[0]!, answer: 'Есть замечания' })).toBe('fail')
  expect(savedTone(SAVED[2]!)).toBe('muted')
  expect(savedTone({ ...OPEN, state: 'done', kind: 'choose', answer: 'Первый' })).toBe('muted')
})

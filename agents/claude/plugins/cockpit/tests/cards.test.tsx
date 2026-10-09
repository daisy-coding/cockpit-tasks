import { expect, test } from 'claude-code/testing'
import type { OwnerTask } from '../types'
import { parseTaskAction } from '../hooks/domain/task-loop'
import { ownerLayout, wrapPlain } from '../hooks/owner/tasks'
import { historyRows, taskRows } from '../hooks/tasks'
import { TASK, seeded } from './fixtures'
import { adopt, storedOf } from '../hooks/owner/project'
import { CARD_HOVER, drawCardControls, frameActions, hoverScope } from '../hooks/card-controls'

const REVIEW: OwnerTask = {
  id: 22, title: 'Проверить: Исправить отклонение карточки', why: 'Открой вкладку Мне и нажми крестик. Карточка должна закрыться одним нажатием.',
  kind: 'choose', options: ['Принято', 'Есть замечания'], taskAlias: 'TASK-108',
  state: 'open', update: 'none', sessionId: 'fixture-session', createdMs: 1, updatedMs: 1,
}

for (const width of [40, 60, 100]) {
  test(`CARDS-1: короткий result, обычный полный review и запасной заголовок на ${width}`, () => {
    const result = 'Крестик отклоняет одним нажатием'
    const withResult = { ...REVIEW, result }
    const layout = ownerLayout([withResult], 22, null, 100, width, 100, REVIEW.sessionId)
    expect(layout.cards[0]?.titleLines).toEqual(wrapPlain(result, width - 4))
    expect(layout.cards[0]?.context).toEqual(wrapPlain(REVIEW.why, width - 4))
    const fallback = ownerLayout([REVIEW], 22, null, 100, width, 100, REVIEW.sessionId)
    expect(fallback.cards[0]?.titleLines).toEqual(wrapPlain('Исправить отклонение карточки', width - 4))
    expect(fallback.cards[0]?.context).toEqual(wrapPlain(REVIEW.why, width - 4))
  })

  test(`CARDS-2: обе проверки показывают полный review без выбранной карточки на ${width}`, () => {
    const other = { ...REVIEW, id: 23, taskAlias: 'TASK-109' }
    const layout = ownerLayout([REVIEW, other], 22, null, 100, width, 100, REVIEW.sessionId)
    expect(layout.cards.map(card => card.context)).toEqual([wrapPlain(REVIEW.why, width - 4), wrapPlain(REVIEW.why, width - 4)])
    expect(layout.cards.map(card => card.selected)).toEqual([false, false])
    expect(ownerLayout([REVIEW, other], 23, null, 100, width, 100, REVIEW.sessionId).cards).toEqual(layout.cards)
  })

  test(`CARDS-1: #N во всех списках, у поручения без задачи номера нет, на ${width}`, () => {
    const task = { ...TASK, alias: 'TASK-108', stage: 'task' as const, certainty: 'verified' as const, certaintySource: 'agent' as const }
    const view = { cursor: 'task:task-1', offset: 0, limit: 100, expanded: new Set<string>(), collapsed: new Set<string>() }
    const card = taskRows(seeded(task), view, width, 0).find(row => row.kind === 'card')
    expect(card?.kind === 'card' ? card.number : undefined).toBe('#108')
    const history = historyRows(seeded({ ...task, status: 'done' }), view, width, Date.now()).find(row => row.kind === 'card')
    expect(history?.kind === 'card' ? history.number : undefined).toBe('#108')
    const owner = ownerLayout([REVIEW, { ...REVIEW, id: 23, taskAlias: undefined, kind: 'do', options: undefined }], 22, null, 100, width, 100, REVIEW.sessionId)
    expect(owner.cards.map(row => row.label)).toEqual(['#108', ''])
  })

  test(`CARDS-1: промежутки Мне равны промежуткам Агенту на ${width}`, () => {
    const layout = ownerLayout([REVIEW, { ...REVIEW, id: 23 }], 22, null, 100, width, 100, REVIEW.sessionId)
    expect(layout.cardsHeight).toBe(layout.cards.reduce((sum, card) => sum + card.height, 0))
  })

  test(`CARDS-2: нехватка высоты сокращает пояснения снизу вверх, сохраняя заголовки на ${width}`, () => {
    const first = { ...REVIEW, why: 'Проверь переносы текста и сохранение положения каждой карточки. '.repeat(4).trim() }
    const second = { ...first, id: 23, taskAlias: 'TASK-109' }
    const full = ownerLayout([first, second], null, null, 100, width, 100, REVIEW.sessionId)
    const count = full.cards[0]!.context.length
    const clipped = ownerLayout([first, second], null, null, full.height - 1, width, full.height - 1, REVIEW.sessionId)
    expect(clipped.cards.map(card => card.titleLines)).toEqual(full.cards.map(card => card.titleLines))
    expect(clipped.cards[0]?.context).toEqual(full.cards[0]?.context)
    expect(clipped.cards[1]?.context).toEqual(full.cards[1]!.context.slice(0, -1).map((line, index, lines) => index === lines.length - 1 ? line.slice(0, width - 5).trimEnd() + '…' : line))
    expect(clipped.cards.map(card => card.whole)).toEqual([true, false])
    const tighter = ownerLayout([first, second], null, null, full.height - count, width, full.height - count, REVIEW.sessionId)
    expect(tighter.cards.map(card => card.context.length)).toEqual([count - 1, 1])
    expect(tighter.cards.map(card => card.whole)).toEqual([false, false])
    expect(tighter.cards.map(card => card.titleLines)).toEqual(full.cards.map(card => card.titleLines))
    expect(tighter.cards.map(card => card.selected)).toEqual([false, false])
    expect(tighter.height).toBe(full.height - count)
  })
}

test('CARDS-1: task_done принимает result отдельно от review', () => {
  expect(parseTaskAction('task_done', { result: 'Крестик отклоняет одним нажатием', review: REVIEW.why })).toEqual({ result: 'Крестик отклоняет одним нажатием', review: REVIEW.why })
})

for (const result of ['а'.repeat(61), 'Две\nстроки', 'Две\rстроки', '', 42]) test(`CARDS-1: неверный result отклоняется: ${String(result).slice(0, 10)}`, () => {
  expect(parseTaskAction('task_done', { result, review: 'none' })).toMatchObject({ error: expect.stringContaining('result') })
})

test('CARDS-1: result в 60 знаков и полное название сохраняются после чтения хранилища', () => {
  const result = 'а'.repeat(60)
  const taskTitle = 'Название исходной задачи сохраняется независимо от префикса доставки'.padEnd(80, 'а')
  expect(parseTaskAction('task_done', { result, review: 'none' })).toEqual({ result, review: 'none' })
  const stored = storedOf({ nextId: 23, sessions: { [REVIEW.sessionId]: { seenMs: 1, tasks: [{ ...REVIEW, result, taskTitle }] } } })
  expect(adopt(stored, REVIEW.sessionId, 2).adopted[0]).toMatchObject({ result, taskTitle })
})

test('CARDS-1: узкая рамка оставляет первые действия; группы наведения не содержат запрещённых знаков', () => {
  const actions = Array.from({ length: 20 }, (_, index) => ({ key: `action-${index}`, label: '×', hint: 'Удалить', keyHint: 'x' }))
  for (const width of [40, 60, 100]) {
    const visible = frameActions(actions, width)
    expect(visible).toEqual(actions.slice(0, visible.length))
    expect(2 + visible.length + 2 * (visible.length - 1)).toBeLessThanOrEqual(width - 4)
  }
  for (const key of ['task:Foo/Bar', 'owner-22', 'Upper_CASE']) expect(hoverScope(key)).toMatch(/^[a-z0-9-]+$/u)
})

test('Группа значков входит в группу наведения карточки: курсор над значком подсвечивает её рамку', () => {
  const ui = {
    Box: (props: Record<string, unknown>) => ({ type: 'Box', props }),
    Text: (props: Record<string, unknown>) => ({ type: 'Text', props }),
    Button: (props: Record<string, unknown>) => ({ type: 'Button', props }),
  } as unknown as Parameters<typeof drawCardControls>[0]
  const [group] = drawCardControls(ui, [{ id: 'a', scope: 'owner-card-7', top: 3, width: 40, selected: true, actions: [{ key: 'done', label: '✓', hint: 'Сделано', keyHint: 'd' }] }], 40, 10, CARD_HOVER, () => undefined) as unknown as { props: { hover?: Record<string, unknown> } }[]
  // Свойство top повторяет положение группы: движку нужно стилевое свойство, а сдвига быть не должно.
  expect(group?.props.hover).toEqual({ scope: 'owner-card-7', top: 3 })
})

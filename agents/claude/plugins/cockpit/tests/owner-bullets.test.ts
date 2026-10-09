import { expect, test } from 'claude-code/testing'
import { fullLinesOf, isPlainTask, ownerLayout, parseAsk } from '../hooks/owner/tasks'
import { parseTaskAction } from '../hooks/domain/task-loop'
import type { OwnerTask } from '../types'

const body = 'Проверь результат:\n- Первый пункт с переносом по словам\n- Второй пункт'
const task: OwnerTask = { id: 1, title: 'Проверь панель', why: body, kind: 'do', state: 'open', update: 'none', sessionId: 's', createdMs: 0, updatedMs: 0 }

test('BULLETS-234: review и done_when сохраняют строки, обычный текст очищается как прежде', () => {
  expect(parseAsk({ title: task.title, why: body })).toEqual({ title: task.title, why: body, kind: 'do' })
  expect(parseAsk({ title: task.title, why: 'Причина', done_when: body })).toEqual({ title: task.title, why: 'Причина', doneWhen: body, kind: 'do' })
  expect(parseAsk({ title: task.title, why: 'Первая\nвторая' })).toEqual({ title: task.title, why: 'Первая вторая', kind: 'do' })
  expect(isPlainTask(task)).toBe(true)
})

test('BULLETS-234: каждый пункт с маркером и висячим отступом; высота по строкам', () => {
  const lines = ['Проверь панель', 'Проверь результат:', '• Первый пункт с', '  переносом по', '  словам', '• Второй пункт']
  expect(fullLinesOf(task, 18, false)).toEqual(lines)
  const layout = ownerLayout([task], 1, null, 30, 22, 30, 's')
  expect(layout.cards[0]?.height).toBe(lines.length + 2)
  expect(layout.isWhole).toBe(true)
  expect(ownerLayout([task], 1, null, 5, 22, 5, 's').isWhole).toBe(false)
})

test('BULLETS-234: седьмой пункт отклоняется до закрытия, шесть допустимы', () => {
  const six = Array.from({ length: 6 }, (_, i) => `- Пункт ${i}`).join('\n')
  expect(parseTaskAction('task_done', { review: six })).toEqual({ review: six })
  expect(parseTaskAction('task_done', { review: six + '\n- Лишний' })).toEqual({ error: 'review: не больше 6 пунктов; сократи список.' })
  expect(parseAsk({ title: task.title, why: 'Причина', done_when: six + '\n- Лишний' })).toEqual({ error: 'done_when: не больше 6 пунктов; сократи список.' })
})

test('BULLETS-234: предел 300 сохраняется, вводная одна, пустой пункт не принимается', () => {
  expect('error' in parseTaskAction('task_done', { review: '- ' + 'а'.repeat(299) })).toBe(true)
  expect('error' in parseAsk({ title: task.title, why: 'Первая\nВторая\n- Пункт' })).toBe(true)
  expect('error' in parseTaskAction('task_done', { review: 'Вводная\n- ' })).toBe(true)
  for (const width of [3, 4, 5, 6]) expect(ownerLayout([task], 1, null, 100, width, 100, 's').isWhole).toBe(false)
  const six = { ...task, why: Array.from({ length: 6 }, (_, i) => `- Пункт ${i} с продолжением`).join('\n') }
  const collapsed = ownerLayout([six], 1, null, 30, 22, 30, 's', true, false, null, true, 0, true)
  expect(collapsed.cards[0]?.details?.[1]?.startsWith('  ')).toBe(true)
  expect(collapsed.cards[0]?.details?.length).toBe(8)
  expect(collapsed.cards[0]?.details?.[7]?.endsWith('…')).toBe(true)
})

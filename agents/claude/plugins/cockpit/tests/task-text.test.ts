import { expect, test } from 'claude-code/testing'
import { splitTaskText } from '../hooks/domain/task-text.ts'
import { parseTaskAdd } from '../hooks/domain/task-loop'

test('Разбор без критерия сохраняет описание и внутренние пустые абзацы', () => {
  expect(splitTaskText('  Сделать работу\n\nСохранить контекст  ')).toEqual({ goal: 'Сделать работу\n\nСохранить контекст', criteria: [] })
  expect(splitTaskText()).toEqual({ goal: '', criteria: [] })
})

test('Критерий отделяется и в абзаце, и в прежней общей строке', () => {
  for (const separator of [' ', '\n\n', '\r\n\r\n']) {
    expect(splitTaskText(`Исправить панель.${separator}Готово, когда: Проверки проходят.`)).toEqual({ goal: 'Исправить панель.', criteria: ['Проверки проходят.'] })
  }
})

test('Префикс Владелец срезается только в начале, отдельное поле и встроенные критерии объединяются без дублей', () => {
  expect(splitTaskText('Владелец: Исправить панель\n\nГотово, когда: • Проверить клавиши\n- Проверить мышь', ['Проверить клавиши', '', '1. Сохранить данные']))
    .toEqual({ goal: 'Исправить панель', criteria: ['Проверить клавиши', 'Сохранить данные', 'Проверить мышь'] })
  expect(splitTaskText('Уточнить роль Владелец: в тексте')).toEqual({ goal: 'Уточнить роль Владелец: в тексте', criteria: [] })
})

test('Критерий без описания не становится сутью задачи; parseTaskAdd сохраняет прежний формат', () => {
  const parsed = parseTaskAdd({ title: 'Проверить мод', description: 'Владелец: Исправить панель', acceptance: 'Проверки проходят' })
  expect(parsed).toEqual({ tasks: [{ title: 'Проверить мод', description: 'Владелец: Исправить панель\n\nГотово, когда: Проверки проходят' }] })
  expect(splitTaskText('Готово, когда: Проверки проходят')).toEqual({ goal: '', criteria: ['Проверки проходят'] })
})

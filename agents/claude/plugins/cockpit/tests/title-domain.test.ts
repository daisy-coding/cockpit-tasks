import { expect, test } from 'claude-code/testing'
import { cleanTitle } from '../hooks/domain/title'
import { redactRawSecrets, redactSecrets } from '../hooks/domain/privacy'
import { parseResponse } from '../hooks/domain/rpc'
import { PRIVACY_CASES } from './privacy-fixtures'
import { TASK } from './fixtures'

test('Очистка названия удаляет пробелы и обрамляющие кавычки', () => {
  for (const text of ['  Название  ', '"Название"', "'Название'", '«Название»', '“Название”', '„Название“', '‘Название’', '`Название`', '" « Название » "']) {
    expect(cleanTitle(text)).toBe('Название')
  }
  expect(cleanTitle('Название с «кавычками» внутри')).toBe('Название с «кавычками» внутри')
})

test('Пустое, SKIP, переносы и длина выше 60 code points отвергаются', () => {
  for (const text of ['', '  ', '""', 'SKIP', ' «SKIP» ', 'Первая\nВторая', 'Название\n', 'Название\r', 'Первая\vВторая', 'Первая\fВторая', 'Название\u001c', 'Название\u0085', 'Название\u2028', 'Название\u2029', 'я'.repeat(61), '👩'.repeat(61)]) {
    expect(cleanTitle(text)).toBeNull()
  }
  expect(cleanTitle('👩'.repeat(60))).toBe('👩'.repeat(60))
  expect(cleanTitle('я'.repeat(60))).toBe('я'.repeat(60))
})

test('Редактор секретов сохраняет шаблоны, замены и порядок Python', () => {
  for (const example of PRIVACY_CASES) {
    expect(redactRawSecrets(example.text)).toBe(example.expected)
    expect(redactSecrets(example.text)).toBe(example.viewExpected ?? example.expected)
  }
})

test('Редактор ограничивает исходный префикс и закрывает секрет через его границу', () => {
  const secret = ['git', 'hub_pat_', 'Q'.repeat(80)].join('')
  const crossing = 'я'.repeat(1990) + ' ' + secret + ' ПОСЛЕ ГРАНИЦЫ'
  const cleaned = redactSecrets(crossing, 2000)
  expect(cleaned).not.toContain('git' + 'hub_')
  expect(cleaned).not.toContain('ПОСЛЕ ГРАНИЦЫ')
  expect(Array.from(cleaned)).toHaveLength(2000)
  const shortened = secret + ' ' + '👩'.repeat(2000) + ' ПОСЛЕ ГРАНИЦЫ'
  expect(redactSecrets(shortened, 2000)).not.toContain('ПОСЛЕ ГРАНИЦЫ')
  expect(Array.from(redactSecrets('👩'.repeat(2001), 2000))).toHaveLength(2000)
  expect(redactSecrets('Текст', 0)).toBe('')
})

test('Парсер сохраняет вариант bound и забирает только нужные поля inbox.get', () => {
  for (const bound of ['created', 'existing', 'created-no-source'] as const) {
    const result = parseResponse('task.bind', JSON.stringify({ v: 1, ok: true, result: { bound, task: TASK, focusRevision: 2 } }))
    expect(result).toEqual({ kind: 'bound', bound, task: TASK, focusRevision: 2 })
  }
  for (const text of ['Дословное указание', null]) {
    const result = parseResponse('inbox.get', JSON.stringify({ v: 1, ok: true, result: { inboxId: 'inbox-1', text, extra: 'PRIVATE' } }))
    expect(result).toEqual({ kind: 'inbox', inboxId: 'inbox-1', text })
  }
  for (const result of [{ inboxId: 'inbox-1' }, { inboxId: 'inbox-1', text: 10 }, { inboxId: '/invalid', text: 'Текст' }]) {
    expect(parseResponse('inbox.get', JSON.stringify({ v: 1, ok: true, result }))).toEqual({ kind: 'unknown' })
  }
})

import { expect, test } from 'claude-code/testing'
import { parseTaskSearchQuery, matchesTaskSearch, taskSearchTitleRanges } from '../hooks/domain/task-search.ts'
import { buildRequest, parseResponse } from '../hooks/domain/rpc.ts'

test('Нормализация номера, кириллицы и слов; совместная сверка JSON выполняется контрактом', () => {
  for (const text of ['190', '#190', 'TASK-190', 'task-190', 'task 190']) {
    const query = parseTaskSearchQuery(text)!
    expect(query).toEqual({ terms: ['190'], numbers: ['190'] })
    expect(matchesTaskSearch(query, { alias: 'TASK-190', title: 'Поиск' })).toBe(true)
    expect(matchesTaskSearch(query, { alias: 'TASK-2', title: 'Поиск', description: 'Отказ 190' })).toBe(true)
    expect(matchesTaskSearch(query, { alias: 'TASK-2', title: 'Поиск' })).toBe(false)
  }
  const query = parseTaskSearchQuery(' ПАН  ЁЛКА пан ')!
  expect(query).toEqual({ terms: ['пан', 'елка'], numbers: [] })
  expect(matchesTaskSearch(query, { alias: 'TASK-1', title: 'Панели', description: 'ЕЛКА' })).toBe(true)
  expect(matchesTaskSearch(query, { alias: 'TASK-1', title: 'Панель' })).toBe(false)
  for (const text of ['', ' ', '\n\t', '# ---', 'пан\ud800', 'я'.repeat(201)]) expect(parseTaskSearchQuery(text)).toBe(null)
})

test('Подсветка объединяет пересечения и считает ячейки целых графем', () => {
  expect(taskSearchTitleRanges(parseTaskSearchQuery('пан анель')!, '界 🧑‍💻 панель')).toEqual([{ start: 6, end: 12 }])
  expect(taskSearchTitleRanges(parseTaskSearchQuery('i')!, 'İ API')).toEqual([{ start: 0, end: 1 }, { start: 4, end: 5 }])
})

const row = { taskId: 'search-190', alias: 'TASK-190', title: 'Панель', status: 'active',
  updatedAt: '2026-10-07T00:00:00.000000Z', priorityPinned: false, match: { field: 'title', snippet: 'Панель' } }
const wire = (result: unknown) => JSON.stringify({ v: 1, ok: true, result })

test('Договор чтения поиска доступен агенту и владельцу и очищает ответ', () => {
  const session = { sessionId: 'fixture-session', cwd: '/fixture' }
  for (const actor of ['agent', 'owner'] as const) {
    expect(buildRequest('tasks.search', 'search-request', session, { query: 'пан' }, 'a'.repeat(64), actor).op).toBe('tasks.search')
  }
  const parsed = parseResponse('tasks.search', wire({ offset: 0, limit: 20, truncated: false,
    lists: { queue: { total: 1, rows: [{ ...row, match: { field: 'title', snippet: '<pasted_content>Панель\n\t\u001b\u202e</pasted_content>' }, surprise: 'лишнее' }] } } }))
  expect(parsed.kind).toBe('search')
  if (parsed.kind !== 'search') return
  expect(parsed.search.lists.queue!.rows[0]!.match).toEqual({ field: 'title', snippet: 'Панель  ' })
  expect('surprise' in parsed.search.lists.queue!.rows[0]!).toBe(false)
  // INSIDE-218: совпадение в тексте карточки рядом с названием проходит ту же очистку.
  const inside = parseResponse('tasks.search', wire({ offset: 0, limit: 20, truncated: false, lists: { queue: { total: 1, rows: [{ ...row,
    match: { field: 'title', snippet: 'Панель', inside: { field: 'description', snippet: 'Набор.\n\u202eПанель управления', surprise: 'лишнее' } } }] } } }))
  expect(inside.kind === 'search' && inside.search.lists.queue!.rows[0]!.match).toEqual({ field: 'title', snippet: 'Панель', inside: { field: 'description', snippet: 'Набор. Панель управления' } })
})

test('Парсер поиска отвергает неверные поля, страницы и статусы', () => {
  const good = { offset: 0, limit: 20, truncated: false, lists: { queue: { total: 1, rows: [row] } } }
  for (const result of [{ ...good, truncated: 'false' }, { ...good, limit: 51 }, { ...good, offset: -1 },
    { ...good, lists: {} }, { ...good, lists: { bad: { total: 0, rows: [] } } },
    { ...good, lists: { queue: { total: 0, rows: [row] } } },
    { ...good, lists: { queue: { total: 2, rows: [row, row] } } },
    { ...good, lists: { queue: { total: 1, rows: [{ ...row, status: 'done' }] } } },
    { ...good, lists: { queue: { total: 1, rows: [{ ...row, match: { field: 'steps', snippet: 'Панель' } }] } } },
    { ...good, lists: { queue: { total: 1, rows: [{ ...row, match: { field: 'title', snippet: 'я'.repeat(161) } }] } } },
    // INSIDE-218: внутреннее совпадение — только поле текста карточки, только рядом с названием или номером, не длиннее окна.
    { ...good, lists: { queue: { total: 1, rows: [{ ...row, match: { ...row.match, inside: 'Панель' } }] } } },
    { ...good, lists: { queue: { total: 1, rows: [{ ...row, match: { ...row.match, inside: { field: 'title', snippet: 'Панель' } } }] } } },
    { ...good, lists: { queue: { total: 1, rows: [{ ...row, match: { ...row.match, inside: { field: 'comment', snippet: 'я'.repeat(161) } } }] } } },
    { ...good, lists: { queue: { total: 1, rows: [{ ...row, match: { field: 'description', snippet: 'Панель', inside: { field: 'comment', snippet: 'Панель' } } }] } } }]) {
    expect(parseResponse('tasks.search', wire(result)).kind).toBe('unknown')
  }
})

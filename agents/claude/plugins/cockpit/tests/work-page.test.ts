import { expect, test } from 'claude-code/testing'
import type { AgentTaskNote, OwnerComment } from '../types'
import { cellWidth } from '../hooks/layout'
import { entryLines, movePage, newTaskPage, pageLines, pageWindow, scrollPage, selectPageTab } from '../hooks/task-page-model'
import { cleanWorkText, workAuthor, workEntries, WORK_GLYPHS } from '../hooks/work-history'
import { DEFAULT_THEME } from '../hooks/theme'
import { TASK } from './fixtures'

function newCommentsPage(...args: Parameters<typeof newTaskPage>) {
  const page = newTaskPage(...args)
  selectPageTab(page, 'comments')
  return page
}

const NOW = new Date(2026, 9, 7, 15, 0).getTime()
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString()
const note = (index: number): AgentTaskNote => ({ noteId: `note-${index}`, taskId: TASK.taskId, kind: 'note',
  source: 'agent', provenance: 'tool', text: `Запись ${index}`, createdAt: at(7, 10, index) })
const comment: OwnerComment = { commentId: 'owner-1', text: 'Ответ владельца', revision: 0, createdAt: at(7, 11), updatedAt: at(7, 11) }

for (const plain of [true, false]) test(`Ход работы отличает трёх авторов, значки занимают одну ячейку: ${plain ? 'plain' : 'nerd'}`, () => {
  const page = newCommentsPage({ ...TASK, lastCheckpoint: { checkpointId: 'system-1', taskId: TASK.taskId, kind: 'detour',
    source: 'engine', provenance: 'cli', text: 'Смена состояния', createdAt: at(7, 12) } }, [comment], [note(0)])
  page.height = 40
  page.plain = plain
  const lines = pageLines(page, NOW)
  const headers = lines.filter(line => line.kind === 'time')
  expect(headers.map(line => line.text)).toEqual(plain ? ['а 10:00', 'я 11:00', '· 12:00'] : ['\u{f06a9} 10:00', '\u{f0004} 11:00', '\u{f0493} 12:00'])
  for (const header of headers) expect(cellWidth(Array.from(header.text)[0]!)).toBe(1)
  expect(lines.filter(line => line.kind === 'heading')).toEqual([])
  expect(lines.filter(line => ['note', 'comment', 'trail'].includes(line.kind)).map(line => line.text)).toEqual(['  Запись 0', '  Ответ владельца', '  Смена состояния'])
})

test('Записи разделены одной пустой строкой, после последней её нет', () => {
  const page = newCommentsPage(TASK, [], [note(0), note(1), note(2)])
  page.height = 40
  const lines = pageLines(page, NOW)
  const start = lines.findIndex(line => line.kind === 'time')
  expect(lines.slice(start).map(line => [line.kind, line.text])).toEqual([
    ['time', 'а 10:00'], ['note', '  Запись 0'], ['gap', ''],
    ['time', 'а 10:01'], ['note', '  Запись 1'], ['gap', ''],
    ['time', 'а 10:02'], ['note', '  Запись 2'],
  ])
})

test('Время записи абсолютное: сегодня часы, раньше дата и часы', () => {
  const page = newCommentsPage(TASK, [], [note(0), { ...note(1), createdAt: at(6, 9, 3) }])
  page.height = 40
  expect(pageLines(page, NOW).filter(line => line.kind === 'time').map(line => line.text)).toEqual(['а 06.10 09:03', 'а 10:00'])
})

for (const width of [40, 60, 100]) test(`Ход работы переносит полный текст и адрес по ячейкам с отступом: ${width}`, () => {
  const text = 'Проверка переноса по словам сохраняет текст целиком '.repeat(3).trim()
  const address = 'https://example.invalid/' + 'а\u0301'.repeat(70) + '界'.repeat(20)
  const page = newCommentsPage(TASK, [], [{ ...note(0), text }, { ...note(1), text: address }])
  page.width = width
  page.height = 100
  const lines = pageLines(page, NOW)
  const bodies = lines.filter(line => line.kind === 'note')
  expect(bodies.filter(line => line.entryId === 'note:note-0').map(line => line.text.slice(2)).join(' ')).toBe(text)
  expect(bodies.filter(line => line.entryId === 'note:note-1').map(line => line.text.slice(2)).join('')).toBe(address)
  for (const line of bodies) {
    expect(line.text.startsWith('  ')).toBe(true)
    expect(cellWidth(line.text)).toBeLessThanOrEqual(width - 4)
    expect(line.text).not.toContain('…')
  }
})

test('Пустая вкладка комментариев видна с точным сообщением', () => {
  const page = newCommentsPage(TASK, [])
  page.height = 10
  expect(pageLines(page, NOW).map(line => [line.kind, line.text])).toEqual([
    ['empty', 'Записей пока нет'],
  ])
})

test('Управляющие последовательности удаляются до переноса; абзацы остаются', () => {
  const page = newCommentsPage(TASK, [], [{ ...note(0), text: 'Начало\u001b[31m цвета\u001b[0m\r\n\nКонец\u0000\u0007\u202e\u009b2J\u001b]0;чужой заголовок\u0007' }])
  page.height = 40
  expect(pageLines(page, NOW).filter(line => line.kind === 'note').map(line => line.text)).toEqual(['  Начало цвета', '  ', '  Конец'])
})

test('30 записей занимают одну область прокрутки: последние видны, полная высота сохранена', () => {
  const page = newCommentsPage(TASK, [], Array.from({ length: 30 }, (_, index) => note(index)))
  page.width = 60
  page.height = 20
  const lines = pageLines(page, NOW)
  const window = pageWindow(page, lines, DEFAULT_THEME)
  expect(window.offset).toBe(69)
  expect(window.total).toBe(89)
  expect(window.lines[0]?.text).toBe('а 10:23')
  expect(window.lines.at(-1)?.text).toBe('  Запись 29')
  expect(window.lines.filter(line => line.kind === 'time').map(line => line.text)).toEqual(['а 10:23', 'а 10:24', 'а 10:25', 'а 10:26', 'а 10:27', 'а 10:28', 'а 10:29'])
})

test('Автор берётся из источника, автоматический и неизвестный виды остаются системными', () => {
  expect(['user', 'agent', 'claude', 'engine', 'tool', 'provider'].map(source => workAuthor({ kind: 'note', source }))).toEqual(['owner', 'agent', 'agent', 'system', 'system', 'system'])
  expect(['comment', 'answer', 'edit', 'note', 'result'].map(kind => workAuthor({ kind }))).toEqual(['owner', 'owner', 'owner', 'agent', 'agent'])
  for (const source of ['user', 'agent', undefined]) {
    for (const kind of ['detour', 'return', 'completed', 'deferred', 'cancelled', 'unknown-kind']) expect(workAuthor({ kind, source })).toBe('system')
  }
  expect(Object.values(WORK_GLYPHS).map(pair => [cellWidth(pair.nerd), cellWidth(pair.plain)])).toEqual([[1, 1], [1, 1], [1, 1]])
})

test('Имя исполнителя в заголовке очищено и укладывается в ширину', () => {
  const entry = { id: 'named', kind: 'note', source: 'agent', executor: 'Codex\u001b[31m\u0000', text: 'Проверил', createdAt: at(7, 10) }
  expect(entryLines(entry, 56, NOW, true)[0]?.text).toBe('а 10:00 Codex')
  const lines = entryLines({ ...entry, executor: 'Codex'.repeat(30) }, 36, NOW, true)
  expect(cellWidth(lines[0]!.text)).toBe(36)
  expect(lines[0]?.text.endsWith('…')).toBe(true)
  expect(lines[1]?.text).toBe('  Проверил')
})

test('Контрольные точки и изменения владельца объединены без дублей и чужих задач', () => {
  const mark = { checkpointId: 'cp', taskId: TASK.taskId, kind: 'note' as const, source: 'claude' as const, provenance: 'tool' as const, text: 'Проверил', createdAt: at(7, 10) }
  const task = { ...TASK, lastCheckpoint: mark }
  const changes = [{ eventId: 1, taskId: TASK.taskId, action: 'edited' as const, createdAt: at(7, 11) },
    { eventId: 2, taskId: 'foreign', action: 'completed' as const, createdAt: at(7, 12) }]
  const entries = workEntries(task, [], [{ ...note(0), taskId: 'foreign' }], [mark, { ...mark, taskId: 'foreign', checkpointId: 'foreign' }], changes)
  expect(entries.map(entry => [entry.id, entry.executor, entry.text, workAuthor(entry)])).toEqual([
    ['checkpoint:cp', 'Claude', 'Проверил', 'agent'],
  ])
  expect(changes[0]?.action).toBe('edited')
})

for (const status of ['done', 'cancelled'] as const) test(`Только слово состояния системной записи имеет роль: ${status}`, () => {
  const page = newCommentsPage({ ...TASK, status, updatedAt: at(7, 12) }, [comment], [{ ...note(0), text: 'Задача закрыта, отклонена в тесте' }])
  const lines = pageLines(page, NOW)
  expect(lines.filter(line => line.kind === 'time').map(line => line.spans)).toEqual([
    [{ text: 'а 10:00', role: 'muted' }], [{ text: 'я 11:00', role: 'muted' }], [{ text: '· 12:00', role: 'muted' }],
  ])
  expect(lines.filter(line => line.kind === 'note' || line.kind === 'comment').map(line => line.spans)).toEqual([
    [{ text: '  Задача закрыта, отклонена в тесте', role: 'fg' }], [{ text: '  Ответ владельца', role: 'fg' }],
  ])
  expect(lines.filter(line => line.kind === 'trail').map(line => line.spans)).toEqual([[
    { text: '  Состояние задачи: ', role: 'fg' }, { text: status === 'done' ? 'закрыта' : 'отклонена', role: status === 'done' ? 'ok' : 'fail' },
  ]])
})

test('Завершение агентом — отдельное событие с временем result; текущее состояние не дублируется', () => {
  const page = newCommentsPage({ ...TASK, status: 'done' }, [], [{ ...note(0), kind: 'result', text: 'Проверки пройдены' }])
  expect(pageLines(page, NOW).filter(line => line.kind === 'time').map(line => line.text)).toEqual(['а 10:00', '· 10:00'])
  expect(pageLines(page, NOW).filter(line => line.kind === 'trail').map(line => line.spans)).toEqual([[
    { text: '  Задача ', role: 'fg' }, { text: 'закрыта', role: 'ok' },
  ]])
})

test('Пустые записи после очистки не создают заголовки или интервалы', () => {
  const page = newCommentsPage(TASK, [], [{ ...note(0), text: '\u001b[31m\u0000' }, { ...note(1), text: '  \n  ' }, note(2)])
  expect(pageLines(page, NOW).map(line => [line.kind, line.text])).toEqual([['time', 'а 10:02'], ['note', '  Запись 2']])
  expect(cleanWorkText('слово\u001b[2J\u202a\u2066\u007f\u009dзаголовок\u009c')).toBe('слово')
})

test('Область следит за новыми записями снизу и сохраняет стабильную строку после прокрутки вверх', () => {
  const page = newCommentsPage(TASK, [], Array.from({ length: 30 }, (_, index) => note(index)))
  page.height = 20
  pageWindow(page, pageLines(page, NOW), DEFAULT_THEME)
  page.agentNotes.push(note(30))
  expect(pageWindow(page, pageLines(page, NOW), DEFAULT_THEME).lines.at(-1)?.text).toBe('  Запись 30')
  scrollPage(page, -12)
  const earlier = pageWindow(page, pageLines(page, NOW), DEFAULT_THEME)
  const first = earlier.lines[0]!.id
  page.agentNotes.push(note(31))
  page.agentNotes.unshift({ ...note(32), createdAt: at(6, 10) })
  const held = pageWindow(page, pageLines(page, NOW), DEFAULT_THEME)
  expect(held.lines[0]!.id).toBe(first)
  expect(held.offset).toBe(earlier.offset + 3)
  expect(held.lines.some(line => line.text === '  Запись 31')).toBe(false)
  movePage(page, 'end', NOW)
  expect(pageWindow(page, pageLines(page, NOW), DEFAULT_THEME).lines.at(-1)?.text).toBe('  Запись 31')
  page.agentNotes.push(note(33))
  expect(pageWindow(page, pageLines(page, NOW), DEFAULT_THEME).lines.at(-1)?.text).toBe('  Запись 33')
})

test('Начало, конец и страница ограничивают единственное смещение вкладки', () => {
  const page = newCommentsPage(TASK, [], Array.from({ length: 30 }, (_, index) => note(index)))
  page.height = 20
  pageWindow(page, pageLines(page, NOW), DEFAULT_THEME)
  movePage(page, 'home', NOW)
  const start = pageWindow(page, pageLines(page, NOW), DEFAULT_THEME)
  expect(start.offset).toBe(0)
  expect(start.lines[0]?.text).toBe('а 10:00')
  expect(start.lines[1]?.text).toBe('  Запись 0')
  movePage(page, 'pagedown', NOW)
  expect(pageWindow(page, pageLines(page, NOW), DEFAULT_THEME).offset).toBe(19)
  movePage(page, 'pageup', NOW)
  expect(pageWindow(page, pageLines(page, NOW), DEFAULT_THEME).offset).toBe(0)
  scrollPage(page, -999)
  expect(page.views.comments.offset).toBe(0)
  scrollPage(page, Number.NaN)
  expect(page.views.comments.offset).toBe(0)
  scrollPage(page, 999)
  expect(page.views.comments.offset).toBe(69)
  expect(page.views.description.offset).toBe(0)
})

test('Отчёт PAGE-2: пять записей трёх авторов на панели шириной 60', () => {
  const page = newCommentsPage({ ...TASK, status: 'done', updatedAt: at(7, 10, 10) }, [
    { ...comment, text: 'Уточнил критерий приёмки.', createdAt: at(7, 10), updatedAt: at(7, 10) },
    { ...comment, commentId: 'owner-2', text: 'Добавил условие для длинных адресов.', createdAt: at(7, 10, 7), updatedAt: at(7, 10, 7) },
  ], [{ ...note(0), text: 'Начал проверку на ширине 60.', createdAt: at(7, 10, 5) },
    { ...note(1), text: 'Проверки пройдены.', createdAt: at(7, 10, 9) }])
  page.changes = [{ eventId: 1, taskId: TASK.taskId, action: 'completed', createdAt: at(7, 10, 10) }]
  page.width = 60
  page.height = 20
  const window = pageWindow(page, pageLines(page, NOW), DEFAULT_THEME)
  expect(window.lines.map(line => line.text).join('\n')).toBe('я 10:00\n  Уточнил критерий приёмки.\n\nа 10:05\n  Начал проверку на ширине 60.\n\nя 10:07\n  Добавил условие для длинных адресов.\n\nа 10:09\n  Проверки пройдены.\n\n· 10:10\n  Задача закрыта')
  expect(window.lines.filter(line => line.kind === 'time')).toHaveLength(5)
  expect(window).toMatchObject({ total: 14, offset: 0 })
  for (const line of window.lines) expect(cellWidth(line.text)).toBeLessThanOrEqual(56)
})

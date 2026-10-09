import { expect, test } from 'claude-code/testing'
import type { AgentTaskNote, OwnerComment } from '../types'
import { cellWidth, graphemes } from '../hooks/layout'
import { commentTime, newTaskPage, pageLines, pageNumber, selectPageTab, pageWindow, movePage } from '../hooks/task-page-model'
import { editableDescription, splitTaskText, taskTextParts } from '../hooks/domain/task-text'
import { DEFAULT_THEME } from '../hooks/theme'
import { TASK } from './fixtures'
import { gitTrail } from '../hooks/domain/work-trail'
import { START_REVISION, WORK_LOG, WORK_DIFF, WORK_STATUS } from './work-trail-fixtures'

const NOW = new Date(2026, 9, 5, 14, 0).getTime()
const localTime = (day: number, hours: number, minutes: number) => new Date(2026, 9, day, hours, minutes).toISOString().replace('.000Z', '.000000Z')
const COMMENT: OwnerComment = { commentId: 'comment-1', text: 'Первый комментарий', revision: 0, createdAt: localTime(5, 13, 7), updatedAt: localTime(5, 13, 7) }

for (const width of [30, 60, 100]) test(`Страница переносит весь текст вкладок без многоточий; «Описание» начинается с названия, номер — в шапке: ${width}`, () => {
  const title = 'Название задачи с понятными словами для переноса '.repeat(5).trim()
  const description = 'Описание целиком сохраняет каждое слово даже на узкой панели '.repeat(10).trim()
  const text = 'Большой комментарий содержит полный контекст для агента '.repeat(60).trim()
  const page = newTaskPage({ ...TASK, title, description }, [{ ...COMMENT, text }])
  page.width = width
  const descriptionLines = pageLines(page, NOW)
  expect(descriptionLines[0]?.kind).toBe('title')
  // Номер задачи отдаётся шапке панели и в строках вкладки не повторяется.
  expect(pageNumber(page)).toBe('#1')
  expect(descriptionLines.some(line => line.text.includes('#1'))).toBe(false)
  expect(descriptionLines.filter(line => line.kind === 'title').map(line => line.text).join(' ')).toBe(title)
  expect(descriptionLines.filter(line => line.kind === 'heading').map(line => line.text)).toEqual(['Задача:'])
  selectPageTab(page, 'comments')
  const comments = pageLines(page, NOW)
  expect(comments.some(line => line.kind === 'title')).toBe(false)
  const lines = [...descriptionLines, ...comments]
  for (const [kind, expected] of [['description', description], ['comment', text]] as const) {
    expect(lines.filter(line => line.kind === kind).map(line => kind === 'comment' ? line.text.slice(2) : line.text).join(' ')).toBe(expected)
  }
  for (const line of lines) {
    expect(cellWidth(line.text)).toBeLessThanOrEqual(width - 4)
    expect(line.text).not.toContain('…')
  }
  expect(lines.filter(line => line.kind === 'heading').map(line => line.text)).toEqual(['Задача:'])
})

test('Пустой раздел описания пропущен, комментарии сохраняют порядок создания', () => {
  const page = newTaskPage(TASK, [COMMENT, { ...COMMENT, commentId: 'comment-2', text: 'Второй', revision: 1 }])
  expect(page.tab).toBe('description')
  expect(pageLines(page, NOW).map(line => [line.kind, line.text])).toEqual([['title', TASK.title], ['gap', ''], ['empty', 'Описания пока нет']])
  selectPageTab(page, 'comments')
  const lines = pageLines(page, NOW)
  expect(lines.some(line => line.text === 'Задача:')).toBe(false)
  expect(lines.filter(line => line.kind === 'empty')).toEqual([])
  expect(lines.filter(line => line.kind === 'comment').map(line => line.commentId)).toEqual(['comment-1', 'comment-2'])
  expect(lines.filter(line => line.kind === 'time').map(line => line.text)).toEqual(['я 13:07', 'я 13:07  изм.'])
})

for (const width of [40, 60, 100]) test(`Разделы страницы идут по порядку, приёмка отдельным разделом, заметки по времени: ${width}`, () => {
  const note: AgentTaskNote = { noteId: 'note-1', taskId: TASK.taskId, kind: 'note', text: 'Начал проверку', createdAt: localTime(5, 10, 0), source: 'agent', provenance: 'tool' }
  const notes = [{ ...note, noteId: 'note-2', kind: 'result' as const, text: 'Проверил результат', createdAt: localTime(5, 12, 0) }, note]
  const page = newTaskPage({ ...TASK, description: 'Владелец: Исправить панель\n\nГотово, когда: Проверить мышь', acceptance: ['Проверить клавиши'], constraints: ['Рантайм не менять'] }, [COMMENT], notes)
  page.width = width
  const lines = pageLines(page, NOW)
  expect(lines[0]?.kind).toBe('title')
  expect(lines.filter(line => line.kind === 'heading').map(line => line.text)).toEqual(['Задача:', 'Приёмка:', 'Ограничения:'])
  expect(lines.filter(line => line.kind === 'description').map(line => line.text)).toEqual(['Владелец: Исправить панель'])
  // Текст после пометки хранения и отдельные критерии — один раздел; пометка «Готово, когда:» на странице не печатается.
  expect(lines.filter(line => line.kind === 'criteria').map(line => line.text)).toEqual(['Проверить мышь', '• Проверить клавиши'])
  expect(lines.some(line => line.text.includes('Готово, когда'))).toBe(false)
  expect(lines.filter(line => line.kind === 'constraint').map(line => line.text)).toEqual(['Рантайм не менять'])
  selectPageTab(page, 'comments')
  const comments = pageLines(page, NOW)
  expect(comments.filter(line => line.kind === 'note').map(line => line.text)).toEqual(['  Начал проверку', '  Проверил результат'])
  expect(comments.filter(line => line.kind === 'trail').map(line => line.text)).toEqual(['  Задача закрыта'])
  expect(comments.filter(line => line.kind === 'time').map(line => line.text)).toEqual(['а 10:00', 'а 12:00', '· 12:00', 'я 13:07'])
  for (const heading of lines.filter(line => line.kind === 'heading').slice(1)) expect(lines[lines.indexOf(heading) - 1]?.kind).toBe('gap')
  for (const line of lines) expect(cellWidth(line.text)).toBeLessThanOrEqual(width - 4)
  expect(new Set(lines.map(line => line.id)).size).toBe(lines.length)
})

test('Пустые поля пропущены, обе вкладки имеют пустое состояние; редактор сохраняет полный исходный текст', () => {
  const page = newTaskPage({ ...TASK, description: '', acceptance: ['  '], constraints: [''] }, [])
  expect(pageLines(page, NOW).map(line => line.kind)).toEqual(['title', 'gap', 'empty'])
  expect(pageLines(page, NOW).at(-1)?.text).toBe('Описания пока нет')
  selectPageTab(page, 'comments')
  expect(pageLines(page, NOW).map(line => line.text)).toEqual(['Записей пока нет'])
  selectPageTab(page, 'description')
  page.task.description = 'Владелец: Цель\n\nГотово, когда: Проверить'
  page.descriptionDraft = page.task.description
  expect(pageLines(page, NOW).filter(line => line.kind === 'editor')).toHaveLength(3)
  expect(page.descriptionDraft).toBe('Владелец: Цель\n\nГотово, когда: Проверить')
})

test('Время локальное; прошлый день и другая дата года показываются с днём и месяцем', () => {
  expect(commentTime(COMMENT, NOW)).toBe('13:07')
  expect(commentTime({ ...COMMENT, createdAt: localTime(4, 9, 3), revision: 2 }, NOW)).toBe('04.10 09:03  изм.')
  const previousYear = new Date(2025, 9, 5, 13, 7).toISOString().replace('.000Z', '.000000Z')
  expect(commentTime({ ...COMMENT, createdAt: previousYear }, NOW)).toBe('05.10 13:07')
})

test('Длинное слово сохраняет целые графемы, пустые абзацы не исчезают', () => {
  const word = ('а' + String.fromCharCode(0x301)).repeat(100) + '界'.repeat(30)
  const page = newTaskPage({ ...TASK, title: word, description: 'Первый\n\nПоследний' }, [])
  page.width = 40
  const lines = pageLines(page, NOW)
  const title = lines.filter(line => line.kind === 'title').map(line => line.text)
  expect(title.length).toBeGreaterThan(2)
  expect(title.join('')).toBe(word)
  for (const line of title) expect(cellWidth(line)).toBeLessThanOrEqual(36)
  for (const part of title.flatMap(graphemes)) expect(graphemes(word)).toContain(part)
  expect(lines.filter(line => line.kind === 'description').map(line => line.text)).toEqual(['Первый', '', 'Последний'])
})

test('Окно содержит только видимые строки, прокрутка достигает последней без отрицательных координат', () => {
  const page = newTaskPage({ ...TASK, description: 'Строка\n'.repeat(30).trim() }, [COMMENT])
  page.height = 4
  const lines = pageLines(page, NOW)
  movePage(page, 'end', NOW)
  const window = pageWindow(page, lines, DEFAULT_THEME)
  expect(window.lines).toEqual(lines.slice(-4))
  expect(window.offset).toBe(lines.length - 4)
  movePage(page, 'home', NOW)
  expect(pageWindow(page, lines, DEFAULT_THEME).offset).toBe(0)
  selectPageTab(page, 'comments')
  movePage(page, 'j', NOW)
  expect(page.selected).toBe(COMMENT.commentId)
  expect(pageWindow(page, pageLines(page, NOW), DEFAULT_THEME).lines.some(line => line.commentId === COMMENT.commentId)).toBe(true)
})

test('Разбор текста задачи для страницы: суть до пометки, приёмка после, ни одна строка не теряется', () => {
  expect(taskTextParts('Цель\n\nГотово, когда: Первое\n• Второе\n• Второе\n\nПоследнее')).toEqual({ goal: 'Цель', acceptance: 'Первое\n• Второе\n• Второе\n\nПоследнее' })
  // Прежние задачи хранят пометку внутри одной строки: перед ней пробел, а не перенос.
  expect(taskTextParts('Цель в одну строку.  Готово, когда: итог виден')).toEqual({ goal: 'Цель в одну строку.', acceptance: 'итог виден' })
  // То же слово, которое владелец видит на странице, работает пометкой в начале строки и не срабатывает посреди фразы.
  expect(taskTextParts('Цель\nПриёмка: итог виден')).toEqual({ goal: 'Цель', acceptance: 'итог виден' })
  expect(taskTextParts('Здесь приёмка: слово внутри фразы')).toEqual({ goal: 'Здесь приёмка: слово внутри фразы', acceptance: '' })
  expect(taskTextParts('Только цель\n\nвторой абзац')).toEqual({ goal: 'Только цель\n\nвторой абзац', acceptance: '' })
  expect(taskTextParts('Готово, когда: только приёмка')).toEqual({ goal: '', acceptance: 'только приёмка' })
  expect(taskTextParts('')).toEqual({ goal: '', acceptance: '' })
})

test('Дописанное в описание видно на странице: строка после пометки стоит отдельной строкой раздела «Приёмка»', () => {
  const before = 'Сделать панель.\n\nГотово, когда: панель открывается.'
  const page = newTaskPage({ ...TASK, description: before }, [])
  const shown = () => pageLines(page, NOW).filter(line => line.kind === 'description' || line.kind === 'criteria').map(line => line.text)
  expect(shown()).toEqual(['Сделать панель.', 'панель открывается.'])
  page.task = { ...page.task, description: before + '\nква' }
  expect(shown()).toEqual(['Сделать панель.', 'панель открывается.', 'ква'])
  page.task = { ...page.task, description: 'Сделать панель.\nуточнение\n\nГотово, когда: панель открывается.' }
  expect(shown()).toEqual(['Сделать панель.', 'уточнение', 'панель открывается.'])
})

test('Редактор описания показывает «Приёмка:» вместо пометки хранения; сохранённый так текст читается так же', () => {
  expect(editableDescription('Цель\n\nГотово, когда: Первое\n• Второе')).toBe('Цель\n\nПриёмка:\nПервое\n• Второе')
  expect(editableDescription('Цель в одну строку.  Готово, когда: итог виден')).toBe('Цель в одну строку.\n\nПриёмка:\nитог виден')
  expect(editableDescription('Готово, когда: только приёмка')).toBe('Приёмка:\nтолько приёмка')
  expect(editableDescription('Цель\n\nГотово, когда:')).toBe('Цель\n\nПриёмка:')
  for (const same of ['', 'Только цель\n\nвторой абзац', 'Цель\n\nПриёмка:\nитог', 'Здесь приёмка: слово внутри фразы']) expect(editableDescription(same)).toBe(same)
  // Круг: то, что владелец видит в редакторе, после сохранения даёт те же разделы страницы и ту же суть карточки.
  for (const stored of ['Цель\n\nГотово, когда: Первое\n• Второе', 'Владелец: Цель  Готово, когда: итог', 'Готово, когда: только приёмка']) {
    expect(taskTextParts(editableDescription(stored))).toEqual(taskTextParts(stored))
    expect(splitTaskText(editableDescription(stored))).toEqual(splitTaskText(stored))
  }
  // Слово без «ё» и с отступом — та же пометка.
  expect(taskTextParts('Цель\n  Приемка: итог')).toEqual({ goal: 'Цель', acceptance: 'итог' })
  expect(splitTaskText('Цель\nПриёмка:\n• первое\n• второе')).toEqual({ goal: 'Цель', criteria: ['первое', 'второе'] })
})

test('Вкладка «Описание» целиком на ширине 60: название, «Задача:», «Приёмка:», «Ограничения:»; номер — в шапке', () => {
  const page = newTaskPage({ ...TASK, alias: 'TASK-190', title: 'Перестроить панель ключей окружения: файлы карточками, значки вместо подписей',
    description: 'У вкладки панели нет значка и стоит имя env. Файлы показывать сворачиваемыми карточками.\n\nГотово, когда: Вкладка панели со значком и русским названием.',
    acceptance: [], constraints: ['Рантайм не менять'] }, [])
  page.width = 60
  expect(pageNumber(page)).toBe('#190')
  expect(pageLines(page, NOW).map(line => line.text)).toEqual([
    'Перестроить панель ключей окружения: файлы карточками,',
    'значки вместо подписей',
    '',
    'Задача:',
    'У вкладки панели нет значка и стоит имя env. Файлы',
    'показывать сворачиваемыми карточками.',
    '',
    'Приёмка:',
    'Вкладка панели со значком и русским названием.',
    '',
    'Ограничения:',
    'Рантайм не менять',
  ])
  expect(pageLines(page, NOW).filter(line => line.kind === 'heading' || line.kind === 'title').length).toBe(5)
})

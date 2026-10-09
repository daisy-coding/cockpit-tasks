import type { AgentTaskNote, Checkpoint, OwnerComment, Task } from '../types'
import type { Theme } from './theme'
import { wordLines } from './tasks'
import { displayTaskNumber } from './domain/task-number.ts'
import { taskTextParts } from './domain/task-text.ts'
import { editorHeight } from './editor'
import { truncateCells } from './layout'
import { sameDay, twoDigits, wallTime } from './local-time'
import { cleanWorkText, workAuthor, workEntries, WORK_GLYPHS, type OwnerChange, type WorkEntry } from './work-history'

export type PageTab = 'description' | 'comments'
type PageScroll = { offset: number; follow: boolean; anchor: string | null }

export interface TaskPage {
  task: Task
  // Сессия, открывшая форму: старый редактор не получает права новой сессии молча.
  session?: string
  comments: OwnerComment[]
  agentNotes: AgentTaskNote[]
  checkpoints: Checkpoint[]
  changes: OwnerChange[]
  historyCursor: number
  plain: boolean
  tab: PageTab
  views: Record<PageTab, PageScroll>
  selected: string | null
  total: number
  height: number
  width: number
  descriptionDraft: string | null
  // Правка описания, закрытая клавишей Esc или уходом фокуса: движок сообщает их одним событием,
  // поэтому набранное не выбрасывается, а возвращается при следующем открытии правки.
  descriptionStash: string | null
  commentDraft: string
  newCommentDraft: string
  editingComment: { commentId: string; revision: number } | null
  held: string | null
  deleting: { commentId: string; revision: number; until: number } | null
  reveal: string | null
  available: boolean
}

export function newTaskPage(task: Task, comments: OwnerComment[], agentNotes: AgentTaskNote[] = []): TaskPage {
  return { task, comments, agentNotes, checkpoints: [], changes: [], historyCursor: 0, plain: true,
    tab: 'description', views: { description: { offset: 0, follow: false, anchor: null }, comments: { offset: 0, follow: true, anchor: null } },
    selected: null, total: 0, height: 1, width: 80, descriptionDraft: null, descriptionStash: null,
    commentDraft: '', newCommentDraft: '', editingComment: null, held: null, deleting: null, reveal: null, available: true }
}

export function commentTime(comment: Pick<OwnerComment, 'createdAt' | 'revision'>, now: number): string {
  const created = wallTime(new Date(comment.createdAt))
  const pad = twoDigits
  return `${sameDay(created, wallTime(now)) ? '' : `${pad(created.day)}.${pad(created.month)} `}${pad(created.hour)}:${pad(created.minute)}${comment.revision > 0 ? '  изм.' : ''}`
}

// Каждая запись окна — целая строка. Движок не режет слова и не рисует отрицательный top.
export type PageSpan = { text: string; role: 'fg' | 'muted' | 'ok' | 'fail' }
export type PageLine = { id: string; text: string; kind: 'title' | 'description' | 'criteria' | 'constraint' | 'note' | 'trail' | 'empty' | 'heading' | 'time' | 'comment' | 'gap' | 'editor'; commentId?: string; entryId?: string; spans?: PageSpan[] }
export type TaskPageProps = { taskId: string; generation: number; tab: PageTab; lines: PageLine[]; width: number; height: number; offset: number; total: number; selected: string | null; theme: Theme }

export function pageEntries(page: TaskPage): WorkEntry[] {
  return workEntries(page.task, page.comments, page.agentNotes, page.checkpoints, page.changes)
}

// Номер стоит в шапке панели над вкладками страницы и виден на обеих вкладках.
export function pageNumber(page: TaskPage): string {
  return displayTaskNumber(page.task.alias)
}

export function selectPageTab(page: TaskPage, tab: PageTab): void {
  page.tab = tab
  page.deleting = null
  page.reveal = null
}

function pageTextLines(text: string, width: number): string[] {
  return cleanWorkText(text).split('\n').flatMap(paragraph => wordLines(paragraph, width, Number.MAX_SAFE_INTEGER))
}

export function entryLines(entry: WorkEntry, width: number, now: number, plain: boolean): PageLine[] {
  const glyph = WORK_GLYPHS[workAuthor(entry)][plain ? 'plain' : 'nerd']
  const time = commentTime({ createdAt: entry.createdAt, revision: entry.revision ?? 0 }, now)
  const executor = entry.executor ? cleanWorkText(entry.executor).replace(/\n/gu, ' ') : ''
  const text = truncateCells(`${glyph} ${time}${executor ? ` ${executor}` : ''}`, width)
  const common = { entryId: entry.id, ...(entry.commentId ? { commentId: entry.commentId } : {}) }
  const lines: PageLine[] = [{ ...common, id: `work:${entry.id}:time`, kind: 'time', text, spans: [{ text, role: 'muted' }] }]
  const indent = ' '.repeat(Math.min(2, Math.max(0, width - 1)))
  pageTextLines(entry.text, Math.max(1, width - indent.length)).forEach((body, index) => {
    const text = indent + body
    const at = entry.state ? body.indexOf(entry.state.word) : -1
    const spans: PageSpan[] = entry.state && at >= 0 ? [
      { text: indent + body.slice(0, at), role: 'fg' }, { text: entry.state.word, role: entry.state.role },
      { text: body.slice(at + entry.state.word.length), role: 'fg' },
    ].filter(span => span.text) as PageSpan[] : [{ text, role: 'fg' }]
    lines.push({ ...common, id: `work:${entry.id}:text:${index}`, kind: entry.commentId ? 'comment' : workAuthor(entry) === 'system' ? 'trail' : 'note', text, spans })
  })
  return lines
}

export function pageLines(page: TaskPage, now: number): PageLine[] {
  const width = Math.max(1, page.width - 4)
  const lines: PageLine[] = []
  const add = (kind: PageLine['kind'], text: string, commentId?: string) => {
    const start = lines.length
    pageTextLines(text, width).forEach((text, index) => lines.push({ id: `${kind}:${commentId ?? ''}:${start + index}`, kind, text, ...(commentId ? { commentId } : {}) }))
  }
  const section = (label: string) => { if (lines.length) lines.push({ id: `gap:${label}`, kind: 'gap', text: '' }); add('heading', `${label}:`) }
  if (page.tab === 'comments') {
    const entries = pageEntries(page)
    if (!entries.length) add('empty', 'Записей пока нет')
    entries.forEach((entry, index) => {
      if (index) lines.push({ id: `work:${entry.id}:gap`, kind: 'gap', text: '' })
      lines.push(...entryLines(entry, width, now, page.plain))
    })
    return lines
  }
  // Вкладка «Описание» сверху вниз: название, суть, приёмка; номер задачи стоит в шапке панели. Текст задачи показан
  // в порядке ввода и целиком: разбор для короткой сводки удаляет маркеры и повторы, поэтому для редактируемого
  // текста не подходит.
  add('title', cleanWorkText(page.task.title).replace(/\n/gu, ' '))
  const { goal, acceptance } = taskTextParts(cleanWorkText(page.task.description ?? ''))
  const listed = (page.task.acceptance ?? []).filter(text => text.trim())
  if (page.descriptionDraft !== null) {
    // Правится исходный текст целиком, вместе с пометкой приёмки: раздел приёмки на время правки скрыт.
    section('Задача')
    for (let index = 0; index < Math.max(3, Math.min(editorHeight(page.descriptionDraft, Math.max(1, page.width - 3)), page.height - 1)); index += 1) lines.push({ id: `description-editor:${index}`, kind: 'editor', text: '' })
    lines.push({ id: 'description-editor:hint', kind: 'empty', text: 'Ctrl+J — новая строка' })
  } else {
    if (goal) { section('Задача'); add('description', goal) }
    if (acceptance || listed.length) {
      section('Приёмка')
      if (acceptance) add('criteria', acceptance)
      for (const criterion of listed) add('criteria', listed.length > 1 || acceptance ? `• ${criterion}` : criterion)
    }
    if (!goal && !acceptance && !listed.length) { lines.push({ id: 'gap:empty', kind: 'gap', text: '' }); add('empty', 'Описания пока нет') }
  }
  const constraints = (page.task.constraints ?? []).filter(text => text.trim())
  if (constraints.length) {
    section('Ограничения')
    for (const constraint of constraints) add('constraint', constraints.length > 1 ? `• ${constraint}` : constraint)
  }
  // Раздела «След» на странице нет: сведения из git нужны агенту и приходят ему в контексте задачи.
  return lines
}

export function scrollPage(page: TaskPage, by: number): void {
  if (!Number.isFinite(by)) return
  const view = page.views[page.tab]
  const max = Math.max(0, page.total - page.height)
  view.offset = Math.max(0, Math.min(max, view.offset + Math.round(by)))
  view.follow = page.tab === 'comments' && view.offset === max
  view.anchor = null
}

export function revealPageLine(page: TaskPage, lines: PageLine[], target: string): void {
  const start = lines.findIndex(line => target === 'description' ? line.kind === 'editor' : line.commentId === target)
  if (start < 0) return
  let end = start + 1
  while (end < lines.length && (target === 'description' ? lines[end]?.kind === 'editor' || lines[end]?.id === 'description-editor:hint' : lines[end]?.commentId === target)) end += 1
  const view = page.views[page.tab]
  if (start < view.offset || end - start > page.height) view.offset = start
  else if (end > view.offset + page.height) view.offset = end - page.height
  view.follow = page.tab === 'comments' && view.offset >= lines.length - page.height
  view.anchor = null
}

export function pageWindow(page: TaskPage, lines: PageLine[], theme: Theme, generation = 0): TaskPageProps {
  const view = page.views[page.tab]
  page.total = lines.length
  const max = Math.max(0, lines.length - page.height)
  const anchor = view.anchor ? lines.findIndex(line => line.id === view.anchor) : -1
  view.offset = page.tab === 'comments' && view.follow ? max : Math.max(0, Math.min(max, anchor >= 0 ? anchor : view.offset))
  if (page.reveal) { revealPageLine(page, lines, page.reveal); page.reveal = null }
  view.offset = Math.max(0, Math.min(max, view.offset))
  view.anchor = lines[view.offset]?.id ?? null
  return { taskId: page.task.taskId, generation, tab: page.tab, lines: lines.slice(view.offset, view.offset + page.height), width: page.width, height: page.height,
    offset: view.offset, total: lines.length, selected: page.selected, theme }
}

export function movePage(page: TaskPage, key: string, now: number): void {
  page.deleting = null
  const lines = pageLines(page, now)
  page.total = lines.length
  if (page.tab === 'comments' && ['up', 'down', 'j', 'k'].includes(key) && page.comments.length) {
    const direction = key === 'up' || key === 'k' ? -1 : 1
    const current = page.comments.findIndex(comment => comment.commentId === page.selected)
    const at = current < 0 ? direction > 0 ? 0 : page.comments.length - 1 : Math.max(0, Math.min(page.comments.length - 1, current + direction))
    page.selected = page.comments[at]!.commentId
    revealPageLine(page, lines, page.selected)
  } else {
    const by = key === 'home' || key === 'g' ? -lines.length : key === 'end' || key === 'G' ? lines.length
      : (['up', 'k', 'pageup'].includes(key) ? -1 : 1) * (key.startsWith('page') ? Math.max(1, page.height - 1) : 1)
    scrollPage(page, by)
  }
}

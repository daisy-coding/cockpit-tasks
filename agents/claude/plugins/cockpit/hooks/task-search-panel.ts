import type { OwnerTask, Projection, TaskPageList, TaskSearch, TaskSearchQuery, TaskSearchRow, TaskSummary } from '../types/index'
import type { TaskRow, TaskView } from './tasks'
import { historyList, historyRows, taskList, taskRows } from './tasks'
import { DEFAULT_THEME, type Theme } from './theme'
import { cellWidth, truncateCells } from './layout'
import { redactSecrets, stripPastedContent } from './domain/privacy'
import { matchesTaskSearch, normalizeTaskSearchText, parseTaskSearchQuery, taskSearchTitleRanges } from './domain/task-search'
import type { TaskSearchRange } from './domain/task-search'

export const SEARCH_LISTS: TaskPageList[] = ['queue', 'deferred', 'closed']
export const SEARCH_LIMIT = 50
export const SEARCH_DELAY_MS = 150
export const SEARCH_UNAVAILABLE = 'Поиск по описаниям недоступен в этой версии. Обнови панель задач.'
export type SearchTab = 'agent' | 'owner' | 'backlog' | 'history'
// query нужен модулю карточек: раскрытое описание он подсвечивает сам; context — подсветка его строк.
export type SearchDecoration = { title: TaskSearchRange[][]; snippet?: string; ranges?: TaskSearchRange[]; query?: TaskSearchQuery; context?: TaskSearchRange[][] }
export type SearchList = { total: number; rows: TaskSearchRow[]; next: number; exhausted: boolean }
export type SearchPanel = {
  open: boolean; focused: boolean; query: string; shownQuery: string; sequence: number; unavailable: boolean
  lists: Record<TaskPageList, SearchList>; loading: Set<TaskPageList>; views: Record<TaskPageList, TaskView>
  reads: Set<string>
}
export type OwnerSearch = { active: boolean; query: TaskSearchQuery | null; empty: string; unavailable?: boolean }

export function newSearchPanel(): SearchPanel {
  const list = (): SearchList => ({ total: 0, rows: [], next: 0, exhausted: true })
  const view = (): TaskView => ({ cursor: '', expanded: new Set(), collapsed: new Set(), offset: 0, limit: 12 })
  // Поле стоит в панели всегда: поиск не нужно открывать.
  return { open: true, focused: false, query: '', shownQuery: '', sequence: 0, unavailable: false,
    lists: { queue: list(), deferred: list(), closed: list() }, loading: new Set(), reads: new Set(), views: { queue: view(), deferred: view(), closed: view() } }
}
export const searchActive = (panel: SearchPanel) => panel.open && panel.query.trim() !== ''
export const searchList = (tab: SearchTab): TaskPageList => tab === 'history' ? 'closed' : tab === 'backlog' ? 'deferred' : 'queue'
export const cleanSearchText = (text: string) => redactSecrets(stripPastedContent(text)).replace(/[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu,
  char => char === '\n' || char === '\t' ? ' ' : '').replace(/\s+/gu, ' ')

export { ownerShownTitle } from './owner/saved-cards'
// По номеру ищется родительская задача; самостоятельное поручение ищется по своему тексту.
export function ownerSearchMatches(task: OwnerTask, query: TaskSearchQuery | null): boolean {
  return query !== null && matchesTaskSearch(query, { alias: task.taskAlias ?? '',
    title: cleanSearchText([task.title, task.result, task.taskTitle].filter(Boolean).join(' ')),
    description: cleanSearchText([task.why, task.doneWhen, task.answer, task.reason].filter(Boolean).join(' ')) })
}

export function acceptSearch(panel: SearchPanel, result: TaskSearch, query: string, append = false): void {
  if (!append) panel.reads.clear()
  for (const list of SEARCH_LISTS) {
    const page = result.lists[list]
    if (!page) continue
    const previous = append ? panel.lists[list].rows : []
    const rows = [...new Map([...previous, ...page.rows].map(row => [row.taskId, row])).values()]
    const next = result.offset + page.rows.length
    panel.lists[list] = { total: page.total, rows, next, exhausted: next >= page.total || page.rows.length === 0 }
    if (!append) {
      const view = panel.views[list]
      view.cursor = rows[0] ? `task:${rows[0].taskId}` : ''; view.offset = 0; view.window = undefined; view.reveal = true
    }
  }
  panel.shownQuery = query
}

export function fallbackSearch(panel: SearchPanel, state: Projection, view: TaskView, closed: Parameters<typeof historyList>[2]): void {
  const query = parseTaskSearchQuery(panel.query)
  const tasks = new Map([...taskList(state), ...historyList(state, view, closed)].map(task => [task.taskId, task]))
  const lists: TaskSearch['lists'] = {}
  for (const list of SEARCH_LISTS) {
    const rows: TaskSearchRow[] = []
    for (const summary of tasks.values()) {
      if (summary.status !== (list === 'closed' ? 'done' : list === 'deferred' ? 'paused' : 'active')) continue
      const task = { ...summary, ...view.details?.get(summary.taskId) }
      const description = cleanSearchText([task.description, ...(task.acceptance ?? []), ...(task.constraints ?? []),
        ...(view.notes?.get(task.taskId) ?? []).map(note => note.text)].filter(Boolean).join(' '))
      if (!query || !matchesTaskSearch(query, { alias: task.alias, title: cleanSearchText(task.title), description })) continue
      const titleMatch = taskSearchTitleRanges(query, task.title).length > 0
      const inside = titleMatch && taskSearchTitleRanges(query, description).length > 0
      rows.push({ taskId: task.taskId, alias: task.alias, title: cleanSearchText(task.title), status: task.status, updatedAt: task.updatedAt ?? '',
        priorityPinned: Boolean(task.priorityPinned), match: { field: titleMatch ? 'title' : 'description', snippet: truncateCells(titleMatch ? task.title : description, 160),
          ...(inside ? { inside: { field: 'description' as const, snippet: truncateCells(description, 160) } } : {}) } })
    }
    lists[list] = { total: rows.length, rows }
  }
  acceptSearch(panel, { offset: 0, limit: SEARCH_LIMIT, lists, truncated: false }, panel.query)
}

export function searchTasks(panel: SearchPanel, state: Projection, details: TaskView['details']): TaskSummary[] {
  const known = new Map(taskList(state).map(task => [task.taskId, task]))
  return SEARCH_LISTS.flatMap(list => panel.lists[list].rows.map(row => ({
    revision: 0, certainty: 'confirmed' as const, certaintySource: 'user' as const, certaintyProvenance: 'panel' as const,
    ...known.get(row.taskId), ...details?.get(row.taskId), taskId: row.taskId, alias: row.alias, title: cleanSearchText(row.title), status: row.status,
    updatedAt: row.updatedAt, priorityPinned: row.priorityPinned, stage: 'task' as const,
  })))
}

export function searchEmpty(panel: SearchPanel, ownerCount: number, tab: SearchTab): string {
  const others = SEARCH_LISTS.some(list => searchList(tab) !== list && panel.lists[list].total > 0) || tab !== 'owner' && ownerCount > 0
    || tab === 'owner' && panel.lists.queue.total > 0
  return others ? 'Здесь совпадений нет. Есть в других вкладках.' : 'Ничего не найдено'
}

// Окно отрывка в рантайме: до 50 знаков перед первым совпадением, 160 знаков всего. По этим числам видно, с какой
// стороны окно обрезало текст поля.
const SNIPPET_LEAD = 50
const SNIPPET_CHARS = 160
// Одна строка отрывка: многоточие, контекст до, найденное слово, контекст после, многоточие — сколько входит в ширину.
// Многоточие стоит только с той стороны, где текст обрезан окном рантайма либо шириной карточки; обрывки слов по
// краям не показываются. Названия поля в строке нет: владельцу важны слова вокруг совпадения, а не имя поля.
export function searchSnippet(query: TaskSearchQuery, raw: string, width: number): { text: string; ranges: TaskSearchRange[] } {
  const normalized = normalizeTaskSearchText(raw)
  const lead = (term: string) => { const at = normalized.indexOf(term); return at < 0 ? -1 : Array.from(normalized.slice(0, at)).length }
  const cutStart = query.terms.some(term => lead(term) === SNIPPET_LEAD)
  const cutEnd = Array.from(raw).length >= SNIPPET_CHARS
  const found = (value: string) => taskSearchTitleRanges(query, value).length > 0
  let text = cleanSearchText(raw).trim()
  // Обрывок слова у обрезанного края убирается, если совпадение не в нём.
  for (const [cut, edge] of [[cutStart, /^\S*\s+/u], [cutEnd, /\s+\S*$/u]] as const) {
    const trimmed = cut ? text.replace(edge, '') : text
    if (found(trimmed) || !found(text)) text = trimmed
  }
  const room = Math.max(1, width)
  const words = text.split(' ')
  const marks = (from: number, to: number) => (from > 0 || cutStart ? 1 : 0) + (to < words.length - 1 || cutEnd ? 1 : 0)
  const fits = (from: number, to: number) => cellWidth(words.slice(from, to + 1).join(' ')) + marks(from, to) <= room
  // Слово с первым совпадением — середина окна; окно растёт по слову влево и вправо, пока входит в строку.
  const first = taskSearchTitleRanges(query, text)[0]
  let hit = 0
  for (let index = 0, cell = 0; first && index < words.length; index += 1) {
    const end = cell + cellWidth(words[index]!)
    if (first.start < end) { hit = index; break }
    cell = end + 1
  }
  let from = hit, to = hit
  for (let grew = true; grew;) {
    grew = false
    if (from > 0 && fits(from - 1, to)) { from -= 1; grew = true }
    if (to < words.length - 1 && fits(from, to + 1)) { to += 1; grew = true }
  }
  const left = from > 0 || cutStart, right = to < words.length - 1 || cutEnd
  const body = words.slice(from, to + 1).join(' ')
  // Одно слово шире строки: обрезка по ячейкам сама ставит многоточие в конце.
  const shown = fits(from, to) ? `${left ? '…' : ''}${body}${right ? '…' : ''}` : truncateCells(`${left ? '…' : ''}${body}`, room)
  return { text: shown, ranges: taskSearchTitleRanges(query, shown) }
}
// Ищем в целом названии до переноса: одно длинное слово может совпасть сразу в двух строках.
export function wrappedSearchRanges(query: TaskSearchQuery, title: string, lines: string[]): TaskSearchRange[][] {
  const source = cleanSearchText(title).trim()
  const ranges = taskSearchTitleRanges(query, source)
  let from = 0
  return lines.map(line => {
    const visible = line.endsWith('…') ? line.slice(0, -1).trimEnd() : line
    const index = source.indexOf(visible, from)
    if (index < 0) return taskSearchTitleRanges(query, line)
    const start = cellWidth(source.slice(0, index)), end = start + cellWidth(visible)
    from = index + visible.length
    return ranges.filter(range => range.start < end && range.end > start)
      .map(range => ({ start: Math.max(0, range.start - start), end: Math.min(end, range.end) - start }))
  })
}

export function searchRows(panel: SearchPanel, state: Projection, view: TaskView, tab: SearchTab, width: number, at: number, ownerCount: number, theme: Theme = DEFAULT_THEME): TaskRow[] {
  const list = searchList(tab)
  if (!panel.lists[list].rows.length) {
    const message = searchEmpty(panel, ownerCount, tab)
    // Пустое состояние без рамки: длинная строка остаётся одной строкой панели и обрезается движком по ширине.
    const lines = [message, ...(panel.unavailable ? [SEARCH_UNAVAILABLE] : [])]
    return [{ kind: 'empty', id: 'search-empty', width, height: lines.length, text: message, lines }]
  }
  const tasks = searchTasks(panel, state, view.details)
  const focus = state.focus ? { ...state.focus, task: tasks.find(task => task.taskId === state.focus?.task?.taskId) ?? null } : null
  const filtered: Projection = { ...state, focus, snapshot: state.snapshot ? { ...state.snapshot, tasks, focus: focus ?? state.snapshot.focus } : null }
  const rows = tab === 'history' ? historyRows(filtered, view, width, at, theme) : taskRows(filtered, view, width, at, theme, tab === 'backlog' ? 'backlog' : 'agent')
  const query = parseTaskSearchQuery(panel.shownQuery)
  if (!query) return rows
  for (const row of rows) {
    if (row.kind !== 'card') continue
    const hit = panel.lists[list].rows.find(item => item.taskId === row.taskId)
    const match = hit?.match
    row.search = { title: wrappedSearchRanges(query, hit?.title ?? row.titleLines.join(' '), row.titleLines), query }
    // Отрывок берётся из текста карточки: само совпадение либо внутреннее, когда лучшее — название или номер.
    const body = match && (match.field !== 'title' && match.field !== 'number' ? match : match.inside)
    if (body) {
      const shown = searchSnippet(query, body.snippet, row.textWidth)
      row.search.snippet = shown.text; row.search.ranges = shown.ranges
      row.height += 1
    }
  }
  return rows
}

import type { TaskSearchQuery } from '../../types/index'
import { cellWidth, graphemes } from '../layout.ts'

export interface TaskSearchSource { alias: string; title: string; description?: string }
export interface TaskSearchRange { start: number; end: number }

export function normalizeTaskSearchText(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е')
}

export function parseTaskSearchQuery(query: string): TaskSearchQuery | null {
  if (typeof query !== 'string' || Array.from(query).length > 200 || /\p{Cs}/u.test(query)) return null
  const words = normalizeTaskSearchText(query).match(/[\p{L}\p{N}]+/gu) ?? []
  const terms = [...new Set(words.filter((word, index) => !(word === 'task' && /^[0-9]+$/.test(words[index + 1] ?? ''))))]
  if (!terms.length) return null
  return { terms, numbers: terms.filter(term => /^[0-9]+$/.test(term)).map(term => term.replace(/^0+/, '') || '0') }
}

export function matchesTaskSearch(query: TaskSearchQuery, row: TaskSearchSource): boolean {
  const texts = [row.alias.replace(/^TASK-/, ''), normalizeTaskSearchText(row.title), normalizeTaskSearchText(row.description ?? '')]
  return query.terms.every(term => texts.some(text => text.includes(term)))
}

export function taskSearchTitleRanges(query: TaskSearchQuery, title: string): TaskSearchRange[] {
  let text = ''
  let cells = 0
  const positions: TaskSearchRange[] = []
  // Каждая позиция нормализованной строки связана с целой исходной графемой:
  // расширение İ при lower и многознаковые эмодзи не разрезают ячейки экрана.
  for (const cluster of graphemes(title)) {
    const normalized = normalizeTaskSearchText(cluster)
    const range = { start: cells, end: cells + cellWidth(cluster) }
    for (let index = 0; index < normalized.length; index += 1) positions.push(range)
    text += normalized
    cells = range.end
  }
  const ranges: TaskSearchRange[] = []
  for (const term of query.terms) {
    let from = 0
    while (from < text.length) {
      const index = text.indexOf(term, from)
      if (index < 0) break
      const start = positions[index]
      const end = positions[index + term.length - 1]
      if (start && end && end.end > start.start) ranges.push({ start: start.start, end: end.end })
      from = index + 1
    }
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: TaskSearchRange[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

import type { OwnerTask } from '../../types'
import type { OwnerCard } from './tasks'
import { truncateCells } from '../layout'
import { displayTaskNumber } from '../domain/task-number.ts'

export const SAVED_CARD_HEIGHT = 3
export type SavedTone = 'ok' | 'fail' | 'muted'
const SAVED_MARKS = {
  ok: { nerd: '\u{f05e0}', plain: '✓' }, // md-check_circle
  fail: { nerd: '\u{f0159}', plain: '×' }, // md-close_circle
  muted: { nerd: '\u{f0188}', plain: '…' }, // md-comment_text
} as const
export const SAVED_SEND = { nerd: '\u{f048a}', plain: '>' } as const // md-send

export function savedMark(tone: SavedTone, plain = false): string {
  return SAVED_MARKS[tone][plain ? 'plain' : 'nerd']
}

export function savedTone(task: OwnerTask): SavedTone {
  if (task.state === 'rejected' || task.taskAlias && task.answer === 'Есть замечания') return 'fail'
  if (task.state === 'done' && (task.taskAlias && task.answer === 'Принято'
    || task.kind === 'do' && !task.answer)) return 'ok'
  return 'muted'
}

// Обрезка оставляет целые слова; отдельное длинное слово режется по графемам и ячейкам.
export function savedTitle(title: string, width: number): string {
  const text = title.replace(/\s+/gu, ' ').trim()
  const clipped = truncateCells(text, width)
  if (clipped === text) return text
  const prefix = clipped.slice(0, -1)
  const boundary = prefix.lastIndexOf(' ')
  return (boundary > 0 && text[prefix.length] !== ' ' ? prefix.slice(0, boundary) : prefix).trimEnd() + '…'
}

// Название поручения на экране: у проверки — итог агента, без него — название задачи. Одно на все виды
// карточки: открытую, свёрнутую в ответ владельца и найденную поиском.
export function ownerShownTitle(task: OwnerTask): string {
  return task.taskAlias ? task.result ?? task.taskTitle ?? task.title.replace(/^Проверить:\s*/u, '') : task.title
}

export function savedCardOf(task: OwnerTask, width: number): OwnerCard {
  return { id: task.id, label: displayTaskNumber(task.taskAlias ?? ''), titleLines: [savedTitle(ownerShownTitle(task), width)],
    context: [], height: SAVED_CARD_HEIGHT, selected: false, whole: false, saved: savedTone(task) }
}

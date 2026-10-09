import type { ClientSurface } from 'claude-code'
import { truncateCells } from './layout.ts'

export const HOVER_INTENT_MS = 200
export const DESCRIPTION_ROWS = 8
// since — такт клиентского модуля, на котором карточку раскрыли: от него идёт индикатор загрузки.
export type Expansion = { id: string; rows: number; since?: number }
// Срок запроса к рантайму — три секунды. Дольше индикатор не крутится: движение без конца выдавало бы
// отказ чтения за работу.
export const LOADER_LIMIT_MS = 3500
export const LOADER_STEP_MS = 200
export const LOADER_WORD = 'Загрузка'
export const LOADER_FAILED = 'Описание не прочитано'
export const LOADER_DOTS = 3

// Какая из трёх точек светится; undefined — срок вышел, вместо индикатора стоит неподвижный текст.
export function loaderStep(elapsedMs: number): number | undefined {
  return elapsedMs > LOADER_LIMIT_MS ? undefined : Math.floor(Math.max(0, elapsedMs) / LOADER_STEP_MS) % LOADER_DOTS
}
export type HoverIntent = { cancel?: () => void }

// Таймер начинается при входе в карточку, а не на общем такте списка.
export function holdCard(surface: Pick<ClientSurface, 'every'>, intent: HoverIntent, id: string | undefined, open: (id: string) => void): void {
  intent.cancel?.()
  intent.cancel = undefined
  if (id === undefined) return
  intent.cancel = surface.every(HOVER_INTENT_MS, () => {
    intent.cancel?.()
    intent.cancel = undefined
    open(id)
  })
}

// Карточка обнимает содержимое: пока текст читается, под названием одна строка «Загрузка…», после чтения —
// столько строк, сколько занял текст. Запас под ещё не прочитанное не держится.
export function expansionFor(id: string, lines: string[], ready: boolean, baseHeight: number, height: number): Expansion {
  return { id, rows: Math.min(ready ? lines.length : 1, DESCRIPTION_ROWS, Math.max(0, height - baseHeight)) }
}

export function expansionLines(expansion: Expansion, lines: string[], ready: boolean, width: number): string[] {
  // Пока текст читается, строку занимает индикатор: его рисует модуль списка, здесь только место под него.
  const shown = ready ? lines.slice(0, expansion.rows) : ['']
  if (ready && lines.length > expansion.rows && shown.length) shown[shown.length - 1] = truncateCells(shown.at(-1)! + ' …', width)
  return Array.from({ length: expansion.rows }, (_, index) => shown[index] ?? '')
}

// Поднимаем только окно, когда нижняя рамка раскрытой карточки вышла за его край.
export function expansionShift(top: number, before: number, baseHeight: number, extra: number, height: number): number {
  return Math.max(0, top + before + baseHeight + extra - height)
}

export function cardBar(total: number, height: number, offset: number): { pos: number; size: number } | undefined {
  const max = total - height
  if (max <= 0) return undefined
  const size = Math.max(1, Math.round(height * height / total))
  return { pos: Math.round(Math.max(0, Math.min(max, offset)) / max * (height - size)), size }
}

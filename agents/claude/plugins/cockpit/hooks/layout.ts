// Основа: ConversationAtlas, hooks/ui/shared.tsx:66–236,291–319.
// Copyright (c) 2026 NeelAPatel, MIT; полный текст в THIRD_PARTY_NOTICES.md.
// Доработки Cockpit: целые графемы, явные приоритеты метаданных и времени.

const segmenter = new Intl.Segmenter('ru', { granularity: 'grapheme' })

// Знак, который занимает одну ячейку и не склеивается с соседями: печатный ASCII, латиница, греческий, кириллица,
// типографские знаки, стрелки, математика, рамки и значки. У текста из таких знаков ширина равна длине,
// а графема — один знак: сегментация не нужна. Обычный русский и английский текст почти весь такой,
// а сегментация каждого знака стоила десятки миллисекунд на каждую отрисовку страницы задачи и каждую клавишу поля.
export const isSingleCell = (code: number) => code >= 0x20 && code <= 0x7e || code >= 0xa0 && code <= 0x2ff || code >= 0x370 && code <= 0x3ff
  || code >= 0x400 && code <= 0x482 || code >= 0x48a && code <= 0x52f || code >= 0x2010 && code <= 0x2027 || code >= 0x2030 && code <= 0x205e
  || code >= 0x20a0 && code <= 0x20bf || code >= 0x2100 && code <= 0x2328 || code >= 0x232b && code <= 0x23ff || code >= 0x2500 && code <= 0x27bf
export const SINGLE_CELL_TEXT = /^[\u0020-\u007e\u00a0-\u02ff\u0370-\u03ff\u0400-\u0482\u048a-\u052f\u2010-\u2027\u2030-\u205e\u20a0-\u20bf\u2100-\u2328\u232b-\u23ff\u2500-\u27bf]*$/u

export function graphemes(value: string): string[] {
  return SINGLE_CELL_TEXT.test(value) ? value.split('') : Array.from(segmenter.segment(value), part => part.segment)
}

// Графемы по одной, без разбора всей строки заранее: вызывающий останавливается, когда набрал нужную ширину.
export function* eachGrapheme(value: string): Generator<string> {
  for (const part of segmenter.segment(value)) yield part.segment
}

function clusterCells(cluster: string): number {
  if (cluster.length === 1 && isSingleCell(cluster.charCodeAt(0))) return 1
  let cells = 0
  for (const ch of cluster) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0) || /\p{Mark}/u.test(ch)
      || code === 0x200d || (code >= 0x1f3fb && code <= 0x1f3ff)) continue
    const wide = code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x1f1e6 && code <= 0x1f1ff)
    )
    cells = Math.max(cells, wide ? 2 : 1)
  }
  if (cluster.includes('\ufe0f') || cluster.includes('\u20e3')) cells = Math.max(cells, 2)
  return cells
}

export function cellWidth(value: string): number {
  if (SINGLE_CELL_TEXT.test(value)) return value.length
  let width = 0
  for (const part of segmenter.segment(value)) width += clusterCells(part.segment)
  return width
}

// То же, что cellWidth(value) > limit, но с остановкой на первой графеме за пределом:
// перенос длинного текста не измеряет весь остаток на каждую строку.
export function widerThan(value: string, limit: number): boolean {
  if (value.length * 2 <= limit) return false
  if (SINGLE_CELL_TEXT.test(value)) return value.length > limit
  let cells = 0
  for (const part of segmenter.segment(value)) {
    cells += clusterCells(part.segment)
    if (cells > limit) return true
  }
  return false
}

export function truncateCells(value: string, width: number): string {
  const limit = Math.max(1, Math.floor(width))
  if (SINGLE_CELL_TEXT.test(value)) return value.length <= limit ? value : limit === 1 ? '…' : `${value.slice(0, limit - 1)}…`
  if (!widerThan(value, limit)) return value
  if (limit === 1) return '…'
  let out = ''
  for (const cluster of eachGrapheme(value)) {
    if (cellWidth(`${out}${cluster}…`) > limit) break
    out += cluster
  }
  return `${out}…`
}


import { expect, test } from 'claude-code/testing'
import { SINGLE_CELL_TEXT, cellWidth, eachGrapheme, graphemes, isSingleCell, truncateCells } from '../hooks/layout'
import { wordLines } from '../hooks/tasks'

// Измерение до быстрого пути: каждая графема сегментируется и проверяется отдельно. Эталон для сверки.
const segmenter = new Intl.Segmenter('ru', { granularity: 'grapheme' })
const graphemesBySegmenter = (value: string) => Array.from(segmenter.segment(value), part => part.segment)
function cellWidthBySegmenter(value: string): number {
  let width = 0
  for (const cluster of graphemesBySegmenter(value)) {
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
    if (cluster.includes('️') || cluster.includes('⃣')) cells = Math.max(cells, 2)
    width += cells
  }
  return width
}

const singles: string[] = []
for (let code = 0; code <= 0xffff; code++) if (isSingleCell(code)) singles.push(String.fromCharCode(code))

test('Каждый знак быстрого пути занимает одну ячейку и не склеивается ни с предыдущим, ни со следующим знаком', () => {
  expect(singles.length).toBeGreaterThan(2000)
  for (const char of singles) {
    expect(SINGLE_CELL_TEXT.test(char)).toBe(true)
    expect(cellWidthBySegmenter(char)).toBe(1)
    // Знак-продолжение склеился бы с предыдущим, знак-приставка — со следующим.
    expect(graphemesBySegmenter(`a${char}`)).toHaveLength(2)
    expect(graphemesBySegmenter(`${char}a`)).toHaveLength(2)
    expect(graphemesBySegmenter(`я${char}я`)).toHaveLength(3)
  }
})

// Отдельный тест: вместе с проверкой выше он занимал под нагрузкой до четырёх секунд из пяти.
test('Множество знаков быстрого пути и регулярное выражение совпадают на всей основной плоскости', () => {
  for (let code = 0; code <= 0xffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue
    expect(SINGLE_CELL_TEXT.test(String.fromCharCode(code))).toBe(isSingleCell(code))
  }
})

test('Ширина и графемы совпадают с посимвольным измерением на случайных строках', () => {
  const mixed = ['日', '本', '🙂', 'é', '҃', '👨‍👩‍👧', '1️⃣', '✔️', '🇺🇦', '\t', '\n', '\u200b', '\u2028', '〈', '⌚', '\ud83d', 'ﬁ', '한', 'กำ', '\u{f040a}', '\u0000', '\u007f']
  let seed = 20261007
  const random = (limit: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % limit }
  for (let round = 0; round < 5_000; round++) {
    let value = ''
    for (let length = random(50); length > 0; length--) value += round % 3 && !random(6) ? mixed[random(mixed.length)] : singles[random(singles.length)]
    expect(cellWidth(value)).toBe(cellWidthBySegmenter(value))
    expect(graphemes(value)).toEqual(graphemesBySegmenter(value))
    expect([...eachGrapheme(value)]).toEqual(graphemesBySegmenter(value))
  }
  expect(cellWidth('')).toBe(0)
  expect(graphemes('')).toEqual([])
})

// Обрезка и перенос по словам до ускорения: вся строка измеряется и разбирается заранее. Эталоны для сверки.
function truncateCellsByMeasuring(value: string, width: number): string {
  const limit = Math.max(1, Math.floor(width))
  if (cellWidthBySegmenter(value) <= limit) return value
  if (limit === 1) return '…'
  let out = ''
  for (const cluster of graphemesBySegmenter(value)) {
    if (cellWidthBySegmenter(`${out}${cluster}…`) > limit) break
    out += cluster
  }
  return `${out}…`
}
function wordLinesByMeasuring(value: string, width: number, limit: number): string[] {
  const lines: string[] = []
  const paragraphs = value.replace(/[\t\r]/gu, ' ').trim().split('\n')
  for (let index = 0; index < paragraphs.length; index += 1) {
    let rest = paragraphs[index]!.replace(/ +/gu, ' ').trim()
    do {
      if (lines.length === limit) {
        lines[limit - 1] = truncateCellsByMeasuring(lines[limit - 1]! + ' ' + rest + ' …', width)
        return lines
      }
      if (cellWidthBySegmenter(rest) <= width) { lines.push(rest); break }
      let prefix = ''
      let prefixWidth = 0
      for (const cluster of graphemesBySegmenter(rest)) {
        const cells = cellWidthBySegmenter(cluster)
        if (prefixWidth + cells > width) break
        prefix += cluster
        prefixWidth += cells
      }
      const boundary = prefix.lastIndexOf(' ')
      const cut = boundary > 0 ? boundary : Math.max(1, prefix.length)
      lines.push(rest.slice(0, cut).trimEnd())
      rest = rest.slice(cut).trimStart()
    } while (rest)
  }
  return lines
}

test('Перенос по словам и обрезка дают то же, что измерение всей строки, на случайных текстах', () => {
  const plain = ['a', 'Z', '0', ' ', ' ', ' ', '~', '\u00a0', 'é', 'ж', 'Я', 'ё', '—', '«', '»', '…', '№', '→', '✓', '│']
  const mixed = [...plain, '日', '🙂', 'e\u0301', '👨\u200d👩\u200d👧', '✔\ufe0f', '🇺🇦', '\t', '\r', '\u200b', '〈', '\u{f040a}', 'ก\u0e33']
  let seed = 4242
  const random = (limit: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % limit }
  for (let round = 0; round < 2_500; round++) {
    const pool = round % 2 ? mixed : plain
    let text = ''
    for (let length = random(120); length > 0; length--) text += random(23) ? pool[random(pool.length)] : '\n'
    const width = 1 + random(26)
    const limit = random(3) ? 1 + random(5) : Number.MAX_SAFE_INTEGER
    expect(wordLines(text, width, limit)).toEqual(wordLinesByMeasuring(text, width, limit))
    expect(truncateCells(text, width)).toBe(truncateCellsByMeasuring(text, width))
  }
  for (const width of [0, 0.5, 1, 2, 2.7, 40]) for (const text of ['', ' ', 'я', 'слово', 'длинное слово без конца', '日本語のテキスト', 'a🙂b'])
    expect(truncateCells(text, width)).toBe(truncateCellsByMeasuring(text, width))
})

test('Перенос страницы и обрезка длинного текста укладываются в отрисовку', () => {
  // Описание и комментарии по несколько тысяч знаков переносятся на каждую отрисовку страницы:
  // раньше сорок тысяч знаков занимали секунды, а поле ввода перерисовывало страницу на каждую клавишу.
  const phrase = 'Проверил строки ответа владельца — всё на месте, но «кнопка» отправки не видна… '
  const text = phrase.repeat(500)
  const lines = wordLines(text, 56, Number.MAX_SAFE_INTEGER)
  expect(lines.join(' ')).toBe(text.trim())
  expect(lines.every(line => cellWidth(line) <= 56)).toBe(true)
  expect(wordLines(text, 56, 3)).toHaveLength(3)
  expect(cellWidth(truncateCells(text, 40))).toBe(40)
})

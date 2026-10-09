// Общий модуль модов набора Cockpit; копии во всех модах должны совпадать побайтно.
// Интерфейс: createSecretView(шаблоны, redactSecrets) возвращает mask и clean.
// Шаблон — [имя, глобальный RegExp либо функция совпадений, необязательная замена с $1, $2, ...].
// Совпадение содержит строку под индексом 0, необязательный index и группы по номерам.
// mask(value, { view = 'joined', multiline = false, maxCodePoints? }) ищет секреты
// во всех прочтениях неизменённого текста и передаёт итог модовому redactSecrets.
// clean(value, { view = 'joined', multiline = false }) только очищает текст;
// её результат нельзя маскировать вместо исходника: потеряются границы секретов.
// joined удаляет невидимые знаки, spaced заменяет их пробелами. multiline
// сохраняет LF, акценты при буквах и связки эмодзи, приводит CRLF к LF и табуляцию к двум пробелам. maxCodePoints
// ограничивает очищенный исходный префикс после маскирования: сокращение секрета
// не подтягивает в него исходный суффикс. Шаблоны и их порядок задаёт только мод.
type SecretMatch = { readonly 0: string; readonly index?: number; readonly [index: number]: string | undefined }
type SecretMatcher = RegExp | ((text: string) => Iterable<SecretMatch>)
type SecretPattern = readonly [string, SecretMatcher, string?]
type View = 'joined' | 'spaced'
type Options = { view?: View; multiline?: boolean; maxCodePoints?: number }
type Span = { start: number; end: number; replacement: string }
type BuiltView = { canonical: string; starts: Int32Array; ends: Int32Array }
type ViewPatch = { start: number; end: number; text: string }
type ControlSequence = { start: number; end: number; bodyStart: number; bodyEnd: number }

// Невидимый знак — всё, что терминал рисует ничем: управляющие и форматирующие,
// игнорируемые по умолчанию, отдельные комбинируемые знаки, половины суррогатных
// пар и неназначенные коды. NFC сохраняет составные буквы перед этой проверкой.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u
// Только при этих знаках слитный и раздельный виды различаются.
const HIDDEN = /(?![\t\n\u2028\u2029])[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u
const ESCAPE_MARK = String.fromCharCode(1)
const INVISIBLE_RUN = new RegExp(INVISIBLE.source + '+', 'gu')
const SEPARATOR = /[\t\n\u2028\u2029]/u
// Проверка единиц UTF-16: флаг u спрятал бы половины корректной пары.
const SURROGATE = /[\ud800-\udbff]/
const EMOJI_LEFT = /\p{Extended_Pictographic}(?:\ufe0f|\p{Emoji_Modifier})*$/u
const EMOJI_RIGHT = /^\p{Extended_Pictographic}/u
const MARK = /[\p{Mn}\p{Me}]/u
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u
// Основа акцента — буква, цифра либо другой знак письма, в том числе занимающий место (Mc):
// в индийских письменностях надстрочный знак стоит после знака гласной.
const ATTACHED_MARK = /(?<=[\p{L}\p{N}\p{M}])[\p{Mn}\p{Me}]/u
const MARK_BASE = /[\p{L}\p{N}\p{M}]$/u

// Управляющая последовательность терминала заменяется одним невидимым знаком:
// она может как разорвать ключ, так и приклеить его к соседнему слову.
function prepare(value: string, multiline: boolean): string {
  const text = value.normalize('NFC')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/gu, ESCAPE_MARK)
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, ESCAPE_MARK)
  return multiline ? text.replace(/\r\n/gu, '\n').replace(/\t/gu, '  ') : text
}

// Короткий участок таблицы копируется поэлементно: при плотных скрытых вставках участков сотни тысяч,
// и отдельный срез массива на каждый стоит дороже самих знаков.
function copyTable(source: BuiltView, from: number, to: number, starts: Int32Array, ends: Int32Array, size: number): number {
  if (to - from < 64) {
    for (let index = from; index < to; index++) { starts[size] = source.starts[index]!; ends[size++] = source.ends[index]! }
    return size
  }
  starts.set(source.starts.subarray(from, to), size)
  ends.set(source.ends.subarray(from, to), size)
  return size + to - from
}

// Меняется только вид. Его таблицы всегда ведут в исходную строку, где делаются замены.
function rewriteView(source: BuiltView, patches: readonly ViewPatch[]): BuiltView {
  if (!patches.length) return source
  const length = patches.reduce((size, patch) => size + patch.text.length - (patch.end - patch.start), source.canonical.length)
  const starts = new Int32Array(length), ends = new Int32Array(length), parts: string[] = []
  let cursor = 0, size = 0
  const copy = (end: number) => {
    if (cursor === end) return
    parts.push(source.canonical.slice(cursor, end))
    size = copyTable(source, cursor, end, starts, ends, size)
  }
  for (const patch of patches) {
    copy(patch.start)
    parts.push(patch.text)
    for (let unit = 0; unit < patch.text.length; unit++) {
      starts[size] = source.starts[patch.start]!
      ends[size++] = source.ends[patch.end - 1]!
    }
    cursor = patch.end
  }
  copy(source.canonical.length)
  return { canonical: parts.join(''), starts, ends }
}

// NFC собирает графему, но совпадение в ней покрывает все исходные части, включая слоги Hangul.
function normalizedView(source: BuiltView, normalized: string): BuiltView {
  if (source.canonical === normalized) return source
  const patches: ViewPatch[] = []
  for (const { segment, index } of new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(source.canonical)) {
    if (segment.length === 1 && segment.charCodeAt(0) < 0x80) continue
    const text = segment.normalize('NFC')
    if (text !== segment) patches.push({ start: index, end: index + segment.length, text })
  }
  return rewriteView(source, patches)
}

function multilineView(source: BuiltView, multiline: boolean): BuiltView {
  if (!multiline) return source
  return rewriteView(source, Array.from(source.canonical.matchAll(/\r\n|\t/gu), match =>
    ({ start: match.index, end: match.index + match[0].length, text: match[0] === '\t' ? '  ' : '\n' })))
}

// CSI: тело — последний байт. OSC: тело между вводящим знаком и BEL либо ESC + обратной косой чертой.
// Незакрытый OSC до конца строки распознаётся точно так же, как в clean().
function controlSequences(text: string): ControlSequence[] {
  return Array.from(text.matchAll(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu), match => {
    const start = match.index, end = start + match[0].length
    const osc = match[0].startsWith(String.fromCharCode(27) + ']')
    const closing = !osc ? 0 : text.charCodeAt(end - 1) === 7 ? 1
      : text.slice(end - 2, end) === String.fromCharCode(27) + '\\' ? 2 : 0
    return { start, end, bodyStart: osc ? start + 2 : end - 1, bodyEnd: end - closing }
  })
}

function controlView(source: BuiltView, controls: readonly ControlSequence[], reading: 'terminal' | 'parameters'): BuiltView {
  const patches: ViewPatch[] = []
  for (const control of controls) {
    patches.push({ start: control.start, end: reading === 'terminal' ? control.end : control.bodyStart, text: ESCAPE_MARK })
    if (reading === 'parameters' && control.bodyEnd < control.end)
      patches.push({ start: control.bodyEnd, end: control.end, text: ESCAPE_MARK })
  }
  return rewriteView(source, patches)
}

// Видимые участки копируются вместе с таблицами. По кодовым точкам обходятся
// только скрытые участки: дополнительные прочтения не перебирают весь обычный текст.
function buildView(source: BuiltView, view: View, multiline: boolean, display = false): BuiltView {
  const text = source.canonical
  const starts = new Int32Array(text.length), ends = new Int32Array(text.length)
  const parts: string[] = []
  let size = 0, cursor = 0
  const copy = (end: number) => {
    if (cursor === end) return
    parts.push(text.slice(cursor, end))
    size = copyTable(source, cursor, end, starts, ends, size)
  }
  for (const match of text.matchAll(INVISIBLE_RUN)) {
    copy(match.index)
    let index = match.index, runStart = index, spaces = 0
    for (const char of match[0]) {
      const code = char.codePointAt(0)!
      const shown = display && multiline && (attachedMark(text, char, index) || emojiJoiner(text, char, index)) ? char
        : code === 10 && multiline ? '\n'
        : code === 9 || code === 10 || code === 0x2028 || code === 0x2029 ? ' '
        : view === 'joined' ? '' : ' '
      for (let unit = 0; unit < shown.length; unit++) {
        starts[size] = source.starts[index]!
        ends[size++] = source.ends[index + char.length - 1]!
      }
      // Длинная скрытая полоса не создаёт массив из отдельных пустых строк или пробелов.
      if (shown === char) {
        if (spaces) { parts.push(' '.repeat(spaces)); spaces = 0 }
      } else {
        if (runStart < index) parts.push(text.slice(runStart, index))
        if (shown === ' ') spaces++
        else {
          if (spaces) { parts.push(' '.repeat(spaces)); spaces = 0 }
          if (shown) parts.push(shown)
        }
        runStart = index + char.length
      }
      index += char.length
    }
    if (spaces) parts.push(' '.repeat(spaces))
    if (runStart < index) parts.push(text.slice(runStart, index))
    cursor = index
  }
  copy(text.length)
  return { canonical: parts.join(''), starts, ends }
}
// При показе задания акцент при букве сохраняется, а отдельный знак и игнорируемые
// селекторы удаляются. При поиске секретов комбинируемые знаки всегда скрытые.
function attachedMark(text: string, char: string, at: number): boolean {
  return MARK.test(char) && !IGNORABLE.test(char) && MARK_BASE.test(text.slice(Math.max(0, at - 2), at))
}
function emojiJoiner(text: string, char: string, at: number): boolean {
  return char === '\u200d' && EMOJI_LEFT.test(text.slice(Math.max(0, at - 8), at))
    && EMOJI_RIGHT.test(text.slice(at + 1, at + 5))
}
function render(text: string, view: View, multiline: boolean): string {
  // Таблицы позиций здесь не нужны. Длинный скрытый участок заменяется разом,
  // чтобы создание массива для каждого знака не провоцировало сборку мусора.
  return text.replace(INVISIBLE_RUN, (chunk, at: number) => {
    if (!HIDDEN.test(chunk)) return multiline ? chunk.replace(/[\t\u2028\u2029]/gu, ' ') : ' '.repeat(chunk.length)
    if (!SEPARATOR.test(chunk) && (!multiline || (!MARK.test(chunk) && !chunk.includes('\u200d')))) {
      if (view === 'joined') return ''
      let length = chunk.length
      if (SURROGATE.test(chunk)) { length = 0; for (const _char of chunk) length++ }
      return ' '.repeat(length)
    }
    const parts: string[] = []
    let index = at
    for (const char of chunk) {
      parts.push(char === '\n' && multiline ? char : SEPARATOR.test(char) ? ' '
        : multiline && (attachedMark(text, char, index) || emojiJoiner(text, char, index)) ? char
        : view === 'joined' ? '' : ' ')
      index += char.length
    }
    return parts.join('')
  })
}

// Вид без очистки: текст как записан либо с каждым знаком, разложенным на части.
function plainView(text: string, decompose: boolean, source?: BuiltView): BuiltView {
  if (!decompose) {
    if (source) return source
    const starts = new Int32Array(text.length), ends = new Int32Array(text.length)
    for (let index = 0; index < text.length; index++) { starts[index] = index; ends[index] = index + 1 }
    return { canonical: text, starts, ends }
  }
  const parts: string[] = [], from: number[] = [], to: number[] = []
  let index = 0
  for (const char of text) {
    const piece = char.charCodeAt(0) < 0x80 ? char : char.normalize('NFD')
    parts.push(piece)
    for (let unit = 0; unit < piece.length; unit++) {
      from.push(source ? source.starts[index]! : index)
      to.push(source ? source.ends[index + char.length - 1]! : index + char.length)
    }
    index += char.length
  }
  return { canonical: parts.join(''), starts: Int32Array.from(from), ends: Int32Array.from(to) }
}

// Поиск не меняет текст: частичное совпадение одного шаблона не ломает другое.
function viewSpans(built: BuiltView, patterns: readonly SecretPattern[]): Span[] {
  const spans: Span[] = []
  for (const [name, expression, template] of patterns) {
    const matches = typeof expression === 'function' ? expression(built.canonical) : built.canonical.matchAll(expression)
    for (const match of matches) {
      if (!match[0].length) continue
      const at = match.index ?? 0
      spans.push({ start: built.starts[at]!, end: built.ends[at + match[0].length - 1]!,
        replacement: (template ?? `[REDACTED:${name}]`).replace(/\$(\d+)/g, (_marker, group: string) => match[Number(group)] ?? '') })
    }
  }
  return spans
}

// Ни совпадение, ни усечение не оставляют половину управляющей последовательности.
function expandControlSpans(spans: Span[], controls: readonly { start: number; end: number }[]): Span[] {
  const expand = (position: number, end: boolean) => {
    let left = 0, right = controls.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (controls[middle]!.start < position) left = middle + 1
      else right = middle
    }
    const control = controls[left - 1]
    return control && position < control.end ? end ? control.end : control.start : position
  }
  return spans.map(span => ({ ...span, start: expand(span.start, false), end: expand(span.end, true) }))
}

// Пересекающиеся участки объединяются; замена берётся у начавшегося первым.
// Граница исходного префикса сдвигается вместе с заменами, до усечения.
function maskSpans(text: string, spans: Span[], boundary = text.length): { text: string; boundary: number } {
  if (!spans.length) return { text, boundary }
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  let clean = '', cursor = 0, nextBoundary = boundary, current = { ...spans[0]! }
  const append = () => {
    clean += text.slice(cursor, current.start) + current.replacement
    cursor = current.end
    if (current.start < boundary) nextBoundary += current.replacement.length - Math.min(current.end - current.start, boundary - current.start)
  }
  for (const span of spans.slice(1)) {
    if (span.start < current.end) { current.end = Math.max(current.end, span.end); continue }
    append()
    current = { ...span }
  }
  append()
  return { text: clean + text.slice(cursor), boundary: nextBoundary }
}

export function createSecretView(patterns: readonly SecretPattern[], redactSecrets: (text: string, maxCodePoints?: number) => string) {
  return {
    clean(value: string, { view = 'joined', multiline = false }: Options = {}): string {
      return render(prepare(value, multiline), view, multiline)
    },
    mask(value: string, { view = 'joined', multiline = false, maxCodePoints }: Options = {}): string {
      const normalized = value.normalize('NFC'), split = normalized !== value
      // Обычный текст не создаёт таблиц позиций и дополнительных прочтений. Перенос строки и табуляция —
      // разделители, а не скрытые вставки: текст с ними (почти каждое описание) идёт тем же коротким путём.
      if (!split && !HIDDEN.test(value)) {
        return redactSecrets(INVISIBLE.test(value) ? render(prepare(value, multiline), view, multiline) : value, maxCodePoints)
      }
      const written = plainView(value, false), source = normalizedView(written, normalized)
      const controls = controlSequences(source.canonical)
      const terminal = multilineView(controlView(source, controls, 'terminal'), multiline)
      const readings = controls.length ? [terminal,
        multilineView(controlView(source, controls, 'parameters'), multiline), multilineView(source, multiline)] : [terminal]
      const searches: BuiltView[] = []
      const add = (built: BuiltView) => {
        if (!searches.some(other => other.canonical === built.canonical)) searches.push(built)
      }
      const joined = buildView(terminal, 'joined', multiline)
      const spaced = HIDDEN.test(terminal.canonical) ? buildView(terminal, 'spaced', multiline) : joined
      add(joined); add(spaced)
      for (const reading of readings.slice(1)) {
        add(buildView(reading, 'joined', multiline))
        if (HIDDEN.test(reading.canonical)) add(buildView(reading, 'spaced', multiline))
      }
      // Прежний неочищенный терминальный вид тоже сохраняется: скрытые знаки могут довести
      // значение до порога шаблона. Поиск как записано и NFD ничего не теряет при сборке NFC.
      add(terminal); add(written)
      if (split) {
        add(source)
        add(plainView(source.canonical, true, source))
        add(plainView(terminal.canonical, true, terminal))
      }
      const shown = maxCodePoints !== undefined && multiline && (ATTACHED_MARK.test(terminal.canonical) || terminal.canonical.includes('\u200d'))
        ? buildView(terminal, view, multiline, true) : view === 'joined' ? joined : spaced
      const prefixLength = maxCodePoints === undefined ? shown.canonical.length : Array.from(shown.canonical).slice(0, maxCodePoints).join('').length
      const boundary = prefixLength === shown.canonical.length ? value.length : prefixLength ? shown.ends[prefixLength - 1]! : 0
      const originalControls = controls.map(control => ({ start: source.starts[control.start]!, end: source.ends[control.end - 1]! }))
      const spans = expandControlSpans(searches.flatMap(built => viewSpans(built, patterns)), originalControls)
      const masked = maskSpans(value, spans, boundary)
      const clean = (text: string) => render(prepare(text, multiline), view, multiline)
      const limit = maxCodePoints === undefined ? undefined : Array.from(clean(masked.text.slice(0, masked.boundary))).length
      // Проверяется весь показанный текст до усечения, в том числе новые границы.
      return redactSecrets(clean(masked.text), limit)
    },
  }
}

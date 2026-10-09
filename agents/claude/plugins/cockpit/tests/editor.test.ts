import { expect, test } from 'claude-code/testing'
import Editor, { acceptEditor, armEditorFocus, clearEditorFocus, createEditorFocus, drawEditor, EDITOR_FOCUS_TTL_MS, EDITOR_MAX_CHARS, EDITOR_RETRIES, EDITOR_RETRY_MS, editKey, editorHeight, editorRows, editorSnapshot, editorState, focusEditors, pasteEditor, pasteFits, pasteFocusedEditor, receiveEditor, rememberEditor, syncEditor, visibleEditor, type EditorMessage, type EditorProps, type EditorSnapshot, type EditorState } from '../hooks/editor'
import { cellWidth } from '../hooks/layout'
import { DEFAULT_THEME, roleColors } from '../hooks/theme'
import { expectEditorHover } from './editor-driver'
import { registerEditorInput } from '../hooks/register'
import type { ClientKeyEvent, ClientPointerEvent, ClientSurface, EngineInterface, Next, On, PaneCloseInput, PromptEditInput } from 'claude-code'
import { pasted } from './editor-driver'

const INITIAL = { id: 'answer-1', value: '', epoch: 0, version: 0, ack: 0 }

for (const width of [40, 60, 100]) for (const [name, source] of [
  ['кириллица', 'Проверил строки ответа владельца. '.repeat(12)],
  ['пробелы на границе', ('а'.repeat(width - 4) + '  конец ').repeat(12)],
  ['длинное слово', 'я'.repeat(300)],
  ['широкие символы', '你好世界 Проверка '.repeat(30)],
] as const) test(`INPUT-1: 300 символов, задержка кадров и полное стирание: ${name}, ${width}`, () => {
  const text = [...source].slice(0, 300).join('')
  let local = editorState(INITIAL)
  let expected = ''
  for (const char of text) {
    expected += char
    local = editKey(local, { key: char }, width - 5)
    // Даже после каждого переноса экрану приходят прежние props: локальный текст не пересобирается из серверных частей.
    local = syncEditor(local, INITIAL)
    expect(local.text).toBe(expected)
    expect(local.cursor).toBe(expected.length)
    for (const row of editorRows(local.text, width - 5)) expect(cellWidth(row.text)).toBeLessThanOrEqual(width - 5)
    expect(editorRows(local.text, width - 5).map(row => row.text).join('')).toBe(expected)
  }
  for (let remaining = [...text]; remaining.length;) {
    remaining.pop()
    local = editKey(local, { key: 'backspace' }, width - 5)
    local = syncEditor(local, INITIAL)
    expect(local.text).toBe(remaining.join(''))
    expect(local.cursor).toBe(local.text.length)
  }
})

for (const width of [40, 60, 100]) for (const lines of [1, 3, 8, 12]) test(`Высота и последние строки: ${lines} строк, ширина ${width}`, () => {
  const text = Array.from({ length: lines }, (_, index) => `Строка ${index + 1}`).join('\n')
  const state = editorState({ ...INITIAL, value: text })
  expect(editorHeight(text, width)).toBe(2 + Math.min(8, lines))
  const visible = visibleEditor(state, width, editorHeight(text, width))
  expect(visible.rows.map(row => row.text)).toEqual(text.split('\n').slice(-8))
  expect(visible.caret).toBe(Math.min(8, lines) - 1)
})

test('Пробел, названный движком словом, даёт пробел; имена служебных клавиш текстом не становятся', () => {
  let state = editKey(editorState(INITIAL), { key: 'a' }, 57)
  for (const key of ['space', 'b', ' ', 'f5', 'escape', 'capslock', 'c']) state = editKey(state, { key }, 57)
  expect(state.text).toBe('a b c')
})

for (const event of [{ key: 'return', shift: true }, { key: 'return', meta: true }, { key: 'j', ctrl: true }] as const)
  test(`Перенос и две пустые строки: ${JSON.stringify(event)}`, () => {
    let state = editKey(editorState(INITIAL), { key: 'Ответ' }, 57)
    state = editKey(editKey(state, event, 57), event, 57)
    expect(state.text).toBe('Ответ\n\n')
    expect(editorRows(state.text, 57).map(row => row.text)).toEqual(['Ответ', '', ''])
    expect(editorHeight(state.text, 60)).toBe(5)
    state = editKey(state, { key: 'backspace' }, 57)
    expect(state.text).toBe('Ответ\n')
    state = editKey(state, { key: 'backspace' }, 57)
    expect(state.text).toBe('Ответ')
  })

test('Каретка, вставка и стирание внутри описания из 600 символов', () => {
  const source = 'Описание задачи '.repeat(40).slice(0, 600)
  expect(source.length).toBe(600)
  let state = editorState({ ...INITIAL, value: source })
  state = editKey(state, { key: 'home', ctrl: true }, 57)
  for (let index = 0; index < 300; index++) state = editKey(state, { key: 'right' }, 57)
  state = editKey(state, { key: 'ВСТАВКА' }, 57)
  expect(state.text).toBe(source.slice(0, 300) + 'ВСТАВКА' + source.slice(300))
  state = editKey(state, { key: 'backspace' }, 57)
  state = editKey(state, { key: 'delete' }, 57)
  expect(state.text).toBe(source.slice(0, 300) + 'ВСТАВК' + source.slice(301))
  const visible = visibleEditor(state, 60, 10)
  const row = visible.rows[visible.caret]!
  expect(state.cursor).toBeGreaterThanOrEqual(row.start)
  expect(state.cursor).toBeLessThanOrEqual(row.end)
  expect(visible.rows.every(row => cellWidth(row.text) <= 57)).toBe(true)
  state = editKey(state, { key: 'end', ctrl: true }, 57)
  expect(state.cursor).toBe(state.text.length)
  state = editKey(state, { key: 'up' }, 57)
  const before = state.cursor
  state = editKey(state, { key: 'home' }, 57)
  expect(state.cursor).toBeLessThanOrEqual(before)
  state = editKey(state, { key: 'end' }, 57)
  expect(state.cursor).toBeGreaterThanOrEqual(before)
})

test('Полный текст вставки одной доставленной строкой не обрезается; отправка новее недоставленного черновика', () => {
  const text = 'Первая строка\n\n' + 'Длинный текст '.repeat(60)
  const local = editKey(editorState(INITIAL), { key: text }, 57)
  expect(local.text).toBe(text)
  const host = { ...INITIAL }
  expect(acceptEditor(host, { id: local.id, epoch: local.epoch, version: local.version, text: local.text, kind: 'submit', submit: 1 })?.text).toBe(text)
  expect(acceptEditor(host, { ...INITIAL, text: '', kind: 'change', submit: 0 })).toBeNull()
  expect(host.value).toBe(text)
})

test('Новый черновик и новое открытие сохраняют текст; устаревшее поле другой задачи отвергается', () => {
  const hosts = new Map()
  const first = editorSnapshot(hosts, 'one', 'Сохранённый черновик')
  const local = editKey(editorState(first), { key: '!' }, 57)
  expect(acceptEditor(first, { id: 'one', epoch: 0, version: local.version, text: local.text, kind: 'change', submit: 0 })).not.toBeNull()
  const reopened = editorState(editorSnapshot(hosts, 'one', local.text))
  expect(reopened.text).toBe('Сохранённый черновик!')
  const next = editorSnapshot(hosts, 'two', '')
  expect(acceptEditor(next, { id: 'one', epoch: 0, version: 100, text: 'Чужой ответ', kind: 'submit', submit: 1 })).toBeNull()
  expect(next.value).toBe('')
})

test('Перемещение каретки не делает сохранённую причину новой; собственная правка делает', () => {
  const initial = { ...INITIAL, value: 'Причина из хранилища' }
  let state = editKey(editorState(initial), { key: 'home' }, 57)
  expect(state.version).toBe(0)
  state = editKey(state, { key: 'a', ctrl: true }, 57)
  state = editKey(state, { key: initial.value }, 57)
  expect(state.version).toBe(1)
  expect(state.text).toBe(initial.value)
})

const FIELD: EditorProps = { ...INITIAL, element: 'owner-answer-input', frame: 'owner-answer-frame', width: 60, height: 3,
  placeholder: 'Ответ агенту', submitLabel: 'Отправить', plain: true, theme: DEFAULT_THEME, actions: [] }

for (const width of [40, 60, 100]) test(`UUID и длинная сессия не расширяют hover.scope за 64 знака: ${width}`, () => {
  expectEditorHover({ ...FIELD, width, id: 'owner-session-37c04c5d-003a-4170-8130-20fc89a2a67c'.repeat(10) })
})

test('Смена фокуса перекрашивает только активное поле; старый кадр не возвращает прежний фокус', () => {
  const fields = new Map<string, EditorProps>()
  const answer = rememberEditor(fields, { ...FIELD })
  const comment = rememberEditor(fields, { ...FIELD, id: 'comment', element: 'page-comment:task', frame: 'page-comment-frame' })
  const before = { ...answer }
  Object.freeze(answer); Object.freeze(comment)
  focusEditors(fields, answer.element)
  let local = syncEditor(editorState(before), fields.get(answer.id)!)
  expect(local.focused).toBe(true)
  focusEditors(fields, comment.element)
  local = syncEditor(local, fields.get(answer.id)!)
  expect(local.focused).toBe(false)
  expect(editorState(fields.get(comment.id)!).focused).toBe(true)
  local = syncEditor(local, before)
  expect(local.focused).toBe(false)
  expect(rememberEditor(fields, { ...FIELD }).focusRevision).toBe(2)
})

test('INPUT-2: вставка с задержкой props сохраняет неподтверждённые клавиши и каретку, повтор кадра не дублирует её', () => {
  const host: EditorSnapshot = { ...INITIAL, value: 'аб' }
  let local = editKey(editorState(host), { key: 'left' }, 57)
  local = editKey(local, { key: 'X' }, 57)
  const stale = { ...host }
  pasteEditor(host, '🙂\r\n\tТекст')
  local = syncEditor(local, host)
  expect(local.text).toBe('аX🙂\n\tТекстб')
  expect(local.cursor).toBe('аX🙂\n\tТекст'.length)
  expect(syncEditor(local, stale).text).toBe(local.text)
  expect(syncEditor(local, host).text).toBe(local.text)
  expect(acceptEditor(host, { id: local.id, epoch: local.epoch, version: local.version, text: local.text, cursor: local.cursor,
    selected: local.selected, pasteSequence: local.pasteSequence, kind: 'change', submit: local.submit })).not.toBeNull()
  expect(host.value).toBe(local.text)
  expect(host.pastes).toEqual([])
})

test('INPUT-2: две вставки до одного кадра применяются по порядку, прежний ответ хука их не стирает', () => {
  const host = { ...INITIAL, value: 'начало' }
  const old = editorState(host)
  pasteEditor(host, '\r\nПервое')
  pasteEditor(host, '\tВторое🙂')
  const local = syncEditor(old, host)
  expect(local.text).toBe('начало\nПервое\tВторое🙂')
  expect(local.cursor).toBe(local.text.length)
  expect(syncEditor(local, host).text).toBe(local.text)
  expect(acceptEditor(host, { id: old.id, epoch: old.epoch, version: old.version, text: old.text, kind: 'change', submit: 0 })).toBeNull()
  expect(host.value).toBe(local.text)
})

test('INPUT-2: вставка во время ожидания сохранения применяется один раз и сохраняет выделение всего текста', () => {
  const host = { ...INITIAL, value: 'заменить', cursor: 3, selected: true }
  const pending = { ...editorState(host), pending: true, submit: 1 }
  pasteEditor(host, 'Новый\n🙂')
  const local = syncEditor(pending, host)
  expect(local.text).toBe('Новый\n🙂')
  expect(local.cursor).toBe(local.text.length)
  expect(local.selected).toBe(false)
  expect(local.pending).toBe(true)
  expect(syncEditor(local, host).text).toBe(local.text)
})

test('INPUT-2: именованный срок действует ровно две минуты, очистка и исчезновение поля прекращают перехват', () => {
  const focus = createEditorFocus()
  const fields = new Map<string, EditorProps>()
  const host = { ...INITIAL }
  rememberEditor(fields, { ...FIELD })
  let value = '', available = true
  const target = { snapshot: host, element: FIELD.element, at: 10, setValue: (text: string) => { value = text }, isAvailable: () => available }
  armEditorFocus(focus, fields, target)
  expect(pasteFocusedEditor(focus, 'А', 10 + EDITOR_FOCUS_TTL_MS)).toBe(true)
  expect(value).toBe('А')
  expect(pasteFocusedEditor(focus, 'Б', 11 + EDITOR_FOCUS_TTL_MS)).toBe(false)
  expect(fields.get(host.id)?.focused).toBe(false)
  armEditorFocus(focus, fields, target)
  clearEditorFocus(focus)
  expect(pasteFocusedEditor(focus, 'В', 20)).toBe(false)
  armEditorFocus(focus, fields, target)
  available = false
  expect(pasteFocusedEditor(focus, 'Г', 20)).toBe(false)
  expect(value).toBe('А')
})

for (const width of [40, 60, 64, 100]) for (const focused of [false, true])
  test(`INPUT-2: рамка и подпись фокуса без дублирования: ${width}, ${focused}`, () => {
    const props = { ...FIELD, width, focused, caption: '' }
    type Node = { type: string; props: { key?: string; children?: unknown; borderColor?: string } }
    const ui = Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, (props: unknown) => ({ type, props })])) as unknown as Parameters<typeof drawEditor>[0]
    const tree = drawEditor(ui, props, editorState(props), () => {})
    const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'type' in value
      ? [value as Node, ...nodes((value as Node).props.children)] : []
    const all = nodes(tree)
    const textOf = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(textOf).join('')
      : value && typeof value === 'object' && 'props' in value ? textOf((value as Node).props.children) : ''
    const texts = all.filter(node => node.type === 'Text').map(node => textOf(node.props.children)).join('')
    // Приписки на рамке нет ни в фокусе, ни без него: назначение поля называет подсказка внутри.
    expect(texts).not.toContain('Щёлкни')
    // Подсказки переноса строки и повтора названия поля нет: название поля один раз, внутри.
    expect(texts).not.toContain('Shift+Enter')
    expect(texts.split(FIELD.placeholder).length - 1).toBe(1)
    expect(all.find(node => node.props.key === props.frame)?.props.borderColor).toBe(focused ? roleColors(DEFAULT_THEME).accent : roleColors(DEFAULT_THEME).muted)
    if (focused) expect(texts.toLowerCase()).not.toContain('щелчок')
  })

for (const origin of ['person', 'plugin', 'unload'] as const) test(`INPUT-2: настоящий обработчик ui.close снимает признак до продолжения события: ${origin}`, async () => {
  const focus = createEditorFocus()
  const fields = new Map<string, EditorProps>()
  const snapshot = { ...INITIAL }
  rememberEditor(fields, { ...FIELD })
  let value = '', invalidations = 0, continued = 0
  armEditorFocus(focus, fields, { snapshot, element: FIELD.element, at: 0,
    setValue: text => { value = text }, isAvailable: () => true })
  let close: ((engine: EngineInterface, event: PaneCloseInput, next: Next<'ui.close'>) => unknown) | undefined
  let edit: ((engine: EngineInterface, event: PromptEditInput, next: Next<'prompt.edit'>) => unknown) | undefined
  const collect = ((event: string, ...args: unknown[]) => {
    if (event === 'ui.close') {
      expect(args[0]).toEqual({ id: 'tasks' })
      close = args[1] as typeof close
    }
    if (event === 'prompt.edit') edit = args[0] as typeof edit
  }) as On
  registerEditorInput(collect, focus)
  const engine = { clock: { now: async () => 0 }, ui: { invalidate: () => { invalidations++ } } } as unknown as EngineInterface
  await close!(engine, { id: 'tasks', origin: { kind: origin } }, ((event: PaneCloseInput) => {
    expect(event.origin.kind).toBe(origin)
    expect(focus.target).toBeNull()
    continued++
  }) as Next<'ui.close'>)
  expect(invalidations).toBe(1)
  expect(fields.get(snapshot.id)?.focused).toBe(false)
  const event = pasted('Основная строка после закрытия')
  const result = await edit!(engine, event, ((forwarded: PromptEditInput) => {
    expect(forwarded).toBe(event)
    continued++
    return { text: event.text.slice(0, event.start) + event.inputText + event.text.slice(event.end), cursor: event.start + event.inputText.length }
  }) as Next<'prompt.edit'>)
  expect(result).toEqual({ text: 'Осн' + event.inputText + 'овная строка', cursor: 3 + event.inputText.length })
  expect(continued).toBe(2)
  expect(value).toBe('')
})

// Перенос до ускорения: остаток абзаца измеряется целиком на каждую строку. Эталон для сверки.
function editorRowsByMeasuring(text: string, width: number) {
  const rows: { text: string; start: number; end: number }[] = []
  const limit = Math.max(1, width)
  let start = 0
  for (const paragraph of text.split('\n')) {
    let rest = paragraph
    while (cellWidth(rest) > limit) {
      let end = 0, used = 0, space = -1
      for (const char of rest) {
        if (used + cellWidth(char) > limit) break
        used += cellWidth(char); end += char.length
        if (char === ' ') space = end
      }
      const cut = space > 0 ? space : Math.max(end, [...rest][0]?.length ?? 1)
      rows.push({ text: rest.slice(0, cut), start, end: start + cut })
      rest = rest.slice(cut); start += cut
    }
    rows.push({ text: rest, start, end: start + rest.length })
    start += rest.length + 1
  }
  return rows
}

test('INPUT-3: линейный перенос даёт те же строки, что измерение остатка абзаца, на любых знаках', () => {
  // Знаки из каждого диапазона быстрого пути и то, что в него не входит: широкие, составные, нулевой ширины.
  const simple = ['a', 'Z', '0', ' ', ' ', '~', '\u00a0', '\u00ad', 'é', 'ß', 'ǅ', 'ʰ', 'α', 'Ω', 'ж', 'Я', 'ё', 'Ґ', 'ӏ', '—', '–', '«', '»', '“', '”', '…', '•', '‰', '‼', '₽', '€', '№', '™', '→', '↔', '≠', '≤', '⌘', '⏎', '│', '█', '◆', '☑', '✓', '✗', '❯']
  const mixed = [...simple, '日', '本', '🙂', 'e\u0301', '\u0483', '👨\u200d👩\u200d👧', '1\ufe0f\u20e3', '✔\ufe0f', '🇺🇦', '\t', '\u200b', '\u2028', '〈', '⌚', '\ud83d', 'ﬁ', '한', 'ก\u0e33']
  let seed = 158
  const random = (limit: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % limit }
  for (let round = 0; round < 3_000; round++) {
    const pool = round % 2 ? mixed : simple
    let text = ''
    for (let length = random(90); length > 0; length--) text += random(17) ? pool[random(pool.length)] : '\n'
    const width = 1 + random(30)
    expect(editorRows(text, width)).toEqual(editorRowsByMeasuring(text, width))
  }
  for (const text of ['', '\n', ' ', 'а'.repeat(200), ('слово '.repeat(40) + '\n').repeat(3), ' ' + 'я'.repeat(60)])
    for (const width of [1, 2, 7, 55]) expect(editorRows(text, width)).toEqual(editorRowsByMeasuring(text, width))
})

test('INPUT-3: перенос длинного текста не растёт квадратично', () => {
  // Сорок тысяч знаков обычного текста и столько же с эмодзи в одном абзаце: прежний перенос на таком
  // входе занимал секунды, а поле зовёт его на каждую клавишу.
  const plain = 'Проверил строки ответа владельца — всё на месте, но «кнопка» отправки не видна… '.repeat(500)
  expect(editorRows(plain, 55).map(row => row.text).join('')).toBe(plain)
  const wide = 'слово 🙂 '.repeat(5_000)
  expect(editorRows(wide, 55).map(row => row.text).join('')).toBe(wide)
  expect(editorRows('я'.repeat(40_000), 55)).toHaveLength(Math.ceil(40_000 / 55))
})

test('INPUT-3: подтверждается только отправка и действие; повтор отправки исполняется один раз', () => {
  const host: EditorSnapshot = { ...INITIAL }
  const message = (kind: EditorMessage['kind'], submit: number, extra: Partial<EditorMessage> = {}) =>
    ({ id: host.id, epoch: host.epoch, version: host.version + 1, text: 'текст', kind, submit, ...extra })
  // Щелчок или клавиша, обогнавшие недоставленный Enter, несут его номер, но отправкой не являются.
  expect(acceptEditor(host, message('focus', 1, { activity: true }))?.kind).toBe('focus')
  expect(acceptEditor(host, message('change', 1))?.kind).toBe('change')
  expect(host.ack).toBe(0)
  expect(acceptEditor(host, message('submit', 1))?.kind).toBe('submit')
  expect(host.ack).toBe(1)
  // Клиент повторяет неподтверждённую отправку раз в такт: второй раз она не исполняется.
  const repeat = acceptEditor(host, message('submit', 1, { activity: true }))
  expect(repeat?.kind).toBe('focus')
  expect(repeat?.activity).toBe(true)
  expect(host.ack).toBe(1)
  const action = acceptEditor(host, message('action', 2, { action: 'page-comment-confirm' }))
  expect(action).toMatchObject({ kind: 'action', action: 'page-comment-confirm' })
  expect(host.ack).toBe(2)
  const again = acceptEditor(host, message('action', 2, { action: 'page-comment-confirm' }))
  expect(again?.kind).toBe('focus')
  expect(again && 'action' in again).toBe(false)
  // Запоздавшее старое сообщение подтверждение не уменьшает.
  expect(acceptEditor(host, message('submit', 1))?.kind).toBe('focus')
  expect(host.ack).toBe(2)
})

test('INPUT-3: отправка с текстом до вставки не исполняется и не подтверждается; после вставки поле повторяет её само', () => {
  const host: EditorSnapshot = { ...INITIAL, value: 'набрано' }
  let local: EditorState = { ...editorState(host), pending: true, submit: 1, sent: { kind: 'submit' } }
  pasteEditor(host, ' и вставлено')
  expect(acceptEditor(host, { id: local.id, epoch: local.epoch, version: local.version, text: local.text, kind: 'submit', submit: 1, pasteSequence: 0 })).toBeNull()
  expect(host.ack).toBe(0)
  expect(host.value).toBe('набрано и вставлено')
  // Ответ хука несёт вставку; поле остаётся в ожидании и отправляет уже полный текст.
  local = syncEditor(local, host)
  expect(local).toMatchObject({ text: 'набрано и вставлено', pending: true, sent: { kind: 'submit' } })
  expect(acceptEditor(host, { id: local.id, epoch: local.epoch, version: local.version, text: local.text, kind: 'submit', submit: 1, pasteSequence: local.pasteSequence })?.kind).toBe('submit')
  expect(host.ack).toBe(1)
  local = syncEditor(local, host)
  expect(local.pending).toBe(false)
  expect('sent' in local).toBe(false)
})

// Поверхность клиентского модуля. frame() — граница кадра: движок доставляет последнее сообщение кадра
// и вызывает модуль заново. stale — движок отдаёт в surface.state значение прошлой отрисовки до конца кадра.
function mountEditor(props: EditorProps, stale = false) {
  const delivered: EditorMessage[] = []
  let posted: EditorMessage | null = null, queued: EditorState | undefined
  let key: ((event: ClientKeyEvent) => void) | undefined, pointer: ((event: ClientPointerEvent) => void) | undefined, tick: (() => void) | undefined
  let timers = 0, current = props
  const elements = Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, (props: unknown) => ({ type, props })]))
  const surface = { elements, state: undefined as EditorState | undefined, columns: 0, rows: 0,
    setState(next: EditorState) { queued = next; if (!stale) surface.state = next },
    every(ms: number, fn: () => void) { expect(ms).toBe(EDITOR_RETRY_MS); timers++; tick = fn; return () => {} },
    onPointer(fn: typeof pointer) { pointer = fn; return () => {} }, onKey(fn: typeof key) { key = fn; return () => {} },
    post(data: unknown) { posted = data as EditorMessage } }
  const draw = () => Editor(current, surface as unknown as ClientSurface<EditorState>)
  const frame = (next: EditorProps = current) => {
    if (posted) delivered.push(posted)
    posted = null
    if (queued) surface.state = queued
    current = next
    for (let pass = 0; pass < 4; pass++) { queued = undefined; draw(); if (!queued) break; surface.state = queued }
  }
  frame()
  return { delivered, frame, key: (event: ClientKeyEvent) => key!(event), down: () => pointer!({ type: 'down', x: 2, y: 1, button: 'left' } as ClientPointerEvent),
    tick: () => tick!(), get state() { return queued ?? surface.state! }, get timers() { return timers }, get props() { return current } }
}

for (const stale of [false, true]) test(`INPUT-3: клавиши одного кадра не теряют друг друга, surface.state с задержкой=${stale}`, () => {
  const field = mountEditor({ ...FIELD }, stale)
  for (const char of 'привет') field.key({ key: char })
  field.key({ key: 'backspace' })
  field.key({ key: 'backspace' })
  field.key({ key: 'а' })
  expect(field.state.text).toBe('прива')
  field.frame()
  // За кадр уходит одно сообщение — последнее, с полным текстом.
  expect(field.delivered).toHaveLength(1)
  expect(field.delivered[0]).toMatchObject({ kind: 'change', text: 'прива', version: 9, activity: true })
  expect(field.timers).toBe(1)
})

test('INPUT-3: щелчок и клавиша в кадре отправки несут ту же отправку, а не заменяют её', () => {
  const field = mountEditor({ ...FIELD })
  field.key({ key: 'Готово' })
  field.frame()
  field.key({ key: 'return' })
  // Прежде щелчок того же кадра уходил сообщением focus с номером отправки: хук подтверждал, Enter пропадал.
  field.down()
  field.key({ key: 'я' })
  field.frame()
  expect(field.delivered.at(-1)).toMatchObject({ kind: 'submit', submit: 1, text: 'Готово', activity: true })
  expect(field.state).toMatchObject({ pending: true, text: 'Готово', sent: { kind: 'submit' } })
  // Действие на рамке ведёт себя так же и сохраняет своё имя.
  const host: EditorSnapshot = { ...INITIAL }
  expect(acceptEditor(host, field.delivered.at(-1))?.kind).toBe('submit')
  field.frame({ ...field.props, ...host })
  expect(field.state.pending).toBe(false)
  field.key({ key: 'я' })
  expect(field.state.text).toBe('Готовоя')
})

test('INPUT-3: неподтверждённая отправка повторяется раз в такт; после четырёх повторов поле возвращает ввод с замечанием', () => {
  const field = mountEditor({ ...FIELD })
  field.key({ key: 'Текст' })
  field.key({ key: 'return' })
  field.frame()
  expect(field.delivered.map(message => message.kind)).toEqual(['submit'])
  for (let attempt = 1; attempt <= EDITOR_RETRIES; attempt++) {
    field.tick()
    field.frame()
    expect(field.delivered).toHaveLength(1 + attempt)
    expect(field.delivered.at(-1)).toMatchObject({ kind: 'submit', submit: 1, text: 'Текст' })
    expect(field.state.pending).toBe(true)
  }
  field.tick()
  field.frame()
  expect(field.delivered).toHaveLength(1 + EDITOR_RETRIES)
  expect(field.state).toMatchObject({ pending: false, notice: 'stalled', text: 'Текст' })
  expect('sent' in field.state).toBe(false)
  // Поле снова принимает клавиши; первая же снимает замечание.
  field.key({ key: '!' })
  expect(field.state.text).toBe('Текст!')
  expect('notice' in field.state).toBe(false)
  // Без ожидания такт ничего не шлёт.
  field.frame()
  const count = field.delivered.length
  field.tick()
  field.frame()
  expect(field.delivered).toHaveLength(count)
})

test('INPUT-3: подтверждение, пришедшее после повтора, снимает ожидание без замечания', () => {
  const field = mountEditor({ ...FIELD })
  const host: EditorSnapshot = { ...INITIAL }
  field.key({ key: 'Текст' })
  field.key({ key: 'return' })
  field.frame()
  field.tick()
  field.frame()
  expect(acceptEditor(host, field.delivered[0])?.kind).toBe('submit')
  expect(acceptEditor(host, field.delivered[1])?.kind).toBe('focus')
  field.frame({ ...field.props, ...host })
  expect(field.state).toMatchObject({ pending: false, text: 'Текст' })
  expect('notice' in field.state).toBe(false)
  expect('waited' in field.state).toBe(false)
})

test('INPUT-3: текст поля ограничен: клавиша и вставка сверх предела не принимаются, поле говорит об этом', () => {
  const full = 'я'.repeat(EDITOR_MAX_CHARS)
  let state = editKey(editorState({ ...INITIAL, value: full }), { key: 'ю' }, 57)
  expect(state.text).toBe(full)
  expect(state.notice).toBe('full')
  expect(state.version).toBe(0)
  // Замена выделенного и стирание на полном поле работают.
  state = editKey(state, { key: 'backspace' }, 57)
  expect(state.text).toHaveLength(EDITOR_MAX_CHARS - 1)
  expect('notice' in state).toBe(false)
  state = editKey(editKey(state, { key: 'a', ctrl: true }, 57), { key: 'заново' }, 57)
  expect(state.text).toBe('заново')
  const host: EditorSnapshot = { ...INITIAL, value: full.slice(10) }
  expect(pasteFits(host, 'я'.repeat(10))).toBe(true)
  expect(pasteFits(host, 'я'.repeat(11))).toBe(false)
  expect(pasteFits({ ...host, selected: true }, full)).toBe(true)
  const focus = createEditorFocus()
  const fields = new Map<string, EditorProps>()
  rememberEditor(fields, { ...FIELD })
  armEditorFocus(focus, fields, { snapshot: host, element: FIELD.element, at: 0, setValue: () => {}, isAvailable: () => true })
  expect(pasteFocusedEditor(focus, 'я'.repeat(11), 1)).toBe(false)
  expect(host.value).toBe(full.slice(10))
  expect(pasteFocusedEditor(focus, 'я'.repeat(10), 1)).toBe(true)
  expect(host.value).toHaveLength(EDITOR_MAX_CHARS)
})

// Действие рамки (отмена, перенос в строку ввода) ждёт ответа хука так же, как отправка. Подпись «Сохранение» шире
// обычной: от неё значки рамки сдвигались под указателем раньше, чем поле закрывалось.
test('INPUT-4: подпись отправки меняется только при отправке, значки рамки от действия не сдвигаются', () => {
  type Node = { type: string; props: { key?: string; label?: string; children?: unknown } }
  const ui = Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, (props: unknown) => ({ type, props })])) as unknown as Parameters<typeof drawEditor>[0]
  const props = { ...FIELD, focused: true, actions: [{ key: 'field-cancel', label: '×', hint: 'Отменить ввод' }] }
  const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'type' in value
    ? [value as Node, ...nodes((value as Node).props.children)] : []
  const labels = (state: EditorState) => nodes(drawEditor(ui, props, state, () => {})).filter(node => node.type === 'Button').map(node => String(node.props.label))
  const idle = labels(editorState(props))
  expect(idle.some(label => label.endsWith(props.submitLabel))).toBe(true)
  expect(labels({ ...editorState(props), pending: true, submit: 1, sent: { kind: 'action', action: 'field-cancel' } })).toEqual(idle)
  const saving = labels({ ...editorState(props), pending: true, submit: 1, sent: { kind: 'submit' } })
  expect(saving.some(label => label.endsWith('Сохранение'))).toBe(true)
})

for (const notice of ['stalled', 'full'] as const) test(`INPUT-3: замечание занимает место подписи поля цветом предупреждения: ${notice}`, () => {
  type Node = { type: string; props: { children?: unknown; color?: string } }
  const ui = Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, (props: unknown) => ({ type, props })])) as unknown as Parameters<typeof drawEditor>[0]
  const props = { ...FIELD, focused: true, caption: 'Изменение сообщения' }
  const tree = drawEditor(ui, props, { ...editorState(props), notice }, () => {})
  const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'type' in value
    ? [value as Node, ...nodes((value as Node).props.children)] : []
  const textOf = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(textOf).join('')
    : value && typeof value === 'object' && 'props' in value ? textOf((value as Node).props.children) : ''
  const texts = nodes(tree).filter(node => node.type === 'Text')
  const shown = notice === 'stalled' ? 'Не отправлено: нажми Enter ещё раз' : 'В поле помещается до 20 000 знаков'
  const caption = texts.find(node => textOf(node.props.children).includes(shown))
  expect(caption?.props.color).toBe(roleColors(DEFAULT_THEME).warn)
  expect(texts.some(node => textOf(node.props.children).includes('Изменение сообщения'))).toBe(false)
})

test('INPUT-3: запоздавшее сообщение поля не возвращает текст, который хук уже очистил после отправки', () => {
  const fields = new Map<string, EditorSnapshot>()
  const first = editorSnapshot(fields, 'comment', '')
  const typed = editKey(editorState(first), { key: 'Отправленный комментарий' }, 57)
  const message = (submit: number, kind: EditorMessage['kind']) => ({ id: typed.id, epoch: typed.epoch, version: typed.version, text: typed.text, kind, submit })
  // Отправка принята: черновик хука равен набранному.
  let draft = ''
  const sent = receiveEditor(fields, 'comment', draft, message(1, 'submit'))!
  expect(sent.message?.kind).toBe('submit')
  draft = sent.message!.text
  // Комментарий сохранён, хук очистил черновик; отрисовки ещё не было, снимок хранит прежний текст и прежнюю эпоху.
  draft = ''
  expect(fields.get('comment')).toMatchObject({ value: 'Отправленный комментарий', epoch: 0 })
  // Щелчок по полю, отправленный до ответа хука, доходит в этот промежуток. Раньше он принимался и возвращал текст.
  const late = receiveEditor(fields, 'comment', draft, { ...message(1, 'focus'), activity: true })!
  expect(late.message).toBeNull()
  expect(late.snapshot).toMatchObject({ value: '', epoch: 1, version: 0, ack: 0 })
  // Клиент по ответу с новой эпохой начинает с пустого поля; его новые сообщения принимаются.
  const fresh = syncEditor(typed, late.snapshot)
  expect(fresh.text).toBe('')
  const next = editKey(fresh, { key: 'Следующий' }, 57)
  expect(receiveEditor(fields, 'comment', draft, { id: next.id, epoch: next.epoch, version: next.version, text: next.text, kind: 'change', submit: next.submit })?.message?.text).toBe('Следующий')
  // Поле, которого хук не рисовал, сообщений не получает.
  expect(receiveEditor(fields, 'unknown', '', message(1, 'focus'))).toBeNull()
})

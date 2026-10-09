import type { ClientElements, ClientKeyEvent, ClientModule, RenderElement } from 'claude-code'
import { SINGLE_CELL_TEXT, cellWidth, isSingleCell, widerThan } from './layout'
import { drawCardControls, hoverScope } from './card-controls'
import { hoverColor, roleColors, type Theme } from './theme'

export type EditorAction = { key: string; label: string; hint: string }
export type EditorPaste = { sequence: number; text: string }
export type EditorSnapshot = {
  id: string; value: string; epoch: number; version: number; ack: number
  cursor?: number; selected?: boolean; pasteSequence?: number; pastes?: EditorPaste[]
}
export type EditorProps = EditorSnapshot & {
  element: string; frame: string; width: number; height: number; placeholder: string; submitLabel: string; plain: boolean; theme: Theme; actions: EditorAction[]; caption?: string
  focusRevision?: number; focused?: boolean
}
export type EditorMessage = {
  id: string; epoch: number; version: number; text: string; kind: 'focus' | 'change' | 'submit' | 'action'; submit: number; action?: string
  cursor?: number; selected?: boolean; pasteSequence?: number; activity?: true
}
export type EditorState = {
  id: string; epoch: number; version: number; text: string; cursor: number; selected: boolean; focused: boolean; focusRevision: number; submit: number; pending: boolean; pasteSequence: number
  // Неподтверждённая отправка или действие: пока хук не ответил, любое сообщение поля повторяет её, а не заменяет.
  sent?: { kind: 'submit' | 'action'; action?: string }
  // Сколько тактов поле ждёт подтверждения; замечание над полем до следующей клавиши.
  waited?: number
  notice?: 'stalled' | 'full'
}
export type EditorRow = { text: string; start: number; end: number }

const charCells = (char: string) => char.length === 1 && isSingleCell(char.charCodeAt(0)) ? 1 : cellWidth(char)

// Смещения относятся к исходному тексту: пробелы и явные пустые строки не исчезают при переносе.
// Работа линейна по длине текста: поле пересчитывает строки на каждую клавишу, и прежнее измерение
// остатка абзаца на каждую строку стоило десятки миллисекунд на клавишу уже при тысяче знаков.
export function editorRows(text: string, width: number): EditorRow[] {
  const rows: EditorRow[] = []
  const limit = Math.max(1, width)
  let start = 0
  for (const paragraph of text.split('\n')) {
    if (SINGLE_CELL_TEXT.test(paragraph)) {
      let at = 0
      while (paragraph.length - at > limit) {
        const space = paragraph.lastIndexOf(' ', at + limit - 1)
        const cut = space >= at ? space + 1 - at : limit
        rows.push({ text: paragraph.slice(at, at + cut), start: start + at, end: start + at + cut })
        at += cut
      }
      rows.push({ text: paragraph.slice(at), start: start + at, end: start + paragraph.length })
      start += paragraph.length + 1
      continue
    }
    let rest = paragraph
    while (widerThan(rest, limit)) {
      let end = 0, used = 0, space = -1
      for (const char of rest) {
        const cells = charCells(char)
        if (used + cells > limit) break
        used += cells; end += char.length
        if (char === ' ') space = end
      }
      const cut = space > 0 ? space : Math.max(end, rest.codePointAt(0)! > 0xffff ? 2 : 1)
      rows.push({ text: rest.slice(0, cut), start, end: start + cut })
      rest = rest.slice(cut); start += cut
    }
    rows.push({ text: rest, start, end: start + rest.length })
    start += rest.length + 1
  }
  return rows
}

// Рамка и по одной ячейке отступа с каждой стороны; ещё одна ячейка — под каретку в конце строки.
export const EDITOR_INSET = 5
// Сообщение клиента длиннее ста тысяч знаков движок не отправляет вовсе: поле с таким текстом молча перестало бы
// сохраняться. Предел поля стоит заметно ниже и выше любого сохраняемого текста.
export const EDITOR_MAX_CHARS = 20_000
// Неподтверждённая отправка повторяется раз в такт; после четырёх повторов поле возвращает ввод и говорит об этом.
export const EDITOR_RETRY_MS = 1000
export const EDITOR_RETRIES = 4

export function editorHeight(text: string, width: number): number {
  return 2 + Math.min(8, editorRows(text, Math.max(1, width - EDITOR_INSET)).length)
}

// Сервер подтверждает версии, но не присваивает клиенту устаревший черновик после каждого кадра.
export function editorSnapshot(all: Map<string, EditorSnapshot>, id: string, value: string): EditorSnapshot {
  let snapshot = all.get(id)
  if (!snapshot) { snapshot = { id, value, epoch: 0, version: 0, ack: 0 }; all.set(id, snapshot) }
  else if (snapshot.value !== value) {
    snapshot.value = value; snapshot.epoch++; snapshot.version = 0; snapshot.ack = 0
    snapshot.cursor = value.length; snapshot.selected = false; snapshot.pasteSequence = 0; snapshot.pastes = []
  }
  return snapshot
}

export function acceptEditor(snapshot: EditorSnapshot, data: unknown): EditorMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const message = data as Partial<EditorMessage>
  if (message.id !== snapshot.id || message.epoch !== snapshot.epoch || typeof message.text !== 'string'
    || !Number.isSafeInteger(message.version) || message.version! < snapshot.version
    || !Number.isSafeInteger(message.submit) || message.submit! < 0
    || !['focus', 'change', 'submit', 'action'].includes(message.kind ?? '')
    || message.cursor !== undefined && (!Number.isSafeInteger(message.cursor) || message.cursor < 0 || message.cursor > message.text.length)
    || message.selected !== undefined && typeof message.selected !== 'boolean'
    || (message.pasteSequence ?? 0) !== (snapshot.pasteSequence ?? 0)
    || message.activity !== undefined && message.activity !== true
    || message.kind === 'action' && typeof message.action !== 'string') return null
  // Подтверждается только сама отправка или действие. Прежде подтверждало любое принятое сообщение:
  // щелчок того же кадра заменял недоставленный Enter, хук отвечал «принято», и отправка пропадала без следа.
  const decisive = message.kind === 'submit' || message.kind === 'action'
  // Клиент повторяет неподтверждённую отправку; исполняется она один раз, повтор — обычное сообщение поля.
  const repeated = decisive && message.submit! <= snapshot.ack
  snapshot.value = message.text; snapshot.version = message.version!
  if (decisive) snapshot.ack = Math.max(snapshot.ack, message.submit!)
  snapshot.cursor = message.cursor ?? message.text.length; snapshot.selected = message.selected ?? false
  snapshot.pastes = []
  if (!repeated) return message as EditorMessage
  const { action: _action, ...rest } = message as EditorMessage
  return { ...rest, kind: 'focus' }
}

// Приём сообщения поля хуком. Черновик, изменённый самим хуком (очистка после сохранения, отмена правки, возврат из
// строки ввода), главнее текста клиента: снимок сверяется с ним до приёма. Иначе запоздавшее сообщение прежней эпохи,
// пришедшее раньше отрисовки, принималось бы по прежнему снимку и возвращало в поле уже отправленный текст.
export function receiveEditor(all: Map<string, EditorSnapshot>, id: string, draft: string, data: unknown): { snapshot: EditorSnapshot; message: EditorMessage | null } | null {
  if (!all.has(id)) return null
  const snapshot = editorSnapshot(all, id, draft)
  return { snapshot, message: acceptEditor(snapshot, data) }
}

type FocusProps = { focusRevision?: number; focused?: boolean }

export function rememberEditor(all: Map<string, EditorProps>, props: EditorProps): EditorProps {
  const before = all.get(props.id)
  const next = { ...props, focusRevision: before?.focusRevision ?? 0, focused: before?.focused ?? false }
  all.set(props.id, next)
  return next
}

export function focusEditors(all: Map<string, EditorProps>, element: string | undefined): void {
  // Отданные движку props заморожены; смена фокуса создаёт следующий снимок вместо изменения прежнего.
  for (const [id, props] of all) all.set(id, { ...props, focused: props.element === element, focusRevision: (props.focusRevision ?? 0) + 1 })
}

// У движка нет чтения фокуса Client: доверяем только последнему щелчку или клавише редактора.
export const EDITOR_FOCUS_TTL_MS = 2 * 60 * 1000
export type FocusedEditor = {
  snapshot: EditorSnapshot; element: string; at: number; setValue: (text: string) => void; isAvailable: () => boolean
}
export type EditorFocus = { target: FocusedEditor | null; fields: Set<Map<string, EditorProps>> }
export function createEditorFocus(): EditorFocus { return { target: null, fields: new Set() } }

export function clearEditorFocus(focus: EditorFocus): void {
  focus.target = null
  for (const fields of focus.fields) focusEditors(fields, undefined)
}

export function armEditorFocus(focus: EditorFocus, fields: Map<string, EditorProps>, target: FocusedEditor): void {
  if (!target.isAvailable()) return
  focus.fields.add(fields)
  for (const group of focus.fields) focusEditors(group, group === fields ? target.element : undefined)
  focus.target = target
}

export function expireEditorFocus(focus: EditorFocus, now: number): boolean {
  if (!focus.target || now - focus.target.at <= EDITOR_FOCUS_TTL_MS && focus.target.isAvailable()) return false
  clearEditorFocus(focus)
  return true
}

function insertText(state: EditorState, text: string): EditorState {
  const insert = text.replace(/\r\n?/gu, '\n')
  const start = state.selected ? 0 : state.cursor, end = state.selected ? state.text.length : state.cursor
  return { ...state, text: state.text.slice(0, start) + insert + state.text.slice(end), cursor: start + insert.length,
    selected: false, version: state.version + 1 }
}

export function pasteEditor(snapshot: EditorSnapshot, text: string): void {
  const insert = text.replace(/\r\n?/gu, '\n')
  const start = snapshot.selected ? 0 : snapshot.cursor ?? snapshot.value.length
  const end = snapshot.selected ? snapshot.value.length : start
  snapshot.value = snapshot.value.slice(0, start) + insert + snapshot.value.slice(end)
  snapshot.cursor = start + insert.length; snapshot.selected = false; snapshot.version++
  snapshot.pasteSequence = (snapshot.pasteSequence ?? 0) + 1
  snapshot.pastes = [...(snapshot.pastes ?? []), { sequence: snapshot.pasteSequence, text: insert }]
}

// Вставка, с которой текст поля превысил бы предел, в поле не идёт: она остаётся в основной строке.
export function pasteFits(snapshot: EditorSnapshot, text: string): boolean {
  const kept = snapshot.selected ? 0 : snapshot.value.length
  return kept + text.length <= EDITOR_MAX_CHARS
}

export function pasteFocusedEditor(focus: EditorFocus, text: string, now: number): boolean {
  expireEditorFocus(focus, now)
  const target = focus.target
  if (!target || !text || !pasteFits(target.snapshot, text)) return false
  pasteEditor(target.snapshot, text)
  target.setValue(target.snapshot.value)
  return true
}

export function editorState(props: EditorSnapshot & FocusProps): EditorState {
  return { id: props.id, epoch: props.epoch, version: props.version, text: props.value, cursor: props.cursor ?? props.value.length,
    selected: props.selected ?? false, focused: props.focused ?? false, focusRevision: props.focusRevision ?? 0, submit: props.ack, pending: false,
    pasteSequence: props.pasteSequence ?? 0 }
}

export function syncEditor(state: EditorState | undefined, props: EditorSnapshot & FocusProps): EditorState {
  if (!state || state.id !== props.id || state.epoch !== props.epoch) return editorState(props)
  let next = state
  if (state.pending && props.ack >= state.submit) {
    const { sent: _sent, waited: _waited, ...rest } = next
    next = { ...rest, pending: false }
  }
  if ((props.focusRevision ?? 0) > state.focusRevision) next = { ...next, focused: props.focused ?? false, focusRevision: props.focusRevision! }
  // Вставка применяется к живому клиентскому тексту, включая ещё не подтверждённые клавиши.
  // Старые кадры и повторные доставки команды не вставляют её второй раз.
  for (const paste of props.pastes ?? []) if (paste.sequence > next.pasteSequence) next = { ...insertText(next, paste.text), pasteSequence: paste.sequence }
  return next
}

function previous(text: string, cursor: number): number { return cursor - ([...text.slice(0, cursor)].at(-1)?.length ?? 0) }
function following(text: string, cursor: number): number { return cursor + ([...text.slice(cursor)][0]?.length ?? 0) }

export function caretRow(rows: EditorRow[], cursor: number): number {
  let index = 0
  for (let i = 0; i < rows.length; i++) if (rows[i]!.start <= cursor) index = i
  return index
}

const NAMED_KEYS = new Set(['enter', 'escape', 'esc', 'clear', 'capslock', 'numlock', 'scrolllock', 'printscreen', 'pause', 'menu', 'wheelup', 'wheeldown',
  ...Array.from({ length: 24 }, (_, index) => `f${index + 1}`)])

export function editKey(state: EditorState, event: ClientKeyEvent, width: number): EditorState {
  if (state.pending) return state
  const { notice: _notice, ...kept } = state
  const next: EditorState = { ...kept, focused: true }
  const rows = editorRows(state.text, width)
  const rowIndex = caretRow(rows, state.cursor)
  const row = rows[rowIndex]!
  const newline = event.key === 'return' && (event.shift || event.meta) || event.key === 'j' && event.ctrl
  if (event.key === 'a' && (event.ctrl || event.meta)) { next.selected = true; return next }
  if (['left', 'right', 'home', 'end', 'up', 'down'].includes(event.key)) {
    next.selected = false
    if (event.key === 'left') next.cursor = previous(state.text, state.cursor)
    if (event.key === 'right') next.cursor = following(state.text, state.cursor)
    if (event.key === 'home') next.cursor = event.ctrl ? 0 : row.start
    if (event.key === 'end') next.cursor = event.ctrl ? state.text.length : row.end
    if (event.key === 'up' || event.key === 'down') {
      const target = rows[Math.max(0, Math.min(rows.length - 1, rowIndex + (event.key === 'up' ? -1 : 1)))]!
      const column = cellWidth(state.text.slice(row.start, state.cursor))
      let cursor = target.start, used = 0
      for (const char of target.text) { if (used + cellWidth(char) > column) break; used += cellWidth(char); cursor += char.length }
      next.cursor = cursor
    }
    return next
  }
  let start = state.selected ? 0 : state.cursor, end = state.selected ? state.text.length : state.cursor
  let insert = ''
  if (newline) insert = '\n'
  else if (event.key === 'backspace') start = state.selected ? 0 : previous(state.text, state.cursor)
  else if (event.key === 'delete') end = state.selected ? state.text.length : following(state.text, state.cursor)
  else if (event.ctrl || event.meta || ['return', 'tab', 'escape', 'pageup', 'pagedown', 'insert'].includes(event.key)) return next
  // Движок называет часть клавиш словом: пробел приходит и знаком, и именем `space`.
  // Имя клавиши текстом не становится; всё остальное — набранный знак или вставка.
  else if (event.key === 'space') insert = ' '
  else if (NAMED_KEYS.has(event.key)) return next
  else insert = event.key.replace(/\r\n?/gu, '\n')
  if (insert && state.text.length - (end - start) + insert.length > EDITOR_MAX_CHARS) return { ...next, notice: 'full' }
  next.text = state.text.slice(0, start) + insert + state.text.slice(end)
  next.cursor = start + insert.length; next.selected = false
  if (insert !== '' || start !== end) next.version++
  return next
}

export function visibleEditor(state: EditorState, width: number, height: number): { rows: EditorRow[]; caret: number } {
  const rows = editorRows(state.text, Math.max(1, width - EDITOR_INSET))
  const caret = caretRow(rows, state.cursor)
  const count = Math.max(1, height - 2)
  const start = Math.max(0, caret - count + 1)
  return { rows: rows.slice(start, start + count), caret: caret - start }
}

export function drawEditor(ui: Pick<ClientElements, 'Box' | 'Text' | 'Button'>, props: EditorProps, state: EditorState,
  send: (kind: EditorMessage['kind'], action?: string) => void): RenderElement {
  const { Box, Text, Button } = ui
  const roles = roleColors(props.theme), accent = roles.accent
  const visible = visibleEditor(state, props.width, props.height)
  const actions = props.actions.map(action => ({ ...action, keyHint: '' }))
  // Одна подпись на верхней линии рамки: замечание о неотправленном или переполненном поле важнее названия.
  const caption = state.notice === 'stalled' ? 'Не отправлено: нажми Enter ещё раз' : state.notice === 'full' ? 'В поле помещается до 20 000 знаков'
    : state.focused ? props.caption ?? '' : ''
  // Рамка — короткое имя поверхности, UUID задачи не превращается в scope длиннее лимита SDK.
  const scope = hoverScope(props.frame)
  return <Box key={`${props.frame}-slot`} width={props.width} height={props.height} flexShrink={0}>
    <Box key={props.frame} width={props.width} height={props.height} borderStyle="round"
      borderColor={state.focused ? accent : roles.muted} borderDimColor={!state.focused} flexDirection="column" paddingX={1}
      hover={{ scope, borderColor: accent, borderDimColor: false }}>
      {visible.rows.map((row, index) => {
        const cursor = state.cursor - row.start
        const char = [...row.text.slice(cursor)][0] ?? ' '
        return <Box key={`editor-line-${index}`} width={Math.max(1, props.width - 4)} height={1} flexShrink={0}>
          {state.text === '' ? state.focused ? <Text color={roles.muted}><Text inverse>{[...props.placeholder][0] ?? ' '}</Text>{[...props.placeholder].slice(1).join('')}</Text> : <Text color={roles.muted}>{props.placeholder}</Text>
            : index === visible.caret && state.focused ? <Text>{row.text.slice(0, cursor)}<Text inverse>{char}</Text>{row.text.slice(cursor + (char === ' ' && cursor === row.text.length ? 0 : char.length))}</Text>
            : <Text>{row.text}</Text>}
        </Box>
      })}
    </Box>
    <Box position="absolute" top={0} left={2} height={1}>
      <Text color={state.notice ? roles.warn : state.focused ? accent : roles.muted}>{caption ? ` ${caption} ` : ''}</Text>
    </Box>
    {actions.map(action => {
      // Подпись начинается со значка действия, как в шапке панели.
      const text = `${action.label} ${action.hint}`
      return <Box key={`caption-${action.key}`} position="absolute" top={0} left={2} height={1} display="none"
        hover={{ scope: hoverScope(action.key), display: 'flex' }}><Text color={accent}>{` ${text} `}</Text><Text color={accent}>{'─'.repeat(Math.max(0, cellWidth(caption) - cellWidth(text)))}</Text></Box>
    })}
    {/* «Сохранение» пишется только при отправке: от действия рамки (отмена, перенос в строку ввода) подпись
        не меняется, иначе значки сдвигались под указателем до того, как поле закроется. */}
    {drawCardControls(ui, [{ id: props.id, scope, top: props.height - 1, width: props.width, selected: true,
      actions: [...actions, { key: `${props.frame}-enter`, label: `${props.plain ? '⏎' : '\u{f0311}'} ${state.pending && state.sent?.kind === 'submit' ? 'Сохранение' : props.submitLabel}`, hint: props.submitLabel, keyHint: 'Enter' }] }], props.width, props.height, accent, // md-keyboard_return
      key => send(key === `${props.frame}-enter` ? 'submit' : 'action', key), roles.muted)}
  </Box>
}

// Состояние поля между отрисовками держит сам модуль: несколько клавиш одного кадра обязаны видеть правки
// друг друга, даже если движок отдаёт в surface.state значение прошлой отрисовки.
const live = new WeakMap<object, EditorState>()

const Editor: ClientModule<EditorProps, EditorState> = (props, surface) => {
  const first = surface.state === undefined
  const before = first ? undefined : live.get(surface) ?? surface.state
  const state = syncEditor(before, props)
  const set = (next: EditorState) => { live.set(surface, next); surface.setState(next) }
  if (state !== before) set(state)
  else live.set(surface, state)
  const current = () => live.get(surface) ?? state
  const send = (kind: EditorMessage['kind'], action?: string, activity = false) => {
    let local = current()
    if (kind === 'submit' || kind === 'action') {
      if (local.pending) return
      const { notice: _notice, ...kept } = local
      local = { ...kept, submit: local.submit + 1, pending: true, sent: { kind, ...(action ? { action } : {}) }, waited: 0 }
      set(local)
    }
    // Движок доставляет одно сообщение за кадр, более позднее заменяет недоставленное. Пока отправка не подтверждена,
    // любое сообщение поля несёт её же: щелчок или клавиша того же кадра иначе стёрли бы Enter.
    const outgoing = local.pending && local.sent ? local.sent : { kind, ...(action ? { action } : {}) }
    surface.post({ id: local.id, epoch: local.epoch, version: local.version, text: local.text, cursor: local.cursor, selected: local.selected,
      pasteSequence: local.pasteSequence, kind: outgoing.kind, submit: local.submit, ...(activity ? { activity: true } : {}), ...(outgoing.action ? { action: outgoing.action } : {}) })
  }
  if (before && before.epoch === state.epoch && state.pasteSequence > before.pasteSequence) send('change')
  // Таймер заводится один раз на экземпляр. Он повторяет неподтверждённую отправку и не даёт полю остаться
  // запертым, если сообщение не дошло: после нескольких повторов ввод возвращается с замечанием над полем.
  if (first) surface.every(EDITOR_RETRY_MS, () => {
    const local = current()
    if (!local.pending) return
    const waited = (local.waited ?? 0) + 1
    if (waited > EDITOR_RETRIES) {
      const { sent: _sent, waited: _waited, ...rest } = local
      set({ ...rest, pending: false, notice: 'stalled' })
      return
    }
    set({ ...local, waited })
    send('focus')
  })
  surface.onPointer(event => {
    if (event.type === 'down') {
      const { notice: _notice, ...kept } = current()
      set({ ...kept, focused: true })
      send('focus', undefined, true)
    }
  })
  surface.onKey(event => {
    if (event.key === 'return' && !event.shift && !event.meta && !event.ctrl) { send('submit'); return }
    const before = current(), after = editKey(before, event, Math.max(1, props.width - EDITOR_INSET))
    if (after !== before) set(after)
    send(after.version !== before.version ? 'change' : 'focus', undefined, true)
  })
  return drawEditor(surface.elements, props, state, send)
}
export default Editor

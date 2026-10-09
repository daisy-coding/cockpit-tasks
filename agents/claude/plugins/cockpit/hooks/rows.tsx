import type { ClientModule } from 'claude-code'
import { DEFAULT_THEME, roleColors, contrast, inkOn as fillInk, onFill as fillColor } from './theme'

export type Seg = { t: string; c?: string; b?: boolean; s?: boolean; i?: boolean; sh?: string; dim?: boolean; one?: boolean; spin?: boolean; bg?: string; tab?: string }
export type RowSpec = { id: string; left: Seg[]; right: Seg[]; attached?: boolean }
export type RowsProps = {
  rows: RowSpec[]
  active: string
  // Без заливки выбор и наведение показываются цветом текста и значков.
  activeColor: string
  hoverColor: string
  neutral?: string[]
  // С заливкой строка красится фоном, а текст на ней получает цвет с контрастом к заливке не ниже 4,5:1.
  activeBg?: string
  hoverBg?: string
  tones: Record<string, { bright: string[]; dim: string[] }>
  spinner?: string[]
  pointer?: boolean
  bar?: { pos: number; size: number; thumb: string; track: string }
  marks?: { checked: string; empty: string; accent: string; muted: string }
}
type Local = {
  hover: number; phase: number; drag: boolean
  press?: { id: string; target: string; ranging: boolean; ctrl: boolean; shift: boolean; alt: boolean }
  ref: { stop?: () => void; unpoint?: () => void }
}

const TICK_MS = 90
// Ячейка отметки: пробел, значок, пробел. Пробел слева отделяет её от значка состояния Git в конце ряда.
const MARK_CELLS = 3
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function shimmer(i: number, phase: number, len: number, palette: string[]): string {
  const band = ((phase * 1.6) % (len + 8)) - 4
  const d = Math.abs(i - band)
  return palette[d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0] ?? palette[0] ?? roleColors(DEFAULT_THEME).work
}

// Расчёт цвета текста и заливки принадлежит общей теме.
export const fillContrast = contrast
export const inkOn = fillInk
export const onFill = fillColor

const Rows: ClientModule<RowsProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { hover: -1, phase: 0, drag: false, ref: {} }
    surface.setState(state)
  }
  const lit = props.rows.some(r => r.left.some(s => s.sh || s.spin) || r.right.some(s => s.sh || s.spin))
  if (lit && !state.ref.stop) {
    state.ref.stop = surface.every(TICK_MS, () => {
      const cur = surface.state
      if (cur) surface.setState({ ...cur, phase: cur.phase + 1 })
    })
  } else if (!lit && state.ref.stop) {
    state.ref.stop()
    state.ref.stop = undefined
  }
  if (props.pointer === false) {
    state.ref.unpoint?.()
    state.ref.unpoint = undefined
  } else state.ref.unpoint = surface.onPointer(e => {
    const cur = surface.state ?? state
    const span = Math.max(1, props.rows.length - 1)
    const onBar = Boolean(props.bar) && e.x >= surface.columns - 1
    if (props.bar && (cur.drag || (onBar && e.type === 'down' && (e.button ?? 'left') === 'left'))) {
      if (e.type === 'up' || e.type === 'leave') {
        surface.setState({ ...cur, drag: false, press: undefined })
        return
      }
      if (e.type === 'down' || e.type === 'move') {
        if (!cur.drag) surface.setState({ ...cur, drag: true, hover: -1, press: undefined })
        surface.post({ scrollTo: Math.max(0, Math.min(1, e.y / span)) })
        return
      }
    }
    const row = props.rows[e.y]
    if (cur.press && (e.type === 'move' || e.type === 'up')) {
      const pressed = cur.press
      if (row?.id && row.id !== pressed.target) {
        surface.post({ range: [pressed.id, row.id] })
        surface.setState({ ...cur, hover: e.y, press: { ...pressed, target: row.id, ranging: true } })
      }
      if (e.type === 'up') {
        if (!pressed.ranging && row?.id === pressed.id) surface.post({ press: pressed.id, ctrl: pressed.ctrl, shift: pressed.shift, alt: pressed.alt })
        surface.setState({ ...(surface.state ?? cur), press: undefined })
      }
      return
    }
    if (e.type === 'leave' || e.y < 0 || e.y >= props.rows.length) {
      if (cur.hover !== -1) surface.setState({ ...cur, hover: -1 })
      return
    }
    if (e.type === 'move' && !e.button && cur.hover !== e.y) surface.setState({ ...cur, hover: e.y })
    if (e.type === 'down' && e.button === 'right' && row?.id) {
      surface.post({ copy: row.id, shift: Boolean(e.shift) })
      return
    }
    if (e.type !== 'down' || (e.button ?? 'left') !== 'left' || !row) return
    const markEnd = surface.columns - (props.bar ? 1 : 0)
    if (props.marks && row.id && e.x >= markEnd - MARK_CELLS && e.x < markEnd) {
      surface.post({ mark: row.id })
      return
    }
    let x = 0
    for (const seg of row.left) {
      const w = [...seg.t].length
      if (seg.tab && e.x >= x && e.x < x + w) {
        surface.post({ tab: seg.tab })
        return
      }
      x += w
    }
    if (row.id) surface.setState({ ...cur, hover: e.y, press: { id: row.id, target: row.id, ranging: false, ctrl: Boolean(e.ctrl), shift: Boolean(e.shift), alt: Boolean(e.alt) } })
  })
  surface.onKey(e => surface.post({ key: e.key, ctrl: Boolean(e.ctrl), shift: Boolean(e.shift), alt: 'alt' in e && Boolean(e.alt) }))
  const frames = props.spinner?.length ? props.spinner : FRAMES

  const isFrame = (text: string) => /^[\s╭╮╰╯│─├└]+$/u.test(text) && /\S/u.test(text)
  const neutral = new Set(['', ...(props.neutral ?? [])])
  const draw = (s: Seg, isSelected: boolean, isHovered: boolean, fill?: string) => {
    if (fill) {
      // На заливке переливы не рисуются: их палитра подобрана под фон терминала.
      s = { ...s, sh: undefined, c: onFill(s.c, fill), dim: false, b: isSelected && !s.spin ? true : s.b }
    } else if (!s.spin && !s.sh) {
      if (isFrame(s.t)) {
        if (isSelected) s = { ...s, c: props.activeColor, b: true, dim: false }
        else if (isHovered) s = { ...s, c: props.hoverColor, dim: false }
      } else if (isSelected && neutral.has(s.c ?? '')) {
        s = { ...s, b: true, ...(props.activeColor ? { c: props.activeColor } : {}) }
      } else if (isHovered && neutral.has(s.c ?? '')) {
        s = { ...s, c: props.hoverColor, dim: false }
      }
    }
    if (s.spin) {
      return (
        <Text color={s.c} bold={s.b}>
          {s.t + (frames[state.phase % frames.length] ?? '')}
        </Text>
      )
    }
    const palette = s.sh ? (s.dim ? props.tones[s.sh]?.dim : props.tones[s.sh]?.bright) : undefined
    if (!palette) {
      return (
        <Text color={s.c} bold={s.b} strikethrough={s.s} italic={s.i}>
          {s.t}
        </Text>
      )
    }
    if (s.one) {
      return (
        <Text color={shimmer(-1, state.phase, s.t.length, palette)}>
          {s.t}
        </Text>
      )
    }
    const chars = [...s.t]
    return (
      <Text bold={s.b}>
        {chars.map((ch, i) => (
          <Text key={i} color={shimmer(i, state.phase, chars.length, palette)}>{ch}</Text>
        ))}
      </Text>
    )
  }
  return (
    <Box flexDirection="column">
      {props.rows.map((r, i) => {
        const isSelected = Boolean(r.id && r.id === props.active)
        const isHovered = Boolean(r.id && i === state.hover)
        const fill = (isSelected ? props.activeBg : isHovered ? props.hoverBg : undefined) || undefined
        return (
          <Box
            key={r.id || `row:${i}`}
            flexDirection="row"
            height={1}
            overflow="hidden"
            backgroundColor={fill}
          >
            <Box flexShrink={1} overflow="hidden">
              {r.left.map(s => draw(s, isSelected, isHovered, fill))}
            </Box>
            <Box flexGrow={1} />
            {r.right.map(s => draw(s, isSelected, isHovered, fill))}
            {props.marks && (
              <Box width={MARK_CELLS} flexShrink={0} paddingLeft={1}>
                <Text color={fill ? onFill(r.attached ? props.marks.accent : props.marks.muted, fill) : r.attached ? props.marks.accent : props.marks.muted}>
                  {r.id && r.attached ? props.marks.checked : r.id && i === state.hover ? props.marks.empty : ' '}
                </Text>
              </Box>
            )}
            {props.bar && (
              <Text color={i >= props.bar.pos && i < props.bar.pos + props.bar.size ? props.bar.thumb : props.bar.track}>
                {i >= props.bar.pos && i < props.bar.pos + props.bar.size ? '┃' : '│'}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export default Rows

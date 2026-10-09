import type { ClientElements, ClientModule, RenderElement } from 'claude-code'
import type { TaskCardsProps } from './tasks'
import { activityTones, hoverColor, roleColors } from './theme'
import { cellWidth, graphemes, truncateCells } from './layout'
import { drawCardControls, frameActions, hoverScope } from './card-controls'
import { labelCells } from './panel-actions'
import { highlightSearch } from './task-search-highlight'
import { taskSearchTitleRanges } from './domain/task-search'
import { cardBar, expansionFor, expansionLines, expansionShift, holdCard, loaderStep, LOADER_DOTS, LOADER_FAILED, LOADER_WORD, type Expansion, type HoverIntent } from './card-expansion'
import { workerCounters } from './domain/peer-work'

export type CardEvent = { press: string } | { control: string }
// clock — миллисекунды, набежавшие тактами модуля: от них считается индикатор загрузки.
type Local = { phase: number; clock?: number; drag: boolean; pressed?: string; hovered?: string; opened?: Expansion; keyboard?: boolean;
  ref: { stop?: () => void; period?: number; signature?: string; intent: HoverIntent; props?: TaskCardsProps } }
type CardElements = Pick<ClientElements, 'Box' | 'Text' | 'Button'>

// Перерисовка модуля раз в такт, даже когда блика нет: новые props хука модуль рисует на своём следующем кадре,
// а без таймера следующего кадра могло не быть до движения указателя, и список оставался на шаг позади прокрутки.
const BEAT_MS = 200
const SHIMMER_MS = 90

// Побайтная формула блика из движка рядов FileTree.
function shimmer(i: number, phase: number, len: number, palette: string[]): string {
  const band = ((phase * 1.6) % (len + 8)) - 4
  const d = Math.abs(i - band)
  return palette[d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0] ?? palette[0] ?? palette[0]!
}

export function drawTaskCards(ui: CardElements, props: TaskCardsProps, send: (event: CardEvent) => void, phase = 0): RenderElement {
  const { Box, Text } = ui
  const { theme } = props
  const roles = roleColors(theme)
  const hover = hoverColor(theme)
  return <Box key="task-cards" width={props.width} height={props.height} flexShrink={0} overflow="hidden">
    <Box key="card-window" position="absolute" top={props.top} left={0} flexDirection="column" width={props.width} paddingRight={2}>
      {props.rows.map(row => {
        if (row.kind === 'gap') return <Box key={row.id} height={row.height} flexShrink={0} />
        if (row.kind === 'more') return <Text key={row.id} dimColor color={roles.muted}>{row.text}</Text>
        if (row.kind === 'day') return <Box key={row.id} width={row.width} height={row.height} flexShrink={0} overflow="hidden">
          <Text color={roles.muted}>{`${groupIcon('day', props.plain)} ${row.label}`}</Text>
        </Box>
        if (row.kind === 'empty' && row.lines) return <Box key={row.id} width={row.width} height={row.height} flexDirection="column" flexShrink={0} paddingX={1}>
          {row.lines.map((line, index) => <Text key={`${row.id}:${index}`} dimColor color={roles.muted} wrap="truncate-end">{line}</Text>)}
        </Box>
        if (row.kind === 'empty') return <Box key={row.id} width={row.width} height={row.height} flexShrink={0} borderStyle="round" borderColor={roles.muted} borderDimColor paddingX={1}>
          <Text dimColor color={roles.muted} wrap="truncate-end">{row.text}</Text>
        </Box>
        if (row.kind === 'heading') return <Box key={row.id} width={row.width} height={row.height} flexShrink={0} overflow="hidden">
          <Text color={roles.muted}>{`${groupIcon(row.group, props.plain)} ` + (row.group === 'now' ? row.label : row.label.toUpperCase()) + (['queue', 'waiting'].includes(row.group) ? ` ${row.count}` : '')}</Text>
        </Box>
        if (row.kind !== 'card') return null
        const length = row.titleLines.reduce((sum, text) => sum + graphemes(text).length, 0)
        let offset = 0
        // Выбранная и текущая карточки уже выделены рамкой: наведение их не перекрашивает.
        const marked = row.selected && row.task.status !== 'paused'
        const still = marked || row.running
        const available = Math.max(0, row.width - cellWidth(row.number ? ` ${row.number} ` : '') - 5)
        const returnLabel = (row.returnCount ?? 0) > 0 ? ` ${props.plain ? '↶' : '\u{f099b}'} ${row.returnCount} ` : '' // md-restore
        const discussionLabel = row.discussionCount > 0 ? ` ${props.plain ? '✉' : '\u{f0361}'} ${row.discussionCount} ` : '' // md-message
        const discussion = cellWidth(discussionLabel) <= available ? discussionLabel : ''
        const discussionWidth = cellWidth(discussion)
        const returned = cellWidth(returnLabel) <= available - discussionWidth ? returnLabel : ''
        const returnWidth = cellWidth(returned)
        // Номер — сосед рамки, нарисованный после неё: потомка с отрицательным смещением линия рамки закрывала.
        return <Box key={`card-slot:${row.taskId}`} width={row.width} height={row.height} flexShrink={0}>
          <Box key={`card:${row.taskId}`} flexDirection="column" width={row.width} height={row.height} flexShrink={0}
          borderStyle="round" borderColor={row.borderColor} borderDimColor={row.borderDimColor}
          hover={still ? undefined : { scope: hoverScope(`card-${row.taskId}`), borderColor: hover, borderDimColor: false }}>
          <Box key={`interior:${row.taskId}`} flexDirection="column" width={row.innerWidth}>
            {[...row.titleLines, ...(row.search?.snippet ? [row.search.snippet] : []), ...row.context].map((text, index) => {
              const title = index < row.titleLines.length
              const start = offset
              if (title) offset += graphemes(text).length
              let titleCells = 0
              const titleGlyph = (ch: string, i: number) => {
                const end = titleCells + cellWidth(ch)
                const hit = row.search?.title[index]?.some(range => range.start < end && range.end > titleCells)
                titleCells = end
                return <Text key={`shine:${row.taskId}:${start + i}`} color={hit ? roles.accent : shimmer(start + i, phase, length, activityTones(theme).bright)}>{ch}</Text>
              }
              // Строка под названием, пока описание читается: слово и три точки, светится одна; ширина постоянна.
              const loading = row.loader !== undefined && index === row.titleLines.length + (row.search?.snippet ? 1 : 0)
              return <Box key={`body:${row.taskId}:${index}`} flexDirection="row" height={1} flexShrink={0} width={row.innerWidth} overflow="hidden">
                <Box key={`title:${row.taskId}:${index}`} width={row.textWidth} height={1} flexShrink={0} overflow="hidden">
                  {loading ? row.loader === 'failed' ? <Text key={`loader:${row.taskId}`} dimColor color={roles.muted}>{LOADER_FAILED}</Text>
                    : <Text key={`loader:${row.taskId}`}><Text color={roles.muted} dimColor>{`${LOADER_WORD} `}</Text>
                      {Array.from({ length: LOADER_DOTS }, (_, dot) => <Text key={`loader:${row.taskId}:${dot}`} color={dot === row.loader ? theme.fg || undefined : roles.muted} dimColor={dot !== row.loader}>•</Text>)}</Text>
                    : title && row.shimmer ? <Text bold>{graphemes(text).map(titleGlyph)}</Text>
                    : <Text bold={title} color={title ? row.running ? roles.work : theme.fg || undefined : roles.muted}>{highlightSearch(ui, text, title ? row.search?.title[index] : row.search?.snippet && index === row.titleLines.length ? row.search.ranges
                      : row.search?.context?.[index - row.titleLines.length - (row.search.snippet ? 1 : 0)], roles.accent)}</Text>}
                </Box>
              </Box>
            })}
          </Box>
          </Box>
          {row.number ? <Box key={`number-frame:${row.taskId}`} position="absolute" top={0} left={2} height={1}>
            <Text key={`number:${row.taskId}`} color={row.running || marked ? row.borderColor : roles.muted} hover={still ? undefined : { scope: hoverScope(`card-${row.taskId}`), color: hover }}>{` ${row.number} `}</Text>
          </Box> : null}
          {discussion ? <Box key={`discussion-frame:${row.taskId}`} position="absolute" top={0} left={row.width - discussionWidth - 2} width={discussionWidth} height={1}>
            <Text key={`discussion:${row.taskId}`} color={row.running || marked ? row.borderColor : roles.muted}
              hover={still ? undefined : { scope: hoverScope(`card-${row.taskId}`), color: hover }}>{discussion}</Text>
          </Box> : null}
          {returned ? <Box key={`return-frame:${row.taskId}`} position="absolute" top={0} left={row.width - discussionWidth - returnWidth - 2} width={returnWidth} height={1}>
            <Text key={`return:${row.taskId}`} color={row.running || marked ? row.borderColor : roles.muted}
              hover={still ? undefined : { scope: hoverScope(`card-${row.taskId}`), color: hover }}>{returned}</Text>
          </Box> : null}
          {/* Время слева: справа на нижней линии теперь стоят действия карточки. */}
          {row.closedTime ? <Box key={`time-frame:${row.taskId}`} position="absolute" top={row.height - 1} left={2} height={1}>
            <Text key={`time:${row.taskId}`} color={row.running || marked ? row.borderColor : roles.muted} hover={still ? undefined : { scope: hoverScope(`card-${row.taskId}`), color: hover }}>
              {` ${truncateCells(closedLabel(row.closedTime, row.closedSpent, props.plain), Math.max(1, (controlSpan(row)?.left ?? row.width - 2) - 4))} `}</Text>
          </Box> : null}
          {/* Счётчики исполнителей: цвет «в работе» у всей карточки группы, подпись словами — в шапке при наведении. */}
          {row.workers?.length ? <Box key={`worker-frame:${row.taskId}`} position="absolute" top={row.height - 1} left={2} height={1}>
            <Text key={`worker:${row.taskId}`} color={roles.work} hover={{ scope: hoverScope(`card-${row.taskId}-workers`), color: hover }}>
              {` ${truncateCells(workerCounters(row.workers, props.plain), Math.max(1, (controlSpan(row)?.left ?? row.width - 2) - 4))} `}</Text>
          </Box> : null}
          {/* Значки стоят на нижней линии рамки внутри слота карточки и двигаются вместе с ней. */}
          {drawCardControls(ui, [{ id: row.taskId, scope: hoverScope(`card-${row.taskId}`), width: row.width, top: row.height - 1, selected: row.selected,
            actions: row.controls.map(control => ({ ...control })) }], row.width, row.height, hover, key => send({ control: key }), roles.muted)}
        </Box>
      })}
    </Box>
    {props.bar ? <Box key="task-scrollbar" position="absolute" right={0} top={0} flexDirection="column" height={props.height} width={1}>
      {Array.from({ length: props.height }, (_, index) => <Text key={`scroll:${index}`} color={roles.muted}>
        {index >= props.bar!.pos && index < props.bar!.pos + props.bar!.size ? '┃' : '│'}
      </Text>)}
    </Box> : null}
  </Box>
}

// Значки заголовков групп: Material Design из таблицы Nerd Fonts.
const GROUP_ICONS: Record<string, [string, string]> = {
  now: ['\u{f040d}', '●'], // md-play_circle_outline
  queue: ['\u{f0279}', '≡'], // md-format_list_bulleted
  detours: ['\u{f00fb}', '↳'], // md-call_split
  waiting: ['\u{f03e6}', '‖'], // md-pause_circle_outline
  done: ['\u{f02da}', '✓'], // md-history
  day: ['\u{f00f6}', '▫'], // md-calendar_today
}
function groupIcon(group: string, plain?: boolean): string {
  const pair = GROUP_ICONS[group] ?? GROUP_ICONS.day!
  return plain ? pair[1] : pair[0]
}

// Нижняя линия карточки истории: когда задача закрыта и сколько была в работе.
const CLOSED_ICON: [string, string] = ['\u{f05e1}', '✓'] // md-check_circle_outline
const SPENT_ICON: [string, string] = ['\u{f051f}', '⧖'] // md-timer_sand
function closedLabel(when: string, spent: string | undefined, plain?: boolean): string {
  const set = plain ? 1 : 0
  return `${CLOSED_ICON[set]} ${when}` + (spent ? `  ${SPENT_ICON[set]} ${spent}` : '')
}

// Ячейки нижней линии рамки, занятые значками действий: нажатие там принадлежит значку, а не телу карточки.
function controlSpan(row: Extract<TaskCardsProps['rows'][number], { kind: 'card' }>): { left: number; right: number } | null {
  const actions = frameActions(row.controls.map(control => ({ ...control })), row.width)
  if (!actions.length) return null
  const cells = 2 + actions.reduce((sum, action) => sum + labelCells(action.label), 0) + 2 * Math.max(0, actions.length - 1)
  return { left: row.width - cells - 2, right: row.width - 2 }
}

function bodyAt(props: TaskCardsProps, x: number, y: number): string | undefined {
  let top = props.top
  for (const row of props.rows) {
    const inside = y >= top && y < top + row.height && x >= 0 && x < row.width
    if (inside && row.kind === 'card') {
      const span = y === top + row.height - 1 ? controlSpan(row) : null
      return span && x >= span.left && x < span.right ? undefined : row.id
    }
    if (inside && row.kind === 'heading' && row.group === 'waiting') return row.id
    top += row.height
  }
  return undefined
}

const TaskCards: ClientModule<TaskCardsProps, Local> = (props, surface) => {
  let local = surface.state
  if (!local) { local = { phase: 0, drag: false, ref: { intent: {} } }; surface.setState(local) }
  local.ref.props = props
  const signature = `${props.windowKey ?? ''}:${props.width}:${props.height}:${props.offset}:${props.top}:${props.rows.map(row => `${row.id}/${row.height}`).join(',')}`
  const selected = props.rows.find(row => row.kind === 'card' && row.selected)?.id
  if (local.ref.signature !== signature || local.keyboard && local.opened?.id !== selected) {
    holdCard(surface, local.ref.intent, undefined, () => undefined)
    local.ref.signature = signature
    local = { ...local, hovered: undefined, opened: undefined, keyboard: false, pressed: undefined }
    surface.setState(local)
  }
  const height = props.viewportHeight ?? props.height
  const open = (id: string, keyboard = false) => {
    const current = surface.state
    const latest = current?.ref.props
    const row = latest?.rows.find(item => item.kind === 'card' && item.id === id)
    if (!current || !latest || row?.kind !== 'card') return
    if (row.detailReady === false) surface.post({ details: row.taskId })
    surface.setState({ ...current, keyboard, opened: { ...expansionFor(id, row.details, row.detailReady !== false, row.height, latest.viewportHeight ?? latest.height), since: current.clock ?? 0 } })
  }
  const opened = local.opened
  let before = 0, shift = 0, extra = 0
  const rows = props.rows.map(row => {
    const at = before
    before += row.height
    if (row.kind !== 'card' || row.id !== opened?.id) return row
    // Высота считается на каждом кадре: описание, дочитанное после раскрытия, растягивает карточку до своего текста.
    const ready = row.detailReady !== false
    const context = expansionLines(expansionFor(opened.id, row.details, ready, row.height, height), row.details, ready, row.textWidth)
    // Индикатор идёт от момента раскрытия; после срока запроса вместо него неподвижный текст.
    const loader = ready || !context.length ? undefined : loaderStep((local.clock ?? 0) - (opened.since ?? 0)) ?? 'failed' as const
    if (!row.search?.query) {
      extra = context.length
      shift = expansionShift(props.top, at, row.height, extra, height)
      return { ...row, expanded: true, context, height: row.height + extra, ...(loader === undefined ? {} : { loader }) }
    }
    // В выдаче поиска раскрытое описание встаёт на место строки отрывка и подсвечивает найденные слова, где они
    // в нём есть. Отрывок остаётся только у задачи, которой при раскрытии показать нечего.
    const { query, title, snippet, ranges } = row.search
    const hits = context.map(line => taskSearchTitleRanges(query, line))
    const replaced = snippet !== undefined && context.length > 0
    const base = row.height - (replaced ? 1 : 0)
    extra = context.length - (replaced ? 1 : 0)
    shift = expansionShift(props.top, at, base, context.length, height)
    return { ...row, expanded: true, context, height: base + context.length, ...(loader === undefined ? {} : { loader }),
      search: { title, query, context: hits, ...(replaced || snippet === undefined ? {} : { snippet, ...(ranges ? { ranges } : {}) }) } }
  })
  const shown = { ...props, rows, height, top: props.top - shift, totalHeight: props.totalHeight + extra, offset: props.offset + shift,
    bar: cardBar(props.totalHeight + extra, height, props.offset + shift) }
  const lit = props.rows.some(row => row.kind === 'card' && row.shimmer)
  const period = lit ? SHIMMER_MS : BEAT_MS
  if (local.ref.period !== period) {
    local.ref.stop?.()
    local.ref.period = period
    local.ref.stop = surface.every(period, () => {
      const current = surface.state
      if (current) surface.setState({ ...current, phase: current.phase + 1, clock: (current.clock ?? 0) + period })
    })
  }
  surface.onPointer(event => {
    const current = surface.state
    if (!current) return
    const onBar = Boolean(shown.bar) && event.x >= (surface.columns || props.width) - 1
    if (current.drag || onBar) {
      if (current.hovered || current.opened) {
        holdCard(surface, current.ref.intent, undefined, () => undefined)
        surface.setState({ ...current, hovered: undefined, opened: undefined, keyboard: false })
      }
      if (event.type === 'up' || event.type === 'leave') { surface.setState({ ...(surface.state ?? current), drag: false }); return }
      if (event.type === 'down' || (event.type === 'move' && current.drag)) {
        if ((event.button ?? 'left') !== 'left') return
        holdCard(surface, current.ref.intent, undefined, () => undefined)
        surface.setState({ ...current, drag: true, pressed: undefined, hovered: undefined, opened: undefined, keyboard: false })
        surface.post({ scrollTo: Math.max(0, Math.min(1, event.y / Math.max(1, props.height - 1))) })
      }
      return
    }
    if (event.type === 'leave') {
      holdCard(surface, current.ref.intent, undefined, () => undefined)
      surface.setState({ ...current, pressed: undefined, hovered: undefined, opened: undefined, keyboard: false }); return
    }
    // Значки на рамке также принадлежат карточке для наведения, но не для щелчка по телу.
    let top = shown.top
    const hovered = shown.rows.find(row => {
      const inside = row.kind === 'card' && event.y >= top && event.y < top + row.height && event.x >= 0 && event.x < row.width
      top += row.height
      return inside
    })?.id
    if (event.type === 'move' && !event.button && current.hovered !== hovered) {
      surface.setState({ ...current, hovered, opened: undefined, keyboard: false })
      holdCard(surface, current.ref.intent, hovered, id => { if (surface.state?.hovered === id) open(id) })
      return
    }
    if (event.type === 'down' && (event.button ?? 'left') === 'left') surface.setState({ ...current, pressed: bodyAt(shown, event.x, event.y) })
    if (event.type === 'up') {
      if (current.pressed && current.pressed === bodyAt(shown, event.x, event.y)) surface.post({ press: current.pressed })
      surface.setState({ ...current, pressed: undefined })
    }
  })
  surface.onKey(event => {
    if (event.key === 'i' && !event.ctrl && !event.shift) {
      const current = surface.state
      holdCard(surface, local.ref.intent, undefined, () => undefined)
      if (current?.opened?.id === selected) surface.setState({ ...current, opened: undefined, keyboard: false })
      else if (selected) open(selected, true)
      return
    }
    surface.post({ key: event.key })
  })
  return drawTaskCards(surface.elements, shown, event => surface.post(event), local.phase)
}
export default TaskCards

import type { ClientElements, ClientModule, RenderElement } from 'claude-code'
import type { OwnerCard } from './tasks'
import type { Theme } from '../theme'
import { hoverColor, roleColors } from '../theme'
import { drawCardControls } from '../card-controls'
import { expansionFor, expansionLines, expansionShift, holdCard, type Expansion, type HoverIntent } from '../card-expansion'
import { taskSearchTitleRanges } from '../domain/task-search'
import { highlightSearch } from '../task-search-highlight'
import type { TaskSearchQuery } from '../../types/index'
import type { TaskSearchRange } from '../domain/task-search'
import { savedMark } from './saved-cards'

export type OwnerCardsProps = { cards: OwnerCard[]; theme: Theme; width: number; height: number; selectedId?: number; top?: number; generation?: number; plain?: boolean; search?: TaskSearchQuery; searchTitles?: Record<string, TaskSearchRange[][]> }
type Local = { hovered?: number; selected?: number; opened?: Expansion; keyboard?: boolean;
  ref: { signature?: string; intent: HoverIntent; props?: OwnerCardsProps; generation?: number; opened?: string } }

// Тот же слот и сосед номера, что у карточек агента; внутри рамки только текст.
// Выбранной карточки на вид нет: действия стоят на рамке каждой, рамку красит только наведение.
export function drawOwnerCards(ui: Pick<ClientElements, 'Box' | 'Text' | 'Button'>, props: OwnerCardsProps, press: (key: string) => unknown = () => undefined): RenderElement {
  const { Box, Text } = ui
  const { theme } = props
  const inner = Math.max(1, props.width - 2)
  const roles = roleColors(theme)
  const hover = hoverColor(theme)
  return <Box key="owner-cards" width={props.width} height={props.height} flexShrink={0} overflow="hidden">
    <Box key="owner-card-window" position="absolute" top={props.top ?? 0} left={0} width={props.width} flexDirection="column">
    {props.cards.map(card => <Box key={`owner-card-row-${card.id}`} flexDirection="column" flexShrink={0}>
      <Box key={`owner-card-slot-${card.id}`} width={props.width} height={card.height} flexShrink={0}>
        <Box key={`owner-${card.saved ? 'saved' : 'task'}-${card.id}`} flexDirection="column" width={props.width} height={card.height} flexShrink={0}
          borderStyle="round" borderColor={roles.muted} borderDimColor
          hover={{ scope: `owner-card-${card.id}`, borderColor: hover, borderDimColor: false }}>
          {[...card.titleLines, ...card.context].map((line, i) => <Box key={`owner-line-${card.id}-${i}`} width={inner} height={1} flexShrink={0} overflow="hidden">
            <Text bold={i < card.titleLines.length} color={card.saved ? roles.fg : i < card.titleLines.length ? theme.fg || undefined : roles.muted}>{highlightSearch(ui, line, !card.saved && i < card.titleLines.length ? props.searchTitles?.[card.id]?.[i] : props.search ? taskSearchTitleRanges(props.search, line) : undefined, roles.accent)}</Text>
          </Box>)}
        </Box>
        {card.label || card.saved ? <Box key={`owner-number-frame-${card.id}`} position="absolute" top={0} left={2} height={1}>
          <Text key={`owner-number-${card.id}`} color={card.saved ? roles[card.saved] : roles.muted} hover={card.saved ? undefined : { scope: `owner-card-${card.id}`, color: hover }}>{` ${[card.saved ? savedMark(card.saved, props.plain) : '', card.label].filter(Boolean).join(' ')} `}</Text>
        </Box> : null}
        {drawCardControls(ui, [{ id: `owner-${card.id}`, scope: `owner-card-${card.id}`, width: props.width, top: card.height - 1, selected: true,
          actions: card.controls ?? [] }], props.width, card.height, hover, press, roles.muted)}
      </Box>
    </Box>)}
    </Box>
  </Box>
}

function cardAt(props: OwnerCardsProps, x: number, y: number): number | undefined {
  if (x < 0 || x >= props.width) return undefined
  let top = props.top ?? 0
  for (const card of props.cards) {
    if (y >= top && y < top + card.height) return card.saved ? undefined : card.id
    top += card.height
  }
  return undefined
}

const OwnerCards: ClientModule<OwnerCardsProps, Local> = (props, surface) => {
  let local = surface.state
  if (!local) { local = { ref: { intent: {} } }; surface.setState(local) }
  local.ref.props = props
  const signature = `${props.width}:${props.height}:${props.cards.map(card => `${card.id}/${card.height}/${card.saved ?? 'open'}`).join(',')}`
  if (signature !== local.ref.signature) {
    holdCard(surface, local.ref.intent, undefined, () => undefined)
    local.ref.signature = signature
    local = { ...local, opened: undefined, hovered: undefined, keyboard: false,
      selected: props.cards.some(card => !card.saved && card.id === local?.selected) ? local.selected : undefined }
    surface.setState(local)
  }
  const open = (id: number, keyboard = false) => {
    const current = surface.state
    const latest = current?.ref.props
    const card = latest?.cards.find(card => card.id === id)
    if (!current || !latest || !card || card.saved) return
    surface.setState({ ...current, keyboard, opened: expansionFor(String(id), card.details ?? [], true, card.height, latest.height) })
  }
  let before = 0, shift = 0
  const cards = props.cards.map(card => {
    const top = before; before += card.height
    if (card.saved || String(card.id) !== local.opened?.id) return card
    const context = expansionLines(local.opened, card.details ?? [], true, props.width - 2)
    shift = expansionShift(0, top, card.height, context.length, props.height)
    return { ...card, context: [...card.context, ...context], height: card.height + context.length }
  })
  const shown = { ...props, cards, top: -shift }
  // Согласие получает квитанцию фактически показанного текста; расчёт прежнего бюджета остаётся в хуке.
  const receipt = (id: number | undefined) => {
    const card = shown.cards.find(card => card.id === id)
    return { generation: props.generation ?? -1, shown: card && !card.saved && card.height <= props.height ? { id: card.id, lines: card.context.length, ...(card.token === undefined ? {} : { token: card.token }) } : null }
  }
  if (local.ref.generation !== props.generation || local.ref.opened !== local.opened?.id) {
    local.ref.generation = props.generation
    local.ref.opened = local.opened?.id
    surface.post(receipt(local.opened ? Number(local.opened.id) : undefined))
  }
  surface.onPointer(event => {
    const current = surface.state
    if (!current) return
    const hovered = event.type === 'leave' ? undefined : cardAt(shown, event.x, event.y)
    if (event.type === 'leave' || hovered !== current.hovered) {
      // Смена карточки под указателем сворачивает раскрытую. Цель клавиш и квитанция «ничего не раскрыто» уходят
      // одним сообщением: второе сообщение того же кадра заменило бы первое, и хук остался бы с прежней целью.
      current.ref.opened = undefined
      surface.setState({ ...current, hovered, opened: undefined, keyboard: false })
      surface.post({ hover: hovered ?? null, ...receipt(undefined) })
      holdCard(surface, current.ref.intent, hovered === undefined ? undefined : String(hovered), id => {
        if (String(surface.state?.hovered) === id) open(Number(id))
      })
    }
    if (event.type === 'down' && (event.button ?? 'left') === 'left' && hovered !== undefined) {
      surface.setState({ ...(surface.state ?? current), selected: hovered })
    }
  })
  surface.onKey(event => {
    const current = surface.state
    const active = props.cards.filter(card => !card.saved)
    const selected = current?.selected ?? props.selectedId ?? active[0]?.id
    if (event.key === 'i' && !event.ctrl && !event.shift) {
      holdCard(surface, local.ref.intent, undefined, () => undefined)
      if (current?.opened?.id === String(selected)) surface.setState({ ...current, opened: undefined, keyboard: false })
      else if (selected !== undefined) open(selected, true)
      return
    }
    // Клавиша несёт известную клиенту цель сама: отдельное сообщение о наведении могло не дойти. После смены
    // раскладки клиент цель забывает (указатель остался на месте, события не было) — тогда хук держит прежнюю.
    surface.post({ key: event.key, ...(current?.hovered === undefined ? {} : { hover: current.hovered }),
      ...receipt(current?.hovered ?? (active.length === 1 ? active[0]?.id : undefined)) })
  })
  return drawOwnerCards(surface.elements, shown, control => surface.post({ control,
    ...receipt(shown.cards.find(card => card.controls?.some(action => action.key === control))?.id) }))
}
export default OwnerCards

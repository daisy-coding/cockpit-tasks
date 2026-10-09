import type { ClientElements, ClientModule, RenderElement } from 'claude-code'
import { cellWidth } from './layout'

// Псевдоним типа, а не интерфейс: свойства модуля Client обязаны укладываться в JsonValue.
export type TaskTab = { id: string; label: string; active: boolean; attention: boolean; dimmed?: boolean }
export type TaskTabsProps = { tabs: TaskTab[]; width: number; fill: string; ink: string; muted: string; alert: string; hover: string }
type Local = { hovered?: string }

export function tabCells(tab: TaskTab, padding = 1): number {
  return cellWidth(tab.label) + padding * 2
}

// Вкладка собирается из значка, названия и счётчика. Когда полные названия не входят в ширину даже без
// отступов, неактивные вкладки остаются значком со счётчиком, на самой узкой панели — все. Значок не исчезает:
// по нему вкладку узнают на любой ширине, а название всегда читается у активной. Без значка (набор без
// Nerd Font) название не убирается: узнать вкладку было бы не по чему.
export type TabParts = { id: string; icon: string; name: string; count: string; active: boolean; attention: boolean; dimmed?: boolean }
export function fitTabs(parts: TabParts[], width: number): TaskTab[] {
  const label = (part: TabParts, short: boolean) => `${part.icon ? `${part.icon} ` : ''}${short && part.icon ? '' : `${part.name} `}${part.count}`
  const build = (short: (part: TabParts) => boolean): TaskTab[] => parts.map(part => ({ id: part.id, label: label(part, short(part)), active: part.active, attention: part.attention, ...(part.dimmed ? { dimmed: true } : {}) }))
  const fits = (tabs: TaskTab[]) => tabs.reduce((sum, tab) => sum + tabCells(tab, 0), 0) + Math.max(0, tabs.length - 1) <= width
  const full = build(() => false)
  if (fits(full)) return full
  const mixed = build(part => !part.active)
  return fits(mixed) ? mixed : build(() => true)
}

// Пока названия входят в ширину, на узкой панели убираются только отступы.
export function tabSpans(props: Pick<TaskTabsProps, 'tabs' | 'width'>): { tab: TaskTab; left: number; cells: number; padding: number }[] {
  const padded = props.tabs.reduce((sum, tab) => sum + tabCells(tab), 0) + Math.max(0, props.tabs.length - 1)
  const padding = padded <= props.width ? 1 : 0
  let left = 0
  return props.tabs.map(tab => {
    const cells = tabCells(tab, padding)
    const span = { tab, left, cells, padding }
    left += cells + 1
    return span
  })
}

function tabAt(props: TaskTabsProps, x: number, y: number): string | undefined {
  if (y !== 0) return undefined
  for (const { tab, left, cells } of tabSpans(props)) {
    if (x >= left && x < left + cells) return tab.id
  }
  return undefined
}

// Вкладка с отметкой о новом остаётся своего цвета и под курсором: цвет занят состоянием, поэтому наведение показано жирностью.
// Заливка только у активной вкладки: она показывает выбор заранее, без наведения. Наведение меняет цвет текста
// у любой вкладки, включая активную: отклик на указатель одинаков по всей полосе, как во вкладках «Проекта».
export function drawTaskTabs(ui: Pick<ClientElements, 'Box' | 'Text'>, props: TaskTabsProps, hovered?: string): RenderElement {
  const { Box, Text } = ui
  return <Box key="task-tabs-row" flexDirection="row" height={1} width={props.width} overflow="hidden">
    {tabSpans(props).flatMap(({ tab, cells, padding }, index) => [
      ...(index ? [<Text key={`tab-separator-${tab.id}`}> </Text>] : []),
      <Box key={`${tab.id}-tab`} width={cells} height={1} flexShrink={0}>
        {tab.active ? <Text key={`${tab.id}-tab-label`} bold dimColor={tab.dimmed} color={hovered === tab.id ? props.hover : props.ink} backgroundColor={props.fill}>{`${' '.repeat(padding)}${tab.label}${' '.repeat(padding)}`}</Text> : <Text key={`${tab.id}-tab-label`} dimColor={tab.dimmed && hovered !== tab.id}           bold={tab.attention && hovered === tab.id} color={tab.attention ? props.alert : hovered === tab.id ? props.hover : props.muted}>{`${' '.repeat(padding)}${tab.label}${' '.repeat(padding)}`}</Text>}
      </Box>,
    ])}
  </Box>
}

const TaskTabs: ClientModule<TaskTabsProps, Local> = (props, surface) => {
  const local = surface.state ?? {}
  surface.onPointer(event => {
    const current = surface.state ?? {}
    if (event.type === 'leave') { if (current.hovered !== undefined) surface.setState({}); return }
    const at = tabAt(props, event.x, event.y)
    if (event.type === 'up' && at !== undefined && (event.button ?? 'left') === 'left') surface.post({ tab: at })
    if (current.hovered !== at) surface.setState(at === undefined ? {} : { hovered: at })
  })
  surface.onKey(event => surface.post({ key: event.key }))
  return drawTaskTabs(surface.elements, props, local.hovered)
}
export default TaskTabs

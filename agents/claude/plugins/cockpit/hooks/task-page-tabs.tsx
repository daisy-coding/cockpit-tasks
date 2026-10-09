import type { ClientModule } from 'claude-code'
import { drawTaskTabs, tabSpans, type TaskTabsProps } from './task-tabs'

export type PageTabsProps = TaskTabsProps & { taskId: string; generation: number }

const PageTabs: ClientModule<PageTabsProps, { hovered?: string }> = (props, surface) => {
  const identity = { taskId: props.taskId, generation: props.generation }
  surface.onPointer(event => {
    const tab = event.y === 0 ? tabSpans(props).find(span => event.x >= span.left && event.x < span.left + span.cells)?.tab.id : undefined
    if (event.type === 'up' && tab && (event.button ?? 'left') === 'left') surface.post({ ...identity, tab })
    const hovered = event.type === 'leave' ? undefined : tab
    if (surface.state?.hovered !== hovered) surface.setState(hovered ? { hovered } : {})
  })
  surface.onKey(event => surface.post({ ...identity, key: event.key }))
  return drawTaskTabs(surface.elements, props, surface.state?.hovered)
}
export default PageTabs

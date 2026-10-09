import type { ClientElements, ClientModule, RenderElement } from 'claude-code'
import type { TaskPageProps } from './task-page-model'
import { roleColors } from './theme'

export function drawTaskPage(ui: Pick<ClientElements, 'Box' | 'Text'>, props: TaskPageProps): RenderElement {
  const { Box, Text } = ui
  const size = Math.max(1, Math.round(props.height * props.height / Math.max(1, props.total)))
  const position = Math.round(props.offset / Math.max(1, props.total - props.height) * Math.max(0, props.height - size))
  const roles = roleColors(props.theme)
  return <Box key="page-window" flexDirection="column" width={props.width} height={props.height} flexShrink={0} overflow="hidden">
    {props.lines.map(line => <Box key={`page-line:${line.id}`} flexDirection="row" width={Math.max(1, props.width - 2)} height={1} flexShrink={0}>
      <Text key={`page-mark:${line.id}`} color={roles.accent}>{line.commentId && line.commentId === props.selected ? '┃' : ' '}</Text>
      <Text color={roles.fg}> </Text>
      {line.spans ? line.spans.map((span, index) => <Text key={`page-text:${line.id}:${index}`} color={roles[span.role]}>{span.text}</Text>)
        : <Text key={`page-text:${line.id}`} bold={line.kind === 'title' || line.kind === 'heading'} color={['time', 'empty'].includes(line.kind) ? roles.muted : roles.fg}>{line.text}</Text>}
    </Box>)}
    {props.total > props.height ? <Box key="page-scrollbar" position="absolute" top={0} right={0} width={1} height={props.height} flexDirection="column">
      {Array.from({ length: props.height }, (_, index) => <Text key={`page-scroll:${index}`} color={roles.muted}>{index >= position && index < position + size ? '┃' : '│'}</Text>)}
    </Box> : null}
  </Box>
}

const TaskPageContent: ClientModule<TaskPageProps, { dragging: boolean; scope: string }> = (props, surface) => {
  const scope = `${props.taskId}:${props.generation}:${props.tab}`
  if (surface.state?.scope !== scope) surface.setState({ dragging: false, scope })
  const identity = { taskId: props.taskId, generation: props.generation, activeTab: props.tab }
  surface.onKey(event => surface.post({ ...identity, key: event.key }))
  surface.onPointer(event => {
    if (event.type === 'up') { surface.setState({ dragging: false, scope }); return }
    const dragging = surface.state?.scope === scope && surface.state.dragging
    if ((event.type !== 'down' && !(event.type === 'move' && dragging)) || (event.button ?? 'left') !== 'left') return
    if ((event.x >= props.width - 1 || dragging) && props.total > props.height) {
      surface.setState({ dragging: true, scope })
      surface.post({ ...identity, scrollTo: event.y / Math.max(1, props.height - 1) })
      return
    }
    if (event.type !== 'down') return
    surface.setState({ dragging: false, scope })
    const commentId = props.lines[Math.floor(event.y)]?.commentId
    if (commentId) surface.post({ ...identity, commentId })
  })
  return drawTaskPage(surface.elements, props)
}
export default TaskPageContent

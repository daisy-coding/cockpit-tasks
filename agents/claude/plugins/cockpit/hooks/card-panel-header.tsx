import type { ClientModule } from 'claude-code'
import PanelHeader, { type HeaderProps } from './panel-header'
import { actionCaption, labelCells } from './panel-actions'
import { hoverScope } from './card-controls'

type Local = NonNullable<Parameters<typeof PanelHeader>[1]['state']>

// Общая шапка сохраняет доставку и клавиши; локальная обёртка добавляет только подсказки карточек.
const CardPanelHeader: ClientModule<HeaderProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  const header = PanelHeader(props, surface)
  const focused = surface.state?.focus || props.focused
  return <Box width={surface.columns} height={1}>
    {header}
    {props.actions.filter(action => action.hidden && action.key !== props.metaAction).map(action => {
      const isFocused = action.key === focused
      return <Box key={`caption-${action.key}`} position="absolute" top={0} left={0} height={1}
        display={isFocused ? 'flex' : 'none'} hover={isFocused ? undefined : { scope: hoverScope(action.key), display: 'flex' }} overflow="hidden">
        <Text bold color={props.accent} wrap="truncate-end">{actionCaption(action)}</Text>
        <Text>{' '.repeat(Math.max(0, labelCells(props.title) - labelCells(actionCaption(action))))}</Text>
      </Box>
    })}
  </Box>
}
export default CardPanelHeader

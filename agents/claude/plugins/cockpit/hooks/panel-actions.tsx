import type { ClientModule } from 'claude-code'

// Наведение и подпись используют одну роль accent, переданную панелью.

// Общий помощник панелей; самостоятельные моды получают одинаковую копию.
export type PanelAction = { key: string; label: string; hint: string; keyHint: string; shortcut?: string; dimColor?: boolean; hidden?: true }
export type PanelActionsProps = { title: string; accent: string; muted: string; actions: PanelAction[]; hint: string; focused: string; meta?: string; metaAction?: string; plugin?: string }
type Local = { focus: string; externalFocus: string }

export function labelCells(text: string): number {
  let cells = 0
  for (const { segment } of new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(text)) {
    const code = segment.codePointAt(0) ?? 0
    cells += /\p{Extended_Pictographic}/u.test(segment) || code >= 0x1100 && code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 ? 2 : 1
  }
  return cells
}

export function actionSpans(actions: PanelAction[], columns: number) {
  actions = actions.filter(action => !action.hidden)
  const total = actions.reduce((sum, action) => sum + labelCells(action.label), 0) + Math.max(0, actions.length - 1) * 2 + 1
  let x = Math.max(0, columns - total)
  return actions.map(action => {
    const start = x
    x += labelCells(action.label) + 2
    return { key: action.key, start, end: x - 2 }
  })
}

// Подпись начинается со значка действия: по нему видно, к какому значку она относится.
export function actionCaption(action: PanelAction): string {
  const keyHint = action.keyHint ? action.keyHint.replace(/·/g, ' ').replace(/\s+/g, ' ').trim() : ''
  const text = keyHint ? `${action.hint}  [${keyHint}]` : action.hint
  return action.label && action.label !== action.hint ? `${action.label} ${text}` : text
}

export function actionHint(actions: PanelAction[], key: string, fallback: string): string {
  const action = actions.find(item => item.key === key)
  return action ? actionCaption(action) : fallback
}

const PanelActions: ClientModule<PanelActionsProps, Local> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  let local = surface.state ?? { focus: '', externalFocus: props.focused }
  if (!surface.state || local.externalFocus !== props.focused) {
    local = { ...local, focus: '', externalFocus: props.focused }
    surface.setState(local)
  }
  surface.onKey(event => {
    const current = surface.state ?? local
    if (event.key === 'escape') {
      surface.setState({ ...current, focus: '' })
    } else if (event.key === 'tab' || event.key === 'left' || event.key === 'right') {
      const visible = props.actions.filter(action => !action.hidden)
      const index = visible.findIndex(action => action.key === (current.focus || props.focused))
      const delta = event.key === 'left' || event.shift ? -1 : 1
      const next = (index + delta + visible.length) % visible.length
      surface.setState({ ...current, focus: visible[next]?.key ?? '' })
    } else {
      const action = ['return', 'enter', 'space', ' '].includes(event.key)
        ? props.actions.find(item => item.key === (current.focus || props.focused))
        : props.actions.find(item => item.shortcut === event.key)
      if (action) surface.post({ panelAction: action.key })
    }
  })
  const activeFocus = local.focus || props.focused
  const actionScope = (key: string) => `${props.plugin ? `${props.plugin}-` : ''}action-${key}`
  const metaAction = props.actions.find(action => action.key === props.metaAction)
  const hintActions = props.actions.filter(action => !action.hidden || action.key === props.metaAction)
  return <Box flexDirection="column" height={1} width={surface.columns}>
    <Box key="header-actions" flexDirection="row" height={1} overflow="hidden">
      <Box flexShrink={1} overflow="hidden">
        <Text key="action-caption" bold color={props.accent} wrap="truncate-start">{activeFocus ? '' : props.title}</Text>
      </Box>
      {hintActions.map(action => {
        const isFocused = action.key === activeFocus
        return <Box
          key={`caption-${action.key}`}
          position="absolute"
          left={0}
          top={0}
          height={1}
          display={isFocused ? 'flex' : 'none'}
          hover={isFocused ? undefined : { scope: actionScope(action.key), display: 'flex' }}
          overflow="hidden"
        >
          <Text bold color={props.accent} wrap="truncate-end">{actionCaption(action)}</Text>
          {/* Хвост заголовка длиннее подписи закрывается пробелами, иначе он виден справа от неё. */}
          <Text>{' '.repeat(Math.max(0, labelCells(props.title) - labelCells(actionCaption(action))))}</Text>
        </Box>
      })}
      <Box flexGrow={1} />
      {props.meta ? <Text color={props.muted}>{props.meta + ' '}</Text> : null}
      {metaAction ? <Button key={metaAction.key} plain color={props.muted} dimColor={metaAction.dimColor} label={metaAction.label}
        hover={{ scope: actionScope(metaAction.key), color: props.accent, inverse: false }} onPress={() => surface.post({ panelAction: metaAction.key })} /> : null}
      <Box flexDirection="row" gap={2} flexShrink={0}>
        {props.actions.filter(action => !action.hidden && action.key !== props.metaAction).map(action => <Button key={action.key} plain color={props.muted} dimColor={action.dimColor}
          label={action.label} hover={{ scope: actionScope(action.key), color: props.accent, inverse: false }} onPress={() => surface.post({ panelAction: action.key })} />)}
      </Box>
      <Text> </Text>
    </Box>
  </Box>
}
export default PanelActions

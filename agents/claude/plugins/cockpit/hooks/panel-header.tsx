import type { ClientModule } from 'claude-code'
import PanelActions, { type PanelActionsProps } from './panel-actions'

export type HeaderPress = { id: number; key: string }
export type HeaderProps = PanelActionsProps & { generation: string; acknowledged: number }
type Local = NonNullable<Parameters<typeof PanelActions>[1]['state']> & { generation: string; sequence: number; pending: HeaderPress[] }

// post заменяет недоставленное сообщение того же кадра: отправляем все неподтверждённые действия.
const PanelHeader: ClientModule<HeaderProps, Local> = (props, surface) => {
  const held = surface.state
  // Новая загрузка hooks начинает собственную доставку, даже если Client сохранил локальное состояние.
  if (held && held.generation !== props.generation) {
    surface.setState({ ...held, generation: props.generation, sequence: props.acknowledged, pending: [] })
  } else if (held?.pending.some(item => item.id <= props.acknowledged)) {
    surface.setState({ ...held, pending: held.pending.filter(item => item.id > props.acknowledged) })
  }
  return PanelActions(props, {
    ...surface,
    get state() { return surface.state },
    setState(next) {
      const current = surface.state
      surface.setState({ ...next, generation: props.generation, sequence: current?.sequence ?? props.acknowledged, pending: current?.pending ?? [] })
    },
    post(data) {
      // Array.isArray не сужает readonly-массив JsonValue; читаем поле через структурный тип.
      const action = data && typeof data === 'object' && !Array.isArray(data) ? (data as { readonly panelAction?: unknown }).panelAction : undefined
      if (typeof action !== 'string') return
      const current = surface.state
      const id = Math.max(current?.sequence ?? 0, props.acknowledged) + 1
      const pending = [...(current?.pending ?? []).filter(item => item.id > props.acknowledged), { id, key: action }]
      surface.setState({ focus: '', externalFocus: props.focused, ...current, generation: props.generation, sequence: id, pending })
      surface.post({ generation: props.generation, panelActions: pending })
    },
  })
}
export default PanelHeader

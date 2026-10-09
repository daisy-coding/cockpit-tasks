import type { ClientElements, RenderElement } from 'claude-code'
import type { PanelAction } from './panel-actions'
import { labelCells } from './panel-actions'
import { HOVER_ANY, DEFAULT_THEME, roleColors } from './theme'

// Одна группа наведения для кнопки и подписи в шапке, без запрещённых знаков.
export function hoverScope(key: string): string {
  return `cockpit-action-${[...key].map(char => /[a-z0-9-]/u.test(char) ? char : `-${char.codePointAt(0)!.toString(16)}-`).join('')}`
}

// Цвет значка под курсором: не занят данными и читается на светлом и тёмном фоне терминала.
export const CARD_HOVER = HOVER_ANY

export type CardControls = { id: string; scope?: string; top: number; width: number; selected: boolean; actions: PanelAction[] }

export function frameActions(actions: PanelAction[], width: number): PanelAction[] {
  const visible: PanelAction[] = []
  let cells = 2
  for (const action of actions) {
    const next = cells + labelCells(action.label) + (visible.length ? 2 : 0)
    if (next > Math.max(0, width - 4)) break
    cells = next; visible.push(action)
  }
  return visible
}

// Родные кнопки поверх нижней линии Client: события и фокус обслуживает сам движок.
// Абсолютное положение сохраняет высоту карточки и оставляет её тело доступным для выбора.
export function drawCardControls(ui: Pick<ClientElements, 'Box' | 'Text' | 'Button'>, cards: CardControls[], width: number, height: number,
  accent: string, press: (key: string) => unknown, muted = roleColors(DEFAULT_THEME).muted): (RenderElement | null)[] {
  const { Box, Text, Button } = ui
  // Общего слоя на всю область карточек нет: он перехватывал бы наведение и клики по самим карточкам. Поверх лежат только группы кнопок.
  void width
  return cards.map(card => {
      const actions = frameActions(card.actions, card.width)
      if (!actions.length || card.top < 0 || card.top >= height) return null
      const cells = 2 + actions.reduce((sum, action) => sum + labelCells(action.label), 0) + 2 * Math.max(0, actions.length - 1)
      return <Box key={`card-action-frame-${card.id}`} position="absolute" top={card.top} left={card.width - cells - 2} width={cells} height={1} flexDirection="row"
        hover={card.scope ? { scope: card.scope, top: card.top } : undefined}>
        {/* Группа значков входит в группу наведения своей карточки: курсор над значком подсвечивает и её рамку.
            Движку нужно стилевое свойство в hover; top с тем же значением ничего не сдвигает. */}
        <Text> </Text>
        {/* Промежутки между кнопками — пробелы, а не пустота: пустой промежуток прозрачен, и под ним видна линия рамки. */}
        {actions.flatMap((action, index) => [
          ...(index ? [<Text key={`gap-${action.key}`}>{'  '}</Text>] : []),
          <Button key={action.key} plain label={action.label} color={muted}
            hover={{ scope: hoverScope(action.key), color: accent, inverse: false }} onPress={() => press(action.key)} />,
        ])}
        <Text> </Text>
      </Box>
  })
}

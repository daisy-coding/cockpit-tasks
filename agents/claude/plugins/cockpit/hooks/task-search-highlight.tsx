import type { ClientElements, RenderChildren } from 'claude-code'
import { cellWidth, graphemes } from './layout'
import type { TaskSearchRange } from './domain/task-search'

// Невыделенный текст наследует цвет названия карточки, выделенный получает только роль accent.
export function highlightSearch(ui: Pick<ClientElements, 'Text'>, text: string, ranges: TaskSearchRange[] | undefined, accent: string): RenderChildren {
  if (!ranges?.length) return text
  const { Text } = ui
  const pieces: { text: string; hit: boolean }[] = []
  let cell = 0
  for (const cluster of graphemes(text)) {
    const end = cell + cellWidth(cluster)
    const hit = ranges.some(range => range.start < end && range.end > cell)
    const last = pieces.at(-1)
    if (last?.hit === hit) last.text += cluster
    else pieces.push({ text: cluster, hit })
    cell = end
  }
  return pieces.map((piece, index) => piece.hit ? <Text key={`search-hit-${index}`} color={accent}>{piece.text}</Text> : piece.text)
}

import type { Mounted } from 'claude-code/testing'
import type { On, PromptEditInput } from 'claude-code'
import { expect } from 'claude-code/testing'
import { drawEditor, editorState, type EditorProps } from '../hooks/editor'
import { hoverColor } from '../hooks/theme'

type Drawing = Pick<Mounted<'terminal', 'Pane'>, 'find' | 'findAll'>

export function promptEditHost(on: On) {
  const edits: PromptEditInput[] = []
  on('prompt.edit', (_$, e) => {
    edits.push(e)
    return { text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }
  })
  return edits
}

export function pasted(inputText: string): PromptEditInput {
  return { origin: { kind: 'composer' }, text: 'Основная строка', cursor: 3, start: 3, end: 3, inputText }
}

// Тестовый ввод проходит через настоящий onKey клиентского модуля, а не через неработающий Input внутри Client.
export async function inputEditor(ui: Pick<Mounted<'terminal', 'Pane'>, 'key'>, target: { key: string; text: string; kind?: 'change' | 'submit' }) {
  await ui.key({ in: target.key, key: 'a', ctrl: true })
  await ui.key({ in: target.key, key: target.text || 'backspace' })
  if (target.kind !== 'change') await ui.key({ in: target.key, key: 'return' })
}

export async function findEditor(ui: Drawing, query: Parameters<Drawing['find']>[0]) {
  const direct = await ui.find(query)
  if (direct !== undefined || query.in) return direct
  for (const client of await ui.findAll({ type: 'Client' })) {
    const key = String(client.props.key)
    if (key === 'new-task' || key === 'owner-answer-input' || /^page-(?:description|comment):/u.test(key)) {
      const found = await ui.find({ ...query, in: key })
      if (found !== undefined) return found
    }
  }
  return undefined
}

// FoundElement не переносит hover из клиентских элементов. Проверяем полный дескриптор,
// который общий отрисовщик отдаёт движку, тем же приёмом, что в cards.test.tsx.
export function expectEditorHover(props: EditorProps) {
  type Node = { type: string; props: { children?: unknown; key?: string; hover?: { inverse?: boolean; color?: string; scope?: string }; top?: number } }
  const ui = Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, (props: unknown) => ({ type, props })])) as unknown as Parameters<typeof drawEditor>[0]
  const tree = drawEditor(ui, props, editorState(props), () => {})
  const nodes = (value: unknown): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'type' in value
    ? [value as Node, ...nodes((value as Node).props.children)] : []
  const all = nodes(tree)
  const buttons = all.filter(node => node.type === 'Button')
  expect(buttons).toHaveLength(props.actions.length + 1)
  for (const button of buttons) {
    expect(button.props.hover?.inverse).toBe(false)
    expect(button.props.hover?.color).toBe(hoverColor(props.theme))
    expect(button.props.hover?.scope).toMatch(/^[a-z0-9-]+$/u)
    if (button.props.key !== `${props.frame}-enter`) {
      const caption = all.find(node => node.props.key === `caption-${button.props.key}`)
      expect(caption?.props.hover?.scope).toBe(button.props.hover?.scope)
    }
  }
  const group = all.find(node => node.props.key === `card-action-frame-${props.id}`)
  expect(group?.props.top).toBe(props.height - 1)
  for (const node of all) if (node.props.hover?.scope) expect(node.props.hover.scope.length).toBeLessThanOrEqual(64)
}

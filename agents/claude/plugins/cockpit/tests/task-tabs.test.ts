import { expect, test } from 'claude-code/testing'
import { fitTabs, tabSpans, type TabParts } from '../hooks/task-tabs'
import { cellWidth } from '../hooks/layout'
import { TASK_TAB_ICONS } from '../hooks/icons'

const parts = (active: string, icons = true): TabParts[] => [
  { id: 'agent', icon: icons ? TASK_TAB_ICONS.agent : '', name: 'Агенту', count: '18', active: active === 'agent', attention: false },
  { id: 'owner', icon: icons ? TASK_TAB_ICONS.owner : '', name: 'Мне', count: '3 ●', active: active === 'owner', attention: true },
  { id: 'backlog', icon: icons ? TASK_TAB_ICONS.backlog : '', name: 'Бэклог', count: '1', active: active === 'backlog', attention: false },
  { id: 'history', icon: icons ? TASK_TAB_ICONS.history : '', name: 'История', count: '100', active: active === 'history', attention: false },
]
// Ширина строки вкладок без отступов: названия и по одному пробелу между вкладками.
const rowWidth = (labels: string[]) => labels.reduce((sum, label) => sum + cellWidth(label), 0) + labels.length - 1
const labelsAt = (active: string, width: number, icons = true) => fitTabs(parts(active, icons), width).map(tab => tab.label)
const FULL = [`${TASK_TAB_ICONS.agent} Агенту 18`, `${TASK_TAB_ICONS.owner} Мне 3 ●`, `${TASK_TAB_ICONS.backlog} Бэклог 1`, `${TASK_TAB_ICONS.history} История 100`]

test('Вкладки панели: значок, название и счётчик, пока названия входят в ширину', () => {
  expect(labelsAt('agent', 84)).toEqual(FULL)
  expect(rowWidth(FULL)).toBe(46)
  // Ровно на своей ширине строка остаётся полной, отступы убирает tabSpans.
  expect(labelsAt('agent', 46)).toEqual(FULL)
  expect(tabSpans({ tabs: fitTabs(parts('agent'), 46), width: 46 }).map(span => span.padding)).toEqual([0, 0, 0, 0])
  expect(tabSpans({ tabs: fitTabs(parts('agent'), 84), width: 84 }).map(span => span.padding)).toEqual([1, 1, 1, 1])
})

test('На узкой панели неактивные вкладки остаются значком со счётчиком, название читается у активной', () => {
  for (const active of ['agent', 'owner', 'backlog', 'history']) {
    const tabs = fitTabs(parts(active), 45)
    for (const tab of tabs) {
      const part = parts(active).find(item => item.id === tab.id)!
      expect(tab.label).toBe(tab.active ? `${part.icon} ${part.name} ${part.count}` : `${part.icon} ${part.count}`)
      expect([tab.active, tab.attention]).toEqual([part.active, part.attention])
    }
    const spans = tabSpans({ tabs, width: 45 })
    expect(spans.at(-1)!.left + spans.at(-1)!.cells).toBeLessThanOrEqual(45)
  }
  expect(labelsAt('history', 28)).toEqual([`${TASK_TAB_ICONS.agent} 18`, `${TASK_TAB_ICONS.owner} 3 ●`, `${TASK_TAB_ICONS.backlog} 1`, `${TASK_TAB_ICONS.history} История 100`])
})

test('На самой узкой панели все вкладки — значок со счётчиком', () => {
  const short = [`${TASK_TAB_ICONS.agent} 18`, `${TASK_TAB_ICONS.owner} 3 ●`, `${TASK_TAB_ICONS.backlog} 1`, `${TASK_TAB_ICONS.history} 100`]
  expect(labelsAt('history', 27)).toEqual(short)
  expect(rowWidth(short)).toBe(20)
  expect(labelsAt('history', 12)).toEqual(short)
})

test('Без значков название не убирается ни на какой ширине', () => {
  const names = ['Агенту 18', 'Мне 3 ●', 'Бэклог 1', 'История 100']
  for (const width of [84, 36, 20, 5]) expect(labelsAt('agent', width, false)).toEqual(names)
})

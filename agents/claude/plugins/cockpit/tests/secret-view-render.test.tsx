import { expect, test } from 'claude-code/testing'
import { newSearchPanel, searchRows } from '../hooks/task-search-panel'
import { drawTaskCards } from '../hooks/task-cards'
import type { TaskView } from '../hooks/tasks'
import { DEFAULT_THEME } from '../hooks/theme'
import { seeded, TASK } from './fixtures'

// Исполняется настоящий путь панели поиска: очистка полей, строки всех карточек,
// подсветка совпадений и дерево отрисовки. I/O хоста и транспорт в метрику не входят.
test('Отрисовка панели: 300 задач, лучший из трёх прогретых замеров', () => {
  const tasks = Array.from({ length: 300 }, (_, index) => ({ ...TASK, taskId: `render-${index}`, alias: `TASK-${index + 1}`,
    title: `Проверить карточку ${index}: перенос текста и поля панели`, description: `Карточка ${index}\nСохранить подробное описание` }))
  const state = seeded(null)
  state.snapshot!.tasks = tasks
  const panel = newSearchPanel()
  panel.query = panel.shownQuery = 'карточку'
  panel.lists.queue = { total: 300, next: 300, exhausted: true, rows: tasks.map(item => ({ ...item, priorityPinned: false,
    match: { field: 'title', snippet: item.title } })) }
  const view: TaskView = { cursor: '', offset: 0, limit: 300, expanded: new Set(), collapsed: new Set() }
  const ui = {
    Box: (props: Record<string, unknown>) => ({ type: 'Box', props }),
    Text: (props: Record<string, unknown>) => ({ type: 'Text', props }),
    Button: (props: Record<string, unknown>) => ({ type: 'Button', props }),
  } as unknown as Parameters<typeof drawTaskCards>[0]
  const render = () => {
    const rows = searchRows(panel, state, view, 'agent', 100, 0, 0)
    const totalHeight = rows.reduce((total, row) => total + row.height, 0)
    const tree = drawTaskCards(ui, { rows, theme: DEFAULT_THEME, width: 100, height: totalHeight, top: 0, totalHeight, offset: 0 }, () => undefined)
    return { count: rows.filter(row => row.kind === 'card').length, tree }
  }
  for (let warm = 0; warm < 3; warm++) expect(render().count).toBe(300)
  const samples: number[] = []
  for (let run = 0; run < 3; run++) {
    const start = performance.now()
    const result = render()
    samples.push(performance.now() - start)
    expect(result.count).toBe(300)
    expect(result.tree).toBeDefined()
  }
  console.log(JSON.stringify({ benchmark: 'cockpit-search-panel-300', samplesMs: samples, bestMs: Math.min(...samples) }))
})

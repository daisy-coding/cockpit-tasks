import assert from 'node:assert/strict'
import { bandRow, moveCursor, rowsProps, taskProgress, taskRows, sourceIcon } from '../hooks/tasks.ts'
import { cellWidth } from '../hooks/layout.ts'
import { initialProjection } from '../hooks/domain/projection.ts'
import { parseResponse } from '../hooks/domain/rpc.ts'
import { resumeDraft } from '../hooks/domain/recovery.ts'
import { DEFAULT_THEME, roleColors } from '../hooks/theme.ts'

// Чистая модель карточек: проверка не запускает UI-хост и не пишет вне worktree.
const at = Date.parse('2026-10-05T12:00:00Z')
const task = { taskId: 'task-1', alias: 'TASK-1', title: 'Проверить задачи 👩‍💻 и очередь', status: 'active', revision: 0,
  projectId: 'p-1', worktreeId: 'w-1', origin: 'no-source', source: null,
  certainty: 'confirmed', certaintySource: 'user', certaintyProvenance: 'panel', createdAt: '2026-10-05T11:00:00.000000Z', updatedAt: '2026-10-05T11:00:00.000000Z',
  elapsedMs: 0, activeSince: '2026-10-05T11:40:00.000000Z', queuePosition: 1,
  sourcePhrase: 'Собери панель задач', lastCheckpoint: { checkpointId: 'cp-1', taskId: 'task-1', kind: 'note', text: 'Ряды собраны', source: 'user', provenance: 'panel', createdAt: '2026-10-05T11:50:00.000000Z' },
  steps: [{ position: 0, title: 'Собрать', status: 'done' }, { position: 1, title: 'Проверить', status: 'active' }, { position: 2, title: 'Документировать', status: 'pending' }], needsDecision: false, deleted: false }
const clone = (id, fields = {}) => ({ ...task, taskId: id, alias: `TASK-${id.slice(-1)}`, title: `Задача ${id}`, sourcePhrase: null, lastCheckpoint: null, activeSince: null, steps: [], ...fields })
const state = { ...initialProjection(), focus: { task, revision: 1 }, snapshot: {
  schemaVersion: 1, storageSchemaVersion: 6, binding: { projectId: 'p-1', worktreeId: 'w-1', sessionId: 's-1' },
  focus: { task, revision: 1 }, tasks: [task, clone('task-2', { queuePosition: 2 }), clone('task-3', { status: 'paused' }), clone('task-4', { status: 'done' }), clone('task-5'), clone('task-6', { needsDecision: true })],
  focusStack: [{ taskId: 'task-5', depth: 1, provenance: 'panel' }], inbox: [], inboxCounts: { total: 0, untriaged: 0 }, inboxTriageCounts: { untriaged: 0, blocking: 0 }, captureMode: 'full-local',
  gate: { mode: 'off', counts: { ALLOW: 0, BIND: 0, BLOCK: 0 }, blockReasons: { 'foreign-lease': 0, 'stale-read': 0, 'blocking-inbox': 0, 'pending-decision': 0 } } } }
for (const width of [24, 40, 60, 100]) {
  const view = { cursor: 'task:task-1', expanded: new Set(['task-1']), collapsed: new Set(['done']), offset: 0, limit: 8 }
  const rows = taskRows(state, view, width, at)
  assert.deepEqual(rows.filter(row => row.kind === 'heading').map(row => row.group), ['now', 'queue'])
  assert(!rows.some(row => row.id === 'task:task-4'))
  assert(!rows.some(row => row.id === 'task:task-3'))
  const backlog = taskRows(state, view, width, at, DEFAULT_THEME, 'backlog')
  assert.deepEqual(backlog.map(row => row.taskId), ['task-3'])
  assert.equal(backlog[0].number, '#3')
  assert.equal(backlog[0].width, width - 2)
  const cards = rows.filter(row => row.kind === 'card')
  assert.equal(cards.length, 4)
  assert.deepEqual(cards.map(card => card.taskId), ['task-1', 'task-5', 'task-6', 'task-2'])
  assert.deepEqual(cards.find(row => row.taskId === task.taskId).steps, [])
  for (const card of cards) {
    assert.equal(card.width, width - 2)
    for (const line of card.lines) assert(cellWidth(line) <= card.innerWidth, `${width}: ${card.id}: ${line}`)
    assert.equal(card.actions.length, 0)
    assert(card.titleLines.length >= 1 && card.titleLines.length <= 4)
    assert.equal(card.gutterWidth, 0)
    assert.equal(card.textWidth, card.innerWidth)
    assert(card.actions.every(action => /\p{L}/u.test(action.label)))
    assert(!card.lines.join('').includes('·'))
    assert(!card.lines.join('').includes('0/0'))
    assert.equal(card.borderColor, card.taskId === 'task-1' ? roleColors(DEFAULT_THEME).work : roleColors(DEFAULT_THEME).muted)
    assert.equal(card.borderDimColor, card.taskId !== 'task-1')
  }
  const props = rowsProps(rows, view)
  assert.equal(props.totalHeight, rows.reduce((sum, row) => sum + row.height, 0))
  moveCursor(rows, view, 'end')
  assert.equal(view.cursor, 'task:task-2')
  assert(view.offset > 0)
  const band = bandRow(state, width, at)
  assert(!band.left.some(seg => seg.spin || seg.sh))
  assert(!band.left.some(seg => seg.t.includes('▣')))
  assert(cellWidth(band.left.map(seg => seg.t).join('')) + cellWidth(band.right.map(seg => seg.t).join('')) <= width, `band ${width}`)
  if (width >= 40) assert(band.right.some(seg => seg.t.includes('в очереди 1')))
}
for (const source of ['user', 'provider']) for (const mode of ['nerd', 'unicode']) assert.equal(cellWidth(sourceIcon({ ...task, certaintySource: source }, mode)), 1)
assert.equal(bandRow({ ...state, focus: null }, 80, at), null)
assert.equal(taskProgress({ ...task, steps: [] }), null)
assert(!bandRow({ ...state, focus: { task: { ...task, steps: [] }, revision: 1 } }, 80, at).right.some(seg => seg.t.includes('%')))
const parsed = parseResponse('snapshot', JSON.stringify({ v: 1, ok: true, result: state.snapshot }))
assert.equal(parsed.kind, 'snapshot')
assert.equal(parsed.snapshot.tasks[0].steps[1].status, 'active')
const expanded = { ...task, description: '<pasted_content>Описание</pasted_content>', acceptance: ['Готово'],
  constraints: ['Не трогать UI'], assignee: 'codex', priority: 1, prioritySource: 'user', priorityPinned: true }
const newCard = parseResponse('task.get', JSON.stringify({ v: 1, ok: true, result: { task: expanded } }))
assert.equal(newCard.kind, 'task')
assert.equal(newCard.task.description, 'Описание')
assert.deepEqual(newCard.task.acceptance, ['Готово'])
assert.equal(newCard.task.priority, 1)
const versionSeven = parseResponse('snapshot', JSON.stringify({ v: 1, ok: true, result: { ...state.snapshot,
  storageSchemaVersion: 7, queue: 'paused' } }))
assert.equal(versionSeven.kind, 'snapshot')
assert.equal(versionSeven.snapshot.queue, 'paused')
assert.equal(parseResponse('task.get', JSON.stringify({ v: 1, ok: true, result: { task: { ...task, assignee: ['codex'] } } })).kind, 'unknown')
assert.equal(parseResponse('tasks.rank', JSON.stringify({ v: 1, ok: true, result: { changed: [], skipped: [{ taskId: task.taskId, reason: ['pinned'] }] } })).kind, 'unknown')
const malformed = { ...state.snapshot, tasks: [{ ...task, steps: [{ position: 7, title: 'Чужой порядок', status: 'active' }] }] }
assert.equal(parseResponse('snapshot', JSON.stringify({ v: 1, ok: true, result: malformed })).kind, 'unknown')
const draft = resumeDraft(task)
assert(draft.includes('Сделано (1): Собрать'))
assert(draft.includes('Последняя контрольная точка: Ряды собраны'))
assert(draft.includes('Следующий шаг: Проверить'))
assert.equal(resumeDraft({ ...task, lastCheckpoint: null }), null)
assert.equal(resumeDraft({ ...task, status: 'paused' }), null)
console.log('tasks-check: карточки, группы, шаги, действия, ширины 24/40/60/100, навигация, полоса и RPC проверены')

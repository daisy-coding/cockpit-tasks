import { expect, test } from 'claude-code/testing'
import { acceptTaskList, invalidateTaskLists, newTaskListPages } from '../hooks/tasks'
import type { TaskPage } from '../types/index'

const page = (offset: number, ids: number[]): TaskPage => ({ list: 'queue', offset, total: 300, tasks: ids.map(number => ({
  taskId: `page-${number}`, alias: `TASK-${number}`, title: 'Проверить очередь', status: 'active', priorityPinned: false,
  updatedAt: '2026-10-08T00:00:00.000000Z', revision: 1,
})) })
test('Страницы: одинаковые taskId при изменении очереди не дублируются, старое поколение отвергается', () => {
  const lists = newTaskListPages()
  expect(acceptTaskList(lists, page(0, [1, 2]), 0)).toBe(true)
  expect(acceptTaskList(lists, page(2, [2, 3]), 0)).toBe(true)
  expect(lists.queue.rows.map(task => task.taskId)).toEqual(['page-1', 'page-2', 'page-3'])
  invalidateTaskLists(lists)
  expect(acceptTaskList(lists, page(4, [4]), 0)).toBe(false)
  expect(acceptTaskList(lists, page(0, [3, 1]), 1)).toBe(true)
  expect(lists.queue.rows.map(task => task.taskId)).toEqual(['page-3', 'page-1'])
})

test('Страницы: обновление дальнего окна и чтение назад сохраняют непрерывный диапазон', () => {
  const lists = newTaskListPages()
  acceptTaskList(lists, page(0, [1, 2]), 0)
  invalidateTaskLists(lists)
  lists.queue.loading.add(200)
  expect(acceptTaskList(lists, page(200, [201, 202]), 1)).toBe(true)
  expect([lists.queue.base, lists.queue.next]).toEqual([200, 202])
  expect(acceptTaskList(lists, page(198, [199, 200]), 1)).toBe(true)
  expect(acceptTaskList(lists, page(202, [203, 204]), 1)).toBe(true)
  expect(lists.queue.rows.map(task => task.taskId)).toEqual(['page-199', 'page-200', 'page-201', 'page-202', 'page-203', 'page-204'])
  expect([lists.queue.base, lists.queue.next]).toEqual([198, 204])
  expect(acceptTaskList(lists, page(190, [191]), 1)).toBe(false)
  invalidateTaskLists(lists)
  expect(acceptTaskList(lists, page(204, [205]), 1)).toBe(false)
})

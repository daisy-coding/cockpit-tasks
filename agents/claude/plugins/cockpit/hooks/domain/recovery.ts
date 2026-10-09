import type { TaskSummary } from '../../types/index'

export function resumeDraft(task: TaskSummary): string | null {
  if (task.status !== 'active' || task.deleted || !task.lastCheckpoint) return null
  const done = (task.steps ?? []).filter(step => step.status === 'done').map(step => step.title)
  const next = (task.steps ?? []).find(step => step.status === 'active') ?? (task.steps ?? []).find(step => step.status === 'pending')
  const short = (value: string, limit: number) => [...value].length <= limit ? value : [...value].slice(0, limit - 1).join('') + '…'
  return [`Продолжим задачу: ${short(task.title, 200)}.`,
    ...(done.length ? [`Сделано (${done.length}): ${short(done.join('; '), 300)}.`] : []),
    `Последняя контрольная точка: ${short(task.lastCheckpoint.text, 400)}.`,
    next ? `Следующий шаг: ${short(next.title, 160)}.` : 'Продолжи от этой контрольной точки.'].join('\n')
}

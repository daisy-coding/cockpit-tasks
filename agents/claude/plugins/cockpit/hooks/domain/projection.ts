import type { Projection } from '../../types/index'
import type { Outcome } from './rpc'

export function initialProjection(): Projection {
  return {
    snapshot: null, focus: null, captureMode: null,
    connection: { status: 'idle', detail: 'Связь ещё не проверена.' },
    counters: { requests: 0, failures: 0, captures: 0 }, contextPercent: null, timeline: null, gate: null, panelProvenance: 'cli', attestationStatus: 'unconfirmed',
  }
}

export function reduceProjection(state: Projection, outcome: Outcome, optional = false): Projection {
  const counters = { ...state.counters, requests: state.counters.requests + 1 }
  if (outcome.kind === 'unknown' || outcome.kind === 'unavailable' || outcome.kind === 'error') {
    counters.failures += 1
    // Отказ явного необязательного действия не доказывает потерю связи.
    if (optional) return { ...state, counters }
    return {
      ...state, counters,
      connection: outcome.kind === 'unavailable'
        ? { status: 'unavailable', detail: 'Рантайм недоступен. Проверьте Python и повторите sh install.sh из каталога Cockpit.' }
        : { status: 'degraded', detail: outcome.kind === 'error'
          ? `Рантайм отклонил запрос (${outcome.code}).`
          : 'Связь нарушена; исход запроса неизвестен.' },
    }
  }
  const next = { ...state, counters, connection: { status: 'ready' as const, detail: 'Рантайм доступен.' } }
  if (outcome.kind === 'snapshot') return { ...next, snapshot: outcome.snapshot, focus: outcome.snapshot.focus, captureMode: outcome.snapshot.captureMode, gate: outcome.snapshot.gate }
  if (outcome.kind === 'gated') {
    const currentTotal = next.gate ? Object.values(next.gate.counts).reduce((sum, count) => sum + count, 0) : 0
    const incomingTotal = Object.values(outcome.gate.counts).reduce((sum, count) => sum + count, 0)
    const stale = next.focus && (next.focus.revision > outcome.focusRevision
      || (outcome.task !== null && next.focus.task?.taskId === outcome.task.taskId && next.focus.task.revision > outcome.task.revision))
    return { ...next, focus: stale ? next.focus : { task: outcome.task, revision: outcome.focusRevision },
      gate: incomingTotal < currentTotal && next.gate?.mode === outcome.gate.mode ? next.gate : outcome.gate }
  }
  if (outcome.kind === 'bound') return { ...next, focus: { task: outcome.task, revision: outcome.focusRevision } }
  if (outcome.kind === 'task-changed' || outcome.kind === 'agent-acted') return { ...next, focus: outcome.focus,
    snapshot: next.snapshot ? { ...next.snapshot, focus: outcome.focus, tasks: outcome.task.deleted
      ? next.snapshot.tasks.filter(task => task.taskId !== outcome.task.taskId)
      : [...next.snapshot.tasks.filter(task => task.taskId !== outcome.task.taskId), outcome.task] } : null }
  if (outcome.kind === 'updated' && next.focus?.task?.taskId === outcome.task.taskId) return { ...next, focus: { ...next.focus, task: outcome.task } }
  if (outcome.kind === 'confirmed' && next.focus?.task?.taskId === outcome.task.taskId && next.focus.task.revision <= outcome.task.revision) return { ...next, focus: { ...next.focus, task: outcome.task } }
  if (outcome.kind === 'triaged' && next.snapshot) return { ...next, snapshot: { ...next.snapshot, inbox: next.snapshot.inbox.map(entry => entry.inboxId === outcome.entry.inboxId && entry.triageRevision <= outcome.entry.triageRevision ? outcome.entry : entry) } }
  if (outcome.kind === 'timeline') return { ...next, timeline: { taskId: outcome.taskId, taskRevision: outcome.taskRevision, checkpoints: outcome.checkpoints.slice(0, 5), status: 'ready' } }
  if (outcome.kind === 'noted') {
    const task = next.focus?.task
    return {
      ...next,
      focus: task?.taskId === outcome.checkpoint.taskId && next.focus && task.revision <= outcome.taskRevision ? { ...next.focus, task: { ...task, revision: outcome.taskRevision } } : next.focus,
      // Не выдаём одну новую отметку за полную ленту, если её ещё не читали.
      timeline: next.timeline?.status === 'ready' && next.timeline.taskId === outcome.checkpoint.taskId
        && next.timeline.taskRevision === outcome.taskRevision - 1
        ? { ...next.timeline, taskRevision: outcome.taskRevision, checkpoints: [outcome.checkpoint, ...next.timeline.checkpoints.filter(entry => entry.checkpointId !== outcome.checkpoint.checkpointId)].slice(0, 5) }
        : next.timeline,
    }
  }
  if (outcome.kind === 'detoured' || outcome.kind === 'returned') {
    // Сохранённый ответ идемпотентного повтора может быть старше snapshot.
    if (next.focus && (next.focus.revision > outcome.focus.revision
      || (next.focus.task?.taskId === outcome.focus.task?.taskId && (next.focus.task?.revision ?? 0) > (outcome.focus.task?.revision ?? 0)))) return next
    if (outcome.kind === 'detoured') return { ...next, focus: outcome.focus, timeline: null }
    return { ...next, focus: outcome.focus, timeline: {
      taskId: outcome.returnPacket.taskId, taskRevision: outcome.focus.task?.revision ?? 0, checkpoints: outcome.returnPacket.checkpoints, status: 'ready',
    } }
  }
  if (outcome.kind === 'captured') return { ...next, captureMode: outcome.captureMode, counters: { ...counters, captures: counters.captures + 1 } }
  return next
}

export function contextPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}

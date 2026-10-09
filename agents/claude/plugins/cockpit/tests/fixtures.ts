import type { Checkpoint, Doctor, GateMode, GateObservation, GateSummary, InboxPreview, Projection, Snapshot, Task } from '../types/index'
import type { Request } from '../hooks/domain/rpc'
import { initialProjection, reduceProjection } from '../hooks/domain/projection'

export const TASK: Task = {
  taskId: 'task-1', projectId: 'project-1', worktreeId: 'worktree-1', alias: 'TASK-1',
  title: 'Проверить мод', status: 'active', revision: 3, origin: 'ad-hoc',
  certainty: 'observed', certaintySource: 'engine', certaintyProvenance: 'cli',
  createdAt: '2026-10-04T12:00:00.000001Z', updatedAt: '2026-10-04T12:00:00.000001Z',
  source: { inboxId: 'inbox-1', start: 0, end: 20, sha256: 'a'.repeat(64) },
}

export const ENTRY: InboxPreview = {
  inboxId: 'inbox-1', capturedAt: TASK.createdAt, length: 20, preview: 'Подтверждённый preview',
  type: 'info', classifiedBy: 'rule', scope: { taskId: null, resourceId: null },
  policyVersion: 'rule-1', confidence: null, mode: 'active', observedAt: TASK.createdAt,
  triageStatus: 'untriaged', triageRevision: 1, provenance: 'cli', triageProvenance: 'cli',
}

export const CHECKPOINT: Checkpoint = {
  checkpointId: 'mark-1', taskId: TASK.taskId, kind: 'note', text: 'Отфильтрованная отметка', source: 'user', createdAt: TASK.createdAt, provenance: 'cli',
}

export function gateSummary(mode: GateMode = 'off'): GateSummary {
  return { mode, counts: { ALLOW: 0, BIND: 0, BLOCK: 0 },
    blockReasons: { 'foreign-lease': 0, 'stale-read': 0, 'blocking-inbox': 0, 'pending-decision': 0 } }
}

export const OBSERVATION: GateObservation = {
  observationId: 1, outcome: 'BIND', reasons: [], taskId: TASK.taskId,
  resource: { resourceId: 'path-' + 'a'.repeat(64), path: 'file.ts' }, sessionId: 'fixture-session', observedAt: TASK.createdAt,
}

export function snapshot(task: Task | null = TASK, gate: GateMode = 'off'): Snapshot {
  return {
    schemaVersion: 1, storageSchemaVersion: 5, binding: { projectId: 'project-1', worktreeId: 'worktree-1', sessionId: 'fixture-session' },
    focus: { task, revision: task === null ? 0 : 2 }, captureMode: 'full-local',
    inboxCounts: { total: 2, untriaged: 2 },
    inboxTriageCounts: { untriaged: 2, blocking: 0 },
    tasks: task === null ? [] : [{ taskId: task.taskId, alias: task.alias, title: task.title, status: task.status, revision: task.revision, certainty: task.certainty, certaintySource: task.certaintySource, certaintyProvenance: task.certaintyProvenance }],
    focusStack: [],
    inbox: [ENTRY],
    gate: gateSummary(gate),
  }
}

export function seeded(task: Task | null = TASK, gate: GateMode = 'off'): Projection {
  return reduceProjection(initialProjection(), { kind: 'snapshot', snapshot: snapshot(task, gate) })
}

export const DOCTOR: Doctor = {
  schemaVersion: 1, storageSchemaVersion: 5, integrityCheck: ['ok'], foreignKeyCheck: [],
  permissions: {
    directory: { present: true, mode: '0700', ok: true },
    files: {
      'cockpit.db': { present: true, mode: '0600', ok: true },
      'cockpit.db-wal': { present: false, mode: null, ok: true },
      'cockpit.db-shm': { present: false, mode: null, ok: true },
    },
  },
  counts: { projects: 1, worktrees: 1, sessions: 1, inbox: 2, tasks: 1, task_sources: 1, focus: 1, events: 4, requests: 4, config: 1, inbox_observations: 1, checkpoints: 0, focus_stack: 0, project_config: 0, worktree_leases: 0, gate_observations: 0, session_attestations: 0 },
}

export function reply(request: Request): string {
  let result: unknown
  const provenance = request.panelSecret === undefined ? 'cli' : 'panel'
  switch (request.op) {
    case 'capture.prompt': result = { captured: true, inboxId: 'inbox-2', captureMode: 'full-local' }; break
    case 'task.bind': result = { bound: 'created', task: TASK, focusRevision: 2 }; break
    case 'gate.check': result = { bound: 'created', task: TASK, focusRevision: 2, gate: gateSummary('observe'), observation: OBSERVATION }; break
    case 'session.end': result = { released: 1 }; break
    case 'task.update': result = { task: { ...TASK, status: request.args.status ?? TASK.status, title: request.args.title ?? TASK.title, revision: request.args.expectedRevision + 1 } }; break
    case 'task.confirm': result = { task: { ...TASK, certainty: 'confirmed', certaintySource: 'user', certaintyProvenance: provenance, revision: request.args.expectedRevision + 1 } }; break
    case 'checkpoint.add': result = { checkpoint: { ...CHECKPOINT, provenance }, taskRevision: request.args.expectedRevision + 1 }; break
    case 'checkpoint.list': result = { taskId: request.args.taskId, taskRevision: request.args.expectedRevision ?? TASK.revision, checkpoints: [CHECKPOINT] }; break
    case 'inbox.triage': result = { ...ENTRY, inboxId: request.args.inboxId, type: request.args.type === undefined ? ENTRY.type : request.args.type, triageStatus: request.args.status ?? ENTRY.triageStatus,
      scope: { taskId: request.args.taskId ?? null, resourceId: null }, classifiedBy: 'user', policyVersion: 'user-1', triageRevision: request.args.expectedRevision + 1, provenance, triageProvenance: provenance }; break
    case 'focus.detour': result = { focus: { task: { ...TASK, taskId: 'detour-1', alias: 'TASK-2', title: 'Отфильтрованный отход', certainty: 'confirmed', certaintySource: 'user', certaintyProvenance: provenance, revision: 0 }, revision: request.args.expectedRevision + 1 }, stackDepth: 1, checkpoint: { ...CHECKPOINT, kind: 'detour', provenance } }; break
    case 'focus.return': result = { focus: { task: TASK, revision: request.args.expectedRevision + 1 }, stackDepth: 0, checkpoint: { ...CHECKPOINT, kind: 'return', provenance }, returnPacket: { taskId: TASK.taskId, title: TASK.title, checkpoints: [CHECKPOINT], inbox: [ENTRY] } }; break
    case 'session.attest': result = { attested: true }; break
    case 'config.get': case 'config.set': result = { key: 'gate', value: request.op === 'config.set' ? request.args.value : 'off', provenance }; break
    case 'snapshot': case 'session.rebind': result = snapshot(); break
    case 'doctor': result = DOCTOR; break
  }
  return JSON.stringify({ v: 1, ok: true, result })
}

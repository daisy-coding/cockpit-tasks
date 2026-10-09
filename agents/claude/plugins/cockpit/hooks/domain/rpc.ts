import type { CaptureMode, Certainty, Checkpoint, CheckpointKind, Doctor, Focus, GateObservation, GateReason, GateSummary, InboxPreview, InboxType, Provenance, RebindReason, ReturnPacket, Snapshot, SourceKind, Task, TaskStatus, TaskSummary, TriageStatus } from '../../types/index'
import { redactSecrets, stripPastedContent } from './privacy.ts'
import type { Actor, DismissReason, ExtractionCode, ExtractionStats, QueueMode, TaskFields, TaskRankResult } from '../../types/index'
import type { AgentTaskActionArgs, AgentTaskNote, AgentTaskReference, OwnerComment, OwnerTaskChangeAction, TaskContext, TaskContextEntry } from '../../types/index'
import type { TaskPage, TaskPageEntry, TaskPageList, TaskResolution, TaskSearch, TaskSearchPage } from '../../types/index'

export interface Session {
  sessionId: string
  cwd: string
}

export interface OperationArgs {
  'capture.prompt': { text: string; kind: 'prompt' }
  'task.bind': { reason?: string; resourcePath?: string; staleRead?: boolean }
  'gate.check': { resourcePath: string; staleRead: boolean }
  'session.end': Record<string, never>
  'inbox.get': { inboxId: string }
  'inbox.material': { inboxId: string }
  'candidate.adopt': { taskId: string; expectedRevision: number }
  'candidate.dismiss': { taskIds: string[]; reason: Exclude<DismissReason, 'expired'> }
  'snapshot': { limits?: { tasks?: number; inbox?: number; preview?: number } }
  'focus.get': Record<string, never>
  'focus.set': { taskId: string; expectedRevision: number }
  'session.rebind': { reason: RebindReason; limits?: { tasks?: number; inbox?: number; preview?: number } }
  'session.attest': Record<string, never>
  'session.revoke': Record<string, never>
  'task.update': { taskId: string; expectedRevision: number } & ({ status: TaskStatus; title?: string } | { title: string; status?: TaskStatus })
  'task.get': { taskId: string }
  'task.comment.add': { taskId: string; text: string }
  'task.comment.edit': { taskId: string; commentId: string; expectedRevision: number; text: string }
  'task.comment.delete': { taskId: string; commentId: string; expectedRevision: number }
  'task.create': TaskFields & { title: string; steps?: string[] }
  'task.edit': TaskFields & { taskId: string; expectedRevision: number; pinned?: boolean }
  'tasks.rank': { items: { taskId: string; expectedRevision: number; priority: 0 | 1 | 2 | 3 }[]; source: 'model' | 'jev' }
  'task.action': { taskId: string; expectedRevision: number; expectedFocusRevision: number; action: 'current' | 'done' | 'defer' | 'restore' | 'up' | 'down' | 'delete' | 'step'; step?: number }
  'tasks.agent.create': { tasks: { title: string; description?: string; place?: 'top' | 'bottom' }[] }
  'tasks.agent.rank': { order: string[] }
  'task.agent.action': AgentTaskActionArgs
  'task.reopen': { taskId: string; expectedRevision: number; place?: 'top' | 'bottom'; comment?: string }
  'tasks.context': { cursor?: number }
  'tasks.page': { list: TaskPageList; offset: number; limit: number; preview?: number }
  'tasks.search': { query: string; lists?: TaskPageList[]; offset?: number; limit?: number }
  'task.resolve': { alias: string }
  'task.summary.claim': { taskId: string; expectedRevision: number }
  'task.summary.report': { taskId: string; descriptionHash: string; summary: string | null;
    metrics?: { durationMs: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } }
  'inbox.triage': { inboxId: string; expectedRevision: number; type?: InboxType | null; taskId?: string | null; resourceId?: string | null; status?: TriageStatus }
  'task.confirm': { taskId: string; expectedRevision: number }
  'checkpoint.add': { taskId: string; expectedRevision: number; kind: CheckpointKind; text: string; source?: SourceKind }
  'checkpoint.list': { taskId: string; expectedRevision?: number; limit?: number }
  'focus.detour': { expectedRevision: number } & ({ title: string; taskId?: never } | { taskId: string; title?: never })
  'focus.return': { expectedRevision: number }
  'doctor': Record<string, never>
  'config.get': { key: 'gate' | 'queue' }
  'config.set': { key: 'gate'; value: 'off' | 'observe' } | { key: 'queue'; value: QueueMode }
}

export type Operation = keyof OperationArgs
export type Request = { [K in Operation]: { v: 1; op: K; requestId: string; session: Session; args: OperationArgs[K]; panelSecret?: string; actor?: Actor } }[Operation]
export type ErrorCode = 'INVALID_REQUEST' | 'UNKNOWN_OP' | 'IDEMPOTENCY_CONFLICT' | 'REVISION_CONFLICT' | 'NOT_FOUND' | 'DB_UNAVAILABLE' | 'NOT_IMPLEMENTED' | 'ATTESTATION_FAILED' | 'ATTESTATION_CONFLICT' | 'TASK_LIMIT_REACHED'
export type AttestationReason = 'revoked' | 'unregistered' | 'mismatch' | 'stale-epoch' | 'expired' | 'module-reloaded' | 'other-copy' | 'ownership-lost'
export type Outcome =
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'focused'; focus: Focus }
  | { kind: 'bound'; bound: 'existing' | 'created' | 'created-no-source' | 'unbound'; task: Task | null; focusRevision: number }
  | { kind: 'gated'; bound: 'existing' | 'created' | 'created-no-source' | 'unbound'; task: Task | null; focusRevision: number; gate: GateSummary; observation: GateObservation | null }
  | { kind: 'released'; released: number }
  | { kind: 'inbox'; inboxId: string; text: string | null }
  | { kind: 'material'; inboxId: string; material: string | null }
  | { kind: 'adopted'; task: Task }
  | { kind: 'dismissed'; dismissed: string[]; skipped: string[] }
  | { kind: 'updated'; task: Task }
  | ({ kind: 'ranked' } & TaskRankResult)
  | { kind: 'task'; task: Task; comments?: OwnerComment[]; agentNotes?: AgentTaskNote[] }
  | { kind: 'owner-commented' | 'owner-comment-edited'; taskId: string; comment: OwnerComment }
  | { kind: 'owner-comment-deleted'; taskId: string; commentId: string; revision: number; deleted: true }
  | { kind: 'task-changed'; task: Task; focus: Focus }
  | { kind: 'agent-created'; tasks: AgentTaskReference[] }
  | { kind: 'agent-ranked'; order: string[]; pinned: string[] }
  | { kind: 'agent-acted'; task: Task; focus: Focus; note: AgentTaskNote | null }
  | { kind: 'context'; context: TaskContext }
  | { kind: 'page'; page: TaskPage }
  | { kind: 'search'; search: TaskSearch }
  | { kind: 'resolved'; task: TaskResolution }
  | { kind: 'summary-claimed'; claimed: false }
  | { kind: 'summary-claimed'; claimed: true; descriptionHash: string; description: string }
  | { kind: 'summary-reported'; summary: string | null }
  | { kind: 'triaged'; entry: InboxPreview }
  | { kind: 'confirmed'; task: Task }
  | { kind: 'noted'; checkpoint: Checkpoint; taskRevision: number }
  | { kind: 'timeline'; taskId: string; taskRevision: number; checkpoints: Checkpoint[] }
  | { kind: 'detoured'; focus: Focus; stackDepth: number; checkpoint: Checkpoint }
  | { kind: 'returned'; focus: Focus; stackDepth: number; checkpoint: Checkpoint; returnPacket: ReturnPacket }
  | { kind: 'captured'; inboxId: string; captureMode: 'full-local' | 'off' }
  | { kind: 'doctor'; doctor: Doctor }
  | { kind: 'attested' }
  | { kind: 'revoked' }
  | { kind: 'configured'; key: 'gate'; value: 'off' | 'observe'; provenance: Provenance }
  | { kind: 'configured'; key: 'queue'; value: QueueMode; provenance: Provenance }
  | { kind: 'error'; code: ErrorCode; attestationReason?: AttestationReason }
  | { kind: 'unknown' }
  | { kind: 'unavailable' }

export function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value)
}

const OWNER_COMMENT_OPERATIONS: readonly Operation[] = ['task.comment.add', 'task.comment.edit', 'task.comment.delete']
export const HUMAN_WRITES: readonly Operation[] = ['inbox.triage', 'task.confirm', 'checkpoint.add', 'focus.detour', 'focus.return', 'focus.set', 'task.update', 'config.set', 'task.create', 'task.edit', 'task.action', 'tasks.rank', 'candidate.adopt', 'candidate.dismiss', 'task.reopen', 'task.summary.claim', 'task.summary.report', ...OWNER_COMMENT_OPERATIONS]
const TOOL_OPERATIONS: readonly Operation[] = ['snapshot', 'focus.get', 'task.get', 'inbox.get', 'inbox.material', 'checkpoint.list', 'config.get', 'doctor', 'tasks.agent.create', 'tasks.agent.rank', 'task.agent.action', 'tasks.context', 'tasks.page', 'task.resolve', 'tasks.search']

export function buildRequest<K extends Operation>(op: K, requestId: string, session: Session, args: OperationArgs[K], panelSecret?: string, actor?: Actor) {
  if (!validId(requestId) || !validId(session.sessionId) || !session.cwd.startsWith('/')) {
    // Не включаем входные значения в исключение: среди них может быть промпт.
    throw new Error('Некорректные идентификаторы или каталог RPC.')
  }
  if ((actor !== undefined && (panelSecret === undefined || !['owner', 'agent'].includes(actor)))
    || ((OWNER_COMMENT_OPERATIONS.includes(op) || op === 'session.revoke') && panelSecret === undefined)
    || (actor === 'agent' && !TOOL_OPERATIONS.includes(op))
    || (panelSecret !== undefined && ((!HUMAN_WRITES.includes(op) && op !== 'session.attest' && op !== 'session.revoke' && actor === undefined) || !/^[a-f0-9]{64}$/.test(panelSecret)))) {
    throw new Error('Недопустимое свидетельство или операция панели.')
  }
  return { v: 1 as const, op, requestId, session: { ...session }, args, ...(panelSecret === undefined ? {} : { panelSecret, actor: actor ?? 'owner' as const }) }
}

export function rebindReason(source: string): RebindReason {
  return source === 'resume' || source === 'clear' || source === 'compact' ? source : 'start'
}

// Указанием считается только собственное сообщение человека: Enter в терминале
// или сообщение через Remote Control. Уведомления фоновых задач, расписания,
// соседние сессии и плагины приходят тем же событием и в Inbox не попадают.
const HUMAN_ORIGINS: readonly string[] = ['composer', 'bridge']

export function shouldCapture(text: string, origin: string): boolean {
  return HUMAN_ORIGINS.includes(origin) && text.trim().length > 0 && !/^\s*\/(?:cockpit|tasks)(?:\s|$)/i.test(text)
}

// Разбор Inbox, подтверждение задачи, отметки, отход и возврат несут источник «user».
// Рантайм не отличает агента от человека под тем же пользователем, поэтому мод отклоняет
// агенту команды записи и исполнения рантайма; чтение исходников разрешено отдельно.
// Защита совещательная: текст команды читается не так, как его разберёт оболочка, и
// намеренный обход возможен. До режима блокировки стража записи человека подписывает мод.
// Тесты исполняются при разработке; прочие .py-файлы доступны только командам чтения.
const COCKPIT_REFERENCE = /cockpitctl|cockpit\.db|agents[.\\/]claude[.\\/]cockpit(?![\\/]tests[\\/])(?![\\/]plugins)/iu
const READ_ONLY = /^\s*(?:python3\s+)?(?:[\w.~-]*[\\/])*cockpitctl(?:\.py)?\s+(?:status|inbox|tasks|doctor|show\s+[\w-]+|gate\s+(?:stats|recent)|checkpoint\s+list\s+[\w-]+|config\s+get\s+[\w-]+)(?:\s+--[a-z-]+(?:[= ]\d+)?)*\s*$/u

export const HUMAN_SURFACE_DENIAL = 'Агент обращается к Cockpit только на чтение, одной командой без конвейеров: '
  + 'cockpitctl status, inbox, tasks, show <id>, doctor, gate stats, gate recent, checkpoint list <taskId>, config get <key>. '
  + 'Чтение исходников .py: cat, sed -n с диапазоном строк, rg, grep, head, tail, wc. '
  + 'Всё, что ставит отметку от имени человека, пользователь делает сам через /cockpit или панель.'

const RUNTIME_DIRECTORY = /agents[.\\/]claude[.\\/]cockpit/iu

function isRuntimeSourceRead(command: string): boolean {
  // Это узкий перечень форм чтения, а не интерпретатор shell. Подстановки, перенаправления
  // и несколько команд не допускаются даже внутри кавычек; sed разрешает только печать строк.
  if (/[$`;&|<>\r\n()\\]/u.test(command)
    || !/^\s*(?:'[^']*'|"[^"]*"|[^\s'"]+)(?:\s+(?:'[^']*'|"[^"]*"|[^\s'"]+))*\s*$/u.test(command)) return false
  const words = (command.match(/'[^']*'|"[^"]*"|[^\s'"]+/gu) ?? [])
    .map(word => word.startsWith("'") || word.startsWith('"') ? word.slice(1, -1) : word)
  const tool = words.shift()
  if (tool === 'sed') {
    if (words.shift() !== '-n' || !/^\d+(?:,\d+)?p$/u.test(words.shift() ?? '')) return false
  } else if (tool === 'grep' || tool === 'rg') {
    while (/^(?:-[niHhFElowS]+|--(?:line-number|ignore-case|fixed-strings|word-regexp|no-heading|with-filename|only-matching))$/u.test(words[0] ?? '')) words.shift()
    if (words[0] === '--') words.shift()
    if (!words.length || words.shift()?.startsWith('-')) return false
  } else if (tool === 'head' || tool === 'tail') {
    if (words[0] === '-n' || words[0] === '-c') {
      words.shift()
      if (!/^\d+$/u.test(words.shift() ?? '')) return false
    }
  } else if (tool === 'cat' || tool === 'wc') {
    const flags = tool === 'cat' ? /^-[nbEstTvAe]+$/u : /^-[lwcLm]+$/u
    while (flags.test(words[0] ?? '')) words.shift()
  } else return false
  if (words[0] === '--') words.shift()
  return words.length > 0 && words.every(path => /^(?:\/?[\w.~@+-]+\/)*agents\/claude\/cockpit\/(?:[\w.-]+\/)*[\w.-]+\.py$/u.test(path))
}

export function isHumanSurfaceCommand(command: string): boolean {
  // Текст команды проверяется целиком, тело heredoc тоже: страж не разбирает shell.
  // Прозу с упоминанием рантайма агент пишет в файл инструментом Write, а не через cat <<EOF.
  // Исключение для каталога тестов не действует, если в команде есть подъём на уровень выше:
  // tests/../rpc.py — это снова сам рантайм.
  if (RUNTIME_DIRECTORY.test(command) && command.includes('..')) return true
  return COCKPIT_REFERENCE.test(command) && !READ_ONLY.test(command) && !isRuntimeSourceRead(command)
}

export function isFileMutation(tool: string): boolean {
  // MultiEdit отсутствует в claude-code-tools сборки 2.1.289.
  return tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit'
}

export function missingExecutable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && error.code === 'ENOENT') return true
  return 'message' in error && typeof error.message === 'string'
    && /\bENOENT\b|command not found|executable (?:not found|does not exist)|spawn .+ ENOENT/i.test(error.message)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function priority(value: unknown): value is 0 | 1 | 2 | 3 { return integer(value) && value <= 3 }
function textWithin(value: unknown, limit: number): value is string { return typeof value === 'string' && Array.from(value).length <= limit }
function taskList(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 10 && value.every(item => textWithin(item, 300)) }
function id(value: unknown): value is string { return typeof value === 'string' && validId(value) }
function timestamp(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value) }
const STORAGE_SCHEMA_VERSIONS: readonly Snapshot['storageSchemaVersion'][] = [5, 6, 7, 8, 9, 10, 11, 12, 13]
function storageSchemaVersion(value: unknown): value is Snapshot['storageSchemaVersion'] { return STORAGE_SCHEMA_VERSIONS.some(version => version === value) }
function status(value: unknown): value is TaskStatus { return value === 'active' || value === 'paused' || value === 'done' || value === 'cancelled' }
function mode(value: unknown): value is CaptureMode { return value === 'full-local' || value === 'off' || value === 'redacted' }
function certainty(value: unknown): value is Certainty { return value === 'observed' || value === 'inferred' || value === 'confirmed' || value === 'verified' }
function sourceKind(value: unknown): value is SourceKind { return value === 'user' || value === 'claude' || value === 'agent' || value === 'engine' || value === 'tool' || value === 'provider' }
function provenance(value: unknown): value is Provenance { return value === 'panel' || value === 'cli' || value === 'tool' }
function inboxType(value: unknown): value is InboxType { return value === 'info' || value === 'proposal' || value === 'question' || value === 'decision' || value === 'approval' || value === 'conflict' || value === 'blocking' }
function checkpointKind(value: unknown): value is CheckpointKind { return value === 'commit' || value === 'tests-passed' || value === 'note' || value === 'detour' || value === 'return' }
function inboxPreview(value: unknown): value is InboxPreview {
  return record(value) && id(value.inboxId) && timestamp(value.capturedAt) && integer(value.length)
    && (value.preview === null || typeof value.preview === 'string')
    && (value.type === null || inboxType(value.type))
    && (value.classifiedBy === null || value.classifiedBy === 'rule' || value.classifiedBy === 'user' || value.classifiedBy === 'jev')
    && record(value.scope) && (value.scope.taskId === null || id(value.scope.taskId)) && (value.scope.resourceId === null || id(value.scope.resourceId))
    && (value.policyVersion === null || typeof value.policyVersion === 'string')
    && (value.confidence === null || (typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1))
    && (value.mode === null || value.mode === 'shadow' || value.mode === 'active') && (value.observedAt === null || timestamp(value.observedAt))
    && (value.triageStatus === 'untriaged' || value.triageStatus === 'triaged' || value.triageStatus === 'rejected') && integer(value.triageRevision)
    && provenance(value.provenance) && provenance(value.triageProvenance)
}
function checkpoint(value: unknown): value is Checkpoint {
  return record(value) && id(value.checkpointId) && id(value.taskId) && checkpointKind(value.kind)
    && typeof value.text === 'string' && sourceKind(value.source) && timestamp(value.createdAt) && provenance(value.provenance)
}
function checkpointList(value: unknown, taskId: string, limit: number): value is Checkpoint[] {
  return Array.isArray(value) && value.length <= limit && value.every(entry => checkpoint(entry) && entry.taskId === taskId)
}
function returnPacket(value: unknown): value is ReturnPacket {
  return record(value) && id(value.taskId) && typeof value.title === 'string'
    && checkpointList(value.checkpoints, value.taskId, 5)
    && Array.isArray(value.inbox) && value.inbox.length <= 5 && value.inbox.every(inboxPreview)
}
function summary(value: unknown): value is TaskSummary {
  return record(value) && id(value.taskId) && typeof value.alias === 'string' && /^TASK-\d+$/.test(value.alias)
    && returnFields(value)
    && typeof value.title === 'string' && status(value.status) && integer(value.revision)
    && certainty(value.certainty) && sourceKind(value.certaintySource) && provenance(value.certaintyProvenance)
    && (value.stage === undefined || value.stage === 'candidate' || value.stage === 'task')
    && (value.adoptedBy === undefined || value.adoptedBy === null || value.adoptedBy === 'owner' || value.adoptedBy === 'agent')
    && (value.dismissReason === undefined || value.dismissReason === null || ['answered', 'owner', 'expired', 'duplicate'].some(reason => reason === value.dismissReason))
    && (value.dismissedAt === undefined || value.dismissedAt === null || timestamp(value.dismissedAt))
    && (value.description === undefined || textWithin(value.description, 4000))
    && (value.summary === undefined || textWithin(value.summary, 300))
    && (value.assignee === undefined || value.assignee === null || value.assignee === 'claude' || value.assignee === 'codex' || value.assignee === 'antigravity' || value.assignee === 'human')
    && (value.priority === undefined || priority(value.priority))
    && (value.prioritySource === undefined || value.prioritySource === 'user' || value.prioritySource === 'model' || value.prioritySource === 'jev')
    && (value.priorityPinned === undefined || typeof value.priorityPinned === 'boolean')
    && (value.createdAt === undefined || timestamp(value.createdAt)) && (value.updatedAt === undefined || timestamp(value.updatedAt))
    && (value.queuePosition === undefined || integer(value.queuePosition) || (value.stage === 'candidate' && value.queuePosition === null))
    && (value.steps === undefined || (Array.isArray(value.steps) && value.steps.length <= 50 && value.steps.every((step, index) =>
      record(step) && step.position === index && typeof step.title === 'string' && ['pending', 'active', 'done', 'blocked'].includes(String(step.status)))))
    && (value.sourcePhrase === undefined || value.sourcePhrase === null || typeof value.sourcePhrase === 'string')
    && (value.lastCheckpoint === undefined || value.lastCheckpoint === null || (checkpoint(value.lastCheckpoint) && value.lastCheckpoint.taskId === value.taskId))
    && (value.needsDecision === undefined || typeof value.needsDecision === 'boolean')
    && (value.elapsedMs === undefined || integer(value.elapsedMs))
    && (value.activeSince === undefined || value.activeSince === null || timestamp(value.activeSince))
    && (value.deleted === undefined || typeof value.deleted === 'boolean')
}
function task(value: unknown): value is Task {
  if (!record(value) || !summary(value) || !id(value.projectId) || !id(value.worktreeId)
    || (value.origin !== 'ad-hoc' && value.origin !== 'no-source') || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || (value.description !== undefined && !textWithin(value.description, 4000))
    || (value.acceptance !== undefined && !taskList(value.acceptance))
    || (value.constraints !== undefined && !taskList(value.constraints))) return false
  const source = value.source
  return source === null || (record(source) && id(source.inboxId) && integer(source.start) && integer(source.end)
    && source.end >= source.start && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.sha256))
}
function focus(value: unknown): value is Focus {
  return record(value) && integer(value.revision) && (value.task === null || task(value.task))
}
export const GATE_REASONS: readonly GateReason[] = ['foreign-lease', 'stale-read', 'blocking-inbox', 'pending-decision']
function gateSummary(value: unknown): value is GateSummary {
  if (!record(value)) return false
  const { counts, blockReasons } = value
  return (value.mode === 'off' || value.mode === 'observe')
    && record(counts) && ['ALLOW', 'BIND', 'BLOCK'].every(key => integer(counts[key]))
    && record(blockReasons) && GATE_REASONS.every(key => integer(blockReasons[key]))
}
function gateObservation(value: unknown): value is GateObservation {
  return record(value) && integer(value.observationId) && value.observationId > 0
    && (value.outcome === 'ALLOW' || value.outcome === 'BIND' || value.outcome === 'BLOCK')
    && Array.isArray(value.reasons) && value.reasons.every(reason => GATE_REASONS.includes(reason))
    && new Set(value.reasons).size === value.reasons.length && (value.outcome === 'BLOCK') === (value.reasons.length > 0)
    && (value.taskId === null || id(value.taskId)) && id(value.sessionId) && timestamp(value.observedAt)
    && record(value.resource) && typeof value.resource.resourceId === 'string' && /^path-[a-f0-9]{64}$/.test(value.resource.resourceId)
    && (value.resource.path === null || typeof value.resource.path === 'string')
}
function cleanGate(value: GateSummary): GateSummary {
  return { mode: value.mode, counts: { ALLOW: value.counts.ALLOW, BIND: value.counts.BIND, BLOCK: value.counts.BLOCK },
    blockReasons: { 'foreign-lease': value.blockReasons['foreign-lease'], 'stale-read': value.blockReasons['stale-read'],
      'blocking-inbox': value.blockReasons['blocking-inbox'], 'pending-decision': value.blockReasons['pending-decision'] } }
}
function cleanGateObservation(value: GateObservation): GateObservation {
  return { observationId: value.observationId, outcome: value.outcome, reasons: [...value.reasons], taskId: value.taskId,
    resource: { resourceId: value.resource.resourceId, path: value.resource.path }, sessionId: value.sessionId, observedAt: value.observedAt }
}
function taskCounts(value: unknown): boolean {
  return record(value) && ['active', 'deferred', 'done', 'queued'].every(key => integer(value[key]))
}
function snapshot(value: unknown): value is Snapshot {
  return record(value) && value.schemaVersion === 1 && storageSchemaVersion(value.storageSchemaVersion) && record(value.binding)
    && id(value.binding.projectId) && id(value.binding.worktreeId) && id(value.binding.sessionId)
    && focus(value.focus) && record(value.inboxCounts) && integer(value.inboxCounts.total) && integer(value.inboxCounts.untriaged)
    && record(value.inboxTriageCounts) && integer(value.inboxTriageCounts.untriaged) && integer(value.inboxTriageCounts.blocking)
    && Array.isArray(value.tasks) && value.tasks.every(summary)
    && ((value.openTaskCount === undefined && value.tasksTruncated === undefined)
      || (integer(value.openTaskCount) && typeof value.tasksTruncated === 'boolean'
        && value.openTaskCount >= value.tasks.filter(entry => entry.status === 'active' || entry.status === 'paused').length
        && (value.tasksTruncated || value.openTaskCount === value.tasks.filter(entry => entry.status === 'active' || entry.status === 'paused').length)))
    && (value.storageSchemaVersion < 8 || (Array.isArray(value.candidates) && value.candidates.length <= 5
      && value.candidates.every(entry => summary(entry) && entry.stage === 'candidate' && entry.dismissReason === null && entry.queuePosition === null)
      && integer(value.candidateCount) && value.candidateCount >= value.candidates.length && value.tasks.every(entry => entry.stage === 'task') && (value.focus.task === null || value.focus.task.stage === 'task')))
    && Array.isArray(value.inbox) && value.inbox.length <= 100 && value.inbox.every(inboxPreview)
    && Array.isArray(value.focusStack) && value.focusStack.length <= 8
    && value.focusStack.every((frame, index) => record(frame) && id(frame.taskId) && frame.depth === index + 1 && provenance(frame.provenance))
    && mode(value.captureMode) && gateSummary(value.gate) && (value.extraction === undefined || extractionStats(value.extraction))
    && (value.queue === undefined || value.queue === 'run' || value.queue === 'paused')
    && (value.taskCounts === undefined || taskCounts(value.taskCounts))
    && (value.workingTasks === undefined || Array.isArray(value.workingTasks) && value.workingTasks.length <= 8 && value.workingTasks.every(summary))
}

export const EXTRACTION_CODES: readonly ExtractionCode[] = ['extracted', 'no-tasks', 'skipped-gate', 'no-attestation', 'model-timeout', 'model-unparsable', 'runtime-rejected', 'error']
function extractionStats(value: unknown): value is ExtractionStats {
  if (!record(value)) return false
  const counts = value.counts
  return record(counts) && EXTRACTION_CODES.every(code => integer(counts[code]))
    && (value.lastSuccessAt === null || timestamp(value.lastSuccessAt)) && integer(value.consecutiveFailures)
    && integer(value.ownerRequests) && (value.lastReason === null || EXTRACTION_CODES.some(code => code === value.lastReason))
}

function permission(value: unknown): boolean {
  return record(value) && typeof value.present === 'boolean' && (value.mode === null || typeof value.mode === 'string') && typeof value.ok === 'boolean'
}
function doctor(value: unknown): value is Doctor {
  if (!record(value)) return false
  const { permissions, counts } = value
  if (!record(permissions) || !record(permissions.files) || !record(counts)
    || (value.extraction !== undefined && !extractionStats(value.extraction))) return false
  const files = permissions.files
  return value.schemaVersion === 1 && storageSchemaVersion(value.storageSchemaVersion) && Array.isArray(value.integrityCheck) && value.integrityCheck.every(entry => typeof entry === 'string')
    && (value.storageSchemaVersion < 8 || integer(counts.attestation_revocations))
    && (value.storageSchemaVersion < 11 || integer(counts.task_owner_comments))
    && Array.isArray(value.foreignKeyCheck) && value.foreignKeyCheck.every(entry => record(entry)
      && typeof entry.table === 'string'
      && (entry.rowId === null || (typeof entry.rowId === 'number' && Number.isSafeInteger(entry.rowId)))
      && typeof entry.parent === 'string' && integer(entry.fkIndex))
    && permission(permissions.directory) && ['cockpit.db', 'cockpit.db-wal', 'cockpit.db-shm'].every(name => permission(files[name]))
    && ['projects', 'worktrees', 'sessions', 'inbox', 'tasks', 'task_sources', 'focus', 'events', 'requests', 'config', 'inbox_observations', 'checkpoints', 'focus_stack', 'project_config', 'worktree_leases', 'gate_observations', 'session_attestations'].every(name => integer(counts[name]))
}

function cleanTask(value: Task): Task {
  return {
    ...cleanSummary(value), projectId: value.projectId, worktreeId: value.worktreeId, origin: value.origin,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...(value.description === undefined ? {} : { description: redactSecrets(stripPastedContent(value.description), 4000) }),
    ...(value.acceptance === undefined ? {} : { acceptance: value.acceptance.map(item => redactSecrets(stripPastedContent(item), 300)) }),
    ...(value.constraints === undefined ? {} : { constraints: value.constraints.map(item => redactSecrets(stripPastedContent(item), 300)) }),
    source: value.source === null ? null : { inboxId: value.source.inboxId, start: value.source.start, end: value.source.end, sha256: value.source.sha256 },
  }
}
function cleanSummary(value: TaskSummary): TaskSummary {
  return { taskId: value.taskId, alias: value.alias, title: stripPastedContent(value.title), status: value.status, revision: value.revision, certainty: value.certainty, certaintySource: value.certaintySource, certaintyProvenance: value.certaintyProvenance,
    ...cleanReturnFields(value),
    ...(value.stage === undefined ? {} : { stage: value.stage }),
    ...(value.adoptedBy === undefined ? {} : { adoptedBy: value.adoptedBy }),
    ...(value.dismissReason === undefined ? {} : { dismissReason: value.dismissReason }),
    ...(value.dismissedAt === undefined ? {} : { dismissedAt: value.dismissedAt }),
    ...(value.description === undefined ? {} : { description: redactSecrets(stripPastedContent(value.description), 4000) }),
    ...(value.summary === undefined ? {} : { summary: redactSecrets(stripPastedContent(value.summary), 300) }),
    ...(value.assignee === undefined ? {} : { assignee: value.assignee }),
    ...(value.priority === undefined ? {} : { priority: value.priority }),
    ...(value.prioritySource === undefined ? {} : { prioritySource: value.prioritySource }),
    ...(value.priorityPinned === undefined ? {} : { priorityPinned: value.priorityPinned }),
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }), ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
    ...(value.queuePosition === undefined ? {} : { queuePosition: value.queuePosition }),
    ...(value.steps === undefined ? {} : { steps: value.steps.map(step => ({ position: step.position, title: stripPastedContent(step.title), status: step.status })) }),
    ...(value.sourcePhrase === undefined ? {} : { sourcePhrase: value.sourcePhrase === null ? null : stripPastedContent(value.sourcePhrase) }),
    ...(value.lastCheckpoint === undefined ? {} : { lastCheckpoint: value.lastCheckpoint === null ? null : cleanCheckpoint(value.lastCheckpoint) }),
    ...(value.needsDecision === undefined ? {} : { needsDecision: value.needsDecision }),
    ...(value.elapsedMs === undefined ? {} : { elapsedMs: value.elapsedMs }), ...(value.activeSince === undefined ? {} : { activeSince: value.activeSince }),
    ...(value.deleted === undefined ? {} : { deleted: value.deleted }) }
}
function cleanInbox(value: InboxPreview): InboxPreview {
  return {
    inboxId: value.inboxId, capturedAt: value.capturedAt, length: value.length, preview: value.preview === null ? null : stripPastedContent(value.preview),
    type: value.type, classifiedBy: value.classifiedBy, scope: { taskId: value.scope.taskId, resourceId: value.scope.resourceId },
    policyVersion: value.policyVersion, confidence: value.confidence, mode: value.mode, observedAt: value.observedAt,
    triageStatus: value.triageStatus, triageRevision: value.triageRevision,
    provenance: value.provenance, triageProvenance: value.triageProvenance,
  }
}
function cleanCheckpoint(value: Checkpoint): Checkpoint {
  return { checkpointId: value.checkpointId, taskId: value.taskId, kind: value.kind, text: value.text, source: value.source, createdAt: value.createdAt, provenance: value.provenance }
}
function cleanFocus(value: Focus): Focus {
  return { task: value.task === null ? null : cleanTask(value.task), revision: value.revision }
}
function cleanSnapshot(value: Snapshot): Snapshot {
  return {
    schemaVersion: 1, storageSchemaVersion: value.storageSchemaVersion, binding: { projectId: value.binding.projectId, worktreeId: value.binding.worktreeId, sessionId: value.binding.sessionId,
      ...(typeof value.binding.worktreePath === 'string' && value.binding.worktreePath.startsWith('/') && !value.binding.worktreePath.includes('\0') ? { worktreePath: value.binding.worktreePath } : {}) },
    focus: cleanFocus(value.focus),
    inboxCounts: { total: value.inboxCounts.total, untriaged: value.inboxCounts.untriaged },
    inboxTriageCounts: { untriaged: value.inboxTriageCounts.untriaged, blocking: value.inboxTriageCounts.blocking },
    tasks: value.tasks.map(cleanSummary), inbox: value.inbox.map(cleanInbox),
    ...(value.openTaskCount === undefined ? {} : { openTaskCount: value.openTaskCount }),
    ...(value.tasksTruncated === undefined ? {} : { tasksTruncated: value.tasksTruncated }),
    ...(value.candidates === undefined ? {} : { candidates: value.candidates.map(cleanSummary) }),
    ...(value.candidateCount === undefined ? {} : { candidateCount: value.candidateCount }),
    focusStack: value.focusStack.map(frame => ({ taskId: frame.taskId, depth: frame.depth, provenance: frame.provenance })),
    captureMode: value.captureMode, gate: cleanGate(value.gate),
    ...(value.queue === undefined ? {} : { queue: value.queue }),
    ...(value.extraction === undefined ? {} : { extraction: { ...value.extraction, counts: { ...value.extraction.counts } } }),
  }
}

function rankResult(value: unknown): value is TaskRankResult {
  if (!record(value) || !Array.isArray(value.changed) || !Array.isArray(value.skipped)
    || value.changed.length + value.skipped.length > 50) return false
  if (!value.changed.every(item => record(item) && id(item.taskId) && priority(item.priority))
    || !value.skipped.every(item => record(item) && id(item.taskId)
      && (item.reason === 'pinned' || item.reason === 'stale' || item.reason === 'terminal' || item.reason === 'not-found' || item.reason === 'candidate'))) return false
  const ids = [...value.changed, ...value.skipped].map(item => item.taskId)
  return new Set(ids).size === ids.length
}

function agentNote(value: unknown): value is AgentTaskNote {
  return record(value) && id(value.noteId) && id(value.taskId) && (value.kind === 'note' || value.kind === 'result')
    && textWithin(value.text, value.kind === 'result' ? 500 : 1000) && timestamp(value.createdAt)
    && value.source === 'agent' && value.provenance === 'tool'
}
function ownerComment(value: unknown): value is OwnerComment {
  return record(value) && id(value.commentId) && textWithin(value.text, 4000)
    && timestamp(value.createdAt) && timestamp(value.updatedAt) && value.updatedAt >= value.createdAt
    && integer(value.revision) && value.deleted === undefined
}
function ownerComments(value: unknown): value is OwnerComment[] {
  return Array.isArray(value) && value.length <= 100 && value.every(ownerComment)
    && new Set(value.map(comment => comment.commentId)).size === value.length
    && value.every((comment, index) => index === 0 || (value[index - 1]?.createdAt ?? '') <= comment.createdAt)
}
function cleanOwnerComment(value: OwnerComment): OwnerComment {
  return { commentId: value.commentId, text: redactSecrets(stripPastedContent(value.text), 4000),
    createdAt: value.createdAt, updatedAt: value.updatedAt, revision: value.revision }
}
function contextEntry(value: unknown): value is TaskContextEntry {
  return record(value) && id(value.taskId) && typeof value.alias === 'string' && /^TASK-[1-9][0-9]*$/.test(value.alias) && textWithin(value.title, 300)
    && returnFields(value)
    && (value.priorityPinned === undefined || typeof value.priorityPinned === 'boolean')
}
const CONTEXT_COUNTS = ['total', 'open', 'active', 'queued', 'deferred', 'done', 'cancelled', 'closedLast24h', 'projectOpen'] as const
const OWNER_CHANGE_ACTIONS: readonly OwnerTaskChangeAction[] = ['created', 'edited', 'reordered', 'deferred', 'deleted', 'reopened', 'noted', 'completed', 'current', 'restored', 'step', 'commented', 'comment-edited', 'comment-deleted']
function taskContext(value: unknown): value is TaskContext {
  if (!record(value) || !record(value.binding) || !id(value.binding.projectId) || !id(value.binding.worktreeId) || !id(value.binding.sessionId)
    || !integer(value.cursor) || !record(value.counts) || !Array.isArray(value.ownerChanges)) return false
  const counts = value.counts
  if (!CONTEXT_COUNTS.every(key => integer(counts[key]))) return false
  if (!Array.isArray(value.queue) || value.queue.length > 30 || !value.queue.every(item => contextEntry(item) && record(item) && textWithin(item.description, 4000))
    || !Array.isArray(value.deferred) || value.deferred.length > 10 || !value.deferred.every(contextEntry)
    || !Array.isArray(value.closed) || value.closed.length > 10 || !value.closed.every(contextEntry)) return false
  const current = value.current
  if (current !== null && (!contextEntry(current) || !record(current) || !integer(current.revision) || !textWithin(current.description, 4000)
    || !taskList(current.acceptance) || !taskList(current.constraints)
    || !Array.isArray(current.ownerNotes) || !current.ownerNotes.every(note => checkpoint(note) && note.taskId === current.taskId && note.source === 'user' && note.kind === 'note')
    || (current.ownerComments !== undefined && !ownerComments(current.ownerComments))
    || !Array.isArray(current.agentNotes) || !current.agentNotes.every(note => agentNote(note) && note.taskId === current.taskId))) return false
  const cursor = value.cursor
  return value.ownerChanges.every((change, index, changes) => record(change) && integer(change.eventId) && change.eventId > 0 && change.eventId <= cursor
    && (index === 0 || (record(changes[index - 1]) && Number(changes[index - 1].eventId) < change.eventId))
    && id(change.taskId) && OWNER_CHANGE_ACTIONS.some(action => action === change.action) && timestamp(change.createdAt))
}
function cleanAgentNote(value: AgentTaskNote): AgentTaskNote {
  return { noteId: value.noteId, taskId: value.taskId, kind: value.kind, text: redactSecrets(stripPastedContent(value.text), value.kind === 'result' ? 500 : 1000), createdAt: value.createdAt, source: 'agent', provenance: 'tool' }
}
function returnFields(value: Record<string, unknown>): boolean {
  return (value.returnCount === undefined || integer(value.returnCount))
    && (value.returnContext === undefined || integer(value.returnCount) && value.returnCount > 0 && record(value.returnContext)
      && (value.returnContext.result === null || textWithin(value.returnContext.result, 500))
      && (value.returnContext.ownerComment === null || textWithin(value.returnContext.ownerComment, 4000)))
}
function cleanReturnFields(value: TaskContextEntry | TaskSummary): Pick<TaskContextEntry, 'returnCount' | 'returnContext'> {
  return { ...(value.returnCount === undefined ? {} : { returnCount: value.returnCount }),
    ...(value.returnContext === undefined ? {} : { returnContext: {
      result: value.returnContext.result === null ? null : redactSecrets(stripPastedContent(value.returnContext.result), 500),
      ownerComment: value.returnContext.ownerComment === null ? null : redactSecrets(stripPastedContent(value.returnContext.ownerComment), 4000),
    } }) }
}
function cleanContextEntry(value: TaskContextEntry): TaskContextEntry {
  return { taskId: value.taskId, alias: value.alias, title: redactSecrets(stripPastedContent(value.title), 300),
    ...cleanReturnFields(value),
    ...(value.priorityPinned === undefined ? {} : { priorityPinned: value.priorityPinned }) }
}
function taskPageEntry(value: unknown): value is TaskPageEntry {
  return contextEntry(value) && record(value) && status(value.status) && timestamp(value.updatedAt) && typeof value.priorityPinned === 'boolean'
    && (value.description === undefined || textWithin(value.description, 2000))
    && (value.summary === undefined || textWithin(value.summary, 300))
    && (value.priority === undefined || integer(value.priority) && value.priority <= 3)
    && (value.queuePosition === undefined || integer(value.queuePosition))
    && (value.revision === undefined || integer(value.revision))
    && (value.needsDecision === undefined || typeof value.needsDecision === 'boolean')
    && (value.discussionCount === undefined || integer(value.discussionCount))
    && (value.stepCounts === undefined || record(value.stepCounts) && integer(value.stepCounts.total)
      && integer(value.stepCounts.done) && integer(value.stepCounts.active) && value.stepCounts.done + value.stepCounts.active <= value.stepCounts.total)
    && (value.createdAt === undefined || timestamp(value.createdAt))
    && (value.closedAt === undefined || timestamp(value.closedAt))
    && (value.elapsedMs === undefined || integer(value.elapsedMs))
    && (value.activeSince === undefined || value.activeSince === null || timestamp(value.activeSince))
    && (value.certaintySource === undefined || sourceKind(value.certaintySource))
}
function taskPage(value: unknown): value is TaskPage {
  return record(value) && ['queue', 'deferred', 'closed'].some(list => list === value.list)
    && integer(value.offset) && integer(value.total) && Array.isArray(value.tasks) && value.tasks.length <= 50
    && value.tasks.every(taskPageEntry) && value.tasks.length <= Math.max(0, value.total - value.offset)
    && new Set(value.tasks.map(item => item.taskId)).size === value.tasks.length
    && value.tasks.every(item => item.status === (value.list === 'queue' ? 'active' : value.list === 'deferred' ? 'paused' : 'done'))
}
function taskSearch(value: unknown): value is TaskSearch {
  if (!record(value) || !integer(value.offset) || !integer(value.limit) || value.limit < 1 || value.limit > 50
    || typeof value.truncated !== 'boolean' || !record(value.lists) || Object.keys(value.lists).length === 0) return false
  const offset = value.offset
  const limit = value.limit
  return Object.entries(value.lists).every(([list, page]) => ['queue', 'deferred', 'closed'].includes(list)
    && record(page) && integer(page.total) && Array.isArray(page.rows) && page.rows.length <= limit
    && page.rows.length <= Math.max(0, page.total - offset) && new Set(page.rows.map(item => record(item) ? item.taskId : null)).size === page.rows.length
    && page.rows.every(item => taskPageEntry(item) && item.status === (list === 'queue' ? 'active' : list === 'deferred' ? 'paused' : 'done')
      && record(item) && record(item.match) && ['number', 'title', 'description', 'acceptance', 'constraints', 'result', 'comment'].includes(item.match.field as string)
      && typeof item.match.snippet === 'string' && Array.from(item.match.snippet).length <= 160
      && (item.match.inside === undefined || record(item.match.inside) && ['number', 'title'].includes(item.match.field as string)
        && SEARCH_INSIDE_FIELDS.includes(item.match.inside.field as string)
        && typeof item.match.inside.snippet === 'string' && Array.from(item.match.inside.snippet).length <= 160)))
}
const SEARCH_INSIDE_FIELDS = ['description', 'acceptance', 'constraints', 'result', 'comment']
function cleanSearchSnippet(text: string): string {
  return Array.from(redactSecrets(stripPastedContent(text).replace(/\t/gu, ' ')))
    .map(char => char === '\n' || char === '\t' ? ' ' : /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/u.test(char) ? '' : char).slice(0, 160).join('')
}
function cleanTaskContext(value: TaskContext): TaskContext {
  return { binding: { projectId: value.binding.projectId, worktreeId: value.binding.worktreeId, sessionId: value.binding.sessionId,
      ...(typeof value.binding.worktreePath === 'string' && value.binding.worktreePath.startsWith('/') && !value.binding.worktreePath.includes('\0') ? { worktreePath: value.binding.worktreePath } : {}) },
    current: value.current === null ? null : { ...cleanContextEntry(value.current), revision: value.current.revision,
      description: redactSecrets(stripPastedContent(value.current.description), 4000),
      acceptance: value.current.acceptance.map(text => redactSecrets(stripPastedContent(text), 300)),
      constraints: value.current.constraints.map(text => redactSecrets(stripPastedContent(text), 300)),
      ownerNotes: value.current.ownerNotes.map(note => ({ ...cleanCheckpoint(note), text: redactSecrets(stripPastedContent(note.text), 1000) })),
      ownerComments: (value.current.ownerComments ?? []).map(cleanOwnerComment),
      agentNotes: value.current.agentNotes.map(cleanAgentNote) },
    queue: value.queue.map(item => ({ ...cleanContextEntry(item), description: redactSecrets(stripPastedContent(item.description), 4000) })),
    deferred: value.deferred.map(cleanContextEntry), closed: value.closed.map(cleanContextEntry),
    counts: { total: value.counts.total, open: value.counts.open, active: value.counts.active, queued: value.counts.queued, deferred: value.counts.deferred,
      done: value.counts.done, cancelled: value.counts.cancelled, closedLast24h: value.counts.closedLast24h, projectOpen: value.counts.projectOpen },
    ownerChanges: value.ownerChanges.map(change => ({ eventId: change.eventId, taskId: change.taskId, action: change.action, createdAt: change.createdAt })), cursor: value.cursor }
}

export function parseResponse(op: Operation, stdout: string, exitCode = 0, truncated = false): Outcome {
  if (exitCode !== 0 || truncated) return { kind: 'unknown' }
  let body: unknown
  try { body = JSON.parse(stdout) } catch { return { kind: 'unknown' } }
  if (!record(body) || body.v !== 1) return { kind: 'unknown' }
  if (body.ok === false && record(body.error)) {
    const code = body.error.code
    if (code === 'DB_UNAVAILABLE') return { kind: 'unknown' }
    if ((code === 'ATTESTATION_FAILED' || code === 'ATTESTATION_CONFLICT') && typeof body.error.message === 'string') {
      // Переносится только известная причина, а не произвольный текст транспорта.
      for (const reason of ['revoked', 'unregistered', 'mismatch', 'stale-epoch', 'expired'] as const) {
        if (body.error.message.startsWith(`[attestation-${reason}]`)) return { kind: 'error', code, attestationReason: reason }
      }
    }
    if (code === 'INVALID_REQUEST' || code === 'UNKNOWN_OP' || code === 'IDEMPOTENCY_CONFLICT' || code === 'REVISION_CONFLICT' || code === 'NOT_FOUND' || code === 'NOT_IMPLEMENTED' || code === 'ATTESTATION_FAILED' || code === 'ATTESTATION_CONFLICT' || code === 'TASK_LIMIT_REACHED') return { kind: 'error', code }
    return { kind: 'unknown' }
  }
  if (body.ok !== true || !record(body.result)) return { kind: 'unknown' }
  const result = body.result
  if (op === 'task.summary.claim' && typeof result.claimed === 'boolean') {
    if (!result.claimed) return { kind: 'summary-claimed', claimed: false }
    if (typeof result.descriptionHash === 'string' && /^[a-f0-9]{64}$/u.test(result.descriptionHash) && textWithin(result.description, 4000)) {
      return { kind: 'summary-claimed', claimed: true, descriptionHash: result.descriptionHash,
        description: redactSecrets(stripPastedContent(result.description), 4000) }
    }
  }
  if (op === 'task.summary.report' && (result.summary === null || textWithin(result.summary, 300))) {
    return { kind: 'summary-reported', summary: result.summary === null ? null : redactSecrets(stripPastedContent(result.summary), 300) }
  }
  if (op === 'tasks.search' && taskSearch(result)) {
    const lists: Partial<Record<TaskPageList, TaskSearchPage>> = {}
    for (const [name, page] of Object.entries(result.lists)) {
      if (!page) continue
      lists[name as TaskPageList] = { total: page.total, rows: page.rows.map(item => ({
        ...cleanContextEntry(item), status: item.status, updatedAt: item.updatedAt, priorityPinned: item.priorityPinned,
        match: { field: item.match.field, snippet: cleanSearchSnippet(item.match.snippet),
          ...(item.match.inside ? { inside: { field: item.match.inside.field, snippet: cleanSearchSnippet(item.match.inside.snippet) } } : {}) },
      })) }
    }
    return { kind: 'search', search: { offset: result.offset, limit: result.limit, lists, truncated: result.truncated } }
  }
  if (op === 'tasks.page' && taskPage(result)) return { kind: 'page', page: { list: result.list, offset: result.offset, total: result.total,
    tasks: result.tasks.map(item => ({ ...cleanContextEntry(item), status: item.status, updatedAt: item.updatedAt, priorityPinned: item.priorityPinned,
      ...(item.description === undefined ? {} : { description: redactSecrets(stripPastedContent(item.description), 2000) }),
      ...(item.summary === undefined ? {} : { summary: redactSecrets(stripPastedContent(item.summary), 300) }),
      ...(item.priority === undefined ? {} : { priority: item.priority }), ...(item.queuePosition === undefined ? {} : { queuePosition: item.queuePosition }),
      ...(item.revision === undefined ? {} : { revision: item.revision }), ...(item.needsDecision === undefined ? {} : { needsDecision: item.needsDecision }),
      ...(item.stepCounts === undefined ? {} : { stepCounts: { ...item.stepCounts } }), ...(item.discussionCount === undefined ? {} : { discussionCount: item.discussionCount }),
      ...(item.certaintySource === undefined ? {} : { certaintySource: item.certaintySource }), ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
      ...(item.elapsedMs === undefined ? {} : { elapsedMs: item.elapsedMs }), ...(item.activeSince === undefined ? {} : { activeSince: item.activeSince }),
      ...(item.closedAt === undefined ? {} : { closedAt: item.closedAt }),
    })) } }
  if (op === 'task.resolve' && contextEntry(result) && status(result.status) && integer(result.revision)) {
    return { kind: 'resolved', task: { ...cleanContextEntry(result), status: result.status, revision: result.revision } }
  }
  if ((op === 'task.comment.add' || op === 'task.comment.edit') && id(result.taskId) && ownerComment(result.comment)) {
    return { kind: op === 'task.comment.add' ? 'owner-commented' : 'owner-comment-edited', taskId: result.taskId, comment: cleanOwnerComment(result.comment) }
  }
  if (op === 'task.comment.delete' && id(result.taskId) && id(result.commentId) && integer(result.revision) && result.revision > 0 && result.deleted === true) {
    return { kind: 'owner-comment-deleted', taskId: result.taskId, commentId: result.commentId, revision: result.revision, deleted: true }
  }
  if (op === 'tasks.context' && taskContext(result)) return { kind: 'context', context: cleanTaskContext(result) }
  if (op === 'tasks.agent.rank' && Array.isArray(result.order) && result.order.every(id)
    && new Set(result.order).size === result.order.length && Array.isArray(result.pinned) && result.pinned.every(id)
    && new Set(result.pinned).size === result.pinned.length) {
    const order = new Set(result.order)
    if (result.pinned.every(item => order.has(item))) return { kind: 'agent-ranked', order: [...result.order], pinned: [...result.pinned] }
  }
  if (op === 'tasks.agent.create' && Array.isArray(result.tasks) && result.tasks.length >= 1 && result.tasks.length <= 20
    && result.tasks.every(item => contextEntry(item) && record(item) && integer(item.revision) && typeof item.duplicate === 'boolean')) {
    return { kind: 'agent-created', tasks: result.tasks.map(item => ({ ...cleanContextEntry(item), revision: item.revision, duplicate: item.duplicate })) }
  }
  if (op === 'task.agent.action' && task(result.task) && result.task.stage === 'task' && focus(result.focus)
    && (result.note === null || (agentNote(result.note) && result.note.taskId === result.task.taskId))) {
    return { kind: 'agent-acted', task: cleanTask(result.task), focus: cleanFocus(result.focus), note: result.note === null ? null : cleanAgentNote(result.note) }
  }
  if ((op === 'focus.get' || op === 'focus.set') && focus(result)) return { kind: 'focused', focus: cleanFocus(result) }
  if (op === 'session.attest' && result.attested === true) return { kind: 'attested' }
  if (op === 'session.revoke' && result.revoked === true) return { kind: 'revoked' }
  if ((op === 'config.get' || op === 'config.set') && result.key === 'gate' && (result.value === 'off' || result.value === 'observe') && provenance(result.provenance)) {
    return { kind: 'configured', key: result.key, value: result.value, provenance: result.provenance }
  }
  if ((op === 'config.get' || op === 'config.set') && result.key === 'queue' && (result.value === 'run' || result.value === 'paused') && provenance(result.provenance)) {
    return { kind: 'configured', key: result.key, value: result.value, provenance: result.provenance }
  }
  if ((op === 'snapshot' || op === 'session.rebind') && snapshot(result)) return { kind: 'snapshot', snapshot: {
    ...cleanSnapshot(result),
    ...(result.taskCounts === undefined ? {} : { taskCounts: { ...result.taskCounts } }),
    ...(result.workingTasks === undefined ? {} : { workingTasks: result.workingTasks.map(cleanSummary) }),
  } }
  if (op === 'task.bind' && result.gate === undefined && (result.bound === 'existing' || result.bound === 'created' || result.bound === 'created-no-source' || result.bound === 'unbound')
    && (result.bound === 'unbound' ? result.task === null : task(result.task)) && integer(result.focusRevision)) {
    return { kind: 'bound', bound: result.bound, task: result.task === null ? null : task(result.task) ? cleanTask(result.task) : null, focusRevision: result.focusRevision }
  }
  if ((op === 'gate.check' || op === 'task.bind') && (result.bound === 'existing' || result.bound === 'created' || result.bound === 'created-no-source' || result.bound === 'unbound')
    && (result.bound === 'unbound' ? result.task === null : task(result.task)) && integer(result.focusRevision) && gateSummary(result.gate)) {
    const observation = result.observation
    if (observation !== null && !gateObservation(observation)) return { kind: 'unknown' }
    const card = task(result.task) ? cleanTask(result.task) : null
    if (result.gate.mode === 'off' ? observation !== null : observation === null || observation.taskId !== (card?.taskId ?? null)) return { kind: 'unknown' }
    return { kind: 'gated', bound: result.bound, task: card, focusRevision: result.focusRevision,
      gate: cleanGate(result.gate), observation: observation === null ? null : cleanGateObservation(observation) }
  }
  if (op === 'session.end' && integer(result.released)) return { kind: 'released', released: result.released }
  // Оригинал Inbox нужен только локальной фоновой операции, не проекции.
  if (op === 'inbox.get' && id(result.inboxId) && (typeof result.text === 'string' || result.text === null)) {
    return { kind: 'inbox', inboxId: result.inboxId, text: result.text }
  }
  if (op === 'inbox.material' && id(result.inboxId) && (typeof result.material === 'string' || result.material === null)) return { kind: 'material', inboxId: result.inboxId, material: result.material }
  if (op === 'candidate.adopt' && task(result.task) && result.task.stage === 'task' && result.task.adoptedBy) return { kind: 'adopted', task: cleanTask(result.task) }
  if (op === 'candidate.dismiss' && Array.isArray(result.dismissed) && Array.isArray(result.skipped) && result.dismissed.every(id) && result.skipped.every(id)
    && result.dismissed.length + result.skipped.length <= 20 && new Set([...result.dismissed, ...result.skipped]).size === result.dismissed.length + result.skipped.length) return { kind: 'dismissed', dismissed: [...result.dismissed], skipped: [...result.skipped] }
  if ((op === 'task.update' || op === 'task.edit') && task(result.task)) return { kind: 'updated', task: cleanTask(result.task) }
  if (op === 'tasks.rank' && rankResult(result)) return { kind: 'ranked',
    changed: result.changed.map(item => ({ taskId: item.taskId, priority: item.priority })),
    skipped: result.skipped.map(item => ({ taskId: item.taskId, reason: item.reason })) }
  if (op === 'task.get' && task(result.task) && (result.comments === undefined || ownerComments(result.comments))
    && (result.agentNotes === undefined || Array.isArray(result.agentNotes) && result.agentNotes.every(note => agentNote(note) && note.taskId === (result.task as Task).taskId))) {
    return { kind: 'task', task: cleanTask(result.task), ...(result.comments === undefined ? {} : { comments: result.comments.map(cleanOwnerComment) }),
      ...(result.agentNotes === undefined ? {} : { agentNotes: result.agentNotes.map(cleanAgentNote) }) }
  }
  if ((op === 'task.create' || op === 'task.action' || op === 'task.reopen') && task(result.task) && focus(result.focus)) return { kind: 'task-changed', task: cleanTask(result.task), focus: cleanFocus(result.focus) }
  if (op === 'task.confirm' && task(result.task)) return { kind: 'confirmed', task: cleanTask(result.task) }
  if (op === 'inbox.triage' && inboxPreview(result)) return { kind: 'triaged', entry: cleanInbox(result) }
  if (op === 'checkpoint.add' && checkpoint(result.checkpoint) && integer(result.taskRevision)) {
    return { kind: 'noted', checkpoint: cleanCheckpoint(result.checkpoint), taskRevision: result.taskRevision }
  }
  if (op === 'checkpoint.list' && id(result.taskId) && integer(result.taskRevision) && checkpointList(result.checkpoints, result.taskId, 100)) {
    return { kind: 'timeline', taskId: result.taskId, taskRevision: result.taskRevision, checkpoints: result.checkpoints.map(cleanCheckpoint) }
  }
  if ((op === 'focus.detour' || op === 'focus.return') && focus(result.focus) && result.focus.task !== null
    && integer(result.stackDepth) && result.stackDepth <= 8 && checkpoint(result.checkpoint)) {
    if (op === 'focus.detour') return { kind: 'detoured', focus: cleanFocus(result.focus), stackDepth: result.stackDepth, checkpoint: cleanCheckpoint(result.checkpoint) }
    if (returnPacket(result.returnPacket) && result.returnPacket.taskId === result.focus.task.taskId && result.checkpoint.taskId === result.focus.task.taskId) {
      return { kind: 'returned', focus: cleanFocus(result.focus), stackDepth: result.stackDepth, checkpoint: cleanCheckpoint(result.checkpoint),
        returnPacket: { taskId: result.returnPacket.taskId, title: result.returnPacket.title, checkpoints: result.returnPacket.checkpoints.map(cleanCheckpoint), inbox: result.returnPacket.inbox.map(cleanInbox) } }
    }
  }
  if (op === 'capture.prompt' && id(result.inboxId) && result.captured === true && (result.captureMode === 'full-local' || result.captureMode === 'off')) {
    return { kind: 'captured', inboxId: result.inboxId, captureMode: result.captureMode }
  }
  if (op === 'doctor' && doctor(result)) return { kind: 'doctor', doctor: result }
  return { kind: 'unknown' }
}

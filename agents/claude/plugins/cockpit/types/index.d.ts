export type TaskStatus = 'active' | 'paused' | 'done' | 'cancelled'
export type CaptureMode = 'full-local' | 'redacted' | 'off'
export type RebindReason = 'start' | 'resume' | 'clear' | 'compact'
export type Certainty = 'observed' | 'inferred' | 'confirmed' | 'verified'
export type SourceKind = 'user' | 'claude' | 'agent' | 'engine' | 'tool' | 'provider'
export type Provenance = 'panel' | 'cli' | 'tool'
export type Actor = 'owner' | 'agent'
export type TaskStage = 'candidate' | 'task'
export type DismissReason = 'answered' | 'owner' | 'expired' | 'duplicate'
export type Assignee = 'claude' | 'codex' | 'antigravity' | 'human'
export type Priority = 0 | 1 | 2 | 3
export type PrioritySource = 'user' | 'model' | 'jev'
export type QueueMode = 'run' | 'paused'
export interface AgentTaskReference {
  taskId: string
  alias: string
  title: string
  revision: number
  duplicate: boolean
}
export interface AgentTaskNote {
  noteId: string
  taskId: string
  kind: 'note' | 'result'
  text: string
  createdAt: string
  source: 'agent'
  provenance: 'tool'
}
export interface OwnerComment {
  commentId: string
  text: string
  createdAt: string
  updatedAt: string
  revision: number
}
export type AgentTaskActionArgs = { taskId: string; expectedRevision: number; expectedFocusRevision: number } & (
  | { action: 'current' | 'defer'; note?: never }
  | { action: 'done'; note?: string }
  | { action: 'note'; note: string }
)
export type OwnerTaskChangeAction = 'created' | 'edited' | 'reordered' | 'deferred' | 'deleted' | 'reopened' | 'noted' | 'completed' | 'current' | 'restored' | 'step' | 'commented' | 'comment-edited' | 'comment-deleted'
export interface TaskReturnContext { result: string | null; ownerComment: string | null }
export interface TaskContextEntry { taskId: string; alias: string; title: string; priorityPinned?: boolean; returnCount?: number; returnContext?: TaskReturnContext }
export type TaskPageList = 'queue' | 'deferred' | 'closed'
export interface TaskPageEntry extends TaskContextEntry {
  summary?: string
  status: TaskStatus; updatedAt: string; priorityPinned: boolean
  description?: string
  priority?: Priority; queuePosition?: number; revision?: number; needsDecision?: boolean
  stepCounts?: { total: number; done: number; active: number }; discussionCount?: number
  certaintySource?: SourceKind; createdAt?: string; elapsedMs?: number; activeSince?: string | null; closedAt?: string
}
export interface TaskPage { list: TaskPageList; offset: number; total: number; tasks: TaskPageEntry[] }
export type TaskSearchField = 'number' | 'title' | 'description' | 'acceptance' | 'constraints' | 'result' | 'comment'
// `inside` — совпадение в тексте карточки, когда лучшее совпадение — название или номер.
export type TaskSearchInsideField = Exclude<TaskSearchField, 'number' | 'title'>
export interface TaskSearchRow extends TaskPageEntry { match: { field: TaskSearchField; snippet: string; inside?: { field: TaskSearchInsideField; snippet: string } } }
export interface TaskSearchPage { total: number; rows: TaskSearchRow[] }
export interface TaskSearch { offset: number; limit: number; lists: Partial<Record<TaskPageList, TaskSearchPage>>; truncated: boolean }
export interface TaskSearchQuery { terms: string[]; numbers: string[] }
export interface TaskResolution extends TaskContextEntry { status: TaskStatus; revision: number }
export interface TaskLoopState {
  cursor?: number
  shown?: string | null
  comments: [string, number][]
  ownerNotes: string[]
  updated: boolean
}
export type TaskLoopStates = Record<string, TaskLoopState>
export interface WorkJob { jobId: string; agent: 'codex' | 'antigravity'; mode: 'analyze' | 'review' | 'implement' }
export interface TaskWorkTrail { startRevision?: string; jobs: WorkJob[] }
export type TaskWorkTrails = Record<string, TaskWorkTrail>
export interface TaskContext {
  binding: Binding
  current: (TaskContextEntry & { revision: number; description: string; acceptance: string[]; constraints: string[]; ownerNotes: Checkpoint[]; ownerComments: OwnerComment[]; agentNotes: AgentTaskNote[] }) | null
  queue: (TaskContextEntry & { description: string })[]
  deferred: TaskContextEntry[]
  closed: TaskContextEntry[]
  counts: { total: number; open: number; active: number; queued: number; deferred: number; done: number; cancelled: number; closedLast24h: number; projectOpen: number }
  ownerChanges: { eventId: number; taskId: string; action: OwnerTaskChangeAction; createdAt: string }[]
  cursor: number
}
export interface TaskFields {
  title?: string
  description?: string
  acceptance?: string[]
  constraints?: string[]
  assignee?: Assignee | null
  priority?: Priority
}
export interface TaskRankResult {
  changed: { taskId: string; priority: Priority }[]
  skipped: { taskId: string; reason: 'pinned' | 'stale' | 'terminal' | 'not-found' | 'candidate' }[]
}
export type InboxType = 'info' | 'proposal' | 'question' | 'decision' | 'approval' | 'conflict' | 'blocking'
export type TriageStatus = 'untriaged' | 'triaged' | 'rejected'
export type CheckpointKind = 'commit' | 'tests-passed' | 'note' | 'detour' | 'return'
export type GateMode = 'off' | 'observe'
export type GateOutcome = 'ALLOW' | 'BIND' | 'BLOCK'
export type GateReason = 'foreign-lease' | 'stale-read' | 'blocking-inbox' | 'pending-decision'
export type ExtractionCode = 'extracted' | 'no-tasks' | 'skipped-gate' | 'no-attestation' | 'model-timeout' | 'model-unparsable' | 'runtime-rejected' | 'error'
export interface ExtractionStats {
  counts: Record<ExtractionCode, number>
  lastSuccessAt: string | null
  consecutiveFailures: number
  lastReason: ExtractionCode | null
  ownerRequests: number
}

export interface GateSummary {
  mode: GateMode
  counts: Record<GateOutcome, number>
  blockReasons: Record<GateReason, number>
}

export interface GateObservation {
  observationId: number
  outcome: GateOutcome
  reasons: GateReason[]
  taskId: string | null
  resource: { resourceId: string; path: string | null }
  sessionId: string
  observedAt: string
}

export interface Binding {
  projectId: string
  worktreeId: string
  sessionId: string
  worktreePath?: string
}

export interface TaskStep { position: number; title: string; status: 'pending' | 'active' | 'done' | 'blocked' }

export interface TaskSummary {
  summary?: string
  returnCount?: number
  returnContext?: TaskReturnContext
  stage?: TaskStage
  adoptedBy?: Actor | null
  dismissReason?: DismissReason | null
  dismissedAt?: string | null
  taskId: string
  alias: string
  title: string
  status: TaskStatus
  revision: number
  certainty: Certainty
  certaintySource: SourceKind
  certaintyProvenance: Provenance
  assignee?: Assignee | null
  priority?: Priority
  prioritySource?: PrioritySource
  priorityPinned?: boolean
  description?: string
  acceptance?: string[]
  constraints?: string[]
  createdAt?: string
  updatedAt?: string
  queuePosition?: number | null
  steps?: TaskStep[]
  sourcePhrase?: string | null
  lastCheckpoint?: Checkpoint | null
  needsDecision?: boolean
  elapsedMs?: number
  activeSince?: string | null
  deleted?: boolean
  stepCounts?: { total: number; done: number; active: number }
  discussionCount?: number
  closedAt?: string
}

export interface Task extends TaskSummary {
  description?: string
  acceptance?: string[]
  constraints?: string[]
  projectId: string
  worktreeId: string
  origin: 'ad-hoc' | 'no-source'
  createdAt: string
  updatedAt: string
  source: { inboxId: string; start: number; end: number; sha256: string } | null
}

export interface Focus {
  task: Task | null
  revision: number
}

export interface InboxPreview {
  inboxId: string
  capturedAt: string
  length: number
  preview: string | null
  type: InboxType | null
  classifiedBy: 'rule' | 'user' | 'jev' | null
  scope: { taskId: string | null; resourceId: string | null }
  policyVersion: string | null
  confidence: number | null
  mode: 'shadow' | 'active' | null
  observedAt: string | null
  triageStatus: TriageStatus
  triageRevision: number
  provenance: Provenance
  triageProvenance: Provenance
}

export interface Checkpoint {
  checkpointId: string
  taskId: string
  kind: CheckpointKind
  text: string
  source: SourceKind
  provenance: Provenance
  createdAt: string
}

export interface ReturnPacket {
  taskId: string
  title: string
  checkpoints: Checkpoint[]
  inbox: InboxPreview[]
}

export interface Timeline {
  taskId: string
  taskRevision: number
  checkpoints: Checkpoint[]
  status: 'ready' | 'unavailable'
}

export interface Snapshot {
  candidates?: TaskSummary[]
  candidateCount?: number
  extraction?: ExtractionStats
  binding: Binding
  focus: Focus
  inboxCounts: { total: number; untriaged: number }
  inboxTriageCounts: { untriaged: number; blocking: number }
  tasks: TaskSummary[]
  openTaskCount?: number
  tasksTruncated?: boolean
  taskCounts?: { active: number; deferred: number; done: number; queued: number }
  workingTasks?: TaskSummary[]
  inbox: InboxPreview[]
  captureMode: CaptureMode
  focusStack: { taskId: string; depth: number; provenance: Provenance }[]
  schemaVersion: 1
  storageSchemaVersion: 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13
  queue?: QueueMode
  gate: GateSummary
}

export interface Permission {
  present: boolean
  mode: string | null
  ok: boolean
}

export interface Doctor {
  extraction?: ExtractionStats
  integrityCheck: string[]
  foreignKeyCheck: { table: string; rowId: number | null; parent: string; fkIndex: number }[]
  schemaVersion: 1
  storageSchemaVersion: 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13
  permissions: {
    directory: Permission
    files: Record<'cockpit.db' | 'cockpit.db-wal' | 'cockpit.db-shm', Permission>
  }
  counts: Record<'projects' | 'worktrees' | 'sessions' | 'inbox' | 'tasks' | 'task_sources' | 'focus' | 'events' | 'requests' | 'config' | 'inbox_observations' | 'checkpoints' | 'focus_stack' | 'project_config' | 'worktree_leases' | 'gate_observations' | 'session_attestations', number>
    & Partial<Record<'task_steps' | 'task_lists' | 'attestation_revocations' | 'task_agent_notes' | 'task_closures' | 'task_owner_comments' | `extraction.${ExtractionCode}`, number>> & { 'extraction.last-success-at'?: string }
}

export interface Projection {
  // Последний полный snapshot и более свежие подтверждённые частичные ответы.
  snapshot: Snapshot | null
  focus: Focus | null
  captureMode: CaptureMode | null
  connection: { status: 'idle' | 'ready' | 'degraded' | 'unavailable'; detail: string }
  counters: { requests: number; failures: number; captures: number }
  contextPercent: number | null
  // Только отфильтрованные рантаймом отметки, полученные по действию человека.
  timeline: Timeline | null
  gate: GateSummary | null
  panelProvenance: Provenance
  attestationStatus: 'unconfirmed' | 'confirmed' | 'conflict'
}

export interface RuntimeWitness {
  runtimeSessionId: string
  epoch: number
  ownerRoot: string
  loadId: string
  // Время живости владельца; прежние версии не записывали его.
  heartbeatAt?: number
}
export type RuntimeWitnesses = Record<string, RuntimeWitness>

export type OwnerTaskKind = 'do' | 'answer' | 'choose'
export type OwnerTaskState = 'open' | 'done' | 'rejected' | 'withdrawn'
export type OwnerTaskUpdate = 'none' | 'pending' | 'delivered'
export interface OwnerTask {
  taskReturned?: boolean
  id: number
  title: string
  why: string
  doneWhen?: string
  kind: OwnerTaskKind
  options?: readonly string[]
  state: OwnerTaskState
  answer?: string
  reason?: string
  update: OwnerTaskUpdate
  sessionId: string
  createdMs: number
  updatedMs: number
  taskAlias?: string
  taskTitle?: string
  result?: string
  remarks?: readonly string[]
}
export interface OwnerEditing {
  id: number
  /** read: задача развёрнута целиком, с переносом строк. */
  field: 'answer' | 'read' | 'review-reject' | 'review-comment'
  /** Признак удержанного ответа; сам текст в состояние не пишется. */
  held?: string
}

export interface CockpitTasksReturnInput { id: number; taskAlias: string; comment: string }
export type CockpitTasksReturnResult = 'reopened' | 'unavailable' | 'failed'
export interface CockpitTasks { returnReview: (input: CockpitTasksReturnInput) => Promise<CockpitTasksReturnResult> }

declare module 'claude-code' {
  interface EngineInterface { cockpitTasks: CockpitTasks }
  interface PluginState {
    cockpit: {
      projection: Projection
      attestations: RuntimeWitnesses
      taskLoop: TaskLoopStates
      workTrails: TaskWorkTrails
      resumeTrace: readonly { at: number; event: string; detail?: string }[]
      autoOpenAttempted: boolean
      ownerTasks: readonly OwnerTask[]
      ownerNextId: number
      ownerSelectedId: number | null
      ownerEditing: OwnerEditing | null
      ownerLoadedFor: string | null
      ownerWorking: boolean
    }
  }
}

// Учёт ходов для продолжения работы после ручного сжатия. Чистая логика: события движка приходят аргументами.
//
// Движок сообщает о ходе двумя событиями, и оба ненадёжны как единственный признак. Начало хода не говорит, чей это
// ход: побочный запрос (подсказка, заголовок сессии) начинается так же, как ход главной ленты, только без текста, и
// становится отличим лишь по концу — с agentId. Конец оборванного хода может прийти позже начала сжатия: команда,
// набранная во время хода, сама обрывает его и запускается, не дожидаясь, пока моды обработают конец.
// Поэтому ход без текста ничего не решает, пока не известен его вид, а «оборван» выводится и из отметки конца,
// и из того, что ход главной ленты шёл в момент запроса сжатия.

export type TurnEnd = 'answer' | 'aborted' | 'refusal' | 'error'

export interface ResumeTracker {
  // Сессия и каталог, где оборван последний ход главной ленты; null — последний ход закончился сам либо начался новый.
  mark: string | null
  // Идущие ходы: true — начат репликой (ход главной ленты), false — без текста (вид станет известен по концу).
  open: Map<string, boolean>
  // Чем закончились последние ходы главной ленты: нужно сжатию, запрошенному до конца хода.
  ended: Map<string, TurnEnd>
  // Сколько ходов главной ленты началось: продолжение не отправляется, если после сжатия начался новый.
  mainTurns: number
}

const ENDED_LIMIT = 8

export function newResumeTracker(): ResumeTracker {
  return { mark: null, open: new Map(), ended: new Map(), mainTurns: 0 }
}

// Начало хода. Ход с текстом — работа главной ленты: прежнее прерывание больше не действует.
export function turnStarted(tracker: ResumeTracker, turnId: string, text: string): 'main' | 'unknown' {
  const main = text.trim() !== ''
  tracker.open.set(turnId, main)
  if (!main) return 'unknown'
  tracker.mainTurns += 1
  tracker.mark = null
  return 'main'
}

// Конец хода. С agentId — побочный запрос либо субагент: отметку и счёт ходов главной ленты он не трогает.
export function turnCompleted(tracker: ResumeTracker, turnId: string, agentId: string | undefined, reason: TurnEnd, session: string | null): 'main' | 'side' {
  const started = tracker.open.get(turnId)
  tracker.open.delete(turnId)
  if (agentId !== undefined) return 'side'
  // Ход без текста оказался ходом главной ленты (продолжение): считается начавшимся только теперь.
  if (started === false) tracker.mainTurns += 1
  tracker.mark = reason === 'aborted' ? session : null
  tracker.ended.set(turnId, reason)
  while (tracker.ended.size > ENDED_LIMIT) tracker.ended.delete(tracker.ended.keys().next().value as string)
  return 'main'
}

// Ходы, которые сжатие могло оборвать: начатые репликой, а при работающей главной ленте — и ходы без текста.
export function cutCandidates(tracker: ResumeTracker, engineWorking: boolean | undefined): string[] {
  return [...tracker.open].filter(([, main]) => main || engineWorking === true).map(([turnId]) => turnId)
}

// После сжатия: оборван ли ход, шедший в момент запроса. Ход, конец которого так и не пришёл, оборван сжатием и
// больше не идёт; ход, закончившийся ответом за время сжатия, владелец не прерывал.
export function cutByCompact(tracker: ResumeTracker, candidates: readonly string[]): boolean {
  let cut = false
  for (const turnId of candidates) {
    if (tracker.open.has(turnId)) { tracker.open.delete(turnId); cut = true }
    else if (tracker.ended.get(turnId) === 'aborted') cut = true
  }
  return cut
}

// Почему мод не продолжил работу после ручного сжатия при включённой настройке. Владелец видит причину всегда,
// когда сессия осталась ждать его: молчание неотличимо от поломки.
export type ResumeRefusal = 'self-ended' | 'no-task' | 'unread' | 'not-sent'
const REFUSALS: Record<ResumeRefusal, string> = {
  'self-ended': 'ход не был прерван',
  'no-task': 'нет текущей задачи',
  unread: 'текущая задача не прочитана',
  'not-sent': 'реплика не отправлена',
}
export function resumeRefusal(reason: ResumeRefusal): string {
  return `После сжатия не продолжаю: ${REFUSALS[reason]}. Напиши «продолжи».`
}

// След решений о продолжении: короткое кольцо записей без текста реплик и задач. По нему видно, на каком шаге мод
// промолчал, когда события движка пришли в непривычном порядке.
export interface ResumeTrace { at: number; event: string; detail?: string }
export const TRACE_LIMIT = 40
export function traced(trace: ResumeTrace[], at: number, event: string, detail?: string): void {
  trace.push({ at, event, ...(detail === undefined ? {} : { detail: detail.slice(0, 80) }) })
  if (trace.length > TRACE_LIMIT) trace.splice(0, trace.length - TRACE_LIMIT)
}

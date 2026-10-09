import type { Certainty, Checkpoint, CheckpointKind, Doctor, InboxPreview, InboxType, Projection, Provenance, ReturnPacket, TaskStatus, TriageStatus } from '../../types/index'
import { stripPastedContent } from './privacy.ts'
import { displayTaskNumber } from './task-number.ts'

const STATUS_TEXT: Record<TaskStatus, string> = { active: 'активна', paused: 'в бэклоге', done: 'готово', cancelled: 'отменена' }
const CERTAINTY_TEXT: Record<Certainty, string> = { observed: 'обнаружена', inferred: 'предположена', confirmed: 'подтверждена', verified: 'проверена' }
const TRIAGE_TEXT: Record<TriageStatus, string> = { untriaged: 'не разобран', triaged: 'разобран', rejected: 'отклонён' }
export const INBOX_TYPES: readonly (InboxType | null)[] = ['info', 'proposal', 'question', 'decision', 'approval', 'conflict', 'blocking', null]
const TYPE_TEXT: Record<InboxType, string> = { info: 'информация', proposal: 'предложение', question: 'вопрос', decision: 'решение', approval: 'согласование', conflict: 'конфликт', blocking: 'блокирующий' }
const CHECKPOINT_TEXT: Record<CheckpointKind, string> = { commit: 'коммит', 'tests-passed': 'тесты пройдены', note: 'отметка', detour: 'отход', return: 'возврат' }

export function commandInput(args: string): { mode: string; text: string } {
  const entry = /^\s*(note|detour)(?:\s([\s\S]*))?$/.exec(args)
  // Удаляется только разделитель после команды; сам текст остаётся дословным.
  return entry ? { mode: entry[1] ?? '', text: entry[2] ?? '' } : { mode: args.trim(), text: '' }
}

export function inboxTypeText(type: InboxType | null): string { return type === null ? 'не определён' : TYPE_TEXT[type] }
export function provenanceText(value: Provenance): string { return value === 'panel' ? 'панель' : 'командная строка' }

export function classificationText(entry: InboxPreview, withProvenance = true): string {
  const by = entry.classifiedBy === null ? 'не определено' : { rule: 'правило (догадка)', user: entry.provenance === 'panel' ? 'вы' : 'командная строка', jev: 'Jev' }[entry.classifiedBy]
  return `Вид: ${inboxTypeText(entry.type)} · Кем поставлен: ${by}${entry.mode === 'shadow' ? ' · пробная классификация' : ''}${withProvenance && entry.classifiedBy === 'user' ? ` · ${provenanceText(entry.provenance)}` : ''}`
}

export function triageEntryText(entry: InboxPreview, withProvenance = true): string {
  return `Разбор: ${TRIAGE_TEXT[entry.triageStatus]}${entry.scope.taskId === null ? '' : ' · привязан к задаче'}${withProvenance && entry.classifiedBy === 'user' ? ` · ${provenanceText(entry.triageProvenance)}` : ''}`
}

export function line(text: string, limit?: number): string {
  const safe = stripPastedContent(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return limit === undefined ? safe : [...safe].slice(0, limit).join('')
}

export function statusLine(state: Projection): string {
  const connection = { idle: 'не проверена', ready: 'доступна', degraded: 'нарушена (degraded)', unavailable: 'недоступна' }[state.connection.status]
  const capture = state.captureMode === null ? 'неизвестен' : { 'full-local': 'полный локальный', redacted: 'redacted — не поддерживается в M1', off: 'выключен' }[state.captureMode]
  const detail = state.connection.status === 'ready' ? '' : ` ${state.connection.detail}`
  const attestation = state.attestationStatus === 'confirmed' ? `Записи: ${provenanceText(state.panelProvenance)}.`
    : state.attestationStatus === 'conflict'
      ? 'Задачи временно недоступны: панель не смогла подтвердить себя рантайму. Перезапустите сессию.'
      : 'Записи: свидетельство не подтверждено; действия человека приостановлены.'
  return `Связь: ${connection}.${detail} Захват: ${capture}. Контекст: ${state.contextPercent === null ? 'недоступно' : `${state.contextPercent}%`}. Режим: observe. ${attestation}`
}

export function focusText(state: Projection, withProvenance = true): string {
  const task = state.focus?.task
  if (task?.status === 'done' || task?.status === 'cancelled') return `${displayTaskNumber(task.alias)} · ${line(task.title)}\nСтатус: ${STATUS_TEXT[task.status]}; фокус очищен рантаймом. Полный snapshot ещё не обновлён.`
  if (task) return `${displayTaskNumber(task.alias)} · ${line(task.title)}\nСтатус: ${STATUS_TEXT[task.status]}. Уверенность: ${CERTAINTY_TEXT[task.certainty]}.\nПроисхождение: ${task.origin === 'ad-hoc' ? 'ad-hoc — из сохранённого указания' : 'no-source — без сохранённого указания'}.${withProvenance && task.certaintySource === 'user' ? ` Уверенность: ${provenanceText(task.certaintyProvenance)}.` : ''}`
  return state.focus === null ? 'Данные фокуса пока не получены.' : 'Без задачи: фокус пуст.'
}

export function inboxText(state: Projection): string {
  const snapshot = state.snapshot
  if (snapshot === null) return 'Данные входящих пока не получены.'
  return `${inboxCountsText(state)}\n${snapshot.inbox.length === 0 ? 'Входящих записей нет.' : snapshot.inbox.map(entry => `${entry.capturedAt} · ${entry.length} символов · ${entry.preview === null ? 'предпросмотр недоступен' : line(entry.preview)}\n${classificationText(entry)}\n${triageEntryText(entry)}`).join('\n')}`
}

export function inboxCountsText(state: Projection): string {
  return state.snapshot === null ? 'Счётчики входящих недоступны.' : `Входящие: ${state.snapshot.inboxCounts.total}; не разобрано: ${state.snapshot.inboxTriageCounts.untriaged}; блокирующих: ${state.snapshot.inboxTriageCounts.blocking}.`
}

export function triageText(state: Projection): string {
  if (!state.snapshot) return 'Данные входящих пока не получены.'
  const entries = state.snapshot.inbox.filter(entry => entry.triageStatus === 'untriaged')
  return `${inboxCountsText(state)}\n${entries.length === 0 ? 'В показанной части входящих неразобранных пунктов нет.' : entries.map(entry => `${inboxTypeText(entry.type)} · ${entry.preview === null ? 'предпросмотр недоступен' : line(entry.preview, 80)}`).join('\n')}`
}

export function gateText(state: Projection): string {
  const gate = state.gate
  if (!gate) return 'Данные стража пока не получены.'
  if (gate.mode === 'off') return 'Страж выключен. Включение для проекта: cockpitctl config set gate observe.'
  const reasons = gate.blockReasons
  return `Страж (наблюдение), текущая сессия: ALLOW ${gate.counts.ALLOW}, BIND ${gate.counts.BIND}, BLOCK ${gate.counts.BLOCK}.\n`
    + `Причины: чужая аренда ${reasons['foreign-lease']}, устаревшее чтение ${reasons['stale-read']}, блокирующий пункт ${reasons['blocking-inbox']}, ожидающее решение ${reasons['pending-decision']}.`
}

export function checkpointText(entry: Checkpoint, withProvenance = true): string {
  return `${entry.createdAt} · ${CHECKPOINT_TEXT[entry.kind]} · ${line(entry.text)}${withProvenance ? ` · ${provenanceText(entry.provenance)}` : ''}`
}

export function timelineText(state: Projection): string {
  const task = state.focus?.task
  if (!task) return 'Отметки\nДля ленты задачи нужен фокус.'
  const timeline = state.timeline
  if (!timeline || timeline.taskId !== task.taskId) return 'Отметки\nЛента задачи ещё не прочитана. Откройте «Фокус» или панель заново.'
  if (timeline.status === 'unavailable') return 'Отметки\nЛента задачи недоступна. Откройте «Фокус» или панель заново.'
  const stale = timeline.taskRevision !== task.revision ? '\nЗадача изменилась; лента обновится при повторном открытии.' : ''
  return `Отметки\n${timeline.checkpoints.length === 0 ? 'В ленте задачи пока нет отметок.' : timeline.checkpoints.slice(0, 5).map(entry => checkpointText(entry, true)).join('\n')}${stale}`
}

export function returnPacketText(packet: ReturnPacket): string {
  return `Возврат к задаче: ${line(packet.title)}\nОтметки\n${packet.checkpoints.length === 0 ? 'В ленте задачи пока нет отметок.' : packet.checkpoints.map(entry => checkpointText(entry, true)).join('\n')}\nНеразобранные входящие задачи\n${packet.inbox.length === 0 ? 'Нет.' : packet.inbox.map(entry => `${inboxTypeText(entry.type)} · ${entry.preview === null ? 'предпросмотр недоступен' : line(entry.preview)}`).join('\n')}`
}

// Данные и раскладка экрана не зависят от API хоста и проверяются отдельно.
export function paneModel(state: Projection, tab: 'focus' | 'inbox', _selectedId: string | null, columns: number) {
  const task = state.focus?.task
  const timeline = state.timeline
  const timelineParts = task && timeline?.taskId === task.taskId && timeline.status === 'ready' && timeline.checkpoints.length > 0
    ? [{ text: 'Отметки', dim: false }, ...timeline.checkpoints.slice(0, 5).flatMap(entry => [
      { text: `\n${checkpointText(entry, false)}`, dim: false },
      { text: ` · ${provenanceText(entry.provenance)}`, dim: entry.provenance === 'cli' },
    ]), { text: timeline.taskRevision !== task.revision ? '\nЗадача изменилась; лента обновится при повторном открытии.' : '', dim: false }]
    : [{ text: timelineText(state), dim: false }]
  return {
    tab, direction: columns < 60 ? 'column' as const : 'row' as const,
    focus: focusText(state, false), timeline: timelineText(state), timelineParts, counts: inboxCountsText(state), connection: statusLine(state),
    focusProvenance: task?.certaintySource === 'user' ? ` Уверенность: ${provenanceText(task.certaintyProvenance)}.` : '',
    focusIsCli: task?.certaintyProvenance === 'cli',
    gate: state.gate?.mode === 'observe' && state.gate.counts.BLOCK > 0 ? `Страж (наблюдение): остановил бы ${state.gate.counts.BLOCK} раз` : null,
    canConfirm: !!task && task.certainty !== 'confirmed' && task.certainty !== 'verified',
    canChangeStatus: task?.status === 'active' || task?.status === 'paused',
    canBind: !!task && task.status !== 'done' && task.status !== 'cancelled',
  }
}

export function tasksText(state: Projection): string {
  if (state.snapshot === null) return 'Данные задач пока не получены.'
  return state.snapshot.tasks.length === 0 ? 'Задач пока нет.' : state.snapshot.tasks.map(task => `${displayTaskNumber(task.alias)} · ${line(task.title)} · ${STATUS_TEXT[task.status]}${task.certaintySource === 'user' ? ` · ${provenanceText(task.certaintyProvenance)}` : ''}`).join('\n')
}

export function statusText(state: Projection): string {
  return `Cockpit\n${focusText(state)}\n${inboxCountsText(state)}\n${statusLine(state)}`
}

export function abovePromptText(state: Projection): string | undefined {
  if (state.connection.status === 'unavailable') return 'Cockpit: рантайм недоступен'
  const task = state.focus?.task
  if (!task || task.status === 'done' || task.status === 'cancelled' || !state.snapshot) return undefined
  const blocking = state.snapshot.inboxTriageCounts.blocking
  return `${displayTaskNumber(task.alias)} · ${line(task.title, 48)} · inbox ${state.snapshot.inboxCounts.total}${blocking > 0 ? ` · блокирующих ${blocking}` : ''}`
}

export function doctorText(doctor: Doctor): string {
  const integrity = doctor.integrityCheck.length === 1 && doctor.integrityCheck[0] === 'ok' ? 'в порядке' : 'найдены ошибки'
  const permissions = doctor.permissions.directory.ok && Object.values(doctor.permissions.files).every(file => !file.present || file.ok) ? 'в порядке' : 'нарушены'
  return `Cockpit · диагностика\nСхема: ${doctor.schemaVersion}. Целостность: ${integrity}. Ошибок внешних ключей: ${doctor.foreignKeyCheck.length}.\nПрава: ${permissions}. Задач: ${doctor.counts.tasks}; входящих: ${doctor.counts.inbox}; сессий: ${doctor.counts.sessions}.`
}

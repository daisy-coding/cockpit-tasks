// Разбор запросов, сообщения и защита ответов перенесены из Human in the loop.
import type { OwnerTask as Task, OwnerTaskKind as TaskKind, OwnerEditing } from '../../types'
import { ago, oneLine, plural, sizeOf, clean, cleanOwnerBody, ownerBodyError, plainOwnerBody, mixesScripts, plain, skeleton } from './text'
import type { PanelAction } from '../panel-actions'
import { ownerShownTitle, SAVED_CARD_HEIGHT, type SavedTone } from './saved-cards'
import { displayTaskNumber } from '../domain/task-number.ts'
import { createSecretView } from '../secret-view.ts'

export const MAX_OPEN = 5
export const MAX_TITLE = 80
export const MAX_REASON = 2000
export const WITHDRAW_RULE = 'Как только из разговора или проверки видно, что задача владельцу выполнена или потеряла смысл, отзови её через mcp__cockpit__withdraw_task с причиной в том же ходе. Не проси владельца отмечать её в панели.'
const MAX_WHY = 300
// Карточка во вкладке «Мне» показывает под названием восемь строк. Тело поручения — why и done_when вместе —
// ограничено тем же числом, что review карточки приёмки: на панели обычной ширины это до восьми строк. Текст сверх
// предела не обрезается молча, а возвращается агенту — подробности он пишет в разговоре.
export const MAX_ASK_BODY = 300
const MAX_OPTION = 60
const MAX_INLINE_ANSWER = 2000

const KINDS: readonly TaskKind[] = ['do', 'answer', 'choose']

export function isActive(task: Task): boolean {
  return task.state === 'open'
}

export function isShown(task: Task): boolean {
  return isActive(task) || task.update === 'pending'
}

export function sameAsk(a: string, b: string): boolean {
  const norm = (s: string) => oneLine(skeleton(s).replace(/[^\p{L}\p{N}\s]/gu, ' '))

  return norm(a) === norm(b)
}

export type Ask = Pick<Task, 'title' | 'why' | 'doneWhen' | 'kind' | 'options'>

// fits: false — карточка приёмки, её текст ограничен отдельно (review в task_done).
export function parseAsk(args: Record<string, unknown>, fits = true): Ask | { error: string } {
  const text = (key: string) => (typeof args[key] === 'string' ? clean(args[key] as string) : '')
  const title = text('title')
  const why = typeof args.why === 'string' ? cleanOwnerBody(args.why) : ''
  const doneWhen = typeof args.done_when === 'string' ? cleanOwnerBody(args.done_when) : ''
  const kind = args['kind'] ?? 'do'

  if (title === '') {
    return { error: 'Нужно title: что владелец должен сделать, в повелительном наклонении.' }
  }

  if (title.length > MAX_TITLE) {
    return { error: `В title ${title.length} знаков; предел ${MAX_TITLE}, остальное помести в why.` }
  }

  if (why === '') {
    return { error: 'Нужно why: одно предложение о том, что это позволит продолжить.' }
  }

  const bodyError = ownerBodyError(why, 'why') ?? ownerBodyError(doneWhen, 'done_when')
  if (bodyError) return { error: bodyError }

  if (fits && why.length + doneWhen.length > MAX_ASK_BODY) {
    return { error: `В why и done_when вместе ${why.length + doneWhen.length} знаков; предел ${MAX_ASK_BODY}: карточка владельца вмещает восемь строк. Сократи текст, подробности напиши в разговоре.` }
  }

  if (!KINDS.includes(kind as TaskKind)) {
    return { error: 'kind должен быть "do", "answer" или "choose".' }
  }

  const raw = Array.isArray(args['options']) ? args['options'] : []
  const options = raw.filter((o): o is string => typeof o === 'string').map(clean).filter(o => o !== '')

  if (kind === 'choose' && (options.length < 2 || options.length > 4)) {
    return { error: 'Для choose нужно от 2 до 4 вариантов.' }
  }

  if (![title, ...options].every(plain) || !plainOwnerBody(why) || !plainOwnerBody(doneWhen)) {
    return { error: 'В тексте задачи допустимы буквы латиницы и кириллицы, цифры и обычная пунктуация: без эмодзи, иероглифов, греческих и специальных знаков.' }
  }

  if (options.some(mixesScripts)) {
    return { error: 'В варианте выбора латиница и кириллица смешаны в одном слове: напиши слово одним алфавитом.' }
  }

  if (options.some((o, i) => options.some((other, j) => j < i && sameAsk(o, other)))) {
    return { error: 'Варианты должны различаться на вид: два из них совпадают после очистки.' }
  }

  if (options.some(o => o.length > MAX_OPTION)) {
    return { error: `Каждый вариант должен быть не длиннее ${MAX_OPTION} знаков.` }
  }

  return {
    title,
    why: why.slice(0, MAX_WHY),
    ...(doneWhen === '' ? {} : { doneWhen: doneWhen.slice(0, MAX_WHY) }),
    kind: kind as TaskKind,
    ...(kind === 'choose' ? { options } : {}),
  }
}

function bodyOf(task: Task, isFull: boolean): string {
  switch (task.state) {
    case 'rejected':
      if (task.taskAlias) return `Владелец выбрал: «Есть замечания» (не принято).${task.reason ? ` Причина владельца: «${task.reason}»` : ''} ${reviewRejectionHint(task)}`
      return task.reason ? `Причина владельца: «${task.reason}»` : 'Причина не указана.'
    case 'withdrawn':
      return task.reason ? `Ты отозвал задачу: ${task.reason}` : 'Ты отозвал задачу.'
    case 'done':
      if (task.answer === undefined || task.answer === '') {
        return ''
      }

      if (task.kind === 'choose' && task.options?.includes(task.answer) || task.taskAlias && ['Принято', 'Есть замечания'].includes(task.answer)) {
        if (task.taskAlias) {
          const hint = task.answer === 'Принято'
            ? 'Подсказка агенту: «Принято» — ничего не делать. Закрытую задачу агент не переоткрывает.'
            : task.answer === 'Есть замечания'
              ? reviewRejectionHint(task)
              : ''
          return hint ? `Владелец выбрал: «${task.answer}». ${hint}` : `Владелец выбрал: «${task.answer}»`
        }
        return `Владелец выбрал: «${task.answer}»`
      }

      if (!isFull && task.answer.length > MAX_INLINE_ANSWER) {
        return `Ответ владельца (${sizeOf(task.answer.length)}) сохранён: вызови list_tasks с id ${task.id}, чтобы прочитать его.`
      }

      return `Ответ владельца:\n${task.answer}`
    default:
      return (task.remarks ?? []).map(text => `Комментарий владельца без вердикта:\n${text}`).join('\n')
  }
}

export function newsOf(task: Task, isFull: boolean): string {
  const body = bodyOf(task, isFull)
  const remarks = task.state === 'open' ? '' : (task.remarks ?? []).map(text => `Комментарий владельца без вердикта:\n${text}`).join('\n')
  return `${ownerTaskReference(task)} ${stateOf(task.state)}: ${task.title}.${body === '' ? '' : ` ${body}`}${remarks ? `\n${remarks}` : ''}`
}

function ownWordsOf(task: Task): string {
  const head = `${ownerTaskReference(task)} ${task.title}:`

  switch (task.state) {
    case 'rejected':
      if (task.taskAlias) return `${head} Я выбрал «Есть замечания» (не принято).${task.reason ? ` ${task.reason}` : ''} ${reviewRejectionHint(task)}`
      return task.reason ? `${head} Не буду это делать. ${task.reason}` : `${head} Не буду это делать.`
    case 'done':
      if (task.answer === undefined || task.answer === '') {
        return `${head} Сделано.`
      }

      if (task.kind === 'choose' && task.options?.includes(task.answer) || task.taskAlias && ['Принято', 'Есть замечания'].includes(task.answer)) {
        if (task.taskAlias) {
          const hint = task.answer === 'Принято'
            ? 'Подсказка агенту: «Принято» — ничего не делать. Закрытую задачу агент не переоткрывает.'
            : task.answer === 'Есть замечания'
              ? reviewRejectionHint(task)
              : ''
          return hint ? `${head} Я выбрал «${task.answer}». ${hint}` : `${head} Я выбрал «${task.answer}».`
        }
        return `${head} Я выбрал «${task.answer}».`
      }

      return `${head}\n${task.answer}`
    default:
      return [head, ...(task.remarks ?? []).map(text => `Комментарий владельца без вердикта:\n${text}`)].join('\n')
  }
}

function reviewRejectionHint(task: Task): string {
  if (task.taskReturned) return `Задача ${displayTaskNumber(task.taskAlias ?? '')} возвращена в очередь с замечанием. Возьми её через task_start; новую задачу не заводи.`
  return `Подсказка агенту: «Есть замечания» — записать замечание новой задачей через task_add с place: "top" и ссылкой на ${displayTaskNumber(task.taskAlias ?? '')}. Закрытую задачу агент не переоткрывает.`
}

// В словах агенту внутренний номер поручения всегда назван словом, а решётка относится только к задаче.
export function ownerTaskReference(task: Task): string {
  const number = displayTaskNumber(task.taskAlias ?? '')
  return `поручение ${task.id}${number ? ` (задача ${number})` : ''}`
}

// На экране поручения различаются названием; внутренний номер инструмента владельцу не показывается.
export function ownerTaskCaption(task: Task): string {
  const number = displayTaskNumber(task.taskAlias ?? '')
  return `«${task.title}»${number ? ` (задача ${number})` : ''}`
}

export function messageOf(due: readonly Task[]): string {
  const lines = due.map(task => [ownWordsOf(task), ...(task.state === 'open' ? [] : (task.remarks ?? []).map(text => `Комментарий владельца без вердикта:\n${text}`))].join('\n'))

  return `${due.length === 1 ? 'Мой ответ на задачу, которую ты мне поставил:' : 'Мои ответы на задачи, которые ты мне поставил:'}\n\n${lines.join('\n\n')}`
}

export function digestOf(due: readonly Task[]): string {
  const lines = due.map(task => newsOf(task, false))

  return `Обновления задач владельцу с последнего чтения (cockpit):\n${lines.join('\n')}`
}

// Мостик меняет текст реплики до хука захвата: узнаём и готовое сообщение владельца.
export function isOwnerResponse(text: string): boolean {
  return isBridgeReply(text) || text.startsWith('Мой ответ на задачу, которую ты мне поставил:')
    || text.startsWith('Мои ответы на задачи, которые ты мне поставил:')
}

export function contextOf(shown: readonly Task[], sessionId: string, nowMs: number): string {
  const lines = shown.flatMap(task => {
    const earlier = task.sessionId === sessionId ? '' : ' (из прежней сессии)'
    if (!isActive(task)) return [newsOf(task, false)]
    const elapsed = Math.max(0, nowMs - task.createdMs)
    return [`${ownerTaskReference(task)} ${stateOf(task.state)}${earlier}: ${task.title}. ${task.why} (возраст: ${Math.floor(elapsed / 60_000)} мин)`,
      ...(elapsed > 30 * 60_000 ? [`${ownerTaskReference(task)}: проверь, не выполнена ли уже`] : [])]
  })

  return [
    'Задачи владельцу через инструменты cockpit (assign_task, list_tasks, withdraw_task):',
    ...lines,
    'Владелец видит их во вкладке «Мне» панели «Задачи». На рамке карточки стоит номер родительской задачи #N; у поручения без задачи номера нет. Называй поручение владельцу названием и номером задачи. В инструментах id — внутренний номер поручения, а не номер задачи.',
    WITHDRAW_RULE,
  ].join('\n')
}

export function listOf(tasks: readonly Task[], nowMs: number): string {
  if (tasks.length === 0) {
    return 'Подходящих задач нет.'
  }

  return tasks
    .map(task => {
      const age = ago(nowMs - task.createdMs)
      const detail = isActive(task)
        ? [task.taskAlias ? `Задача: ${displayTaskNumber(task.taskAlias)}` : '', `Зачем: ${task.why}`, task.doneWhen ? `Готово, когда: ${task.doneWhen}` : '', task.options ? `Варианты: ${task.options.join(' | ')}` : '']
        : bodyOf(task, true).split('\n')

      return [`${ownerTaskReference(task)} ${stateOf(task.state)}  назначена ${age}  ${task.title}`, ...detail]
        .filter(line => line.trim() !== '')
        .join('\n  ')
    })
    .join('\n\n')
}

export function assignedOf(task: Task, open: number): string {
  return [
    `Назначено ${ownerTaskReference(task)}: «${task.title}».`,
    'Владелец видит её во вкладке «Мне» панели «Задачи» до ответа. Ответ придёт сообщением или через list_tasks.',
    'Продолжай работу, которая от неё не зависит.',
    `Открытых задач: ${open} из ${MAX_OPEN}.`,
  ].join(' ')
}

export function statusOf(shown: readonly Task[], elsewhere = 0): string | undefined {
  const open = shown.filter(isActive).length
  const saved = shown.length - open
  const parts = [
    open > 0 ? `☐ ${plural(open, ['задача', 'задачи', 'задач'])} для тебя` : '',
    saved > 0 ? `${open > 0 ? '' : '✓ '}${plural(saved, ['ответ', 'ответа', 'ответов'])} ${saved === 1 ? 'не отправлен' : 'не отправлены'}` : '',
    elsewhere > 0 ? `${plural(elsewhere, ['задача', 'задачи', 'задач'])} в другой сессии` : '',
  ].filter(part => part !== '')
  return parts.length === 0 ? undefined : parts.join(', ')
}

export function stateOf(state: Task['state']): string {
  return ({ open: 'открыто', done: 'сделано', rejected: 'отклонено', withdrawn: 'отозвано' } as const)[state]
}

export type OwnerCard = { id: number; label: string; titleLines: string[]; context: string[]; height: number; selected: boolean; whole: boolean; review?: boolean;
  details?: string[]; detailsLength?: number; saved?: SavedTone; controls?: PanelAction[]; token?: string }
export type OwnerButton = 'long' | 'other-way' | 'edit' | 'send-anyway'
export const OWNER_LABELS: Record<OwnerButton, string> = {
  long: '[ В строку ввода ]', 'other-way': '[ Сохранить ]',
  edit: '[ Править ]', 'send-anyway': '[ Отправить всё равно ]',
}

export function ownerButtonLabel(button: OwnerButton, busy: boolean): string {
  return button === 'other-way' && busy ? '[ Отправить сейчас ]' : OWNER_LABELS[button]
}

// Ряды вспомогательных кнопок считаются до отрисовки, включая промежутки между ними.
function buttonRows(buttons: OwnerButton[], width: number, busy: boolean): OwnerButton[][] {
  const rows: OwnerButton[][] = []
  let row: OwnerButton[] = []
  let cells = 0
  for (const button of buttons) {
    const size = ownerButtonLabel(button, busy).length
    if (row.length && cells + 2 + size > width) { rows.push(row); row = []; cells = 0 }
    cells += (row.length ? 2 : 0) + size
    row.push(button)
  }
  if (row.length) rows.push(row)
  return rows
}

// Поле растёт вместе с текстом: движок переносит набранное, а рамка фиксированной высоты его обрезала.
export const MAX_INPUT_LINES = 8
export function inputLinesOf(cells: number, width: number): number {
  // Отрицательное значение — уже посчитанное число строк набранного текста (см. draftLines).
  if (cells < 0) return Math.max(1, Math.min(MAX_INPUT_LINES, -cells))
  // Двенадцать ячеек отданы рамке и подписи действия Enter справа от поля.
  return Math.max(1, Math.min(MAX_INPUT_LINES, Math.ceil((cells + 1) / Math.max(1, width - 12))))
}

// Ширина строки набранного текста: рамка и подпись действия Enter справа от поля.
export function draftWidth(width: number): number {
  return Math.max(4, width - 15)
}

// Поле движка однострочное: длинный текст оно обрезает многоточием. Поэтому текст делится на строки здесь:
// все, кроме последней, рисует панель, последнюю держит поле. Склейка строк даёт исходный текст без потерь.
export function draftLines(text: string, width: number, cells: (value: string) => number): string[] {
  const limit = Math.max(1, Math.floor(width))
  const lines: string[] = []
  let rest = text
  while (cells(rest) > limit) {
    let end = 0, used = 0, space = -1
    for (const char of rest) {
      const next = used + cells(char)
      if (next > limit) break
      used = next; end += char.length
      if (/\s/u.test(char)) space = end
    }
    const cut = space > 0 ? space : Math.max(end, [...rest][0]?.length ?? 1)
    lines.push(rest.slice(0, cut)); rest = rest.slice(cut)
  }
  lines.push(rest)
  return lines
}

export function ownerControlLayout(task: Task | undefined, field: OwnerEditing | null, width: number, hasInput: boolean, busy: boolean, whole: boolean, inputLines = 1) {
  const held = task !== undefined && field?.id === task.id && field.held !== undefined
  // Причина отказа пишется у карточки любого вида; комментарий без вердикта — только у приёмки.
  const reviewMode = task !== undefined && field?.id === task.id && (field.field === 'review-reject' || task.taskAlias && field.field === 'review-comment') ? field.field : undefined
  const legacyReview = task?.taskAlias && task.options?.length === 2 && task.options[0] === 'Принято' && task.options[1] === 'Есть замечания'
  const questions = task !== undefined && field?.id === task.id
  const options = whole && task?.kind === 'choose' && !legacyReview && questions ? (task.options ?? []).map(option => wrapPlain(option, Math.max(1, width - 4))) : []
  const warning = held ? [
    'Ответ похож на секрет.', 'Его увидят агент и журнал на диске.', 'Положи его на место и нажми «Сделано».',
  ].flatMap(text => wrapPlain(text, width)) : []
  const input = hasInput && task !== undefined && (Boolean(reviewMode) || held || !task.taskAlias && field?.id === task.id && field.field === 'answer')
  const buttons = input ? buttonRows(held ? ['edit', 'send-anyway'] : ['long', 'other-way'], width, busy) : []
  const height = options.reduce((sum, lines) => sum + lines.length, 0) + warning.length + (input ? inputLines + 2 : 0)
  return { options, warning, input, buttons, height, inputHeight: inputLines + 2, reviewMode }
}

function cardOf(task: Task, width: number, sessionId: string): OwnerCard {
  const titleLines = wrapPlain(ownerShownTitle(task), width)
  const context = fullLinesOf(task, width, task.sessionId !== sessionId).slice(titleLines.length)
  // На рамке — номер родительской задачи; самостоятельное поручение номера не имеет.
  return { id: task.id, label: displayTaskNumber(task.taskAlias ?? ''), titleLines, context, selected: false, whole: true,
    height: 2 + titleLines.length + context.length, review: Boolean(task.taskAlias) }
}

// Полнота, рамки и нижний блок используют один бюджет и одни и те же перенесённые строки.
export function ownerLayout(shown: readonly Task[], selectedId: number | null, editing: OwnerEditing | null, max = 28, width = 100, room = max, sessionId = '', hasInput = true, busy = false, expandedId: number | null = null, hasClient = true, draftCells = 0, collapsedCards = false) {
  const budget = Math.max(0, Math.min(max, room))
  const cardWidth = Math.max(1, width - 2)
  const textWidth = Math.max(1, cardWidth - 2)
  const active = shown.filter(isActive)
  const saved = shown.filter(task => !isActive(task))
  // Адрес поля или раскрытого текста не меняет порядок и оформление карточек.
  const selected = active.find(task => task.id === editing?.id) ?? active.find(task => task.id === expandedId)
    ?? active.find(task => task.id === selectedId) ?? active[0]
  const fullCards = active.map(task => cardOf(task, textWidth, sessionId))
  const full = fullCards.find(card => card.id === selected?.id)
  const reading = selected !== undefined && (expandedId === selected.id || editing?.id === selected.id && editing.field === 'read')
  const requested = selected !== undefined && (expandedId === selected.id || editing?.id === selected.id)
  // Поле ответа или раскрытый текст разворачивают только свою карточку: соседние остаются свёрнутыми.
  const displayCards = !collapsedCards ? fullCards : fullCards.map(card => requested && card.id === selected?.id ? card : ({ ...card, context: [],
    details: card.context.length <= 8 ? [...card.context] : [...card.context.slice(0, 7), card.context[7]!.slice(0, Math.max(0, textWidth - 1)).trimEnd() + '…'], detailsLength: card.context.length, height: 2 + card.titleLines.length, whole: card.height <= budget }))
  // Поле занимает столько строк, сколько нужно тексту, но не отнимает место у текста задачи: иначе решение закрылось бы посреди набора.
  let inputLines = inputLinesOf(draftCells, cardWidth)
  let fullControls = ownerControlLayout(selected, editing, cardWidth, hasInput, busy, true, inputLines)
  while (inputLines > 1 && displayCards.reduce((sum, card) => sum + card.height, 0) + fullControls.height > budget) {
    inputLines--
    fullControls = ownerControlLayout(selected, editing, cardWidth, hasInput, busy, true, inputLines)
  }
  const compactControls = ownerControlLayout(selected, editing, cardWidth, hasInput, busy, false, inputLines)
  // Если поле не оставляет места даже рамке, сохраняем карточку с отказом и значком раскрытия.
  const reservedControls = fullControls.height + 2 > budget ? compactControls : fullControls
  const needed = (full?.height ?? 0) + fullControls.height
  const together = displayCards.reduce((sum, card) => sum + card.height, 0) + fullControls.height + (saved.length ? 1 : 0)
  const isolated = requested && together > budget
  const expanded = reading
  // Рамке нужны обе стороны, варианту — ещё четыре ячейки префикса.
  // Ряд кнопок высотой в одну строку также должен входить в ширину без скрытого переноса.
  const fitsWidth = cardWidth >= 3 && (selected?.kind !== 'choose' || cardWidth >= 5)
    && (full === undefined || [...full.titleLines, ...full.context].every(line => line.length <= textWidth))
    && fullControls.buttons.flat().every(button => ownerButtonLabel(button, busy).length <= cardWidth)
  const candidates = (isolated ? displayCards.filter(card => card.id === selected?.id) : displayCards)
    .map(card => ({ ...card, titleLines: [...card.titleLines], context: [...card.context] }))
  let total = candidates.reduce((sum, card) => sum + card.height, 0) + reservedControls.height + (!isolated && saved.length ? 1 : 0)
  // При нехватке места одинаковое правило сокращает пояснения снизу вверх; заголовки сохраняются целиком.
  for (let index = candidates.length - 1; index >= 0 && total > budget; index--) {
    const card = candidates[index]!
    const cut = Math.min(Math.max(0, card.context.length - 1), total - budget)
    if (!cut) continue
    card.context = card.context.slice(0, card.context.length - cut)
    const last = card.context.length - 1
    card.context[last] = card.context[last]!.slice(0, textWidth - 1).trimEnd() + '…'
    card.height -= cut; card.whole = false; total -= cut
  }
  const cards: OwnerCard[] = []
  let used = reservedControls.height + (isolated && needed > budget && reservedControls.height < budget ? 1 : 0)
  for (const [index, card] of candidates.entries()) {
    const reserve = index < candidates.length - 1 || !isolated && saved.length ? 1 : 0
    if (used + card.height + reserve <= budget) { cards.push(card); used += card.height; continue }
    if (!cards.length && budget - used >= 2) {
      // Даже в тесной панели отказ остаётся доступным; согласие по обрезанному тексту закрыто.
      const room = budget - used - 2 - (reserve && budget - used > 2 ? 1 : 0)
      const titleLines = card.titleLines.slice(0, room)
      const context = card.context.slice(0, Math.max(0, room - titleLines.length))
      const height = 2 + titleLines.length + context.length
      cards.push({ ...card, titleLines, context, height, whole: false }); used += height
    }
    break
  }
  const visible = cards.find(card => card.id === selected?.id)
  const isWhole = selected !== undefined && isPlainTask(selected) && fitsWidth && visible?.whole === true && needed <= budget
  const controls = isWhole ? fullControls : compactControls
  used += controls.height - reservedControls.height
  const hidden = isolated ? 0 : active.length - cards.length
  // Сначала место раскрытию открытого поручения, затем остаток сохранённым ответам и общей отправке.
  const hoverReserve = collapsedCards && !requested && hasClient ? Math.min(
    Math.max(0, budget - used - (saved.length || hidden ? 1 : 0)),
    Math.max(0, ...cards.map(card => card.details?.length ?? 0)),
  ) : 0
  const visibleSaved: Task[] = []
  if (!isolated) {
    for (const [index, task] of saved.entries()) {
      if (used + SAVED_CARD_HEIGHT + hoverReserve + (index < saved.length - 1 || hidden ? 1 : 0) > budget) break
      visibleSaved.push(task); used += SAVED_CARD_HEIGHT
    }
  }
  const hiddenSaved = isolated ? 0 : saved.length - visibleSaved.length
  const more = hidden + hiddenSaved > 0 && used < budget
  if (more) used++
  const cardsHeight = cards.reduce((sum, card) => sum + card.height, 0)
  return { selected, cards, cardWidth, textWidth, cardsHeight, saved: visibleSaved, savedHeight: visibleSaved.length * SAVED_CARD_HEIGHT, hoverReserve, hidden, hiddenSaved, more, controls,
    expanded, navigation: false, canExpand: selected !== undefined && isPlainTask(selected) && !isWhole && !expanded,
    needed, fitsWidth, isWhole, height: used }
}

export function signatureOf(task: Task): string {
  return JSON.stringify([task.title, task.why, task.doneWhen ?? null, task.options ?? [], task.taskAlias ?? null, task.taskTitle ?? null, task.result ?? null])
}

// Перенос по словам; текст задачи состоит из знаков шириной в одну ячейку, длина строки равна её ширине.
export function wrapPlain(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width))
  const lines: string[] = []
  let line = ''
  for (let word of text.split(' ')) {
    while (word.length > limit) {
      if (line !== '') { lines.push(line); line = '' }
      lines.push(word.slice(0, limit))
      word = word.slice(limit)
    }
    if (line === '') line = word
    else if (line.length + 1 + word.length <= limit) line += ` ${word}`
    else { lines.push(line); line = word }
  }
  if (line !== '') lines.push(line)
  return lines
}

// Текст в том виде, в каком он прошёл приём: всё прочее решением не закрывается.
export function isPlainTask(task: Task): boolean {
  return [task.why, task.doneWhen].every(value => value === undefined || plainOwnerBody(value))
    && [task.title, task.taskAlias, task.taskTitle, task.result, ...(task.options ?? [])].every(value => value === undefined || (plain(value) && clean(value) === value))
    && !(task.options ?? []).some(mixesScripts)
}

export function wrapOwnerBody(text: string, width: number): string[] {
  if (!text.split('\n').some(line => line.startsWith('- '))) return wrapPlain(text, width)
  return text.split('\n').flatMap(line => line.startsWith('- ')
    ? wrapPlain(line.slice(2), Math.max(1, width - 2)).map((part, index) => `${index === 0 ? '• ' : '  '}${part}`)
    : wrapPlain(line, width))
}

export function fullLinesOf(task: Task, width: number, isEarlier = true): string[] {
  return [
    // Карточка без служебных подписей: название, затем сразу что сделать и что получится.
    ...wrapPlain(ownerShownTitle(task), width), ...wrapOwnerBody(task.why, width),
    ...(task.doneWhen === undefined ? [] : wrapOwnerBody(task.doneWhen, width)),
    // Происхождение остаётся частью текста решения, даже после автоматического раскрытия.
    ...(isEarlier ? wrapPlain('из прежней сессии, прочитана из хранилища', width) : []),
  ]
}

export function rowsFor(shown: readonly Task[], selectedId: number | null, editing: OwnerEditing | null, max: number, width?: number, room?: number, sessionId?: string): number {
  return ownerLayout(shown, selectedId, editing, max, width, room, sessionId).height
}

const BRIDGE = /^\s*↳?\s*Ответ на #(\d+):[ \t]*\n?/i

// Адресует ответ только номер поручения. Название задаёт агент: привязка по названию позволяла тексту названия
// увести ответ владельца — в том числе согласие — к другому поручению. Название и номер задачи в префиксе
// поясняют владельцу, на что он отвечает; номер поручения написан словом, решётка остаётся за задачами.
const BRIDGE_ID = /^\s*↳?\s*Ответ на поручение (\d+)(?=[\s«(:])/iu

export function bridgeOf(task: Task): string {
  return `↳ Ответ на поручение ${task.id} ${ownerTaskCaption(task)}: `
}

// Один разбор для захвата реплики и для приёма ответа: что узнано ответом владельца, то и адресовано.
export function isBridgeReply(text: string): boolean {
  return BRIDGE.test(text) || BRIDGE_ID.test(text)
}

export function answerIn(text: string, tasks: readonly Task[] = []): { id: number; answer: string } | null {
  const match = BRIDGE.exec(text)

  // Прежний префикс однозначно относится к внутреннему номеру поручения, даже при совпадении с номером задачи.
  if (match) return { id: Number(match[1]), answer: text.slice(match[0].length).trim() }
  const named = BRIDGE_ID.exec(text)
  if (!named) return null
  const id = Number(named[1])
  // Адресат — только открытое поручение. Отозванное или уже закрытое не находится: иначе ответ, набранный до
  // отзыва, прошёл бы мимо приёма и ушёл агенту обычной репликой.
  const task = tasks.find(one => one.id === id && isActive(one))
  // Принимается только префикс, который мод сам поставил в строку ввода: по изменённому началу строки нельзя
  // надёжно отделить ответ от названия.
  if (!task) return null
  const exact = bridgeOf(task), body = text.trimStart()
  return body.startsWith(exact) ? { id, answer: body.slice(exact.length).trim() } : null
}

const SECRET_SHAPES: readonly RegExp[] = [
  /\b[sr]k_(live|test)_[0-9A-Za-z]{10,}/,
  /\bSG\.[\w-]{16,}\.[\w-]{16,}/,
  /\bglpat-[\w-]{16,}/,
  // Длиннее хэша коммита: 48 и более шестнадцатеричных знаков подряд.
  /\b[0-9a-f]{48,}\b/i,
  /\bsk-ant-[\w-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bA(KIA|SIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abprs]-[\w-]{10,}/,
  // Адрес входящего вебхука сам является ключом; раньше он ловился только склейкой пути в один отрезок.
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]{20,}/,
  /\bAIza[\w-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/,
]

// Общий признак ключа — отрезок от 32 знаков алфавита base64 со строчными, прописными и цифрами.
const BLOB = /[A-Za-z0-9+/_=-]{32,}/g
const opaque = (text: string) => (text.match(BLOB) ?? []).some(part => /[a-z]/.test(part) && /[A-Z]/.test(part) && /[0-9]/.test(part))
const secretView = createSecretView([], text => text)
const secretIn = (text: string) => SECRET_SHAPES.some(shape => shape.test(text)) || opaque(text)

// Строгий признак без исключений. Им проверяются записи агента, след работы и сохранённые данные:
// там нет человека, который подтвердил бы отправку, поэтому длинный путь к файлу тоже считается подозрительным.
export function looksSecret(text: string): boolean {
  // Исходная строка проверяется, как прежде; два очищенных вида только добавляют к ней.
  return secretIn(text) || secretIn(secretView.clean(text)) || secretIn(secretView.clean(text, { view: 'spaced' }))
}

// Слово считается путём или адресом только по признаку, которого у сплошного ключа быть не может: схема адреса,
// домашний или относительный каталог, диск Windows, известный корневой каталог либо расширение файла в конце.
// В алфавите base64 нет точки, двоеточия, тильды и обратной косой черты; ключ, начавшийся с косой черты, под список
// корневых каталогов не подходит.
const PATH_EVIDENCE: readonly RegExp[] = [
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u,
  /^(?:~|\.{1,2})[\\/]/u,
  /^[A-Za-z]:[\\/]/u,
  /^\/(?:Users|home|var|tmp|private|Volumes|Library|System|Applications|usr|opt|etc|mnt|srv|root)\//u,
  /[\\/][^\\/]*\.(?:[a-z0-9]{1,6}|[A-Z0-9]{1,6})$/u,
]

// Обычное имя каталога или файла от пяти знаков: строчные буквы и цифры либо слова с заглавной буквы, через точку,
// дефис или подчёркивание. Прописные с цифрами именем не считаются: так выглядит и часть ключа — в учебном ключе AWS
// есть отрезок K7MDENG. Короткое имя не считается тоже: оно не разрывает ключ, записанный через косую черту.
// Цифра внутри повтора стоит одна: «[0-9]+» под звёздочкой перебирал бы разбиения длинного ряда цифр экспоненциально.
const NAME_TOKEN = /^(?:[a-z0-9]+|[A-Za-z][a-z]+(?:[A-Z][a-z]{2,}|[0-9])*)$/u
const plainName = (segment: string) => segment.length >= 5 && segment.split(/[._-]/u).every(token => NAME_TOKEN.test(token))

const OPENING = '"\'`«(<['
const CLOSING = '"\'`»)>],.;:!?'

// Признак для текста, который владелец набирает сам: комментарий, описание, ответ. Отличие от строгого одно —
// в слове с признаком пути или адреса обычные имена каталогов и файлов заменяются пробелом, и общий признак
// применяется к остатку. Каталог временных файлов macOS и имя снимка экрана перестают склеиваться в «ключ»,
// а ключ с косыми чертами по-прежнему ловится внутри пути, после него и в кавычках. Имя, которое само подходит
// под общий признак, не заменяется. Всё, что ловит этот признак, ловит и строгий.
export function looksSecretInDraft(text: string): boolean {
  return secretInDraft(text) || secretInDraft(secretView.clean(text)) || secretInDraft(secretView.clean(text, { view: 'spaced' }))
}

function secretInDraft(text: string): boolean {
  if (SECRET_SHAPES.some(shape => shape.test(text))) return true
  for (const word of text.split(/\s+/u)) {
    // Кавычки, скобки и знаки препинания вокруг слова снимаются проходом с краёв: выражение с якорем конца
    // на длинном ряду знаков внутри слова работало бы квадратично.
    let from = 0, to = word.length
    while (from < to && OPENING.includes(word[from]!)) from++
    while (to > from && CLOSING.includes(word[to - 1]!)) to--
    const core = word.slice(from, to)
    if (!/[\\/]/u.test(core) || !PATH_EVIDENCE.some(evidence => evidence.test(core))) {
      if (opaque(word)) return true
      continue
    }
    // Разделители остаются на месте: отрезки, не похожие на имена, склеиваются через косую черту, как в строгом признаке.
    const rest = core.split(/([\\/])/u).map((part, index) => index % 2 === 0 && plainName(part) && !opaque(part) ? ' ' : part).join('')
    if (opaque(rest)) return true
  }
  return false
}

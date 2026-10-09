// Механика инструментов и доставки Human in the loop; интерфейс встроен в cockpit.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolSpec, RenderInput, RenderElement, RenderSurface } from 'claude-code'

import type { OwnerEditing as Editing, OwnerTask as Task } from '../../types'
import {
  MAX_OPEN,
  MAX_TITLE,
  MAX_REASON,
  WITHDRAW_RULE,
  answerIn, isBridgeReply,
  assignedOf,
  bridgeOf,
  contextOf,
  digestOf,
  isActive,
  isShown,
  listOf,
  looksSecretInDraft,
  messageOf,
  ownerTaskReference,
  ownerTaskCaption,
  parseAsk,
  ownerLayout,
  stateOf,
  sameAsk,
  statusOf,
  ownerButtonLabel,
  wrapPlain,
  signatureOf,
  isPlainTask,
} from './tasks'
import { HEARTBEAT_MS, adopt, elsewhereIn, endSlot, storedOf, withSlot } from './project'
import type { Stored } from './project'
import { oneLine, plain, printable } from './text'
import type { PanelAction } from '../panel-actions'
import { hoverColor, roleColors, type Theme } from '../theme'
import { cellWidth } from '../layout'
import { drawOwnerCards, type OwnerCardsProps } from './cards'
import { ownerSearchMatches, ownerShownTitle, SEARCH_UNAVAILABLE, wrappedSearchRanges, type OwnerSearch } from '../task-search-panel'
import { savedCardOf, SAVED_SEND } from './saved-cards'
import { clipWords } from '../domain/task-loop'
import { displayTaskNumber } from '../domain/task-number.ts'
import { CARD_HOVER } from '../card-controls'
import { EDITOR_INSET, armEditorFocus, clearEditorFocus, createEditorFocus, editorHeight, editorSnapshot, editorRows, focusEditors, receiveEditor, rememberEditor, type EditorFocus, type EditorSnapshot, type EditorProps } from '../editor'

const PLUGIN = 'cockpit'

const ASSIGN = 'mcp__cockpit__assign_task'
const LIST = 'mcp__cockpit__list_tasks'
const WITHDRAW = 'mcp__cockpit__withdraw_task'

const STEERING = [
  'Когда тебе нужно то, что может сделать только владелец (положить секрет на место, выполнить действие на своей машине или недоступном тебе аккаунте, принять своё решение), назначь задачу через mcp__cockpit__assign_task, чтобы она оставалась перед ним до ответа.',
  'Это включает просьбу проверить или одобрить твою работу: назначь задачу, даже если просишь об этом в реплике, поскольку владелец может быть занят, а задача сохранит просьбу.',
  'Владелец видит открытые задачи во вкладке «Мне» в панели «Задачи», ответ приходит тебе сообщением.',
  WITHDRAW_RULE,
].join('\n')

const BATCH_MS = 800
// В состоянии сессии хранится признак удержания, а не сам ответ: состояние пишется на диск.
const HELD = 'удержан'
const PANE = 'tasks'

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'assign_task',
    description: [
      'Поставь владельцу задачу, которую может выполнить только он; она остаётся перед ним до действия.',
      'Используй для секрета или доступа, который он должен положить на место, действия на его машине или недоступном аккаунте (панель сервиса, устройство, одобрение выкладки), его решения, проверки или одобрения твоей работы.',
      'Назначай задачу, даже если просишь об этом в реплике: владелец может быть занят другими делами, а задача сохраняет просьбу.',
      'Задача не блокирует: продолжай работу, пока она ждёт, ответ придёт, когда владелец доберётся до неё. Это подходит для того, что потребуется в какой-то момент сессии.',
      'Если без ответа нельзя продолжить, спроси владельца в реплике или анкетой и заверши ход; задача подходит для того, что может подождать.',
      'Одна задача на одну потребность: list_tasks покажет уже открытые.',
      'Дай короткое имя до 50 знаков, например «Значки вкладок панели». Что именно сделать и по чему судить о готовности, напиши в done_when.',
      'Карточка владельца вмещает восемь строк: why и done_when вместе — до 300 знаков; более длинный текст отклоняется, подробности пиши в разговоре.',
      'Секрет попроси положить туда, где он нужен, а не вставлять в ответ.',
      'Владелец видит открытые задачи во вкладке «Мне» панели «Задачи». Он отклоняет задачу, причина необязательна. При выполнении отмечает готовность, выбирает вариант, отвечает своими словами.',
      'Ответ приходит тебе сообщением или при вызове list_tasks.',
      WITHDRAW_RULE,
    ].join(' '),
    inputSchema: { type: 'object', properties: {
      title: { type: 'string', description: 'Короткое имя до 50 знаков, например «Значки вкладок панели»; подробности действия — в done_when.' },
      why: { type: 'string', description: 'Одно предложение: что это позволит продолжить или почему действие доступно только владельцу.' },
      done_when: { type: 'string', description: 'Необязательно: что именно сделать и по чему судить о готовности. Можно до 6 пунктов с новой строки с "- " и одной вводной строкой; why и done_when вместе до 300 знаков. Для секрета: «Ключ лежит в .env. Не вставляй его сюда».' },
      kind: { type: 'string', enum: ['do', 'answer', 'choose'], description: 'do: действие и отметка готовности. answer: ответ своими словами (ошибка, лог, результаты тестов). choose: выбор варианта.' },
      options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: 'Только для choose: от 2 до 4 коротких вариантов.' },
    }, required: ['title', 'why', 'kind'] },
  },
  {
    name: 'list_tasks',
    description: 'Посмотри задачи владельцу и его действия: готовность с ответом или выбором, отклонение задачи, причина необязательна. Вызывай перед использованием результата, после сообщения о сохранённом ответе или перед назначением, чтобы не повторить задачу. Прочитанные обновления отмечаются доставленными.',
    inputSchema: { type: 'object', properties: {
      show: { type: 'string', enum: ['updates', 'open', 'all'], description: 'updates (по умолчанию): открытые задачи и непрочитанные ответы. open: только открытые. all: все задачи этой сессии.' },
      id: { type: 'number', description: 'Одно поручение целиком по внутреннему id из assign_task или list_tasks. Это не номер родительской задачи #N.' },
    } },
  },
  {
    name: 'withdraw_task',
    description: 'Отзови задачу владельцу, если она выполнена вне панели или больше не нужна: ты нашёл другой путь или план изменился. Владелец увидит причину. ' + WITHDRAW_RULE,
    inputSchema: { type: 'object', properties: {
      id: { type: 'number', description: 'Внутренний id поручения из assign_task или list_tasks. Это не номер родительской задачи #N.' },
      reason: { type: 'string', description: 'Короткая причина для владельца.' },
    }, required: ['id'] },
  },
]

const tasks = atom({ plugin: 'cockpit', key: 'ownerTasks' } as const, [] as readonly Task[])
const nextId = atom({ plugin: 'cockpit', key: 'ownerNextId' } as const, 1)
const selectedId = atom({ plugin: 'cockpit', key: 'ownerSelectedId' } as const, null as number | null)
const editing = atom({ plugin: 'cockpit', key: 'ownerEditing' } as const, null as Editing | null)
const loadedFor = atom({ plugin: 'cockpit', key: 'ownerLoadedFor' } as const, null as string | null)
const isWorking = atom({ plugin: 'cockpit', key: 'ownerWorking' } as const, false)

type How = 'auto' | 'now' | 'later'

const live = {
  sessionId: '',
  root: '',
  isUnread: false,
  isSendingAtEnd: false,
  drafts: new Map<number, string>(),
  editors: new Map<string, EditorSnapshot>(),
  editorProps: new Map<string, EditorProps>(),
  editorFocus: createEditorFocus(),
  editorVisible: false,
  /** Черновики, поднятые из хранилища и не тронутые владельцем: по отрисовке «увиденным» текст не считается, только по правке в поле. */
  unseenDrafts: new Set<number>(),
  /** Задачи, чьи действия-согласия нарисованы при целиком показанном тексте: номер и отпечаток текста.
   *  Согласие принимается только с такой отметкой; обрезанная отрисовка её снимает. */
  offered: new Map<number, string>(),
  previewOffers: new Map<number, { signature: string; lines: number; serverVisible: boolean; token: string }>(),
  // Метка показанного текста карточки в нынешней раскладке. Клиентский модуль возвращает её в квитанции: по ней
  // квитанция прежнего кадра принимается, если с тех пор не менялись ни текст карточки, ни ширина и высота
  // раздела, ни число строк полного текста. Иначе метка новая, и прежняя квитанция согласия не даёт.
  cardTokens: new Map<number, { shown: string; token: string }>(),
  cardsGeneration: 0,
  batch: null as Timer | null,
  heartbeat: null as Timer | null,
  elsewhere: 0,
  turns: new Set<string>(),
  engineWorking: undefined as boolean | undefined,
  expandedId: null as number | null,
  actions: [] as OwnerAction[],
  choiceId: null as number | null,
  reviewModes: new Map<number, 'review-reject' | 'review-comment'>(),
  hoveredId: null as number | null,
  cardIds: [] as number[],
}

let pendingReview: { title: string; review: string; taskAlias?: string; result?: string } | null = null

export function setPendingReview(req: { title: string; review: string; taskAlias?: string; result?: string } | null) {
  pendingReview = req
}

function working(): boolean {
  return live.engineWorking ?? live.turns.size > 0
}

export function ownerSession(): string {
  return live.sessionId
}

export type CreateOwnerTaskInput = {
  title: string
  why: string
  kind: Task['kind']
  options?: readonly string[]
  doneWhen?: string
  taskAlias?: string
  taskTitle?: string
  result?: string
}

export type CreateOwnerTaskResult =
  | { ok: true; task: Task; duplicate?: boolean; openCount: number }
  | { ok: false; error: string; code?: 'LIMIT' | 'VALIDATION' }

export async function createOwnerTask(
  ask: CreateOwnerTaskInput,
  $: EngineInterface,
): Promise<CreateOwnerTaskResult> {
  if (live.root === '') {
    try {
      live.root = await $.session.root()
    } catch {
    }
  }
  if (live.sessionId === '') {
    try {
      live.sessionId = await $.session.id()
    } catch {
    }
  }
  const active = (await read($, tasks)).filter(isActive)
  const same = active.find(task => sameAsk(task.title, ask.title))

  if (same !== undefined) {
    return { ok: true, task: same, duplicate: true, openCount: active.length }
  }

  if (active.length >= MAX_OPEN) {
    return {
      ok: false,
      code: 'LIMIT',
      error: `У владельца уже есть ${MAX_OPEN} открытых задач. Отзови ненужную или дождись ответа (list_tasks покажет задачи).`,
    }
  }

  const counted = (await readStore($)).nextId
  const taken = (await read($, tasks)).reduce((max, one) => Math.max(max, one.id + 1), 1)
  const id = await read($, nextId).then(n => Math.max(n, counted, taken))
  await update($, nextId, () => id + 1)
  const nowMs = await $.clock.now()
  const task: Task = {
    id,
    ...ask,
    state: 'open',
    update: 'none',
    sessionId: live.sessionId,
    createdMs: nowMs,
    updatedMs: nowMs,
  }

  await change($, list => [...list, task])
  await update($, selectedId, chosen => chosen ?? id)

  $.ui.toast('Агент назначил тебе задачу. Открой «Мне» в панели «Задачи».')

  return { ok: true, task, openCount: active.length + 1 }
}

export type OwnerAction = PanelAction & { taskId?: number; run: (surface: RenderSurface) => unknown }

export function registerOwnerTasks(on: Parameters<Register>[0], renderHeader: (actions: OwnerAction[]) => RenderElement | undefined, themeOf: () => Theme, editorFocus: EditorFocus, searchOf: () => OwnerSearch | undefined = () => undefined) {
  live.editorFocus = editorFocus
  editorFocus.fields.add(live.editorProps)
  on('tool.call', { tool: 'mcp__cockpit__task_done' }, async ($, e, next) => {
    pendingReview = null
    const result = await next(e)
    const ask = pendingReview
    pendingReview = null

    if (result.deny !== undefined || result.isError || !ask) {
      return result
    }

    // Карточка проверки проходит те же ворота, что assign_task: главный агент и тот же разбор текста.
    const taskTitle = clipWords(ask.title, 300)
    const checked = e.agentId !== undefined
      ? { error: 'проверку владельцу передаёт только главный агент' }
      : !plain(taskTitle) ? { error: 'Название задачи должно состоять из обычного текста: без управляющих и специальных знаков.' }
      : parseAsk({ title: clipWords(ask.result ?? ask.title, MAX_TITLE), why: ask.review, kind: 'choose', options: ['Принято', 'Есть замечания'] }, false)
    const created: CreateOwnerTaskResult = 'error' in checked
      ? { ok: false, error: checked.error, code: 'VALIDATION' }
      : await createOwnerTask({ ...checked, taskTitle, ...(ask.result === undefined ? {} : { result: ask.result }), ...(ask.taskAlias && /^TASK-\d+$/u.test(ask.taskAlias) ? { taskAlias: ask.taskAlias } : {}) }, $)

    const notice = created.ok
      ? `Проверка передана владельцу: ${ownerTaskReference(created.task)}.`
      : `Не удалось передать проверку владельцу (${created.error}). Назначь проверку вручную через mcp__cockpit__assign_task.`

    if (typeof result.result === 'string') {
      const lines = result.result.split('\n')
      if (lines.length > 0) {
        lines[0] = `${lines[0]} ${notice}`
        return { ...result, result: lines.join('\n') }
      }
    }

    return result
  })

  on('session.start', {}, async ($, e, next) => {
    for (const tool of TOOLS) {
      await $.tool.register(tool)
    }

    await join($)

    return next(e)
  })

  on('session.end', {}, async ($, e, next) => {
    clearEditorFocus(live.editorFocus)
    live.heartbeat?.cancel()
    live.heartbeat = null

    try {
      await writeStore($, endSlot(await readStore($), e.sessionId, await $.clock.now()))
    } catch {
    }

    const ended = await next(e)

    if (e.reason === 'clear') {
      $.clock.after(0, () => void join($))
    }

    return ended
  })

  on('tool.describe', { tool: 'mcp__cockpit__assign_task' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: 'mcp__cockpit__list_tasks' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: 'mcp__cockpit__withdraw_task' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: ASSIGN }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Только главный агент назначает задачи владельцу. Укажи, что тебе нужно от владельца, в своём результате.' }
    }

    const ask = parseAsk(e as unknown as Record<string, unknown>)

    if ('error' in ask) {
      return { deny: ask.error }
    }

    const created = await createOwnerTask(ask, $)
    if (!created.ok) {
      return { deny: created.error }
    }
    if (created.duplicate) {
      return { result: `Поручение ${created.task.id}${created.task.taskAlias ? ` (задача ${displayTaskNumber(created.task.taskAlias)})` : ''} уже просит об этом («${created.task.title}»); новое поручение не назначено.` }
    }

    return { result: assignedOf(created.task, created.openCount) }
  })

  on('tool.call', { tool: LIST }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const id = typeof args['id'] === 'number' ? args['id'] : undefined
    const scope = args['show'] === 'open' || args['show'] === 'all' ? args['show'] : 'updates'
    const list = await read($, tasks)

    const picked =
      id !== undefined
        ? list.filter(task => task.id === id)
        : scope === 'all'
          ? list
          : scope === 'open'
            ? list.filter(isActive)
            : list.filter(isShown)

    if (id !== undefined && picked.length === 0) {
      return { result: `Нет поручения ${id}.` }
    }

    if (e.agentId === undefined) {
      await delivered($, picked.filter(task => task.update === 'pending').map(task => task.id))
    }

    return { result: listOf(picked, await $.clock.now()) }
  })

  on('tool.call', { tool: WITHDRAW }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'Только главный агент отзывает задачи.' }
    }

    const args = e as unknown as Record<string, unknown>
    const id = args['id']
    const reason = typeof args['reason'] === 'string' ? oneLine(args['reason']) : ''
    const task = (await read($, tasks)).find(one => one.id === id)

    if (task === undefined) {
      return { deny: `Нет поручения ${String(id)}.` }
    }

    if (!isActive(task)) {
      return { deny: `${ownerTaskReference(task)} уже ${stateOf(task.state)}; отзывать нечего.` }
    }

    await edit($, task.id, one => ({
      ...one,
      state: 'withdrawn',
      update: 'delivered',
      ...(reason === '' ? {} : { reason }),
    }))
    await settle($, task.id)
    const why = reason === '' ? '' : `. ${printable(reason, 200)}`
    $.ui.toast('Агент отозвал твою задачу; выполнять её больше не нужно.', { timeoutMs: 8000 })

    return { result: `${ownerTaskReference(task)} отозвано и убрано из панели «Задачи».\nНазвание: «${task.title}».` }
  })

  on('turn.start', {}, async ($, e, next) => {
    live.isUnread = false
    live.turns.add(e.turnId)
    await syncWorking($)

    return next(e)
  })

  on('turn.step', {}, async function* ($, e, next) {
    if (e.agentId === undefined) {
      live.isUnread = false
    }

    return yield* next(e)
  })

  on('turn.complete', {}, async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      live.turns.clear()
      live.engineWorking = false
    } else {
      live.turns.delete(e.turnId)
    }

    await syncWorking($)

    if (e.agentId === undefined) {
      const all = await read($, tasks)
      const isAllAnswered = all.some(task => task.update === 'pending') && !all.some(isActive)

      if (live.isSendingAtEnd || isAllAnswered) {
        live.isSendingAtEnd = false
        live.isUnread = false
        void send($, true)
      } else if (live.isUnread) {
        live.isUnread = false
        void $.prompt.submit({ text: 'Я ответил на задачу, пока ты завершал свою реплику; мой ответ выше.', asUser: true })
      }
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (live.engineWorking !== e.props.isWorking) {
      live.engineWorking = e.props.isWorking
      $.clock.after(0, () => void syncWorking($))
    }

    return next(e)
  })

  on('prompt.submit', {}, async ($, e, next) => {
    if (e.origin.kind === 'plugin' && e.origin.name === PLUGIN) {
      return next(e)
    }

    // Реплики приходят и от уведомлений, расписаний, других плагинов; ответом считается только набранное владельцем.
    const ownerOrigin = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const list = ownerOrigin ? await read($, tasks) : []
    const bridged = ownerOrigin ? answerIn(e.text, list) : null
    const task = bridged === null ? undefined : list.find(one => one.id === bridged.id && isActive(one))
    if (ownerOrigin && isBridgeReply(e.text) && bridged === null) {
      return { drop: 'Ответ не принят: нет поручения или изменено начало строки. Ответь в «Задачах».' }
    }

    if (bridged !== null && task !== undefined) {
      live.unseenDrafts.delete(task.id)
      const reviewMode = await reviewModeFor($, task.id)
      if (looksSecretInDraft(bridged.answer)) {
        live.drafts.set(task.id, bridged.answer)
        await update($, selectedId, () => task.id)
        await update($, editing, (): Editing => ({ id: task.id, field: reviewMode ?? 'answer', held: HELD }))
        return {
          drop: 'Ответ похож на секрет, удержан. Положи на место; «Сделано» или проверь в панели.',
        }
      }

      if (bridged.answer === '' && task.kind !== 'do' && reviewMode !== 'review-reject') {
        return { drop: 'Ответ не принят: нужен текст. Допиши его после двоеточия.' }
      }

      const given = bridged.answer === '' ? {} : { answer: bridged.answer }

      if (!(reviewMode ? await submitAnswer($, task.id, bridged.answer, 'later') : await resolve($, task.id, { state: 'done', ...given }, 'later'))) {
        // Набранный текст не теряется: он ждёт черновиком в поле ответа.
        if (bridged.answer !== '') live.drafts.set(task.id, bridged.answer)
        return { drop: 'Ответ не принят: задача показана не целиком. Разверни её; черновик в «Задачах».' }
      }

      if (e.turnId !== undefined) {
        const when = (await read($, tasks)).some(isActive) ? 'вместе с остальными ответами' : 'когда этот ход закончится'

        return {
          drop: `Твой ответ сохранён; агент получит его ${when}.`,
        }
      }

      const due = (await read($, tasks)).filter(one => one.update === 'pending')
      await delivered($, due.map(one => one.id))

      return next({ ...e, text: messageOf(due) })
    }

    const held = await read($, tasks)
    const due = held.filter(one => one.update === 'pending')
    const open = held.filter(isActive)
    const ownerContext = open.length && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')
      ? [`ownerTasks:\n${contextOf(open, live.sessionId, await $.clock.now())}`] : []

    if (due.length === 0) {
      return next(ownerContext.length ? { ...e, context: [...(e.context ?? []), ...ownerContext] } : e)
    }

    await delivered($, due.map(one => one.id))

    return next({ ...e, context: [...(e.context ?? []), [digestOf(due), ...ownerContext].join('\n\n')] })
  })

  on('prompt.compose', {}, async ($, e, next) => {
    const composed = await next(e)
    const isReachable = e.tools.some(tool => tool === ASSIGN || tool === 'ToolSearch')

    if (!isReachable || e.traits.includes('print') || e.traits.includes('bare')) {
      return composed
    }

    return { sections: [...composed.sections, { id: 'cockpit:owner-tasks', text: STEERING, scope: 'session' }] }
  })

  on('prompt.context', {}, async ($, e, next) => {
    const result = await next(e)
    const shown = (await read($, tasks)).filter(isShown)

    if (shown.length === 0) {
      return result
    }

    return { ...result, blocks: [...result.blocks, { name: 'ownerTasks', text: contextOf(shown, live.sessionId, await $.clock.now()) }] }
  })

  on('ui.render', { component: 'ToolUse', props: { tool: ASSIGN } }, async ($, e, next) => {
    const input = e.props.input as Record<string, unknown> | null | undefined
    const title = typeof input?.['title'] === 'string' ? input['title'] : ''
    if (title === '' || e.props.isErrored || e.props.isInterrupted) return next(e)
    const output = e.props.output
    const resultText = typeof output === 'string' ? output
      : output !== null && typeof output === 'object' && 'result' in output && typeof output.result === 'string' ? output.result : ''
    const assigned = /^(?:Назначено поручение|Поручение) (\d+)/u.exec(resultText)
    const task = (await read($, tasks)).find(one => assigned === null ? isActive(one) && sameAsk(one.title, title) : one.id === Number(assigned[1]))
    const { Box, Text } = $.ui.resolve(e)
    return <Box flexDirection="row" height={1}>
      <Text>{`☐ Тебе поручено${task?.taskAlias ? ` ${displayTaskNumber(task.taskAlias)}` : ''}: `}</Text>
      <Text bold wrap="truncate-end">{printable(title, MAX_TITLE)}</Text>
    </Box>
  })

  on('ui.message', { component: 'Pane', requestId: PANE, element: 'owner-cards' }, async ($, e, next) => {
    if (e.module !== 'hooks/owner/cards.tsx' || (e.surface !== 'terminal' && e.surface !== 'desktop')
      || !e.data || typeof e.data !== 'object' || Array.isArray(e.data)) return next(e)
    const data = e.data as { hover?: unknown; key?: unknown; control?: unknown; generation?: unknown; shown?: unknown }
    if (data.generation === live.cardsGeneration && 'shown' in data) {
      for (const [id, offer] of live.previewOffers) if (!offer.serverVisible) live.offered.delete(id)
    }
    if (data.shown && typeof data.shown === 'object' && !Array.isArray(data.shown)) {
      const shown = data.shown as { id?: unknown; lines?: unknown; token?: unknown }
      const fresh = data.generation === live.cardsGeneration
      if (typeof shown.id === 'number' && Number.isSafeInteger(shown.id)) {
        const offer = live.previewOffers.get(shown.id)
        // Панель перерисовывается при каждом действии агента, и нажатие часто приходит с номером прежнего кадра.
        // Такая квитанция годится, если клиент показал тот же текст: метка совпадает с меткой нынешней карточки.
        if (offer && (fresh || shown.token === offer.token)) {
          if (fresh) live.offered.delete(shown.id)
          if (typeof shown.lines === 'number' && Number.isSafeInteger(shown.lines) && shown.lines === offer.lines) live.offered.set(shown.id, offer.signature)
        }
      }
    }
    // Неизвестная или устаревшая карточка сбрасывает цель: клавиша не должна попасть в прежнюю.
    if ('hover' in data) live.hoveredId = typeof data.hover === 'number' && Number.isSafeInteger(data.hover) && live.cardIds.includes(data.hover) ? data.hover : null
    if (typeof data.control === 'string') {
      await live.actions.find(action => action.key === data.control)?.run(e.surface)
      $.ui.invalidate('ui.render')
      return {}
    }
    if (typeof data.key !== 'string') return {}
    if (data.key === 'escape') { await closeEditor($); return {} }
    if (await ownerKey($, data.key, e.surface)) return {}
    if (typeof data.key === 'string' && /^[1-4]$/.test(data.key)) {
      const task = (await read($, tasks)).find(one => one.id === live.choiceId && isActive(one) && one.kind === 'choose')
      const option = task?.options?.[Number(data.key) - 1]
      if (task !== undefined && option !== undefined) await resolve($, task.id, { state: 'done', answer: option }, 'auto')
      return {}
    }
    return next(e)
  })

  on('ui.message', { component: 'Pane', requestId: PANE, element: 'owner-answer-input' }, async ($, e, next) => {
    if (e.module !== 'hooks/editor.tsx' || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    const field = await read($, editing)
    if (!field) return {}
    const id = `owner-${live.sessionId}-${field.id}`
    // Снимок сверяется с черновиком хука до приёма сообщения: см. receiveEditor.
    const fieldWidth = live.editorProps.get(id)?.width ?? 1
    const before = { height: editorHeight(live.editors.get(id)?.value ?? '', fieldWidth), focus: live.editorFocus.target?.element }
    const received = receiveEditor(live.editors, id, live.drafts.get(field.id) ?? '', e.data)
    if (!received) return {}
    const { snapshot } = received
    // Любое сообщение поля получает свежие props: подтверждение, вставку и эпоху клиент узнаёт сразу.
    const reply = () => ({ props: { ...live.editorProps.get(id), ...snapshot } })
    const data = received.message
    if (!data) return reply()
    // Черновик записывается в том же такте, что и снимок: отрисовка во время ожидания часов ниже
    // иначе видит расхождение, поднимает эпоху и возвращает клиенту прежний текст.
    live.drafts.set(field.id, data.text)
    if (data.kind === 'submit' || data.kind === 'action') clearEditorFocus(live.editorFocus)
    else if (data.activity) {
      const sessionId = live.sessionId
      const at = await $.clock.now()
      // Пока шло ожидание часов, поле могло принять более новое сообщение: старое не возвращает в черновик свой текст.
      if (snapshot.version !== data.version || snapshot.value !== data.text) return reply()
      armEditorFocus(live.editorFocus, live.editorProps, {
        snapshot, element: e.element, at,
        setValue: text => { live.drafts.set(field.id, text); live.unseenDrafts.delete(field.id) },
        isAvailable: () => live.sessionId === sessionId && live.editors.get(id) === snapshot && live.editorVisible,
      })
    }
    live.drafts.set(field.id, data.text)
    if (data.version > 0) live.unseenDrafts.delete(field.id)
    if (data.kind === 'submit') await submitAnswer($, field.id, data.text, 'auto')
    else if (data.kind === 'action') {
      if (data.action === 'owner-long') await longAnswer($, field.id)
      else if (data.action === 'owner-field-cancel') await closeEditor($)
      else if (data.action === 'owner-edit') await update($, editing, () => ({ id: field.id, field: field.field }))
      else if (data.action === 'owner-send-anyway' || data.action === 'owner-other-way') await submitAnswer($, field.id, data.text,
        data.action === 'owner-other-way' ? working() ? 'now' : 'later' : 'auto', data.action === 'owner-send-anyway')
    }
    // Перерисовка нужна, только когда от правки зависит вид раздела: отправка и действие, другое число строк поля, смена поля с фокусом.
    if (data.kind === 'submit' || data.kind === 'action' || editorHeight(data.text, fieldWidth) !== before.height
      || live.editorFocus.target?.element !== before.focus) $.ui.invalidate('ui.render')
    return reply()
  })

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      if (live.editorFocus.target?.element !== e.element) clearEditorFocus(live.editorFocus)
      focusEditors(live.editorProps, live.editorFocus.target?.element === e.element ? e.element : undefined)
      $.ui.invalidate('ui.render')
    }
    // Esc движок сообщает снятием фокуса: клиентский модуль эту клавишу не получает.
    if (result.deny === undefined && e.origin.kind === 'person' && e.element === undefined) await closeEditor($)
    return result
  })

  // Сначала существующая панель считает бюджет; затем заполняем её серверный слот.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const below = await next(e)
    // Скрытая вкладка и новая отрисовка снимают разрешения прежних кнопок.
    live.offered.clear()
    live.previewOffers.clear()
    live.cardsGeneration++
    live.actions = []
    live.choiceId = null
    if (below.type !== 'Box') return below
    const present = <T,>(child: T | undefined): child is T => child !== undefined
    const children = (Array.isArray(below.children) ? below.children : [below.children]).filter(present)
    const placeholder = children.find(child => child !== null && typeof child === 'object' && !Array.isArray(child) && 'type' in child
      && child.type === 'Box' && child.props?.key === 'owner-tasks')
    if (placeholder === undefined || typeof placeholder !== 'object' || !('type' in placeholder) || placeholder.type !== 'Box') {
      live.editorVisible = false
      live.hoveredId = null; live.cardIds = []; return below
    }
    const headerFrame = children.find((child): child is RenderElement => child !== null && typeof child === 'object' && !Array.isArray(child) && 'type' in child
      && child.type === 'Box' && child.props?.key === 'owner-header')
    const { section, actions } = await ownerSection($, e, placeholder, headerFrame, themeOf(), searchOf())
    live.actions = actions
    const header = renderHeader(actions.map(action => ({ ...action, run: surface => ownerKey($, action.shortcut ?? '', surface) }))) ?? headerFrame
    return { ...below, children: children.map(child => child === placeholder ? section : child === headerFrame ? header : child).filter(present) }
  })
}

export { tasks as ownerTasks, nextId as ownerNextId, selectedId as ownerSelectedId, editing as ownerEditing, loadedFor as ownerLoadedFor, isWorking as ownerWorking }

async function ownerSection($: EngineInterface, e: RenderInput<'Pane'>, frame: RenderElement, headerFrame: RenderElement | undefined, theme: Theme, search?: OwnerSearch): Promise<{ section: RenderElement; actions: OwnerAction[] }> {
  const ui = $.ui.resolve(e)
  const { Box, Text, Button } = ui
  const Client = (e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in ui ? ui.Client : undefined
  const hasEditor = Client !== undefined
  const shown = (await read($, tasks)).filter(isShown).filter(task => !search?.active || ownerSearchMatches(task, search.query))
  const field = await read($, editing)
  const isBusy = await read($, isWorking)
  const hasHeight = frame.type === 'Box' && typeof frame.props?.height === 'number'
  const height = hasHeight && frame.type === 'Box' ? Number(frame.props?.height) : 0
  const headerMarker = headerFrame !== undefined && 'children' in headerFrame
    ? (Array.isArray(headerFrame.children) ? headerFrame.children[0] : headerFrame.children) : undefined
  const nerd = headerMarker !== null && typeof headerMarker === 'object' && 'type' in headerMarker && headerMarker.type === 'Text'
    && (Array.isArray(headerMarker.children) ? headerMarker.children[0] : headerMarker.children) === 'nerd'
  const width = Math.max(1, e.props.bodyColumns)
  const chosenId = field?.id ?? live.expandedId ?? await read($, selectedId)
  const layoutArgs = [shown, chosenId, field, height, width, hasHeight ? height : 0, live.sessionId, hasEditor, isBusy, live.expandedId, Client !== undefined, draftCellsOf(chosenId, shown, width)] as const
  const layout = ownerLayout(...layoutArgs, true)
  // Свёрнутый вид не расширяет прежнюю границу согласия: полный текст и поле должны входить в тот же бюджет.
  const consent = layout.expanded ? layout : ownerLayout(...layoutArgs)
  for (const card of layout.cards) card.whole = card.whole && Boolean(consent.cards.find(item => item.id === card.id)?.whole)
  const selected = layout.selected
  const whole = hasHeight && layout.isWhole && consent.isWhole
  live.cardIds = layout.cards.map(card => card.id)
  if (!live.cardIds.includes(live.hoveredId ?? -1)) live.hoveredId = null
  if (whole && selected?.kind === 'choose' && layout.controls.options.length) live.choiceId = selected.id
  const actions: OwnerAction[] = []
  // Модуль карточек получает всё свободное место раздела: в нём раскрывается текст под указателем.
  const reserved = layout.height - layout.cardsHeight - layout.savedHeight
  const cardsRoom = Math.max(layout.cardsHeight + layout.savedHeight, height - reserved)
  for (const id of live.cardTokens.keys()) if (!shown.some(task => task.id === id)) live.cardTokens.delete(id)
  for (const card of layout.cards) {
    const task = shown.find(task => task.id === card.id)!
    const signature = signatureOf(task)
    const shownAs = JSON.stringify([signature, layout.cardWidth, cardsRoom, consent.cards.find(item => item.id === task.id)?.context.length ?? -1])
    if (live.cardTokens.get(task.id)?.shown !== shownAs) live.cardTokens.set(task.id, { shown: shownAs, token: crypto.randomUUID() })
    card.token = live.cardTokens.get(task.id)!.token
    const canComplete = hasHeight && card.whole && layout.fitsWidth && isPlainTask(task) && (task.id !== selected?.id || whole)
    const legacyReview = task.taskAlias && task.options?.length === 2 && task.options[0] === 'Принято' && task.options[1] === 'Есть замечания'
    // Каждая целиком нарисованная карточка получает свою отметку; варианты выбора также должны быть видны целиком.
    if (canComplete && (task.kind !== 'choose' || legacyReview || selected?.id === task.id && whole && layout.controls.options.length === task.options?.length)) {
      const full = consent.cards.find(item => item.id === task.id)!
      live.previewOffers.set(task.id, { signature, lines: full.context.length, serverVisible: card.context.length === full.context.length, token: card.token })
      if (card.context.length === full.context.length) live.offered.set(task.id, signatureOf(task))
    }
    const taskActions: OwnerAction[] = []
    const add = (key: string, glyph: string, fallback: string, hint: string, shortcut: string, run: () => unknown) =>
      taskActions.push({ key: card.id === layout.cards[0]?.id ? key : `${key}-${task.id}`, taskId: task.id, label: nerd ? glyph : fallback, hint, keyHint: shortcut, shortcut, hidden: true,
        run: () => run() })
    if (task.taskAlias) {
      add('owner-done', '\u{f05e0}', '✓', 'Принято', 'd', () => completeCard($, task, 'Принято')) // md-check_circle
      if (hasEditor) {
        // У приёмки два действия: принять и не принять; замечание пишется причиной отказа. Поле комментария без
        // вердикта остаётся только у сохранённого прежней версией черновика, и тот же значок его закрывает.
        if (field?.id === task.id && field.field === 'review-comment') add('owner-answer', '\u{f0156}', '✕', 'Отменить ввод', 'a', () => closeEditor($)) // md-close
        add('owner-reject', '\u{f0159}', '×', 'Не принято', 'x', () => startReview($, task.id, 'review-reject')) // md-close_circle
      } else add('owner-reject', '\u{f0159}', '×', 'Не принято', 'x', () => reject($, task.id)) // md-close_circle
    } else {
      if (canComplete && task.kind !== 'choose') add('owner-done', '\u{f05e0}', '✓', 'Сделано', 'd', () => completeCard($, task)) // md-check_circle
      if (isPlainTask(task)) {
        if (hasEditor && field?.id === task.id && (field.field === 'answer' || field.field === 'review-reject')) add('owner-answer', '\u{f0156}', '✕', 'Отменить ввод', 'a', () => closeEditor($)) // md-close
        else if (hasEditor) add('owner-answer', '\u{f03eb}', '✎', 'Ответить', 'a', () => startEditing($, task.id)) // md-pencil
      }
      // Крестик открывает поле причины у карточки любого вида. При открытом поле этой карточки он отклоняет:
      // набранное становится причиной, пустое поле отклоняет без причины. В панели, где поле не поместится,
      // крестик отклоняет сразу: отказ остаётся доступным и в тесной раскладке.
      const writing = field?.id === task.id && (field.field === 'answer' || field.field === 'review-reject')
      // Поле помещается, когда вместе с ним входит хотя бы рамка карточки со строкой названия.
      const reasonFits = () => {
        const controls = ownerLayout(shown, task.id, { id: task.id, field: 'review-reject' }, height, width, hasHeight ? height : 0, live.sessionId, hasEditor, isBusy,
          live.expandedId, Client !== undefined, draftCellsOf(task.id, shown, width), true).controls
        return hasHeight && controls.input && controls.height + 3 <= height
      }
      add('owner-reject', '\u{f0159}', '×', 'Отклонить', 'x', () => hasEditor && !writing && reasonFits() ? startReview($, task.id, 'review-reject') : reject($, task.id)) // md-close_circle
    }
    if (isPlainTask(task)) {
      if (selected?.id === task.id && layout.expanded) add('owner-collapse', '\u{f0209}', '▴', 'Свернуть', 'o', () => stopReading($)) // md-eye_off
      else {
        const fullLines = card.detailsLength ?? consent.cards.find(item => item.id === task.id)?.context.length ?? 0
        // Раскрытие под указателем показывает до восьми строк и только в свободном месте раздела. Когда полный текст
        // туда не входит либо согласие закрыто по другой причине, остаётся «Показать целиком»: иначе согласие
        // закрыто, а открыть текст нечем. Варианты выбора открываются своим действием.
        const cut = (card.details?.length ?? card.context.length) < fullLines || card.context.length < fullLines && fullLines > cardsRoom - card.height
        if (!canComplete || cut)
          add('owner-read', '\u{f0208}', '▾', 'Показать целиком', 'o', () => startReading($, task.id)) // md-eye
        else if (task.kind === 'choose' && !legacyReview && !(selected?.id === task.id && layout.controls.options.length))
          add('owner-read', '\u{f0279}', '≡', 'Варианты ответа', 'o', () => startReading($, task.id)) // md-format_list_bulleted
      }
    }
    actions.push(...taskActions)
    card.controls = taskActions.map(({ run, taskId, ...action }) => action)
  }
  const savedCards = layout.saved.map(task => {
    const action: OwnerAction = { key: `owner-send-${task.id}`, label: nerd ? SAVED_SEND.nerd : SAVED_SEND.plain,
      hint: 'Отправить', keyHint: '', hidden: true, run: () => sendNow($) }
    actions.push(action)
    const { run, ...control } = action
    return { ...savedCardOf(task, layout.textWidth), controls: [control] }
  })
  const hiddenTask = shown.filter(isActive).find(task => task.id !== selected?.id && !layout.cards.some(card => card.id === task.id))
  const more = !layout.more ? null : <Button key="owner-more" plain
    label={layout.hidden > 0 ? `[ Ещё ${layout.hidden + layout.hiddenSaved} ]` : `[ Отправить ${layout.hiddenSaved} ]`}
    onPress={() => hiddenTask === undefined ? sendNow($) : startReading($, hiddenTask.id)} />
  // Отвеченная карточка остаётся на своём месте: порядок списка — порядок поручений, ответ его не меняет.
  const drawn = new Map<number, OwnerCardsProps['cards'][number]>([...layout.cards, ...savedCards].map(card => [card.id, card]))
  const ordered = shown.flatMap(task => { const card = drawn.get(task.id); return card ? [card] : [] })
  const cards = { cards: ordered, width: layout.cardWidth, height: cardsRoom, theme, plain: !nerd,
    generation: live.cardsGeneration, ...(selected ? { selectedId: selected.id } : {}), ...(search?.active && search.query ? { search: search.query,
      searchTitles: Object.fromEntries(layout.cards.map(card => [card.id, wrappedSearchRanges(search.query!, ownerShownTitle(shown.find(task => task.id === card.id)!), card.titleLines)])) } : {}) } satisfies OwnerCardsProps
  const roles = roleColors(theme)
  const section = <Box key="owner-tasks" flexDirection="column" width={width} height={height} flexShrink={0} overflow="hidden">
      {Client ? <Client key="owner-cards" module="./cards.tsx" width={cards.width} height={cards.height} props={cards} /> : drawOwnerCards(ui, cards, key => actions.find(action => action.key === key)?.run(e.surface))}
      {selected !== undefined && layout.expanded && !whole ? <Box key="owner-too-small" height={1} flexShrink={0}>
        <Text color={roles.muted} wrap="truncate-end">{layout.fitsWidth ? `Панель мала: нужно ${layout.needed + 3} строк. Увеличь панель.` : 'Панель мала: увеличь ширину для текста и поля ответа.'}</Text>
      </Box> : null}
      {selected !== undefined && !isPlainTask(selected) ? <Text color={roles.muted} wrap="truncate-end">В тексте недопустимые знаки.</Text> : null}
      {more ? <Box key="owner-more-row" height={1} flexShrink={0}>{more}</Box> : null}
      {shown.length === 0 ? <Box key="owner-empty" height={1}><Text color={roles.muted} wrap="truncate-end">{search?.active ? search.empty : 'Агенту от тебя сейчас ничего не нужно'}</Text></Box> : null}
      {shown.length === 0 && search?.active && search.unavailable ? <Box key="owner-search-unavailable" height={1}><Text color={roles.muted} wrap="truncate-end">{SEARCH_UNAVAILABLE}</Text></Box> : null}
      <Box key="owner-bottom-space" flexGrow={1} />
      {selected === undefined ? null : ownerControls($, e, selected, isBusy, shown.filter(isActive).length, layout, theme, !nerd)}
    </Box>
  return { actions, section }
}

// Число строк набранного в нижнем поле ответа, отрицательным числом: так его принимает inputLinesOf.
function draftCellsOf(selectedId: number | null, shown: readonly Task[], width: number): number {
  const task = shown.filter(isActive).find(one => one.id === selectedId) ?? shown.filter(isActive)[0]
  if (task === undefined) return 0
  // Та же ширина, что у клиента: карточка уже панели на две ячейки, текст — на EDITOR_INSET уже карточки.
  return -editorRows(live.drafts.get(task.id) ?? '', Math.max(1, width - 2 - EDITOR_INSET)).length
}

function ownerControls($: EngineInterface, e: RenderInput<'Pane'>, task: Task, busy: boolean, open: number, layout: ReturnType<typeof ownerLayout>, theme: Theme, plain: boolean): RenderElement {
  const ui = $.ui.resolve(e)
  const { Box, Text, Button } = ui
  const Client = (e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in ui ? ui.Client : undefined
  const { controls, cardWidth: width } = layout
  live.editorVisible = controls.input && Client !== undefined
  const roles = roleColors(theme)
  const hover = hoverColor(theme)
  const editor: EditorProps = rememberEditor(live.editorProps, { ...editorSnapshot(live.editors, `owner-${live.sessionId}-${task.id}`, live.drafts.get(task.id) ?? ''),
    element: 'owner-answer-input', frame: 'owner-answer-frame', width, height: controls.inputHeight, theme, plain, submitLabel: busy ? 'Сохранить' : 'Отправить',
    placeholder: controls.reviewMode === 'review-reject' ? 'Причина отказа' : controls.reviewMode === 'review-comment' ? 'Комментарий агенту' : 'Ответ агенту',
    actions: [...controls.buttons.flat().map(button => ({ key: `owner-${button}`, label: button === 'long' ? '↗' : button === 'edit' ? '✎' : button === 'send-anyway' ? '!' : '⇥',
      hint: button === 'long' ? 'В строку ввода' : ownerButtonLabel(button, busy).replace(/^\[ | \]$/gu, '') })),
      ...(!controls.buttons.flat().includes('long') ? [{ key: 'owner-long', label: '↗', hint: 'В строку ввода' }] : []),
      { key: 'owner-field-cancel', label: '×', hint: 'Отменить ввод  [Esc]' }] })
  void open
  return <Box key="owner-controls" flexDirection="column" width={width} height={controls.height} flexShrink={0}>
    <Box key="owner-actions" flexDirection="column" flexShrink={0}>
      {controls.options.map((lines, index) => <Box key={`owner-choice-${index}`} width={width} height={lines.length} flexDirection="column" flexShrink={0}>
        {lines.map((line, row) => <Box key={`owner-option-row-${index + 1}-${row}`} height={1} width={width} flexShrink={0}>
          <Button key={row ? `owner-option-${index + 1}-line-${row}` : `owner-option-${index + 1}`} plain hotkey={row ? undefined : String(index + 1)}
            label={`${row ? '    ' : ' '}${line.padEnd(Math.max(1, width - 4))}`} hover={{ scope: `cockpit-option-${index + 1}`, color: hover, inverse: false }}
            onPress={() => resolve($, task.id, { state: 'done', answer: task.options![index]! }, 'auto')} />
          {row ? null : <Box key={`owner-option-prefix-${index + 1}`} position="absolute" top={0} left={0} width={3} height={1}>
            <Text hover={{ scope: `cockpit-option-${index + 1}`, color: hover }}>{`[${index + 1}]`}</Text></Box>}
        </Box>)}
      </Box>)}
    </Box>
    {controls.warning.length ? <Box key="owner-held" flexDirection="column" height={controls.warning.length} flexShrink={0}>
      {controls.warning.map((line, i) => <Text key={`owner-warning-${i}`} color={roles.muted}>{line}</Text>)}
    </Box> : null}
    {controls.input && Client !== undefined ? <Client key="owner-answer-input" module="../editor.tsx" width={width} height={controls.inputHeight} props={editor} /> : null}
  </Box>
}

async function syncWorking($: EngineInterface) {
  const now = working()

  await update($, isWorking, () => now)
}

async function join($: EngineInterface) {
  live.sessionId = await $.session.id()
  live.root = await $.session.root()
  await load($)

  live.heartbeat?.cancel()
  live.heartbeat = $.clock.every(HEARTBEAT_MS, () => void beat($))

  await refresh($)
}

async function load($: EngineInterface) {
  const nowMs = await $.clock.now()

  if ((await read($, loadedFor)) === live.sessionId) {
    await beat($)
    return
  }

  const { adopted, drafts, stored } = adopt(await readStore($), live.sessionId, nowMs)

  // Ответ из файла хранилища в этой сессии владелец не давал: он ждёт в поле черновиком.
  for (const [id, draft] of drafts) { live.drafts.set(id, draft); live.unseenDrafts.add(id) }

  await update($, tasks, () => adopted)
  await update($, nextId, n => Math.max(n, stored.nextId))
  await update($, loadedFor, () => live.sessionId)
  await writeStore($, withSlot(stored, live.sessionId, adopted, nowMs))
  live.elsewhere = elsewhereIn(stored, live.sessionId, nowMs)
  await reselect($)
}

async function beat($: EngineInterface) {
  const nowMs = await $.clock.now()
  const stored = await readStore($)
  const elsewhere = elsewhereIn(stored, live.sessionId, nowMs)

  await writeStore($, withSlot(stored, live.sessionId, await read($, tasks), nowMs))

  if (elsewhere !== live.elsewhere) {
    live.elsewhere = elsewhere
    await refresh($)
  }
}

function storeKey(): string {
  return `owner-tasks:${live.root}`
}

async function readStore($: EngineInterface): Promise<Stored> {
  return storedOf(await $.store.get(storeKey()))
}

async function writeStore($: EngineInterface, stored: Stored) {
  await $.store.set(storeKey(), stored)
}

async function change($: EngineInterface, fn: (list: readonly Task[]) => readonly Task[]) {
  const list = await update($, tasks, fn)
  const nowMs = await $.clock.now()
  const stored = await readStore($)
  const counted = { ...stored, nextId: Math.max(stored.nextId, await read($, nextId)) }

  await writeStore($, withSlot(counted, live.sessionId, list, nowMs))
  live.elsewhere = elsewhereIn(stored, live.sessionId, nowMs)
  await refresh($)
}

async function refresh($: EngineInterface): Promise<boolean> {
  const shown = (await read($, tasks)).filter(isShown)

  $.ui.status(statusOf(shown, live.elsewhere))
  $.ui.invalidate('ui.render')


  return shown.length > 0
}

async function fit($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

async function edit($: EngineInterface, id: number, fn: (task: Task) => Task) {
  const nowMs = await $.clock.now()

  await change($, list => list.map(task => (task.id === id ? { ...fn(task), updatedMs: nowMs } : task)))
}

async function delivered($: EngineInterface, ids: readonly number[]) {
  if (ids.length === 0) {
    return
  }

  await change($, list => list.map(task => (ids.includes(task.id) ? { ...task, update: 'delivered', remarks: undefined } : task)))
}

async function settle($: EngineInterface, id: number) {
  clearEditorFocus(live.editorFocus)
  if (live.expandedId === id) live.expandedId = null
  live.drafts.delete(id); live.unseenDrafts.delete(id)
  live.offered.delete(id)
  live.reviewModes.delete(id)
  await update($, editing, field => (field?.id === id ? null : field))
  await reselect($)
}

async function reselect($: EngineInterface) {
  const active = (await read($, tasks)).filter(isActive)

  await update($, selectedId, chosen => (active.some(task => task.id === chosen) ? chosen : (active[0]?.id ?? null)))
}

// Согласие проверяется в момент нажатия, а не только при отрисовке: устаревшая кнопка,
// строка ввода или сменившаяся ширина не проводят решение по тексту, показанному не целиком.
async function resolve($: EngineInterface, id: number, patch: Pick<Task, 'state'> & Partial<Task>, how: How): Promise<boolean> {
  const target = (await read($, tasks)).find(one => one.id === id)
  if (!target || !isActive(target)) return false
  if (patch.state === 'done') {
    const task = (await read($, tasks)).find(one => one.id === id)
    // Приёмка — вердикт владельца о сделанной задаче: её номер и итог стоят на карточке, а решение «принято»
    // агенту ничего не разрешает. Она принимается с первого нажатия. Признак — не номер задачи на карточке, а
    // сам вердикт: карточка, созданная модом при закрытии задачи (два его варианта), и ответ «Принято». Любой
    // другой ответ и любое поручение («сделай», «выбери», «ответь») описывают действие в тексте, и согласие на
    // текст, показанный не целиком, по-прежнему не принимается.
    const review = task !== undefined && task.taskAlias !== undefined && task.kind === 'choose' && patch.answer === 'Принято'
      && task.options?.length === 2 && task.options[0] === 'Принято' && task.options[1] === 'Есть замечания'
    if (task === undefined || !isPlainTask(task) || !review && live.offered.get(id) !== signatureOf(task)) {
      // Первое нажатие раскрывает поручение целиком. Открытое поле ответа раскрытие не закрывает: набранный текст
      // остаётся в поле, и сообщение говорит, что мешает; оно же остаётся, когда раскрывать уже нечего.
      if (task !== undefined && isPlainTask(task) && live.expandedId !== id && (await read($, editing))?.id !== id) await startReading($, id)
      else $.ui.toast('Задача показана не целиком: разверни её в панели «Задачи», чтобы ответить.')
      $.ui.invalidate('ui.render')
      return false
    }
  }
  const review = target.taskAlias !== undefined && target.kind === 'choose' && target.options?.length === 2
    && target.options[0] === 'Принято' && target.options[1] === 'Есть замечания'
  if (review && (patch.state === 'rejected' || patch.state === 'done' && patch.answer === 'Есть замечания')) {
    const result = await $.cockpitTasks.returnReview({ id: target.id, taskAlias: target.taskAlias!, comment: patch.reason ?? '' })
    if (result === 'failed') {
      $.ui.toast('Задача не возвращена. Ответ сохранён в черновике; повтори отправку.')
      return false
    }
    if (result === 'reopened') patch = { ...patch, taskReturned: true }
  }
  await edit($, id, task => ({ ...task, ...patch, update: 'pending' }))
  await settle($, id)

  if (how === 'now' || (how === 'auto' && !working())) {
    sendSoon($)
  }
  return true
}

async function answer($: EngineInterface, id: number, text: string, how: How, isSecretOk = false) {
  const value = text

  if (value.trim() === '') {
    $.ui.toast('Ответ не сохранён: поле пустое. Сначала напиши ответ.')
    return
  }

  live.drafts.set(id, value)
  if (!isSecretOk && looksSecretInDraft(value)) {
    await update($, editing, (): Editing => ({ id, field: 'answer', held: HELD }))
    return
  }

  await resolve($, id, { state: 'done', answer: value }, how)
}

async function completeCard($: EngineInterface, task: Task, answer?: string) {
  return resolve($, task.id, { state: 'done', ...(answer ? { answer } : {}) }, 'auto')
}

async function ownerKey($: EngineInterface, key: string, surface: RenderSurface): Promise<boolean> {
  // Выбранной карточки на вид нет, поэтому клавиша действует только на видимую цель:
  // карточку под курсором либо единственную. Иначе «принять» и «отклонить» ушли бы в карточку, на которую владелец не смотрит.
  const id = live.cardIds.includes(live.hoveredId ?? -1) ? live.hoveredId : live.cardIds.length === 1 ? live.cardIds[0] : undefined
  if (id === undefined) return false
  const action = live.actions.find(item => item.taskId === id && item.shortcut === key)
  if (!action) return false
  await action.run(surface)
  return true
}

async function closeEditor($: EngineInterface) {
  clearEditorFocus(live.editorFocus)
  const field = await read($, editing)
  if (field) live.reviewModes.delete(field.id)
  live.expandedId = null
  await update($, editing, () => null)
  await fit($)
}

async function startReview($: EngineInterface, id: number, mode: 'review-reject' | 'review-comment') {
  live.reviewModes.set(id, mode)
  await update($, selectedId, () => id)
  await update($, editing, () => ({ id, field: mode }))
  await fit($)
  void $.ui.focus({ requestId: PANE, key: 'owner-answer-input' }).then(undefined, () => undefined)
}

async function reviewModeFor($: EngineInterface, id: number) {
  const cached = live.reviewModes.get(id)
  if (cached) return cached
  const field = await read($, editing)
  return field?.id === id && (field.field === 'review-reject' || field.field === 'review-comment') ? field.field : undefined
}

async function submitAnswer($: EngineInterface, id: number, text: string, how: How, isSecretOk = false): Promise<boolean> {
  clearEditorFocus(live.editorFocus)
  const mode = await reviewModeFor($, id)
  if (!mode) { await answer($, id, text, how, isSecretOk); return !(await read($, tasks)).some(task => task.id === id && isActive(task)) }
  live.drafts.set(id, text)
  if (!isSecretOk && looksSecretInDraft(text)) {
    await update($, editing, () => ({ id, field: mode, held: HELD }))
    return false
  }
  const value = mode === 'review-reject' && live.unseenDrafts.has(id) ? '' : oneLine(text)
  if (value.length > MAX_REASON) { $.ui.toast(`Ответ не сохранён: сократи текст до ${MAX_REASON} знаков. Черновик сохранён.`); return false }
  if (mode === 'review-reject') {
    const done = await resolve($, id, { state: 'rejected', ...(value ? { reason: value } : {}) }, how)
    if (done && how === 'auto' && working()) live.isSendingAtEnd = true
    return done
  }
  if (!value) { $.ui.toast('Комментарий не сохранён: поле пустое. Напиши текст.'); return false }
  const task = (await read($, tasks)).find(task => task.id === id && isActive(task))
  if (!task) return false
  await edit($, id, task => ({ ...task, remarks: [...(task.remarks ?? []), value], update: 'pending' }))
  live.unseenDrafts.delete(id); live.reviewModes.delete(id)
  await update($, editing, field => field?.id === id ? null : field)
  if (how === 'now' || how === 'auto' && !working()) sendSoon($)
  else if (how === 'auto') live.isSendingAtEnd = true
  return true
}

async function reject($: EngineInterface, id: number) {
  // Причиной становится только набранное владельцем в этой сессии: текст из хранилища, который он не правил, агенту с крестика не уходит.
  const draft = live.unseenDrafts.has(id) ? '' : live.drafts.get(id) ?? ''
  // Проверяется весь черновик: нормализация и предел длины не должны скрыть секрет.
  if (looksSecretInDraft(draft)) {
    await update($, editing, (): Editing => ({ id, field: 'answer', held: HELD }))
    return
  }
  const reason = oneLine(draft)
  if (reason.length > MAX_REASON) {
    $.ui.toast(`Отказ не отправлен: сократи причину до ${MAX_REASON} знаков. Черновик сохранён.`)
    return
  }
  await resolve($, id, { state: 'rejected', ...(reason === '' ? {} : { reason }) }, 'auto')
}

async function startEditing($: EngineInterface, id: number) {
  clearEditorFocus(live.editorFocus)
  // Поле ответа после поля причины: отправленный текст — ответ, а не отказ.
  live.reviewModes.delete(id)
  await update($, selectedId, () => id)
  await update($, editing, (): Editing => ({ id, field: 'answer' }))
  await fit($)

  void $.ui.focus({ requestId: PANE, key: 'owner-answer-input' }).then(undefined, () => undefined)
}

async function startReading($: EngineInterface, id: number) {
  live.expandedId = id
  await update($, selectedId, () => id)
  await update($, editing, (): Editing => ({ id, field: 'read' }))
  await fit($)
}

async function stopReading($: EngineInterface) {
  live.expandedId = null
  await update($, editing, field => field?.field === 'read' ? null : field)
  await fit($)
}

async function longAnswer($: EngineInterface, id: number) {
  const task = (await read($, tasks)).find(task => task.id === id && isActive(task))
  if (!task) return
  const box = await $.prompt.read()
  const draft = live.drafts.get(id) ?? ''
  const text = bridgeOf(task) + [draft, box.text].filter(part => part.trim() !== '').join('\n')
  const filled = await $.prompt.fill({ text, mode: 'replace' })

  if (!filled.isFilled) {
    $.ui.toast('Ответ не перенесён: строка ввода недоступна. Напиши его в панели.')
    return
  }

  clearEditorFocus(live.editorFocus)
  live.drafts.delete(id); live.unseenDrafts.delete(id)
  const mode = await reviewModeFor($, id)
  // Режим приёмки сохраняется и для длинного ответа, в том числе после перезагрузки.
  live.expandedId = id
  await update($, editing, () => mode ? { id, field: mode } : { id, field: 'read' })
  $.ui.toast('Напиши ответ в строке ввода (Esc вернёт туда), затем нажми Enter.', { timeoutMs: 8000 })
}

function sendNow($: EngineInterface) {
  live.batch?.cancel()
  live.batch = null
  void send($)
}

function sendSoon($: EngineInterface) {
  live.batch?.cancel()
  live.batch = $.clock.after(BATCH_MS, () => {
    live.batch = null
    void send($)
  })
}

async function send($: EngineInterface, isTurnOver = false) {
  const due = (await read($, tasks)).filter(task => task.update === 'pending')

  if (due.length === 0) {
    return
  }

  const text = messageOf(due)
  const ids = due.map(task => task.id)
  const which = due.map(ownerTaskCaption).join(', ')

  if (isTurnOver || !working()) {
    await delivered($, ids)
    void $.prompt.submit({ text, asUser: true })
    return
  }

  const isTaken = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).then(
    appended => appended.deny === undefined,
    () => false,
  )

  if (!isTaken) {
    live.isSendingAtEnd = true
    $.ui.toast('Ответ пока не доставлен: агент занят. Он получит его, когда закончит этот ход.')
    return
  }

  live.isUnread = true
  await delivered($, ids)

  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: 'Твой ответ отправлен агенту.' }] } })
  } catch {
  }
}

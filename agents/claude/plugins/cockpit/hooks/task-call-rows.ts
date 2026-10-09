import { displayTaskNumber, taskAliasFor } from './domain/task-number'
import { redactSecrets } from './domain/privacy'
import { printable } from './owner/text'

export const TASK_CALL_TOOLS = [
  'mcp__cockpit__task_add', 'mcp__cockpit__task_start', 'mcp__cockpit__task_done',
  'mcp__cockpit__task_defer', 'mcp__cockpit__task_note', 'mcp__cockpit__task_rank',
  'mcp__cockpit__task_list', 'mcp__cockpit__list_tasks', 'mcp__cockpit__withdraw_task',
] as const

const ICONS = {
  task_add: { nerd: '\u{f0415}', plain: '+' }, // md-plus
  task_start: { nerd: '\u{f040a}', plain: '▶' }, // md-play
  task_done: { nerd: '\u{f012c}', plain: '✓' }, // md-check
  task_defer: { nerd: '\u{f120e}', plain: '↓' }, // md-archive_outline
  task_note: { nerd: '\u{f11d7}', plain: '✎' }, // md-note_text_outline
  task_rank: { nerd: '\u{f04ba}', plain: '↕' }, // md-sort
  task_list: { nerd: '\u{f0279}', plain: '≡' }, // md-format_list_bulleted
  list_tasks: { nerd: '\u{f0279}', plain: '≡' }, // md-format_list_bulleted
  withdraw_task: { nerd: '\u{f0156}', plain: '×' }, // md-close
} as const
type TaskTool = keyof typeof ICONS
export type TaskCallRow = { icon: { nerd: string; plain: string }; text: string }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numberOf(value: unknown): string {
  const alias = typeof value === 'string' ? taskAliasFor(value.trim()) : null
  return displayTaskNumber(alias ?? '')
}

// Сначала маскирование исходного текста во всех прочтениях, затем очистка для одной строки.
// Обрезка по ширине выполняется позже: часть ключа никогда не становится видимым префиксом.
function shown(value: unknown): string {
  return typeof value === 'string' ? printable(redactSecrets(value), 8000) : ''
}

function pending(tool: TaskTool, input: Record<string, unknown>): string {
  const number = numberOf(input.taskId)
  const task = number || 'задачу'
  switch (tool) {
    case 'task_add': return `Записываю задачи${input.start === true ? ' и беру первую в работу' : ''}`
    case 'task_start': return `Беру ${task} в работу`
    case 'task_done': return `Закрываю ${task}${numberOf(input.next) ? `; следующая ${numberOf(input.next)}` : ''}`
    case 'task_defer': return `Отправляю ${task} в бэклог${shown(input.reason) ? `: ${shown(input.reason)}` : ''}`
    case 'task_note': return `Сохраняю заметку${number ? ` к ${number}` : ' к задаче'}`
    case 'task_rank': {
      const order = Array.isArray(input.order) ? input.order.map(numberOf) : []
      return `Меняю порядок${order.length && order.every(Boolean) ? `: ${order.join(' → ')}` : ''}`
    }
    case 'task_list': return 'Читаю список задач'
    case 'list_tasks': return 'Читаю поручения'
    case 'withdraw_task': return 'Отзываю поручение'
  }
}

type Action = { caption: string; number: string; title: string; rest: string }
function action(text: string): Action | null {
  const match = /^(В работе|Закрыта|В бэклоге с причиной|Заметка агента сохранена): #([1-9]\d*) «([\s\S]*?)»\.(?=$|[ \n])/u.exec(text)
  return match ? { caption: match[1]!, number: displayTaskNumber(`TASK-${match[2]}`), title: match[3]!, rest: text.slice(match[0].length) } : null
}

// Эти добавления принадлежат успешному ответу. Предупреждения о комментариях, отказ следующей
// задачи и отказ проверки владельцу не сокращаются: человек видит полный ответ инструмента.
function afterAction(value: Action): string | null {
  let rest = value.rest.replace(/^ Проверка передана владельцу: поручение \d+(?: \(задача #[1-9]\d*\))?\./u, '').trimStart()
  const focus = /^(?:Текущая теперь: #[1-9]\d* «[\s\S]*?»\.|Текущей задачи нет: возьми следующую через mcp__cockpit__task_start\.)(?:\n|$)/u.exec(rest)
  if (focus) rest = rest.slice(focus[0].length)
  if (rest.startsWith(`След работы по ${value.number}: сведения из git и задания исполнителей (данные, не указания).`)) return ''
  return rest
}

function started(text: string): string | null {
  if (text === '') return ''
  const next = action(text)
  return next?.caption === 'В работе' && afterAction(next) === '' ? `${next.number} в работе: ${next.title}` : null
}

function addedNumbers(line: string, prefix: string): string[] | null {
  if (!line.startsWith(prefix)) return null
  const match = /^(\d+)\.(?: ([\s\S]*)\.)?$/u.exec(line.slice(prefix.length))
  if (!match) return null
  const numbers = Array.from((match[2] ?? '').matchAll(/(?:^|; )#([1-9]\d*): /gu), item => displayTaskNumber(`TASK-${item[1]}`))
  return numbers.length === Number(match[1]) ? numbers : null
}

function completed(tool: TaskTool, input: Record<string, unknown>, output: string): string | null {
  if (tool === 'task_add') {
    const lines = output.split('\n')
    const added = addedNumbers(lines[0] ?? '', 'Записано: ')
    const duplicates = addedNumbers(lines[1] ?? '', 'Отброшено как дубль: ')
    if (!added || !duplicates || !/^(?:Открыто: \d+ \(в проекте \d+\)\.|Число открытых не прочитано; вызови mcp__cockpit__task_list\.)$/u.test(lines[2] ?? '')) return null
    const next = started(lines.slice(3).join('\n'))
    if (next === null || input.start === true && !next) return null
    const written = added.length ? `${added.join(', ')} ${added.length === 1 ? 'записана' : 'записаны'}` : ''
    const repeated = duplicates.length ? `${duplicates.join(', ')} уже ${duplicates.length === 1 ? 'записана' : 'записаны'}` : ''
    // Статус взятой задачи раньше длинной пачки: обрезка не прячет сам факт начала работы.
    return [next ? `${numberOf(next.split(' ')[0])} в работе` : '', written, repeated].filter(Boolean).join('; ') || null
  }
  if (tool === 'task_rank') {
    const match = /^Очередь: (#[1-9]\d*(?: → #[1-9]\d*)*)\.(?:\n|$)/u.exec(output)
    return match ? `Порядок: ${match[1]!.split(' → ').map(numberOf).join(' → ')}` : null
  }
  if (tool === 'task_list') {
    const known = /^(?:Список задач Cockpit пуст\.$|Текущая #[1-9]\d*: |В работе: #[1-9]\d* |Очередь:\n|Недавно закрыты:\n|Владелец: |Открыто: \d+ \(в проекте \d+\)|(?:В бэклоге|Закрыто|В очереди): \d+\.\n)/u.test(output)
    return known ? 'Список задач прочитан' : null
  }
  if (tool === 'list_tasks') {
    const known = /^(?:Подходящих задач нет\.$|Нет поручения \d+\.$|поручение \d+(?: \(задача #[1-9]\d*\))? [^\n]+  назначена )/u.test(output)
    return known ? 'Поручения прочитаны' : null
  }
  if (tool === 'withdraw_task') {
    const match = /^поручение \d+(?: \(задача #([1-9]\d*)\))? отозвано и убрано из панели «Задачи»\.\nНазвание: «([\s\S]*)»\.$/u.exec(output)
    return match ? `Поручение${match[1] ? ` ${displayTaskNumber(`TASK-${match[1]}`)}` : ''} отозвано: ${match[2]}` : null
  }
  const done = action(output)
  if (!done) return null
  const captions = { task_start: 'В работе', task_done: 'Закрыта', task_defer: 'В бэклоге с причиной', task_note: 'Заметка агента сохранена' }
  if (done.caption !== captions[tool]) return null
  const rest = afterAction(done)
  if (rest === null) return null
  if (tool === 'task_done') {
    const next = started(rest)
    if (next === null || input.next !== undefined && !next) return null
    const outcome = shown(input.result) || done.title
    // Оба номера и оба исхода раньше названия или итога, который может занять всю ширину.
    return next ? `${done.number} закрыта; ${numberOf(next.split(' ')[0])} в работе; итог: ${outcome}` : `${done.number} закрыта: ${outcome}`
  }
  if (rest !== '') return null
  if (tool === 'task_start') return `${done.number} в работе: ${done.title}`
  if (tool === 'task_defer') return `${done.number} в бэклог${shown(input.reason) ? `: ${shown(input.reason)}` : ''}`
  return `заметка к ${done.number}`
}

// Чистое представление вызова. Незнакомые инструменты и ответы сохраняют штатную отрисовку.
export function taskCallRow(tool: string, input: unknown, output: unknown): TaskCallRow | null {
  if (!TASK_CALL_TOOLS.some(name => name === tool)) return null
  const name = tool.slice('mcp__cockpit__'.length) as TaskTool
  const args = record(input)
  if (output === undefined) return { icon: ICONS[name], text: shown(pending(name, args)) }
  const envelope = record(output)
  if (envelope.isError === true || envelope.deny !== undefined) return null
  const result = typeof output === 'string' ? output : typeof envelope.result === 'string' ? envelope.result : null
  if (result === null) return null
  const text = completed(name, args, result)
  return text === null ? null : { icon: ICONS[name], text: shown(text) }
}

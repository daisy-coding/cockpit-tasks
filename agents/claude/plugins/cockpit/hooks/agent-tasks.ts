import type { ToolSpec } from 'claude-code'

const taskId = { type: 'string', description: 'Номер задачи #N из task_list или идентификатор taskId. Принимается и прежняя запись номера, с префиксом task- любого регистра или без префикса. Без него используется текущая задача.' }
const fields = {
  title: { type: 'string', maxLength: 80, description: 'Что сделать: повелительное наклонение, до 80 знаков.' },
  description: { type: 'string', maxLength: 4000, description: 'Необязательное описание работы.' },
  acceptance: { type: 'string', maxLength: 1000, description: 'Как проверить готовность. Сохраняется в описании с пометкой «Готово, когда».' },
  place: { type: 'string', enum: ['top', 'bottom'], description: 'Место среди незакреплённых задач: top — вверху, bottom — внизу (по умолчанию). Закреплённые владельцем остаются на своих местах.' },
}

export const AGENT_TOOLS: readonly ToolSpec[] = [
  { name: 'task_add', description: 'Запиши поручения агенту в Cockpit до начала работы. Одну задачу передай через title, несколько — массивом tasks (1–20). Несколько просьб владельца записывай одним вызовом. Дубли не создаются. Владелец ничего не принимает и не отклоняет.',
    inputSchema: { type: 'object', properties: { ...fields, start: { type: 'boolean', description: 'true — сразу взять первую записанную задачу в работу этим же вызовом, без отдельного task_start.' }, tasks: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: fields, required: ['title'], additionalProperties: false } } }, additionalProperties: false } },
  { name: 'task_rank', description: 'Расставь открытые задачи очереди по важности. order — номера #N или taskId от самого важного; прежние записи номера тоже принимаются. Неуказанные остаются ниже в прежнем взаимном порядке. Закреплённые владельцем остаются на своих местах. Текущая, задачи бэклога и закрытые не принимаются.',
    inputSchema: { type: 'object', properties: { order: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true, items: { type: 'string' } } }, required: ['order'], additionalProperties: false } },
  { name: 'task_start', description: 'Возьми задачу агенту в работу перед правкой или командами, в том числе верни её из бэклога. Укажи номер #N или taskId из task_list. Новые просьбы записывай, сохраняя текущую работу.',
    inputSchema: { type: 'object', properties: { taskId }, required: ['taskId'], additionalProperties: false } },
  { name: 'task_done', description: 'Закрой только сделанную и проверенную задачу. result — необязательно: что сделано, до 60 знаков одной строкой, заголовок карточки проверки. review обязателен: что именно владелец сам увидит на экране (до 300 знаков) либо "none". Текст — только когда владелец может сам увидеть результат в панели или терминале; внутреннее поведение, тесты, ошибки, которых он не увидит, и работу самих инструментов проверяешь сам и пишешь "none". Без taskId закрывается текущая. Необязательный summary (одна-две строки до 500 знаков) сохраняется заметкой агента перед закрытием.',
    inputSchema: { type: 'object', properties: { taskId, result: { type: 'string', maxLength: 60, description: 'Что сделано: короткий заголовок проверки, до 60 знаков одной строкой без секретов.' }, review: { type: 'string', maxLength: 300, description: 'Что именно владелец сам увидит на экране: обычный текст или до 6 коротких пунктов, каждый с новой строки с "- "; перед списком допустима одна вводная строка. Всего до 300 знаков с переносами либо "none", если проверка не нужна.' }, summary: { type: 'string', maxLength: 500, description: 'Что сделано и проверено.' }, next: { type: 'string', description: 'Необязательно: номер #N или taskId следующей задачи — она берётся в работу этим же вызовом после закрытия. Принимается и прежняя запись номера, с префиксом task- любого регистра или без префикса.' } }, required: ['review'], additionalProperties: false } },
  { name: 'task_defer', description: 'Отправь текущую или указанную задачу в бэклог с обязательной причиной. Причина сохраняется отдельной заметкой агента до отправки в бэклог.',
    inputSchema: { type: 'object', properties: { taskId, reason: { type: 'string', maxLength: 1000, description: 'Почему работа сейчас не может быть завершена.' } }, required: ['reason'], additionalProperties: false } },
  { name: 'task_note', description: 'Оставь заметку агента к текущей или указанной задаче: ход работы, находку, результат проверки. Комментарии владельца через этот инструмент не меняются.',
    inputSchema: { type: 'object', properties: { taskId, note: { type: 'string', maxLength: 1000, description: 'Заметка о работе до 1000 знаков.' } }, required: ['note'], additionalProperties: false } },
  { name: 'task_list', description: 'Прочитай текущую задачу, очередь, недавние закрытые, счётчики и правки владельца с прошлого чтения. show: "queue", "backlog" или "closed" читает страницу из 30 записей; offset — сколько пропустить (по умолчанию 0). Бэклог представлен с причинами. Правки и комментарии владельца важнее собственного плана.',
    inputSchema: { type: 'object', properties: { show: { type: 'string', enum: ['backlog', 'queue', 'closed'], description: 'Какой список читать постранично.' }, offset: { type: 'integer', minimum: 0, description: 'Сколько записей пропустить; страницы по 30 записей.' } }, additionalProperties: false } },
]

export const TASK_STEERING = [
  'Веди работу по списку Cockpit. Каждую просьбу владельца, которая займёт больше одного шага, запиши через mcp__cockpit__task_add до начала работы; несколько просьб в одной реплике — несколько задач одним вызовом (до 20, остальные следующей пачкой).',
  'Новые просьбы посреди работы запиши сразу, текущую задачу не бросай. Мелкий вопрос или ответ в одну реплику задачей не оформляй.',
  'Записав новые задачи, сверь порядок очереди с важностью: что блокирует владельца или другие задачи — выше; косметика и документация — ниже. При необходимости переставь одним вызовом mcp__cockpit__task_rank в том же ходе; порядок, выставленный владельцем, не трогай.',
  'Перед работой возьми задачу через mcp__cockpit__task_start. Закрывай задачу, как только работа сделана и проверки пройдены — не держи её открытой в ожидании взгляда владельца; result — что сделано, до 60 знаков одной строкой; review обязателен: только то, что владелец сам увидит на экране, иначе "none"; пока идёт работа (в том числе у внешнего исполнителя), у агента всегда есть текущая задача. Иначе mcp__cockpit__task_defer с причиной или mcp__cockpit__task_note о ходе работы.',
  'Вызовы списка не занимают отдельный ход: отправляй их в одном сообщении с рабочими командами. Запись и взятие — один вызов task_add со start: true; закрытие и взятие следующей — один task_done с next. Заметку оставляй, когда есть находка или результат проверки, а не ради отметки о ходе.',
  'mcp__cockpit__task_list показывает список и новости. Правки и комментарии владельца к задаче важнее собственного плана. Владелец может поставить задачу сам; принимать или отклонять задачи ему не нужно.',
].join('\n')

export const TODO_REDIRECT = 'Список работы агента ведётся в Cockpit. Используй mcp__cockpit__task_add для записи, mcp__cockpit__task_rank для порядка по важности, mcp__cockpit__task_start для начала, mcp__cockpit__task_done для завершения, mcp__cockpit__task_defer с причиной, mcp__cockpit__task_note для заметки и mcp__cockpit__task_list для чтения.'

import type { On, RenderChildren, RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { cellWidth } from '../hooks/layout'
import { taskPanelHost } from './task-panel-host'

const PREFIX = 'mcp__cockpit__'
const CALL = 'compact-task-call'
let callSequence = 0
const PLAIN = { options: { glyphs: 'plain' } }
const CASES = [
  { tool: 'task_add', input: { tasks: [{ title: 'Проверить панель' }, { title: 'Проверить ответ' }] },
    output: 'Записано: 2. #227: Проверить панель; #228: Проверить ответ.\nОтброшено как дубль: 0.\nОткрыто: 2 (в проекте 2).', text: '+ #227, #228 записаны' },
  { tool: 'task_start', input: { taskId: 'TASK-224' }, output: 'В работе: #224 «Проверить панель».\nТекущая теперь: #224 «Проверить панель».', text: '▶ #224 в работе: Проверить панель' },
  { tool: 'task_done', input: { taskId: 'TASK-224', result: 'Панель проверена', review: 'none' }, output: 'Закрыта: #224 «Проверить панель».\nТекущей задачи нет: возьми следующую через mcp__cockpit__task_start.', text: '✓ #224 закрыта: Панель проверена' },
  { tool: 'task_defer', input: { taskId: 'TASK-224', reason: 'Ждём ответа' }, output: 'В бэклоге с причиной: #224 «Проверить панель».\nТекущей задачи нет: возьми следующую через mcp__cockpit__task_start.', text: '↓ #224 в бэклог: Ждём ответа' },
  { tool: 'task_note', input: { taskId: 'TASK-224', note: 'Сверено' }, output: 'Заметка агента сохранена: #224 «Проверить панель».', text: '✎ заметка к #224' },
  { tool: 'task_rank', input: { order: ['TASK-228', '#227'] }, output: 'Очередь: #228 → #227.\nЗакреплены владельцем и не сдвинуты: нет.', text: '↕ Порядок: #228 → #227' },
  { tool: 'task_list', input: {}, output: 'Текущая #224: Проверить панель\nОткрыто: 1 (в проекте 1); в очереди: 0; в бэклоге: 0; закрыто за сутки: 0.', text: '≡ Список задач прочитан' },
  { tool: 'list_tasks', input: { show: 'open' }, output: 'поручение 7 (задача #224) открыта  назначена сейчас  Проверить ключ\n  Задача: #224\n  Зачем: Для проверки', text: '≡ Поручения прочитаны' },
  { tool: 'withdraw_task', input: { id: 7 }, output: 'поручение 7 (задача #224) отозвано и убрано из панели «Задачи».\nНазвание: «Проверить ключ».', text: '× Поручение #224 отозвано: Проверить ключ' },
] as const

function textOf(node: RenderChildren): string {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object' || !('type' in node)) return ''
  if (node.type === 'Box' && node.props?.display === 'none') return ''
  return 'children' in node ? textOf(node.children) : ''
}

function standard(on: On): string[] {
  const seen: string[] = []
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    seen.push(e.props.tool)
    const { Box, Text } = $.ui.resolve(e)
    return <Box height={3}><Text>Штатный вызов</Text></Box>
  })
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    seen.push(e.props.tool)
    const { Box, Text } = $.ui.resolve(e)
    return <Box height={3}><Text>Штатный результат</Text></Box>
  })
  return seen
}

function use(tool: string, input: unknown, output?: unknown, flags: Partial<RenderPropsOf['ToolUse']> = {}) {
  const requestId = `${CALL}-${++callSequence}`
  return { plugin: 'cockpit', surface: 'terminal', component: 'ToolUse', requestId,
    props: { tool_use_id: requestId, tool, input, output, isRunning: output === undefined, isErrored: false, isInterrupted: false, ...flags } } as const
}

function result(tool: string, output: unknown, isErrored = false, requestId = `${CALL}-${++callSequence}`) {
  return { plugin: 'cockpit', surface: 'terminal', component: 'ToolResult', requestId,
    props: { tool_use_id: requestId, tool, output, isErrored } } as const
}

for (const item of CASES) {
  test(`TASK-227: ${item.tool} завершён одной строкой`, PLAIN, async ($, on) => {
    standard(on)
    const ui = await $.ui.mount(use(PREFIX + item.tool, item.input, item.output))
    const tree = await ui.drawn()
    expect(textOf(tree)).toBe(item.text)
    expect(tree.type === 'Box' ? tree.props?.height : null).toBe(1)
    const text = await ui.find({ type: 'Text' })
    expect(text?.props?.wrap).toBe('truncate-end')
  })
  test(`TASK-227: ${item.tool} не рисует отдельный ToolResult`, PLAIN, async ($, on) => {
    standard(on)
    const call = use(PREFIX + item.tool, item.input, item.output)
    await $.ui.mount(call)
    const ui = await $.ui.mount(result(PREFIX + item.tool, item.output, false, call.requestId))
    const tree = await ui.drawn()
    expect(textOf(tree)).toBe('')
    expect(tree.type === 'Box' ? tree.props?.display : null).toBe('none')
    expect(tree.type === 'Box' ? tree.props?.height ?? 0 : -1).toBe(0)
  })
}

// Результат скрывается только вместе со строкой своего вызова: у вызова в штатном виде ответ инструмента остаётся.
test('TASK-227: результат вызова, не нарисованного строкой, остаётся на экране', PLAIN, async ($, on) => {
  standard(on)
  const item = CASES[0]!
  const lonely = await (await $.ui.mount(result(PREFIX + item.tool, item.output))).drawn()
  expect(textOf(lonely)).toBe('Штатный результат')
  // Вызов с параметром start, после которого работа не началась, строкой не рисуется — и его результат тоже.
  const output = 'Записано: 1. #227: Панель.\nОтброшено как дубль: 0.\nОткрыто: 3 (в проекте 3).'
  const call = use(PREFIX + 'task_add', { title: 'Панель', start: true }, output)
  expect(textOf(await (await $.ui.mount(call)).drawn())).toBe('Штатный вызов')
  expect(textOf(await (await $.ui.mount(result(PREFIX + 'task_add', output, false, call.requestId))).drawn())).toBe('Штатный результат')
})

const RUNNING = [
  ['task_add', { tasks: [{ title: 'Панель' }], start: true }, '+ Записываю задачи и беру первую в работу'],
  ['task_start', { taskId: 'TASK-224' }, '▶ Беру #224 в работу'],
  ['task_done', { taskId: '#224', next: 'TASK-225' }, '✓ Закрываю #224; следующая #225'],
  ['task_defer', { taskId: '224', reason: 'Ждём ответа' }, '↓ Отправляю #224 в бэклог: Ждём ответа'],
  ['task_note', { taskId: '#224', note: 'Сверено' }, '✎ Сохраняю заметку к #224'],
  ['task_rank', { order: ['TASK-228', '#227'] }, '↕ Меняю порядок: #228 → #227'],
  ['task_list', {}, '≡ Читаю список задач'],
  ['list_tasks', { show: 'all' }, '≡ Читаю поручения'],
  ['withdraw_task', { id: 7 }, '× Отзываю поручение'],
] as const
for (const [tool, input, text] of RUNNING) test(`TASK-227: ${tool} во время вызова`, PLAIN, async ($, on) => {
  standard(on)
  const tree = await (await $.ui.mount(use(PREFIX + tool, input))).drawn()
  expect(textOf(tree)).toBe(text)
  expect(tree.type === 'Box' ? tree.props?.height : null).toBe(1)
})

for (const flag of ['isErrored', 'isInterrupted'] as const) test(`TASK-227: ${flag} сохраняет исходный вызов`, PLAIN, async ($, on) => {
  const seen = standard(on)
  for (const item of CASES) {
    const tree = await (await $.ui.mount(use(PREFIX + item.tool, item.input, item.output, { [flag]: true }))).drawn()
    expect(textOf(tree)).toBe('Штатный вызов')
    expect(tree.type === 'Box' ? tree.props?.height : null).toBe(3)
  }
  expect(seen).toHaveLength(9)
})

// Вызов сначала рисуется строкой, пока идёт, а завершается прерыванием: отметка «нарисован строкой» снимается,
// и результат под штатным вызовом остаётся на экране, даже если его текст выглядит как успешный ответ.
test('TASK-227: прерванный вызов снимает отметку строки — результат не скрывается по устаревшей отметке', PLAIN, async ($, on) => {
  standard(on)
  const item = CASES[1]!
  const running = use(PREFIX + item.tool, item.input)
  const first = await $.ui.mount(running)
  expect(textOf(await first.drawn())).not.toBe('Штатный вызов')
  await first.unmount()
  const cut = { ...running, props: { ...running.props, output: item.output, isRunning: false, isInterrupted: true } }
  expect(textOf(await (await $.ui.mount(cut)).drawn())).toBe('Штатный вызов')
  expect(textOf(await (await $.ui.mount(result(PREFIX + item.tool, item.output, false, running.requestId))).drawn())).toBe('Штатный результат')
})

test('TASK-227: ошибка не скрывает ToolResult', PLAIN, async ($, on) => {
  const seen = standard(on)
  for (const item of CASES) {
    const tree = await (await $.ui.mount(result(PREFIX + item.tool, 'Отказ', true))).drawn()
    expect(textOf(tree)).toBe('Штатный результат')
  }
  expect(seen).toHaveLength(9)
})

test('TASK-227: чужие имена и assign_task проходят без замены', PLAIN, async ($, on) => {
  const seen = standard(on)
  for (const tool of ['Bash', 'mcp__other__task_start', 'mcp__cockpit__task_start_extra', PREFIX + 'assign_task']) {
    expect(textOf(await (await $.ui.mount(use(tool, {}, CASES[1].output))).drawn())).toBe('Штатный вызов')
    expect(textOf(await (await $.ui.mount(result(tool, CASES[1].output))).drawn())).toBe('Штатный результат')
  }
  expect(seen).toHaveLength(8)
})

test('TASK-227: compactTaskCalls=false сохраняет оба штатных блока', { options: { glyphs: 'plain', compactTaskCalls: false } }, async ($, on) => {
  const seen = standard(on)
  for (const item of CASES) {
    expect(textOf(await (await $.ui.mount(use(PREFIX + item.tool, item.input, item.output))).drawn())).toBe('Штатный вызов')
    expect(textOf(await (await $.ui.mount(result(PREFIX + item.tool, item.output))).drawn())).toBe('Штатный результат')
  }
  expect(seen).toHaveLength(18)
})

test('TASK-227: неизвестные результаты остаются целиком в обоих блоках', PLAIN, async ($, on) => {
  standard(on)
  for (const item of CASES) for (const output of ['Новый формат', { unfamiliar: true }, { result: 'Новый формат' }, null]) {
    expect(textOf(await (await $.ui.mount(use(PREFIX + item.tool, item.input, output))).drawn())).toBe('Штатный вызов')
    expect(textOf(await (await $.ui.mount(result(PREFIX + item.tool, output))).drawn())).toBe('Штатный результат')
  }
})

test('TASK-227: task_add показывает первую взятую задачу, дубли и частичный отказ next', PLAIN, async ($, on) => {
  standard(on)
  const started = CASES[0].output + '\nВ работе: #227 «Проверить панель».\nТекущая теперь: #227 «Проверить панель».'
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'task_add', { start: true }, started))).drawn()))
    .toBe('+ #227 в работе; #227, #228 записаны')
  const duplicate = 'Записано: 0.\nОтброшено как дубль: 1. #227: Проверить панель.\nОткрыто: 2 (в проекте 2).'
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'task_add', {}, duplicate))).drawn()))
    .toBe('+ #227 уже записана')
  const failed = CASES[0].output + '\nНет текущей или указанной задачи.'
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'task_add', { start: true }, failed))).drawn())).toBe('Штатный вызов')
  expect(textOf(await (await $.ui.mount(result(PREFIX + 'task_add', failed))).drawn())).toBe('Штатный результат')
})

test('TASK-227: task_done показывает следующую и передаёт её отказ', PLAIN, async ($, on) => {
  standard(on)
  const output = CASES[2].output + '\nВ работе: #225 «Проверить ответ».\nТекущая теперь: #225 «Проверить ответ».'
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'task_done', { next: '#225' }, output))).drawn()))
    .toBe('✓ #224 закрыта; #225 в работе; итог: Проверить панель')
  const failed = CASES[2].output + '\nНет текущей или указанной задачи.'
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'task_done', { next: '#225' }, failed))).drawn())).toBe('Штатный вызов')
  expect(textOf(await (await $.ui.mount(result(PREFIX + 'task_done', failed))).drawn())).toBe('Штатный результат')
})

test('TASK-227: длинный итог не вытесняет номер следующей задачи', PLAIN, async ($, on) => {
  standard(on)
  const title = 'Длинный итог проверки панели '.repeat(4)
  const output = `Закрыта: #224 «${title}».\nТекущей задачи нет: возьми следующую через mcp__cockpit__task_start.\nВ работе: #225 «Проверить ответ».\nТекущая теперь: #225 «Проверить ответ».`
  const ui = await $.ui.mount({ ...use(PREFIX + 'task_done', { next: '#225' }, output), viewport: { columns: 40, rows: 24 } })
  const shown = textOf(await ui.drawn())
  expect(shown).toContain('#224 закрыта')
  expect(shown).toContain('#225 в работе')
  expect(cellWidth(shown)).toBeLessThanOrEqual(40)
})

test('TASK-227: большая пачка не вытесняет статус первой взятой задачи', PLAIN, async ($, on) => {
  standard(on)
  const entries = Array.from({ length: 20 }, (_, index) => `#${227 + index}: Проверить панель`)
  const output = `Записано: 20. ${entries.join('; ')}.\nОтброшено как дубль: 0.\nОткрыто: 20 (в проекте 20).\nВ работе: #227 «Проверить панель».\nТекущая теперь: #227 «Проверить панель».`
  const ui = await $.ui.mount({ ...use(PREFIX + 'task_add', { start: true }, output), viewport: { columns: 40, rows: 24 } })
  const shown = textOf(await ui.drawn())
  expect(shown).toContain('#227 в работе')
  expect(cellWidth(shown)).toBeLessThanOrEqual(40)
})

test('TASK-227: обёртка result поддерживается, номер берётся из результата', PLAIN, async ($, on) => {
  standard(on)
  const tree = await (await $.ui.mount(use(PREFIX + 'task_start', { taskId: 'opaque-id' }, { result: CASES[1].output }))).drawn()
  expect(textOf(tree)).toBe(CASES[1].text)
})

test('TASK-227: список поручений и отзыв используют настоящий ответ инструмента', PLAIN, async ($, on) => {
  taskPanelHost(on)
  standard(on)
  await $.classic.SessionStart({ source: 'startup', cwd: '/fixture', session_id: 'fixture-session' })
  const assigned = await $.tool.call({ tool: PREFIX + 'assign_task', title: 'Проверить ключ', why: 'Для проверки' })
  expect(assigned.isError).not.toBe(true)
  const listed = await $.tool.call({ tool: PREFIX + 'list_tasks', show: 'open' })
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'list_tasks', { show: 'open' }, listed.result))).drawn())).toBe('≡ Поручения прочитаны')
  const withdrawn = await $.tool.call({ tool: PREFIX + 'withdraw_task', id: 1 })
  expect(withdrawn.result).toContain('Название: «Проверить ключ».')
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'withdraw_task', { id: 1 }, withdrawn.result))).drawn()))
    .toBe('× Поручение отозвано: Проверить ключ')
})

test('TASK-227: отсутствие результата у завершённого вызова и прежний отзыв передаются дальше', PLAIN, async ($, on) => {
  standard(on)
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'task_start', {}, undefined, { isRunning: false }))).drawn())).toBe('Штатный вызов')
  expect(textOf(await (await $.ui.mount(result(PREFIX + 'task_start', undefined))).drawn())).toBe('Штатный результат')
  const previous = 'поручение 7 отозвано и убрано из панели «Задачи».'
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'withdraw_task', { id: 7 }, previous))).drawn())).toBe('Штатный вызов')
  expect(textOf(await (await $.ui.mount(result(PREFIX + 'withdraw_task', previous))).drawn())).toBe('Штатный результат')
})

test('TASK-227: пустые списки и страницы тоже прочитаны', PLAIN, async ($, on) => {
  standard(on)
  for (const output of ['Список задач Cockpit пуст.', 'В очереди: 0.\nПоказаны 0–0 из 0.', 'В бэклоге: 1.\n#224: Панель\nПричина: Ждём\nПоказаны 1–1 из 1.', 'Закрыто: 1.\n#224: Панель\nПоказаны 1–1 из 1.']) {
    expect(textOf(await (await $.ui.mount(use(PREFIX + 'task_list', {}, output))).drawn())).toBe('≡ Список задач прочитан')
  }
  for (const output of ['Подходящих задач нет.', 'Нет поручения 7.']) {
    expect(textOf(await (await $.ui.mount(use(PREFIX + 'list_tasks', {}, output))).drawn())).toBe('≡ Поручения прочитаны')
  }
})

test('TASK-227: проверка владельцу не ломает строку, её отказ остаётся целиком', PLAIN, async ($, on) => {
  standard(on)
  const base = 'Закрыта: #224 «Проверить панель».'
  const ok = base + ' Проверка передана владельцу: поручение 7 (задача #224).\nТекущей задачи нет: возьми следующую через mcp__cockpit__task_start.'
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'task_done', {}, ok))).drawn())).toBe('✓ #224 закрыта: Проверить панель')
  const failed = base + ' Не удалось передать проверку владельцу (ошибка). Назначь проверку вручную через mcp__cockpit__assign_task.'
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'task_done', {}, failed))).drawn())).toBe('Штатный вызов')
  expect(textOf(await (await $.ui.mount(result(PREFIX + 'task_done', failed))).drawn())).toBe('Штатный результат')
})

test('TASK-227: номер внутри названия не становится номером записанной задачи', PLAIN, async ($, on) => {
  standard(on)
  const output = 'Записано: 1. #227: Проверить #999: упоминание.\nОтброшено как дубль: 0.\nОткрыто: 1 (в проекте 1).'
  expect(textOf(await (await $.ui.mount(use(PREFIX + 'task_add', {}, output))).drawn())).toBe('+ #227 записана')
})

test('TASK-227: секреты в итоге и причине маскируются, в том числе во время вызова', PLAIN, async ($, on) => {
  standard(on)
  const secret = ['gh', 'p_', 'B'.repeat(32)].join('')
  for (const [tool, field, output] of [['task_done', 'result', CASES[2].output], ['task_defer', 'reason', CASES[3].output]] as const) {
    const input = { taskId: 'TASK-224', [field]: 'Проверен ' + secret }
    for (const answer of [output, undefined]) {
      const shown = textOf(await (await $.ui.mount(use(PREFIX + tool, input, answer))).drawn())
      expect(shown).not.toContain(secret)
      if (answer !== undefined || tool === 'task_defer') expect(shown).toContain('[REDACTED:github_token]')
    }
  }
})

test('TASK-227: glyphs=nerd выбирает значок из справочника', { options: { glyphs: 'nerd' } }, async ($, on) => {
  standard(on)
  const tree = await (await $.ui.mount(use(PREFIX + 'task_start', {}, CASES[1].output))).drawn()
  expect(textOf(tree)).toBe('\u{f040a} #224 в работе: Проверить панель') // md-play
})

test('TASK-227: glyphs=auto использует Unicode на desktop', { options: { glyphs: 'auto' } }, async ($, on) => {
  standard(on)
  const tree = await (await $.ui.mount({ ...use(PREFIX + 'task_start', {}, CASES[1].output), surface: 'desktop' })).drawn()
  expect(textOf(tree)).toBe(CASES[1].text)
})

test('TASK-227: glyphs=auto использует проверку шрифта мода', { options: { glyphs: 'auto' } }, async ($, on) => {
  standard(on)
  on('env.get', () => ({ value: undefined }))
  let probes = 0
  on('process.run', () => {
    probes++
    return { value: { exitCode: 0, stdout: 'missing', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const tree = await (await $.ui.mount(use(PREFIX + 'task_start', {}, CASES[1].output))).drawn()
  expect(textOf(tree)).toBe(CASES[1].text)
  expect(probes).toBe(1)
})

test('TASK-227: секреты маскируются до очистки и обрезки', PLAIN, async ($, on) => {
  standard(on)
  const secret = ['gh', 'p_', 'A'.repeat(32)].join('')
  for (const token of [secret, secret.slice(0, 9) + String.fromCharCode(0x200b) + secret.slice(9)]) {
    const title = `Проверить ${token}\n\u001b[31m ключ`
    const output = `В работе: #224 «${title}».\nТекущая теперь: #224 «${title}».`
    const tree = await (await $.ui.mount(use(PREFIX + 'task_start', {}, output))).drawn()
    const shown = textOf(tree)
    expect(shown).toContain('[REDACTED:github_token]')
    expect(shown).not.toContain(secret)
    expect(shown).not.toContain('A'.repeat(8))
    expect(shown).not.toContain('\n')
    expect(shown).not.toContain(String.fromCharCode(27))
  }
})

for (const width of [18, 40, 60, 100]) test(`TASK-227: обрезка конца на ширине ${width}`, PLAIN, async ($, on) => {
  standard(on)
  const title = 'Проверить 界 панель '.repeat(20)
  const output = `В работе: #224 «${title}».`
  const ui = await $.ui.mount({ ...use(PREFIX + 'task_start', {}, output), viewport: { columns: width, rows: 24 } })
  const tree = await ui.drawn()
  const shown = textOf(tree)
  expect(shown.startsWith('▶ #224 в работе: ')).toBe(true)
  expect(shown.endsWith('…')).toBe(true)
  expect(cellWidth(shown)).toBeLessThanOrEqual(width)
  expect(tree.type === 'Box' ? tree.props?.height : null).toBe(1)
})

test('TASK-227: хост не вызывает нижний мод без next', { ...PLAIN, plugins: [
  { name: 'row-replacer', tier: 'prepend', register(on) {
    on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__probe__task' } }, ($, e) => {
      const { Box, Text } = $.ui.resolve(e)
      return <Box height={1}><Text>Подмена без next</Text></Box>
    })
    on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__probe__task' } }, ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box display="none" />
    })
  } },
  { name: 'row-observer', tier: 'append', register(on) {
    on('ui.render', { component: 'ToolUse' }, ($, e, next) => { $.ui.status('Увидел ToolUse'); return next(e) })
    on('ui.render', { component: 'ToolResult' }, ($, e, next) => { $.ui.status('Увидел ToolResult'); return next(e) })
  } },
] }, async ($, on) => {
  standard(on)
  const seen: string[] = []
  on('ui.status', (_$, e) => { seen.push(e.text ?? ''); return { value: undefined } })
  expect(textOf(await (await $.ui.mount(use('mcp__probe__task', {}))).drawn())).toBe('Подмена без next')
  await $.ui.mount(result('mcp__probe__task', 'Готово'))
  expect(seen).toEqual([])
})

test('TASK-227: компактная строка и скрытый результат доставляют исходные props соседнему моду', { ...PLAIN, plugins: [
  { name: 'row-observer', tier: 'append', register(on) {
    on('ui.render', { component: 'ToolUse' }, ($, e, next) => { $.ui.status(JSON.stringify({ component: e.component, props: e.props, requestId: e.requestId })); return next(e) })
    on('ui.render', { component: 'ToolResult' }, ($, e, next) => { $.ui.status(JSON.stringify({ component: e.component, props: e.props, requestId: e.requestId })); return next(e) })
  } },
] }, async ($, on) => {
  standard(on)
  const seen: { component: string; props: unknown; requestId: string }[] = []
  on('ui.status', (_$, e) => { seen.push(JSON.parse(e.text ?? '{}')); return { value: undefined } })
  const onScreen = { first: 0, last: 1, of: 2 }
  const target = use(PREFIX + 'task_start', CASES[1].input, CASES[1].output, { onScreen })
  expect(textOf(await (await $.ui.mount(target)).drawn())).toBe(CASES[1].text)
  const returned = { ...result(target.props.tool, target.props.output), requestId: target.requestId,
    props: { ...result(target.props.tool, target.props.output).props, tool_use_id: target.props.tool_use_id, onScreen } }
  await $.ui.mount(returned)
  expect(seen).toEqual([
    { component: 'ToolUse', props: target.props, requestId: target.requestId },
    { component: 'ToolResult', props: returned.props, requestId: target.requestId },
  ])
})

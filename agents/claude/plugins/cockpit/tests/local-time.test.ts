import { expect, test } from 'claude-code/testing'
import { dayBefore, relativeTime, setTimeZone, wallTime } from '../hooks/local-time'
import { commentTime } from '../hooks/task-page-model'
import { historyRows } from '../hooks/tasks'
import { seeded, TASK } from './fixtures'
import { drawnText, PANEL, taskPanelHost } from './task-panel-host'
import { cellWidth } from '../hooks/layout'
import type { TaskCardsProps } from '../hooks/tasks'

const at = (iso: string) => Date.parse(iso)
const comment = (iso: string, revision = 0) => ({ createdAt: iso.replace('Z', '.000000Z'), revision })
// Пояс — состояние модуля: каждый тест возвращает пояс машины, чтобы не влиять на соседние файлы.
const inZone = (zone: string, body: () => void) => { try { expect(setTimeZone(zone)).toBe(true); body() } finally { setTimeZone('') } }

test('ZONE-215 время комментария показано в поясе владельца: Киев летом, зимой и в ночь перевода часов', () => inZone('Europe/Kyiv', () => {
  expect(commentTime(comment('2026-10-08T08:17:00Z'), at('2026-10-08T09:00:00Z'))).toBe('11:17')
  expect(commentTime(comment('2026-11-10T08:17:00Z'), at('2026-11-10T09:00:00Z'))).toBe('10:17')
  // 25.10.2026 в 04:00 по Киеву часы переводятся на 03:00: до перевода сдвиг три часа, после — два.
  expect(commentTime(comment('2026-10-24T23:30:00Z'), at('2026-10-25T10:00:00Z'))).toBe('02:30')
  expect(commentTime(comment('2026-10-25T01:30:00Z'), at('2026-10-25T10:00:00Z'))).toBe('03:30')
  expect(commentTime(comment('2026-10-25T02:30:00Z', 1), at('2026-10-25T10:00:00Z'))).toBe('04:30  изм.')
}))

test('ZONE-215 граница суток считается по поясу владельца, а не по времени сервера', () => {
  // 21:30 UTC 8 октября — это 00:30 9 октября по Киеву и 06:30 9 октября по Токио.
  const created = comment('2026-10-08T21:30:00Z'), now = at('2026-10-09T08:00:00Z')
  inZone('Europe/Kyiv', () => expect(commentTime(created, now)).toBe('00:30'))
  inZone('Asia/Tokyo', () => expect(commentTime(created, now)).toBe('06:30'))
  inZone('America/New_York', () => expect(commentTime(created, now)).toBe('08.10 17:30'))
  inZone('UTC', () => expect(commentTime(created, now)).toBe('08.10 21:30'))
})

test('ZONE-215 история: день и время закрытия в поясе владельца, «Вчера» через перевод часов', () => {
  const closed = (id: number, iso: string) => ({ ...TASK, taskId: `done-${id}`, alias: `TASK-${id}`, status: 'done' as const, updatedAt: iso })
  const state = seeded(null)
  state.snapshot!.tasks = [closed(1, '2026-10-25T21:30:00Z'), closed(2, '2026-10-24T22:30:00Z'), closed(3, '2026-10-24T20:30:00Z')]
  const view = { cursor: '', expanded: new Set<string>(), collapsed: new Set<string>(), offset: 0, limit: 12 }
  const shown = (zone: string) => {
    let result: string[] = []
    inZone(zone, () => {
      result = historyRows(state, view, 80, at('2026-10-25T22:30:00Z')).flatMap(row => row.kind === 'day' ? [row.label] : row.kind === 'card' ? [`${row.number} ${row.closedTime}`] : [])
    })
    return result
  }
  // По Киеву сейчас 00:30 26 октября: первая и вторая задачи закрыты вчера, в 23:30 и в 01:30, третья — позавчера.
  expect(shown('Europe/Kyiv')).toEqual(['Вчера', '#1 вчера 23:30', '#2 вчера 01:30', '24.10.2026', '#3 2 дн. назад'])
  expect(shown('UTC')).toEqual(['Сегодня', '#1 1 ч назад', 'Вчера', '#2 вчера 22:30', '#3 вчера 20:30'])
})

test('ZONE-215 пустая настройка и нераспознанное имя оставляют пояс машины', () => {
  const moment = at('2026-10-08T21:30:00Z')
  expect(setTimeZone('')).toBe(true)
  const machine = wallTime(moment)
  const local = new Date(moment)
  expect(machine).toEqual({ year: local.getFullYear(), month: local.getMonth() + 1, day: local.getDate(), hour: local.getHours(), minute: local.getMinutes() })
  for (const bad of ['Mars/Olympus', 'Киев', 'Europe/Kyiv; rm']) {
    expect(setTimeZone(bad)).toBe(false)
    expect(wallTime(moment)).toEqual(machine)
  }
  for (const empty of [undefined, null, 3, '   ']) expect(setTimeZone(empty)).toBe(true)
  expect(setTimeZone(' Europe/Kyiv ')).toBe(true)
  expect(wallTime(moment)).toEqual({ year: 2026, month: 10, day: 9, hour: 0, minute: 30 })
  setTimeZone('')
  expect(dayBefore({ year: 2026, month: 3, day: 1, hour: 5, minute: 6 })).toEqual({ year: 2026, month: 2, day: 28, hour: 5, minute: 6 })
  expect(dayBefore({ year: 2026, month: 1, day: 1, hour: 0, minute: 0 })).toMatchObject({ year: 2025, month: 12, day: 31 })
})

// Пояс берётся из настройки мода при загрузке; проверяется тем, что рисует панель, а не состоянием модуля:
// тест и мод загружают модуль времени отдельно.
// Сейчас 08:00 UTC 10 октября: по Киеву и Токио задача закрыта вчера, по UTC — позавчера.
for (const [zone, day, time] of [['Europe/Kyiv', 'Вчера', 'вчера 00:30'], ['UTC', '08.10.2026', '2 дн. назад'], ['Asia/Tokyo', 'Вчера', 'вчера 06:30']] as const) {
  test(`ZONE-215 настройка мода ${zone}: «История» показывает день ${day} и время ${time}`, { options: { timeZone: zone, glyphs: 'plain' } }, async ($, on) => {
    const done = { ...TASK, taskId: 'zone-1', alias: 'TASK-1', status: 'done' as const, updatedAt: '2026-10-08T21:30:00.000000Z',
      stage: 'task' as const, certainty: 'confirmed' as const, certaintySource: 'user' as const, certaintyProvenance: 'panel' as const }
    const host = taskPanelHost(on, { tasks: [done], paging: true, now: Date.parse('2026-10-10T08:00:00Z') })
    await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
    const pane = await $.ui.mount(PANEL)
    await pane.press({ key: 'tab-history' })
    const rows = ((await pane.find({ key: 'rows' }))!.props.props as TaskCardsProps).rows
    expect(rows.flatMap(row => row.kind === 'day' ? [row.label] : row.kind === 'card' ? [row.closedTime] : [])).toEqual([day, time])
    expect(host.statuses.filter(text => text.includes('Часовой пояс'))).toEqual([])
    await pane.unmount()
  })
}

// Нераспознанное имя не применяется: владелец видит предупреждение при старте сессии.
test('ZONE-215 нераспознанный пояс: предупреждение в строке состояния', { options: { timeZone: 'Mars/Olympus' } }, async ($, on) => {
  const host = taskPanelHost(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  expect(host.statuses.filter(text => text.includes('Часовой пояс'))).toEqual(['Часовой пояс не распознан: показано время сервера. Проверь настройку мода.'])
})

test('TIME-225 когда закрыта: минуты, часы, вчера, дни, дата; сутки считаются по календарю пояса владельца', () => inZone('Europe/Kyiv', () => {
  const now = at('2026-10-08T12:00:00Z') // 15:00 по Киеву
  const shown = (iso: string) => relativeTime(new Date(iso), now)
  expect(shown('2026-10-08T11:59:40Z')).toBe('только что')
  // Часы машин расходятся: закрытие «из будущего» будущим не показывается.
  expect(shown('2026-10-08T12:05:00Z')).toBe('только что')
  expect(shown('2026-10-08T11:59:00Z')).toBe('1 мин назад')
  expect(shown('2026-10-08T11:00:30Z')).toBe('59 мин назад')
  expect(shown('2026-10-08T11:00:00Z')).toBe('1 ч назад')
  // 00:30 по Киеву — ещё сегодня, 23:30 — уже вчера, хотя прошло меньше суток.
  expect(shown('2026-10-07T21:30:00Z')).toBe('14 ч назад')
  expect(shown('2026-10-07T20:30:00Z')).toBe('вчера 23:30')
  expect(shown('2026-10-06T21:30:00Z')).toBe('вчера 00:30')
  expect(shown('2026-10-06T20:30:00Z')).toBe('2 дн. назад')
  expect(shown('2026-10-02T10:00:00Z')).toBe('6 дн. назад')
  expect(shown('2026-10-01T10:00:00Z')).toBe('01.10')
  expect(shown('2025-12-31T10:00:00Z')).toBe('31.12.2025')
  // Меньше часа назад через полночь — всё ещё минуты.
  expect(relativeTime(new Date('2026-10-08T20:50:00Z'), at('2026-10-08T21:10:00Z'))).toBe('20 мин назад')
}))

test('TIME-225 история: у карточки время работы; задача, закрытая без взятия в работу, длительности не несёт', () => inZone('UTC', () => {
  const closed = (id: number, iso: string, elapsedMs?: number) => ({ ...TASK, taskId: `done-${id}`, alias: `TASK-${id}`, status: 'done' as const, updatedAt: iso,
    ...(elapsedMs === undefined ? {} : { elapsedMs }) })
  const state = seeded(null)
  state.snapshot!.tasks = [closed(4, '2026-10-08T11:00:00Z', 4_800_000), closed(3, '2026-10-08T10:00:00Z', 95_000), closed(2, '2026-10-08T09:00:00Z', 0), closed(1, '2026-10-08T08:00:00Z')]
  const view = { cursor: '', expanded: new Set<string>(), collapsed: new Set<string>(), offset: 0, limit: 12 }
  const cards = historyRows(state, view, 80, at('2026-10-08T12:00:00Z')).flatMap(row => row.kind === 'card' ? [[row.number, row.closedTime, row.closedSpent]] : [])
  expect(cards).toEqual([['#4', '1 ч назад', '1 ч 20 мин'], ['#3', '2 ч назад', '1 мин'], ['#2', '3 ч назад', undefined], ['#1', '4 ч назад', undefined]])
}))

// На нижней линии рамки: значок окончания, когда закрыта, значок времени, сколько была в работе. На узкой карточке
// подпись обрезается с конца: «когда» важнее «сколько».
for (const [width, whole] of [[84, true], [30, false]] as const) {
  test(`TIME-225 нижняя линия карточки истории: когда закрыта и сколько заняла: ${width}`, { options: { timeZone: 'Europe/Kyiv', glyphs: 'plain' } }, async ($, on) => {
    const done = { ...TASK, taskId: 'spent-1', alias: 'TASK-1', status: 'done' as const, updatedAt: '2026-10-08T21:30:00.000000Z', elapsedMs: 4_800_000,
      stage: 'task' as const, certainty: 'confirmed' as const, certaintySource: 'user' as const, certaintyProvenance: 'panel' as const }
    taskPanelHost(on, { tasks: [done], paging: true, now: Date.parse('2026-10-10T08:00:00Z') })
    await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
    const pane = await $.ui.mount({ ...PANEL, props: { ...PANEL.props, bodyColumns: width } })
    await pane.press({ key: 'tab-history' })
    const line = drawnText((await pane.find({ in: 'rows', type: 'Box', key: 'time-frame:spent-1' })) ?? null)
    if (whole) expect(line).toBe(' ✓ вчера 00:30  ⧖ 1 ч 20 мин ')
    else {
      expect(line.startsWith(' ✓ вчера 00:30')).toBe(true)
      expect(line.endsWith('… ')).toBe(true)
      expect(2 + cellWidth(line)).toBeLessThanOrEqual(width - 2)
    }
    await pane.unmount()
  })
}

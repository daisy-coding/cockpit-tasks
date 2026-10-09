// Время на экране — в часовом поясе владельца. Пояс задаёт настройка мода «Часовой пояс» (имя IANA,
// например Europe/Kyiv). Без неё берётся пояс машины, где работает Claude Code: при работе по SSH это пояс
// сервера, а не ноутбука владельца, — узнать пояс терминала на другой стороне соединения мод не может.
export type WallTime = { year: number; month: number; day: number; hour: number; minute: number }

let formatter: Intl.DateTimeFormat | null = null

// false — имя пояса не распознано; время остаётся в поясе машины.
export function setTimeZone(name: unknown): boolean {
  formatter = null
  if (typeof name !== 'string' || !name.trim()) return true
  try {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: name.trim(), hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    return true
  } catch { return false }
}

export function wallTime(at: number | Date): WallTime {
  const date = typeof at === 'number' ? new Date(at) : at
  if (!formatter || !Number.isFinite(date.getTime())) {
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() }
  }
  const parts: Record<string, number> = {}
  for (const part of formatter.formatToParts(date)) if (part.type !== 'literal') parts[part.type] = Number(part.value)
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute! }
}

export function sameDay(a: WallTime, b: WallTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day
}

// Предыдущий календарный день считается по дате, без часов: перевод часов его не сдвигает.
export function dayBefore(day: WallTime): WallTime {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day - 1))
  return { ...day, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

// Когда закрыта задача, словами относительно «сейчас»: день виден на самой карточке, а не только в заголовке дня
// над длинным списком. Сутки считаются по календарю пояса владельца, а не по 24 часам.
export function relativeTime(at: Date, now: number): string {
  const minutes = Math.floor((now - at.getTime()) / 60_000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин назад`
  const then = wallTime(at), today = wallTime(now)
  const clock = `${twoDigits(then.hour)}:${twoDigits(then.minute)}`
  if (sameDay(then, today)) return `${Math.floor(minutes / 60)} ч назад`
  if (sameDay(then, dayBefore(today))) return `вчера ${clock}`
  const days = Math.round((Date.UTC(today.year, today.month - 1, today.day) - Date.UTC(then.year, then.month - 1, then.day)) / 86_400_000)
  if (days < 7) return `${days} дн. назад`
  return `${twoDigits(then.day)}.${twoDigits(then.month)}${then.year === today.year ? '' : `.${then.year}`}`
}

export const twoDigits = (value: number): string => String(value).padStart(2, '0')

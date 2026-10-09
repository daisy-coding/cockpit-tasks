// Адаптация Human in the loop, ревизия указана в THIRD_PARTY_NOTICES.md.
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// Текст модели без управляющих и невидимых знаков (смена направления, нулевая ширина):
// владелец видит на экране ровно то, что хранится и уйдёт агенту.
export function clean(text: string): string {
  return oneLine(text.normalize('NFC').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\p{Cf}/gu, ''))
}

// Только список сохраняет границы строк; обычный текст остаётся одним абзацем.
export function cleanOwnerBody(text: string): string {
  const lines = text.split(/\r\n|[\r\n\u2028\u2029]/u).map(clean).filter(Boolean)
  return lines.some(line => /^-(?: |$)/u.test(line)) ? lines.join('\n') : clean(text)
}

export function ownerBodyError(text: string, field: string): string | undefined {
  const lines = cleanOwnerBody(text).split('\n')
  const first = lines.findIndex(line => /^-(?: |$)/u.test(line))
  if (first < 0) return undefined
  if (lines.filter(line => /^-(?: |$)/u.test(line)).length > 6) return `${field}: не больше 6 пунктов; сократи список.`
  if (first > 1 || lines.slice(first).some(line => !line.startsWith('- ') || line.length <= 2)) {
    return `${field}: каждый пункт — отдельная строка с "- "; перед списком допустима одна вводная строка.`
  }
  return undefined
}

export function plainOwnerBody(text: string): boolean {
  return text.split('\n').every(plain) && cleanOwnerBody(text) === text && !ownerBodyError(text, 'Текст')
}

// Знаки, ширина которых в терминале известна и равна одной ячейке: латиница,
// кириллица, цифры, обычная пунктуация. Эмодзи, иероглифы, составные знаки и невидимые
// заполнители сюда не входят: по ним нельзя проверить, что строка показана целиком.
const PLAIN = /^[\u0020-\u007e\u00a1-\u00ac\u00ae-\u024f\u0400-\u052f\u2010-\u2015\u2018-\u201f\u2022\u2026\u20ac\u2116\u2192]*$/u

// Внутри диапазонов есть составные знаки (кириллические U+0483–0489) и неназначенные коды:
// их ширина не равна одной ячейке, поэтому они исключаются по свойству, а не по списку.
const WIDTHLESS = /[\p{M}\p{C}]/u

export function plain(text: string): boolean {
  return PLAIN.test(text) && !WIDTHLESS.test(text)
}

// Буквы кириллицы, одинаковые на вид с латинскими, приводятся к латинским до смены регистра:
// заглавные совпадают чаще строчных. Греческий в текст задач не допускается вовсе.
const LOOKALIKE: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', Ѕ: 'S', І: 'I', Ј: 'J',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', ѕ: 's', і: 'i', ј: 'j', к: 'k', м: 'm', т: 't', в: 'b', н: 'h',
}

export function skeleton(text: string): string {
  return Array.from(text, char => LOOKALIKE[char] ?? char).join('').toLowerCase()
}

// Слово, в котором смешаны латиница и кириллица, читается как одно, а значит другое.
export function mixesScripts(text: string): boolean {
  return text.split(' ').some(word => /\p{Script=Latin}/u.test(word) && /\p{Script=Cyrillic}/u.test(word))
}

export function printable(text: string, max: number): string {
  return clip(clean(text), max)
}

export function plural(count: number, forms: readonly [string, string, string]): string {
  const last = Math.abs(count) % 10
  const hundred = Math.abs(count) % 100
  const word = hundred >= 11 && hundred <= 14 ? forms[2] : last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2]
  return `${count} ${word}`
}

export function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)

  if (minutes < 1) {
    return 'сейчас'
  }

  if (minutes < 60) {
    return `${minutes} мин`
  }

  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours} ч` : `${Math.floor(hours / 24)} д`
}

export function sizeOf(chars: number): string {
  return chars < 1024 ? `${chars} Б` : `${(chars / 1024).toFixed(1)} КБ`
}

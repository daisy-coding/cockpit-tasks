// Порт SECRET_PATTERNS и замен из core/decisioning/privacy.py.
import { createSecretView } from '../secret-view.ts'
// В Python границы слова и пробелы учитывают Unicode иначе, чем в JavaScript.
const WORD_BOUNDARY = String.raw`(?:(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_]))`
const SPACE = String.raw`\u0009-\u000d\u001c-\u001f\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`

export function stripPastedContent(text: string): string {
  return text.replace(/<\/?pasted_content\b[^>]*>/giu, '')
}

function pattern(expression: RegExp): RegExp {
  const source = expression.source.replaceAll('[\\s\\S]', '[^]').replaceAll('\\b', WORD_BOUNDARY)
    .replace(/(\[[^\]]*\])|\\s/g, (segment: string, charClass?: string) => charClass ? charClass.replaceAll('\\s', SPACE) : `[${SPACE}]`)
  return new RegExp(source, expression.ignoreCase ? 'giu' : 'gu')
}

// Порядок сохранён: общий assignment может заменить маркер конкретного формата.
// Дополнительные İ/ı воспроизводят Python IGNORECASE; ſ/K уже учитывает флаг iu.
const SECRET_PATTERNS: readonly (readonly [string, RegExp, string?])[] = [
  ['private_key', pattern(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/)],
  ['typesafe_key', pattern(/\bapikey_[A-Za-z0-9]{16,}(?:_[A-Za-z0-9]{16,})*\b/)],
  ['aws_key_id', pattern(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/)],
  ['github_token', pattern(/\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/)],
  ['api_key', pattern(/\bsk-[A-Za-z0-9_-]{20,}\b/)],
  ['slack_token', pattern(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/)],
  ['jwt', pattern(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/)],
  ['url_credentials', pattern(/(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?:[^\s/@:]+:[^\s/@]+|[^\s/@:]+)@/), '$1[REDACTED:url_credentials]@'],
  ['basic_auth', pattern(/((?:^|\s)(?:-u|--user)(?:\s+|=)?)['"]?[^\s:'"]+:[^\s'"]+['"]?/), '$1[REDACTED:basic_auth]'],
  ['basic_header', pattern(/\b(bas[iİı]c)\s+[A-Za-zİı0-9+/]{8,}=*/i), '$1 [REDACTED:basic_header]'],
  ['bearer', pattern(/\bbearer\s+[A-Za-zİı0-9._~+/-]{16,}=*/i)],
  ['assignment', pattern(/\b([A-Zİı0-9_]*(?:ap[iİı][_-]?key|token|secret|password|passwd)[A-Zİı0-9_]*)(\\?['"]?\s*[:=]\s*\\?['"]?)[^\s'",}\\]{6,}/i), '$1$2[REDACTED:assignment]'],
]

// Обязательные разделители проверяются до RegExp: на длинном имени без присваивания
// прежний шаблон перебирал разбиения имени. Без разделителя совпадений быть не может.
function secretMatches(name: string, expression: RegExp, text: string): Iterable<RegExpMatchArray> {
  if (name === 'assignment' && !text.includes('=') && !text.includes(':')
    || name === 'url_credentials' && !text.includes('://')
    || name === 'jwt' && !text.includes('.')) return []
  return text.matchAll(expression)
}

// Чистый порт остаётся отдельным оракулом сверки с Python; шаблоны и их порядок неизменны.
export function redactRawSecrets(text: string, maxCodePoints?: number): string {
  let boundary = maxCodePoints === undefined ? text.length : Array.from(text).slice(0, maxCodePoints).join('').length
  for (const [name, expression, template] of SECRET_PATTERNS) {
    let clean = ''
    let cursor = 0
    let nextBoundary = boundary
    for (const match of secretMatches(name, expression, text)) {
      const start = match.index ?? 0
      const replacement = (template ?? `[REDACTED:${name}]`).replace(/\$(\d+)/g, (_marker, group: string) => match[Number(group)] ?? '')
      clean += text.slice(cursor, start) + replacement
      cursor = start + match[0].length
      // Секрет, пересёкший границу, удаляется целиком. Позднейший исходный текст
      // не попадает в разрешённый префикс после сокращения длинного секрета.
      if (start < boundary) nextBoundary += replacement.length - Math.min(match[0].length, boundary - start)
    }
    text = clean + text.slice(cursor)
    boundary = nextBoundary
  }
  const prefix = text.slice(0, boundary)
  return maxCodePoints === undefined ? prefix : Array.from(prefix).slice(0, maxCodePoints).join('')
}

const VIEW_PATTERNS = SECRET_PATTERNS.map(([name, expression, template]) =>
  [name, (text: string) => secretMatches(name, expression, text), template] as const)
export const secretText = createSecretView(VIEW_PATTERNS, redactRawSecrets)

// Поиск выполняется до очистки и усечения, абзацы и видимые графемы сохраняются.
// Общий поиск только добавляет к прежнему: всё, что скрывал сырой порт, остаётся скрытым. Общий модуль сам
// начинает с сырого поиска по исходной строке, поэтому masked содержит и его замены.
export function redactSecrets(text: string, maxCodePoints?: number): string {
  const raw = redactRawSecrets(text, maxCodePoints)
  // Если очистка не меняет исходник, оба вида поиска совпадают с сырым портом.
  if (secretText.clean(text) === text) return raw
  const masked = secretText.mask(text, { multiline: true, maxCodePoints })
  // Общий поиск ничего не добавил: исходник не переписывается, сохраняются табуляция, CRLF и знаки
  // за границей совпадения. Иначе берётся его результат.
  return secretText.clean(raw, { multiline: true }) === masked ? raw : masked
}

// Секрет есть, если его видит прежний поиск по исходной строке либо общий. Очистка сама по себе секретом
// не считается: общий поиск сравнивает одинаковые виды текста.
export function hasSecrets(text: string): boolean {
  return redactRawSecrets(text) !== text || secretText.mask(text, { multiline: true }) !== secretText.clean(text, { multiline: true })
}

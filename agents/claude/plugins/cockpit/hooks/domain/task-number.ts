// Псевдоним остаётся форматом хранения; обозначение для владельца и агента строится только здесь.
export function displayTaskNumber(alias: string): string {
  const number = /^TASK-([1-9]\d*)$/u.exec(alias)?.[1]
  return number ? `#${number}` : ''
}

// Прежние записи номера приводятся к псевдониму до обращения к рантайму; идентификатор сюда не относится.
export function taskAliasFor(target: string): string | null {
  const number = /^(?:TASK-|#)?([1-9]\d*)$/iu.exec(target)?.[1]
  return number ? `TASK-${number}` : null
}

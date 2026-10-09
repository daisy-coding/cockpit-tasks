// Пометка отделяет суть задачи от приёмки. «Готово, когда:» пишет инструмент агента; «Приёмка:» в начале строки —
// то же самое словом, которое владелец видит на странице и в редакторе. Посреди фразы слово пометкой не считается.
const ACCEPTANCE_MARK = /(?:^|\n)[ \t]*При[её]мка:[ \t]*|(?:^|\s)Готово,\s*когда:[ \t]*/iu
const trimBlankLines = (text: string): string => text.replace(/^(?:[ \t]*\n)+/u, '').replace(/\s+$/u, '')

// Страница задачи показывает текст двумя разделами и ничего не выбрасывает: всё до пометки — суть,
// всё после — приёмка; строки, пустые строки и повторы остаются как введены.
export function taskTextParts(description = ''): { goal: string; acceptance: string } {
  const marker = ACCEPTANCE_MARK.exec(description)
  if (!marker) return { goal: trimBlankLines(description), acceptance: '' }
  return { goal: trimBlankLines(description.slice(0, marker.index)), acceptance: trimBlankLines(description.slice(marker.index + marker[0].length)) }
}

// Редактор показывает описание теми же словами, что и страница: пометку хранения заменяет строка «Приёмка:».
// Сохранённый в таком виде текст читается так же, поэтому обратного преобразования нет.
export function editableDescription(description = ''): string {
  const marker = ACCEPTANCE_MARK.exec(description)
  if (!marker || !/Готово/iu.test(marker[0])) return description
  const { goal, acceptance } = taskTextParts(description)
  return [goal, ['Приёмка:', acceptance].filter(Boolean).join('\n')].filter(Boolean).join('\n\n')
}

// Формат хранения общий с рантаймом; разделяем текст только при показе.
export function splitTaskText(description = '', acceptance: readonly string[] = []): { goal: string; criteria: string[] } {
  const source = description.trim().replace(/^Владелец:\s*/iu, '')
  const marker = ACCEPTANCE_MARK.exec(source)
  const goal = (marker ? source.slice(0, marker.index) : source).trim()
  const embedded = marker ? source.slice(marker.index + marker[0].length) : ''
  const criteria = [...acceptance, embedded].flatMap(text => text.split(/\r?\n/u))
    .map(text => text.trim().replace(/^(?:[•*-]\s*|\d+[.)]\s+)/u, '').trim()).filter(Boolean)
  return { goal, criteria: [...new Set(criteria)] }
}

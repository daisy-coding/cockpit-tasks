import { expect, test } from 'claude-code/testing'
import { compactResumeToast } from '../hooks/domain/task-loop'
import { resumeRefusal } from '../hooks/domain/compact-resume'
import { ownerAccessNotice } from '../hooks/register'

function expectNotice(text: string) {
  expect(text.length).toBeLessThanOrEqual(80)
  expect(text).not.toMatch(/^(?:cockpit|задачи)\s*:/iu)
  expect(text).not.toMatch(/\b[a-zA-Z_]\w*\.[a-zA-Z_]\w*\b|\b[A-Z]+(?:_[A-Z]+)+\b|\/home\/|\/Users\//u)
}

test('Продолжение после сжатия укладывается в 80 знаков и не раскрывает вход', () => {
  for (const alias of ['TASK-1', 'TASK-999999999', '', '/home/owner/private', 'task.action']) expectNotice(compactResumeToast(alias))
  for (const reason of ['self-ended', 'no-task', 'unread', 'not-sent'] as const) expectNotice(resumeRefusal(reason))
})

test('Отказы доступа называют причину и следующий шаг без служебных имён', () => {
  for (const reason of ['revoked', 'expired', 'stale-epoch', 'mismatch', 'unregistered', 'module-reloaded', 'other-copy', 'ownership-lost'] as const) {
    const text = ownerAccessNotice(reason)!
    expectNotice(text)
    expect(text).toMatch(/Перезапусти|Повтори|Открой|Введи/u)
  }
})

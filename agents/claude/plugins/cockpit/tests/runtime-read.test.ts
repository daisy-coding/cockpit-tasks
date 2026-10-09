import { expect, test } from 'claude-code/testing'
import { isHumanSurfaceCommand, HUMAN_SURFACE_DENIAL } from '../hooks/domain/rpc'

test('RUNTIME-133: чтение исходников рантайма не требует решения владельца', () => {
  for (const command of [
    'cat agents/claude/cockpit/domain.py',
    "sed -n '120,180p' agents/claude/cockpit/rpc.py",
    'rg -n authenticate agents/claude/cockpit/domain.py agents/claude/cockpit/rpc.py',
    "grep -n 'def execute' /home/user/project/agents/claude/cockpit/domain.py",
    'head -n 40 agents/claude/cockpit/store.py',
    'tail -n 20 agents/claude/cockpit/rpc.py',
    'wc -l agents/claude/cockpit/domain.py',
  ]) expect(isHumanSurfaceCommand(command)).toBe(false)
})

test('RUNTIME-133: исполнение, база и побочные действия остаются закрыты', () => {
  for (const command of [
    'python3 agents/claude/cockpit/rpc.py',
    'python3 -m agents.claude.cockpit.rpc',
    'cat agents/claude/cockpit/domain.py | python3 -',
    'cat agents/claude/cockpit/domain.py > copied.py',
    'cat agents/claude/cockpit/domain.py; cockpitctl confirm task-1',
    "sed -i 's/a/b/g' agents/claude/cockpit/domain.py",
    "sed -n '1e touch changed' agents/claude/cockpit/domain.py",
    "sed -n '1w changed' agents/claude/cockpit/domain.py",
    'rg --pre python3 text agents/claude/cockpit/domain.py',
    'cat agents/claude/cockpit/cockpit.db',
    'cat agents/claude/cockpit/tests/../cockpit.db',
    'cat agents/claude/cockpit/domain.py $(touch changed)',
    'cat agents/claude/cockpit/domain.py `touch changed`',
    'cat agents/claude/cockpit/domain.py "unterminated',
    'cat agents/claude/cockpit/domain.py /etc/passwd',
  ]) expect(isHumanSurfaceCommand(command)).toBe(true)
})

test('RUNTIME-133: отказ называет полные формы чтений', () => {
  expect(HUMAN_SURFACE_DENIAL).toContain('checkpoint list <taskId>')
  expect(HUMAN_SURFACE_DENIAL).toContain('config get <key>')
  expect(HUMAN_SURFACE_DENIAL).toContain('исходников .py')
})

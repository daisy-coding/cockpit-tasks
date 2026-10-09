import { expect, test } from 'claude-code/testing'
import { DEFAULT_THEME, roleColors, contrast, colorDistance, inkOn, fileStatusColors, rowFill } from '../hooks/theme'

for (const bg of ['#ffffff', '#1e1e1e', '']) test(`Единые роли: контраст и различимость ${bg || 'неизвестный фон'}`, () => {
  const theme = { ...DEFAULT_THEME, bg }, roles = roleColors(theme)
  for (const key of ['fg', 'muted', 'accent', 'work', 'ok', 'fail', 'warn'] as const) {
    for (const surface of bg ? [bg] : ['#ffffff', '#000000']) expect(contrast(roles[key], surface)).toBeGreaterThanOrEqual(4.5)
  }
  expect(roles.accent).toBe(roles.hover)
  expect(colorDistance(roles.work, roles.warn)).toBeGreaterThanOrEqual(60)
  expect(contrast(inkOn(roles.fill), roles.fill)).toBeGreaterThanOrEqual(4.5)
  const statuses = Object.values(fileStatusColors(theme))
  for (const color of statuses) expect(contrast(color, rowFill(theme))).toBeGreaterThanOrEqual(4.5)
  for (let i = 0; i < statuses.length; i++) for (let j = i + 1; j < statuses.length; j++) {
    expect(colorDistance(statuses[i]!, statuses[j]!)).toBeGreaterThanOrEqual(30)
  }
})

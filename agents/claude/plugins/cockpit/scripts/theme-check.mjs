import assert from 'node:assert/strict'
import { DEFAULT_THEME, roleColors, contrast, colorDistance, fileStatusColors, rowFill, inkOn } from '../hooks/theme.ts'

const roles = ['fg', 'muted', 'accent', 'work', 'ok', 'fail', 'warn']
const backgrounds = ['#ffffff', '#1e1e1e', '']
for (const bg of backgrounds) {
  const theme = { ...DEFAULT_THEME, bg }
  const colors = roleColors(theme)
  for (const role of roles) {
    for (const surface of bg ? [bg] : ['#ffffff', '#000000']) {
      assert.ok(contrast(colors[role], surface) >= 4.5, `${role} ${bg || 'unknown'} ${surface}`)
    }
  }
  assert.ok(colorDistance(colors.work, colors.warn) >= 60, 'work/warn: расстояние RGB не ниже 60')
  assert.ok(contrast(inkOn(colors.fill), colors.fill) >= 4.5)
  const files = fileStatusColors(theme)
  for (const color of Object.values(files)) assert.ok(contrast(color, rowFill(theme)) >= 4.5)
}
console.log('theme-check: роли ≥4.5:1, work/warn различимы, текст на fill ≥4.5:1')

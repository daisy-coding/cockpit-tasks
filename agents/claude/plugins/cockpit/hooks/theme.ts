// Общие роли семи самостоятельных модов; побайтовую сверку выполняет surface-check.py.
export type Theme = { fg: string; accent: string; muted: string; urgent: string; selection: string; bg: string }
const HEX = /^#[0-9a-fA-F]{6}$/
export const CLAY = '#d97757'
export const HOVER_ON_LIGHT = '#7c3aed'
export const HOVER_ON_DARK = '#b794f6'
// При неизвестном фоне одновременно проверяются только чёрный и белый.
// Гарантия для произвольного неизвестного фона математически невозможна.
export const HOVER_ANY = balanced('#8b5cf6')
export const DEFAULT_THEME: Theme = {
  fg: '', accent: HOVER_ANY, muted: balanced('#808a96'), urgent: balanced('#c55755'),
  selection: '#6b7280', bg: '',
}
export const THEME_FILE = '.local/state/omarchy/current/theme/colors.toml'

export function parseTheme(toml: string): Theme {
  const get = (k: string) => toml.match(new RegExp(`^${k}\\s*=\\s*"(#[0-9a-fA-F]{6})"`, 'm'))?.[1]
  return {
    fg: get('foreground') ?? get('color7') ?? DEFAULT_THEME.fg,
    accent: DEFAULT_THEME.accent,
    muted: get('muted') ?? get('color8') ?? DEFAULT_THEME.muted,
    urgent: get('red') ?? get('color1') ?? DEFAULT_THEME.urgent,
    selection: get('selection') ?? DEFAULT_THEME.selection,
    bg: get('dark_background') ?? get('background') ?? DEFAULT_THEME.bg,
  }
}

export function luminance(hex: string): number {
  const v = parseInt(hex.slice(1), 16)
  const lin = (shift: number) => { const c = ((v >> shift) & 255) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(16) + 0.7152 * lin(8) + 0.0722 * lin(0)
}
export function contrast(a: string, b: string): number {
  if (!HEX.test(a) || !HEX.test(b)) return 0
  const hi = Math.max(luminance(a), luminance(b)), lo = Math.min(luminance(a), luminance(b))
  return (hi + 0.05) / (lo + 0.05)
}
function rgbToHsl(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16)
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2
  if (!d) return [0, 0, l]
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, d / (1 - Math.abs(2 * l - 1)), l]
}
function hsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h * 6) % 2 - 1)), m = l - c / 2
  const rgb = h < 1/6 ? [c,x,0] : h < 2/6 ? [x,c,0] : h < 3/6 ? [0,c,x] : h < 4/6 ? [0,x,c] : h < 5/6 ? [x,0,c] : [c,0,x]
  return `#${rgb.map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`
}
function balanced(hex: string): string {
  const [hue, saturation] = rgbToHsl(hex)
  let lo = 0, hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (luminance(hsl(hue, saturation, mid)) < 0.179) lo = mid
    else hi = mid
  }
  const candidates = [hsl(hue, saturation, lo), hsl(hue, saturation, hi)]
  return candidates.reduce((best, value) => Math.abs(luminance(value) - 0.179) < Math.abs(luminance(best) - 0.179) ? value : best)
}
export function ensureContrast(hex: string, bg: string, minContrast = 4.5): string {
  if (contrast(hex, bg) >= minContrast) return hex
  const [hue, saturation, lightness] = rgbToHsl(hex)
  const target = contrast('#ffffff', bg) >= contrast('#000000', bg) ? 1 : 0
  for (let i = 1; i <= 1000; i++) {
    const candidate = hsl(hue, saturation, lightness + (target - lightness) * i / 1000)
    if (contrast(candidate, bg) >= minContrast) return candidate
  }
  return target ? '#ffffff' : '#000000'
}
export function inkOn(fill: string): string {
  return contrast('#ffffff', fill) >= contrast('#000000', fill) ? '#ffffff' : '#000000'
}
export const onFill = (color: string | undefined, fill: string): string => color && contrast(color, fill) >= 4.5 ? color : inkOn(fill)
export function rowFill(theme: Pick<Theme, 'bg'>): string {
  return HEX.test(theme.bg) ? luminance(theme.bg) < 0.179 ? '#30343b' : '#e5e7eb' : '#ffffff'
}
export function colorDistance(a: string, b: string): number {
  const rgb = (hex: string) => [16, 8, 0].map(shift => (parseInt(hex.slice(1), 16) >> shift) & 255)
  return Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]!))
}
export type ThemeRoles = {
  fg: string; muted: string; accent: string; work: string; ok: string; fail: string; warn: string; fill: string
  // Совместимость старых деревьев; новые поверхности используют смысловые имена.
  urgent: string; hover: string; green: string; red: string
}
export function roleColors(theme: Theme, surfaces: string[] = []): ThemeRoles {
  const known = HEX.test(theme.bg)
  const paint = (color: string) => {
    let result = known ? ensureContrast(color, theme.bg) : contrast(color, '#ffffff') >= 4.5 && contrast(color, '#000000') >= 4.5 ? color : balanced(color)
    for (const surface of surfaces) result = ensureContrast(result, surface)
    return result
  }
  const accent = known ? ensureContrast(luminance(theme.bg) > 0.4 ? HOVER_ON_LIGHT : HOVER_ON_DARK, theme.bg) : HOVER_ANY
  const fg = paint(HEX.test(theme.fg) ? theme.fg : known ? inkOn(theme.bg) : '#757575')
  const muted = paint(theme.muted || DEFAULT_THEME.muted)
  const work = paint(CLAY), ok = paint('#32864b'), fail = paint('#c55755')
  const warn = paint(known && luminance(theme.bg) < 0.179 ? '#a9a04a' : '#806200')
  return { fg, muted, accent, work, ok, fail, warn, fill: rowFill(theme), urgent: fail, hover: accent, green: ok, red: fail }
}
export const hoverColor = (theme: Theme): string => roleColors(theme).accent
export const diffColors = (theme: Theme): { added: string; removed: string } => ({ added: roleColors(theme).ok, removed: roleColors(theme).fail })
export const faint = (hex: string): string => hex
// Блик — градиент от цвета «в работе» к его светлому пику: три ступени одного оттенка, без серого.
export function blend(from: string, to: string, share: number): string {
  const channel = (hex: string, shift: number) => (parseInt(hex.slice(1), 16) >> shift) & 255
  return `#${[16, 8, 0].map(shift => Math.round(channel(from, shift) + (channel(to, shift) - channel(from, shift)) * share).toString(16).padStart(2, '0')).join('')}`
}
// Сильный блик: ступени уходят по оттенку к жёлтому, с полной насыщенностью и растущей светлотой
// (кирпичный → оранжевый → жёлтый → бледно-жёлтый). Блик того же оттенка, что основа, читается слабым.
export const GLINT_STEPS = [0.3, 0.7, 1]
const GLINT_LIGHTNESS = [0.62, 0.68, 0.84]
const YELLOW = 1 / 6
export function glint(base: string, share: number, index = GLINT_STEPS.indexOf(share)): string {
  const [hue, , lightness] = rgbToHsl(base)
  // Кратчайший путь по кругу оттенков к жёлтому, не дальше 0,1 круга: зелёный уходит в салатовый, фиолетовый — в розовый.
  const direct = YELLOW - hue, way = Math.abs(direct) <= 0.5 ? direct : direct - Math.sign(direct)
  const turned = (hue + Math.sign(way) * Math.min(Math.abs(way), 0.1) * share + 1) % 1
  return hsl(turned, 0.95, Math.max(lightness, GLINT_LIGHTNESS[Math.max(0, index)] ?? 0.84))
}
export function glintTones(base: string): { bright: string[]; dim: string[] } {
  const shade = blend(base, '#000000', 0.35)
  return { bright: [base, ...GLINT_STEPS.map(share => glint(base, share))], dim: [shade, ...GLINT_STEPS.map(share => blend(shade, base, share))] }
}
export function activityTones(theme: Theme) {
  return glintTones(roleColors(theme).work)
}
export const CLAY_TONES = activityTones(DEFAULT_THEME)
export function withGutter<T extends { right: { t: string }[] }>(rows: T[]): T[] {
  return rows.map(row => ({ ...row, right: [...row.right, { t: '  ' }] }))
}
export function applyTheme<T extends { left: { t: string; c?: string }[]; right: { t: string; c?: string }[] }>(rows: T[], theme: Theme, roles = roleColors(theme)): T[] {
  const defaults = roleColors(DEFAULT_THEME)
  const colors: Record<string, string> = { [DEFAULT_THEME.accent]: roles.accent, [DEFAULT_THEME.muted]: roles.muted, [DEFAULT_THEME.urgent]: roles.fail }
  for (const role of ['fg', 'work', 'ok', 'fail', 'warn'] as const) colors[defaults[role]] = roles[role]
  const segment = (seg: { t: string; c?: string }) => ({ ...seg, c: seg.c ? colors[seg.c] ?? seg.c : roles.fg })
  return rows.map(row => ({ ...row, left: row.left.map(segment), right: row.right.map(segment) }))
}
export type FileStatus = 'M' | 'A' | 'D' | '?' | 'U' | 'R'
const FILE_STATUS_BASE: Record<FileStatus, string> = {
  M: '#007575', A: '#28753b', D: '#b42336', '?': '#51657e', U: '#b00073', R: '#403c98',
}
export function fileStatusColors(theme: Theme): Record<FileStatus, string> {
  const fill = rowFill(theme)
  return Object.fromEntries(Object.entries(FILE_STATUS_BASE).map(([status, color]) => {
    const start = HEX.test(theme.bg) ? ensureContrast(color, theme.bg) : balanced(color)
    return [status, ensureContrast(start, fill)]
  })) as Record<FileStatus, string>
}

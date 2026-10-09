// Копия FileTree; узлу задачи нужны только имя и вид для выбора исходного значка.
type FileNode = { name: string; kind: 'file' | 'dir' | 'link' }

const cp = (n: number) => String.fromCodePoint(n)

export const TASK_ICON = '\u{f0279}' // md-format_list_bulleted
// Вкладки страницы задачи. Набор без Nerd Font обходится названием.
export const PAGE_TAB_ICONS = {
  description: '\u{f09ed}', // md-text_box_outline
  comments: '\u{f0189}', // md-comment_text_outline
} as const
// Вкладки панели задач: значок стоит перед названием и остаётся, когда названию не хватает места.
export const TASK_TAB_ICONS = {
  agent: cp(0xf06a9), // md-robot
  owner: cp(0xf0004), // md-account
  backlog: cp(0xf120e), // md-archive_outline
  history: cp(0xf02da), // md-history
} as const
export const DIR_ICON = cp(0xf024b) // md-folder
export const GITHUB_ICON = cp(0xf09b) // fa-github

export const CHEVRON_OPEN = cp(0xf035d) // md-menu_down
export const CHEVRON_CLOSED = cp(0xf035f) // md-menu_right

export const SORT_ICON = {
  name: { nerd: cp(0xf05bd), plain: 'A↓' }, // md-sort_alphabetical_ascending
  newest: { nerd: cp(0xf154b), plain: '↓' }, // md-sort_clock_descending
  oldest: { nerd: cp(0xf1549), plain: '↑' }, // md-sort_clock_ascending
} as const

// Значки имён файлов по справочнику Nerd Fonts.
const NAMES: Record<string, number> = {
  'agents.md': 0xf0354, // md-language_markdown
  'changelog.md': 0xf0354, // md-language_markdown
  'contributing.md': 0xf0354, // md-language_markdown
  'todo.md': 0xf0354, // md-language_markdown
  'readme.md': 0xf0354, // md-language_markdown
  license: 0xf0fc3, // md-license
  dockerfile: 0xf0868, // md-docker
  makefile: 0xf1064, // md-tools
  'cmakelists.txt': 0xf1064, // md-tools
  justfile: 0xf05b7, // md-wrench
  gemfile: 0xf0d2d, // md-language_ruby
  rakefile: 0xf0d2d, // md-language_ruby
  'cargo.toml': 0xf107b, // md-file_cog
  'cargo.lock': 0xf0221, // md-file_lock
  'pyproject.toml': 0xf107b, // md-file_cog
  'requirements.txt': 0xf160e, // md-family_tree
  'go.mod': 0xf0afa, // md-alpha_m
  'go.sum': 0xf07d3, // md-language_go
  'package.json': 0xf0626, // md-code_json
  'package-lock.json': 0xf0626, // md-code_json
  'tsconfig.json': 0xf0626, // md-code_json
  '.prettierrc': 0xf0626, // md-code_json
  '.eslintrc': 0xf0626, // md-code_json
  'pnpm-lock.yaml': 0xf0221, // md-file_lock
  'yarn.lock': 0xf0221, // md-file_lock
  '.gitignore': 0xf02a2, // md-git
  '.gitmodules': 0xf0493, // md-cog
  '.editorconfig': 0xf0493, // md-cog
}

// Значки расширений файлов по справочнику Nerd Fonts.
const EXTS: Record<string, number> = {
  lua: 0xf08b1, // md-language_lua
  py: 0xf0320, // md-language_python
  pyi: 0xf0320, // md-language_python
  js: 0xf031e, // md-language_javascript
  mjs: 0xf031e, // md-language_javascript
  cjs: 0xf031e, // md-language_javascript
  ts: 0xf06e6, // md-language_typescript
  jsx: 0xf0708, // md-react
  tsx: 0xf0708, // md-react
  json: 0xf0626, // md-code_json
  jsonc: 0xf0626, // md-code_json
  yaml: 0xf1079, // md-file_settings
  yml: 0xf1079, // md-file_settings
  sh: 0xf1183, // md-bash
  bash: 0xf1183, // md-bash
  zsh: 0xf1183, // md-bash
  fish: 0xf1183, // md-bash
  md: 0xf0354, // md-language_markdown
  markdown: 0xf0354, // md-language_markdown
  css: 0xf031c, // md-language_css3
  scss: 0xf031c, // md-language_css3
  html: 0xf031d, // md-language_html5
  htm: 0xf031d, // md-language_html5
  go: 0xf07d3, // md-language_go
  rs: 0xf1617, // md-language_rust
  rb: 0xf0d2d, // md-language_ruby
  php: 0xf031f, // md-language_php
  java: 0xf0b37, // md-language_java
  cs: 0xf031b, // md-language_csharp
  sql: 0xf01bc, // md-database
  graphql: 0xf0877, // md-graphql
  gql: 0xf0877, // md-graphql
  xml: 0xf05c0, // md-xml
  toml: 0xf107b, // md-file_cog
  ini: 0xf0bc2, // md-script_text
  conf: 0xf0493, // md-cog
  pdf: 0xf0226, // md-file_pdf_box
  svg: 0xf0721, // md-svg
  jpg: 0xf0225, // md-file_jpg_box
  jpeg: 0xf0225, // md-file_jpg_box
  png: 0xf0e2d, // md-file_png_box
  gif: 0xf0d78, // md-file_gif_box
  webp: 0xf021f, // md-file_image
  mp4: 0xf022b, // md-file_video
  mkv: 0xf022b, // md-file_video
  mov: 0xf022b, // md-file_video
  mp3: 0xf0223, // md-file_music
  wav: 0xf0223, // md-file_music
  flac: 0xf0223, // md-file_music
  zip: 0xf05c4, // md-zip_box
  gz: 0xf05c4, // md-zip_box
  xz: 0xf05c4, // md-zip_box
  tar: 0xf05c4, // md-zip_box
  qml: 0xf022e, // md-file_code
  cpp: 0xf0672, // md-language_cpp
  cc: 0xf0672, // md-language_cpp
  cxx: 0xf0672, // md-language_cpp
  c: 0xf0671, // md-language_c
  h: 0xf0af5, // md-alpha_h
  hpp: 0xf0af5, // md-alpha_h
  vue: 0xf0844, // md-vuejs
  svelte: 0xf022e, // md-file_code
  csv: 0xf0218, // md-file_delimited
  txt: 0xf09aa, // md-text_long
}

export function fileIcon(n: FileNode, open: boolean, isRepo: boolean): string {
  if (n.kind === 'link') return cp(0xf0337) // md-link
  if (n.kind === 'dir') return cp(isRepo ? 0xf02a2 : open ? 0xf0770 : 0xf024b) // md-git, md-folder_open, md-folder
  const lower = n.name.toLowerCase()
  const named = NAMES[lower]
  if (named) return cp(named)
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  return cp(EXTS[ext] ?? 0xf0214) // md-file
}

export const MACHINE_ICON = {
  machine: { nerd: cp(0xf048b), plain: '▤' }, // md-server
  refresh: { nerd: cp(0xf0450), plain: '↻' }, // md-refresh
  collapse: { nerd: cp(0xf0aa6), plain: '⊟' }, // md-collapse_all
  memory: { nerd: SORT_ICON.name.nerd, plain: 'М↓' },
  cpu: { nerd: SORT_ICON.newest.nerd, plain: 'C↓' },
} as const
export type Glyphs = 'nerd' | 'plain' | 'auto'
export function usePlain(glyphs: Glyphs, surface: string): boolean {
  return glyphs === 'plain' || (glyphs === 'auto' && surface !== 'terminal')
}

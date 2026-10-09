import { expect, test } from 'claude-code/testing'
import { redactSecrets } from '../hooks/domain/privacy'
import { cleanSearchText } from '../hooks/task-search-panel'

const N = 256 * 1024
const rep = (unit: string) => unit.repeat(Math.floor(N / unit.length))
const hidden = (code: number) => String.fromCodePoint(code)
const cases: Record<string, string> = {
  tokenWords: rep('token'), tokenDash: rep('token-'), tokenDot: rep('token.'), keyRun: rep('API_KEY_'), mixed: rep('secret_token_password_'),
  optionRun: ' --' + rep('token-'), optionMany: rep(' --token'), eqRun: rep('token='), eqSpace: rep('token = '), colon: rep('a:'), slashes: rep('a://'),
  at: rep('a@'), userPass: rep('u:p'), bearer: rep('bearer '), basic: rep('basic '), jwt: rep('eyJaaaaaaaa.'), jwt2: rep('eyJaaaaaaaa.bbbbbbbb.'),
  sk: rep(['sk', '-'].join('')), gh: rep(['gh', 'p_'].join('')), xox: rep(['xox', 'b-'].join('')), apikey: rep(['api', 'key_aaaaaaaaaaaaaaaa_'].join('')),
  begin: rep(['-----BEGIN ', 'PRIVATE KEY-----'].join('')), dashU: rep(' -u '), dashUcolon: rep(' -u a'), quotes: rep(`'"`),
  hex: rep('a1'), opaque: rep('Ab1+/-_'), auth: rep('authorization: '), spaces: rep(' '), newlines: rep('\n'), wordsEq: rep('a ') + rep('b='),
  aws: rep(['AK', 'IA'].join('')), tsafe: rep(['api', 'key_'].join('')), jwtDash: rep('eyJ_-'),
  hidden: rep(hidden(0x200b)), hiddenWords: rep('a' + hidden(0x200b)), hiddenKeys: rep(['sk', '-', hidden(0x200b)].join('')),
  hiddenJwt: rep('eyJ_-' + hidden(0xe0041)), hiddenJwt2: rep('eyJaaaaaaaa.' + hidden(0x180e) + 'bbbbbbbb.'), hiddenJwtDash: rep('eyJ_-' + hidden(0x200b) + '_-'),
}
for (const code of [0xe0001, 0xe0041, 0xe007f, 0x180e, 0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x061c, 0x200b, 0x200c, 0x200d, 0x2060, 0xd800, 0xdfff, 0x0301]) {
  cases[`insert-${code.toString(16)}`] = rep('Слова ' + ['sk', '-', 'A7b8C9d0E1', hidden(code), 'A7b8C9d0E1A7b8C9d0E1'].join('') + ' конец ')
}
test('Барьер скорости Cockpit: 40 составов и 18 невидимых вставок', () => { expect(Object.keys(cases)).toHaveLength(58) })

// Тот же барьер, что в github/tests/secret-view-speed.test.ts: абсолютная цена и
// рост с четверти длины проверяются совместно; лучшие из трёх нужны только медленному входу.
const surfaces = [['redactSecrets', redactSecrets], ['cleanSearchText', cleanSearchText]] as const
const names = Object.keys(cases)
for (const [kind, mask] of surfaces) for (let from = 0; from < names.length; from += 5) {
  test(`Скорость ${kind}: входы ${from + 1}–${Math.min(from + 5, names.length)}, 256 КБ`, () => {
    const slow: string[] = []
    for (const name of names.slice(from, from + 5)) {
      const text = cases[name]!
      const timed = (input: string) => { const at = Date.now(); mask(input); return Date.now() - at }
      let ms = timed(text)
      if (ms <= 300) continue
      ms = Math.min(ms, timed(text), timed(text))
      if (ms <= 300) continue
      const part = text.slice(0, Math.floor(text.length / 4))
      const small = Math.min(timed(part), timed(part), timed(part))
      if (ms > 1500 || ms > small * 8) slow.push(`${kind}:${name}=${small}/${ms}`)
    }
    expect(slow.join(' ')).toBe('')
  })
}

export interface PrivacyCase { name: string; text: string; expected: string; viewExpected?: string }

const mark = (name: string) => `[REDACTED:${name}]`
// Синтетические значения собираются из частей: это примеры, не действующие секреты.
const typeKey = ['api', 'key_', 'A'.repeat(20), '_', 'B'.repeat(20)].join('')
const apiKey = ['s', 'k-', 'Q'.repeat(24)].join('')
const jwt = ['ey', 'J', 'A'.repeat(8), '.', 'B'.repeat(8), '.', 'C'.repeat(8)].join('')
const value = ['example', 'value'].join('')
const base64 = ['YWJj', 'ZGVm', 'Z2hp', '=='].join('')
const privateStart = ['-----BE', 'GIN RSA PRI', 'VATE KEY-----'].join('')
const privateEnd = ['-----E', 'ND RSA PRI', 'VATE KEY-----'].join('')

export const PRIVACY_CASES: readonly PrivacyCase[] = [
  { name: 'Приватный ключ', text: `${privateStart}\n${value}\n${privateEnd}\nПосле`, expected: mark('private_key') + '\nПосле' },
  { name: 'Незакрытый приватный ключ', text: `${privateStart}\n${value}`, expected: mark('private_key') },
  { name: 'Ключ TypeSafe с частями', text: `Ключ: ${typeKey}`, expected: `Ключ: ${mark('typesafe_key')}` },
  ...['AK', 'AS'].map(prefix => ({ name: `AWS ${prefix}`, text: [prefix, 'IA', 'A'.repeat(16)].join(''), expected: mark('aws_key_id') })),
  ...['p', 'o', 'u', 's', 'r'].map(kind => ({ name: `GitHub ${kind}`, text: ['g', 'h', kind, '_', 'Q'.repeat(30)].join(''), expected: mark('github_token') })),
  { name: 'GitHub PAT', text: ['git', 'hub_pat_', 'Q'.repeat(40)].join(''), expected: mark('github_token') },
  { name: 'Ключ API', text: apiKey, expected: mark('api_key') },
  ...['a', 'b', 'p', 'r', 's'].map(kind => ({ name: `Slack ${kind}`, text: ['xo', 'x', kind, '-', 'Q'.repeat(12)].join(''), expected: mark('slack_token') })),
  { name: 'JWT', text: jwt, expected: mark('jwt') },
  { name: 'URL с парой', text: ['https://', 'user', ':', value, '@host/path'].join(''), expected: `https://${mark('url_credentials')}@host/path` },
  { name: 'URL с токеном', text: ['ssh://', value, '@host/path'].join(''), expected: `ssh://${mark('url_credentials')}@host/path` },
  { name: 'Basic через -u', text: ['curl -u ', 'user:', value].join(''), expected: `curl -u ${mark('basic_auth')}` },
  { name: 'Basic через --user=', text: ['--user=', 'user:', value].join(''), expected: `--user=${mark('basic_auth')}` },
  { name: 'Basic в кавычках', text: ['curl -u "', 'user:', value, '"'].join(''), expected: `curl -u ${mark('basic_auth')}` },
  { name: 'Заголовок Basic', text: 'Basic ' + base64, expected: `Basic ${mark('basic_header')}` },
  { name: 'Basic без учёта регистра', text: 'BASIC ' + base64, expected: `BASIC ${mark('basic_header')}` },
  { name: 'Bearer', text: 'Bearer ' + 'Q'.repeat(24) + '==', expected: mark('bearer') },
  { name: 'Bearer без учёта регистра', text: 'bEaReR ' + 'Q'.repeat(24), expected: mark('bearer') },
  { name: 'Присваивание пароля', text: 'PASSWORD=' + value, expected: `PASSWORD=${mark('assignment')}` },
  { name: 'Присваивание API key', text: 'api-key = ' + value, expected: `api-key = ${mark('assignment')}` },
  { name: 'JSON токен', text: ['{"api_token": "', value, '"}'].join(''), expected: `{"api_token": "${mark('assignment')}"}` },
  { name: 'Экранированный JSON', text: ['{\\"api_token\\": \\"', value, '\\"}'].join(''), expected: `{\\"api_token\\": \\"${mark('assignment')}\\"}` },
  { name: 'Порядок форматов и assignment', text: 'api_key=' + apiKey, expected: 'api_key=' + mark('assignment') },
  { name: 'Повтор секрета', text: `${apiKey} ${apiKey}`, expected: `${mark('api_key')} ${mark('api_key')}` },
  { name: 'Нет секрета', text: 'Исправить заголовок задачи Cockpit', expected: 'Исправить заголовок задачи Cockpit' },
  { name: 'Короткое значение', text: 'token=' + 'tiny', expected: 'token=' + 'tiny' },
  { name: 'URL без авторизации', text: 'https://host/path', expected: 'https://host/path' },
  { name: 'Python граница после кириллицы', text: 'я' + apiKey, expected: 'я' + apiKey },
  { name: 'Python граница перед кириллицей', text: apiKey + 'я', expected: apiKey + 'я' },
  { name: 'Python граница после Unicode числа', text: 'Ⅷ' + apiKey, expected: 'Ⅷ' + apiKey },
  { name: 'Python граница после combining mark', text: '\u0301' + apiKey, expected: '\u0301' + mark('api_key') },
  { name: 'Python граница после emoji', text: '👩' + apiKey, expected: '👩' + mark('api_key') },
  { name: 'Python пробел U+0085', text: 'Basic\u0085' + base64, expected: 'Basic ' + mark('basic_header') },
  { name: 'Python пробел U+001C', text: 'Bearer\u001c' + 'Q'.repeat(24), expected: mark('bearer') },
  { name: 'BOM не является пробелом Python', text: 'Basic\ufeff' + base64, expected: 'Basic\ufeff' + base64, viewExpected: `Basic ${mark('basic_header')}` },
  { name: 'Python IGNORECASE для İ', text: 'APİ_KEY=' + value, expected: 'APİ_KEY=' + mark('assignment') },
  { name: 'Python IGNORECASE для ı', text: 'basıc ' + base64, expected: 'basıc ' + mark('basic_header') },
]

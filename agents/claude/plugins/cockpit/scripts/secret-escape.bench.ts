import { expect, test } from 'claude-code/testing'
import { redactSecrets } from '../hooks/domain/privacy'

// Прибор замера, а не проверка поведения: имя файла не входит в набор тестов. Запуск — копией под именем *.test.ts.

// Один процесс, одинаковая нагрузка и прогрев; три средних цены вызова для сверки до и после правки.
test('ESC-1 замер redactSecrets: 10 000 знаков, обычный текст, текст с переносами и одна CSI', () => {
  const plain = 'Обычный безопасный текст. '.repeat(400).slice(0, 10_000)
  const sequence = String.fromCodePoint(27) + '[31m'
  const escaped = plain.slice(0, 5000) + sequence + plain.slice(5000 + sequence.length)
  const iterations = 200, warmup = 100
  const samples: Record<string, number[]> = {}
  const lines = plain.replace(/\. /gu, '.\n')
  for (const [name, text] of [['plain', plain], ['lines', lines], ['oneCSI', escaped]]) {
    expect(Array.from(text!).length).toBe(10_000)
    for (let call = 0; call < warmup; call++) redactSecrets(text!)
    samples[name!] = []
    let result = ''
    for (let run = 0; run < 3; run++) {
      const start = performance.now()
      for (let call = 0; call < iterations; call++) result = redactSecrets(text!)
      samples[name!]!.push((performance.now() - start) * 1000 / iterations)
      expect(result).toBe(text)
    }
  }
  console.log(JSON.stringify({ benchmark: 'redactSecrets-10000', iterations, warmup, microsecondsPerCall: samples }))
})

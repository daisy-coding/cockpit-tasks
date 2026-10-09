import { parseResponse } from '../hooks/domain/rpc.ts'

let wire = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) wire += chunk
const runs = Math.max(7, Number(process.argv[2] ?? 7))
for (let index = 0; index < 3; index += 1) parseResponse('snapshot', wire)
const samplesMs = []
let outcome
for (let index = 0; index < runs; index += 1) {
  const start = performance.now()
  outcome = parseResponse('snapshot', wire)
  if (outcome.kind !== 'snapshot') throw new Error('Парсер отверг снимок измерительного набора')
  samplesMs.push(performance.now() - start)
}
const sorted = [...samplesMs].sort((a, b) => a - b)
process.stdout.write(JSON.stringify({ medianMs: sorted[Math.floor(sorted.length / 2)], samplesMs,
  kind: outcome.kind, tasks: outcome.kind === 'snapshot' ? outcome.snapshot.tasks.length : null }))

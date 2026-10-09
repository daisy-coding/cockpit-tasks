import { buildRequest, parseResponse } from '../hooks/domain/rpc.ts'
import { parseTaskSearchQuery, matchesTaskSearch, taskSearchTitleRanges } from '../hooks/domain/task-search.ts'
import { readFileSync } from 'node:fs'

// Node 22 исполняет именно доменный модуль, без копии envelope в Python.
if (process.argv[2] === 'search-cases') {
  const examples = JSON.parse(readFileSync(new URL('../tests/task-search-cases.json', import.meta.url), 'utf8'))
  const results = examples.cases.map(example => {
    const parsed = parseTaskSearchQuery(example.query)
    return { parsed, matches: matchesTaskSearch(parsed, example), ranges: taskSearchTitleRanges(parsed, example.title) }
  })
  process.stdout.write(JSON.stringify({ results, invalid: examples.invalidQueries.map(parseTaskSearchQuery) }))
} else if (process.argv[2] === 'build') {
  const session = { sessionId: 'cockpit-e2e-session', cwd: process.argv[3] }
  const requests = [
    buildRequest('capture.prompt', 'cockpit-e2e-capture', session, { text: 'Проверить RPC мода\r\n👩\u0000', kind: 'prompt' }),
    buildRequest('task.bind', 'cockpit-e2e-bind', session, {}),
    buildRequest('snapshot', 'cockpit-e2e-snapshot', session, {}),
  ]
  process.stdout.write(JSON.stringify(requests))
} else if (process.argv[2] === 'title' || process.argv[2] === 'parse' || process.argv[2] === 'request') {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const body = JSON.parse(input)
  if (process.argv[2] === 'request') {
    process.stdout.write(JSON.stringify(buildRequest(body.op, body.requestId, body.session, body.args, body.panelSecret, body.actor)))
  } else if (process.argv[2] === 'parse') {
    process.stdout.write(JSON.stringify(parseResponse(body.op, body.response)))
  } else {
    const { session, task } = body
    process.stdout.write(JSON.stringify([
      buildRequest('inbox.get', 'cockpit-e2e-inbox', session, { inboxId: task.source.inboxId }),
      buildRequest('task.update', 'cockpit-e2e-title', session, { taskId: task.taskId, expectedRevision: task.revision, title: 'Осмысленные заголовки Cockpit' }),
      buildRequest('snapshot', 'cockpit-e2e-title-snapshot', session, {}),
      buildRequest('task.update', 'cockpit-e2e-conflict', session, { taskId: task.taskId, expectedRevision: task.revision, title: 'Устаревший заголовок' }),
    ]))
  }
} else {
  throw new Error('Использование: runtime-requests.mjs build <cwd> | title | request | parse | search-cases')
}

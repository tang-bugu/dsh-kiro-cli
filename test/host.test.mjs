// Host-half test: mounts dsh-kiro-cli/index.js on a stub Cordis context, then
// exercises the registered tool and HTTP route without DSH or a browser.
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { apply } from '../index.js'

const registered = { tools: [], routes: [] }
let failures = 0

function expect(condition, message) {
  if (condition) console.log('ok  -', message)
  else {
    failures++
    console.error('FAIL:', message)
  }
}

function stubContext() {
  return {
    get(name) {
      if (name === 'workingDirectory') return { defaultDirectory: process.cwd() }
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(names, callback) {
      const scoped = {
        get: (name) => (name === 'workingDirectory' ? { defaultDirectory: process.cwd() } : undefined),
        effect: (cb) => {
          const disposer = cb()
          return typeof disposer === 'function' ? disposer : () => {}
        },
        tools: {
          register(definition) {
            registered.tools.push(definition)
            return () => {}
          },
        },
        webServer: {
          register(route) {
            registered.routes.push(route)
            return () => {}
          },
        },
      }
      callback(scoped)
    },
  }
}

function fakeResponse() {
  const res = new EventEmitter()
  res.statusCode = 0
  res.headers = {}
  res.chunks = []
  res.writableEnded = false
  res.headersSent = false
  res.writeHead = (status, headers) => {
    res.statusCode = status
    res.headers = headers ?? {}
    res.headersSent = true
    return res
  }
  res.write = (chunk) => {
    res.chunks.push(String(chunk))
    return true
  }
  res.end = (chunk) => {
    if (chunk !== undefined) res.chunks.push(String(chunk))
    res.writableEnded = true
    return res
  }
  return res
}

function fakeRequest(url, method, body, headers) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  req.url = url
  req.method = method
  req.headers = headers ?? { host: '127.0.0.1:51860' }
  return req
}

apply(stubContext(), { trustTools: 'fs_read', askTimeoutMs: 120_000 })

expect(
  registered.tools.map((tool) => tool.name).join(',') === 'kiro_cli',
  'registers exactly one tool named kiro_cli',
)
expect(
  registered.routes.length === 1 &&
    registered.routes[0].kind === 'prefix' &&
    registered.routes[0].path === '/api/kiro-cli',
  'registers one prefix route at /api/kiro-cli',
)

const tool = registered.tools[0]
expect(tool.parameters.type === 'object' && tool.parameters.required.includes('action'), 'action is the one required parameter')
expect(
  tool.parameters.properties.action.enum.join(',') === 'ask,status,models,sessions',
  'action enumerates ask/status/models/sessions',
)
expect(typeof tool.output.render === 'function', 'declares an output renderer')

const handler = registered.routes[0].handler

async function call(path, method = 'GET', body, headers) {
  const req = fakeRequest(path, method, body, headers)
  const res = fakeResponse()
  await handler(req, res)
  return { status: res.statusCode, headers: res.headers, body: res.chunks.join('') }
}

const status = await call('/api/kiro-cli/status')
const statusPayload = JSON.parse(status.body || '{}')
expect(status.status === 200, 'GET /status answers 200')
expect(typeof statusPayload.cli?.found === 'boolean', 'status reports whether kiro-cli was found')
expect(Array.isArray(statusPayload.models), 'status carries a model list')
expect(Array.isArray(statusPayload.agents), 'status carries the local agent list')

const blocked = await call('/api/kiro-cli/status', 'GET', undefined, { host: 'evil.example.com' })
expect(blocked.status === 403, 'a foreign Host is refused')

const crossSite = await call('/api/kiro-cli/status', 'GET', undefined, {
  host: '127.0.0.1:51860',
  'sec-fetch-site': 'cross-site',
})
expect(crossSite.status === 403, 'a cross-site request is refused')

const unknown = await call('/api/kiro-cli/nope')
expect(unknown.status === 404, 'an unknown sub-route answers 404')

const empty = await call('/api/kiro-cli/run', 'POST', JSON.stringify({ prompt: '   ' }))
const events = empty.body
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
expect(empty.status === 200 && String(empty.headers['content-type']).includes('ndjson'), 'POST /run streams NDJSON')
expect(events[0]?.kind === 'error' && events[0]?.errorKind === 'empty-prompt', 'an empty prompt reports empty-prompt')
expect(events[events.length - 1]?.kind === 'done', 'every run ends with a done event')

const badJson = await call('/api/kiro-cli/run', 'POST', '{not json')
expect(badJson.status === 400, 'a malformed body answers 400')

console.log(failures === 0 ? '\nRESULT: all host checks passed' : `\nRESULT: ${failures} host check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1

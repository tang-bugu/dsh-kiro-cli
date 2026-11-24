// Client-half test: loads dsh-kiro-cli/client.js the way the Web shell does and
// drives its panel on a minimal React stand-in — first paint, the status fetch,
// a streamed run, and a failing run — without DSH or a browser.
import { readFileSync } from 'node:fs'
import { createMiniReact } from './mini-react.mjs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const registered = { slots: [], styles: [], locale: [] }
const LANG_DICT = {}
let loaderOptions

globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      loaderOptions = options
    },
  },
}
globalThis.document = {
  baseURI: 'http://127.0.0.1:51860/',
  documentElement: { lang: 'zh' },
  createElement: () => {
    const element = {
      textContent: '',
      dataset: {},
      setAttribute(name, value) {
        element[name] = value
      },
      remove() {
        registered.styles = registered.styles.filter((entry) => entry !== element)
      },
    }
    return element
  },
  head: {
    appendChild(element) {
      registered.styles.push(element)
    },
  },
}
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async () => {} } },
})

// eslint-disable-next-line no-new-func
new Function('window', 'document', source)(globalThis.window, globalThis.document)
if (loaderOptions?.id !== 'dsh-kiro-cli') throw new Error('bundle did not register its factory')

const { React, render, findAll, textOf, dispose } = createMiniReact()

const STATUS = {
  cli: { found: true, path: 'C:\\Users\\ultra\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe' },
  version: '3.1.0',
  account: { signedIn: true, email: 'zhihong tang' },
  models: [
    { id: 'auto', label: 'auto', contextWindow: 1000000 },
    { id: 'claude-haiku-4.5', label: 'claude-haiku-4.5', contextWindow: 200000 },
  ],
  agents: [
    { id: 'kiro_default', description: 'Default agent' },
    { id: 'kirocrew', description: 'Autonomous personal AI agent' },
  ],
  cwd: 'C:\\Users\\ultra\\Documents\\deepseek-harness\\default-workspace',
  config: { defaultModel: '', defaultAgent: '', trustTools: '', askTimeoutMs: 600000 },
}

const requests = []
let runMode = 'ok'
globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  requests.push({ target, method: options.method ?? 'GET', body: options.body })
  if (target.includes('/status')) {
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(STATUS)
      },
    }
  }
  if (target.includes('/run')) {
    const lines =
      runMode === 'ok'
        ? [
            { kind: 'start', cwd: STATUS.cwd, model: 'claude-haiku-4.5' },
            { kind: 'session', sessionId: 'sess_test_1' },
            { kind: 'tool', tool: { id: 't1', title: 'List Directory', kind: 'search', status: 'completed' } },
            { kind: 'delta', text: 'bridge' },
            { kind: 'delta', text: '-ok' },
            {
              kind: 'done',
              result: {
                ok: true,
                text: 'bridge-ok',
                sessionId: 'sess_test_1',
                model: 'claude-haiku-4.5',
                durationMs: 4200,
                credits: 0.25,
                tools: [],
                error: '',
                errorKind: '',
              },
            },
          ]
        : [
            { kind: 'error', message: "You've reached your monthly usage limit.", errorKind: 'usage-limit' },
            {
              kind: 'done',
              result: {
                ok: false,
                text: '',
                sessionId: '',
                model: 'claude-haiku-4.5',
                durationMs: 900,
                credits: 0,
                tools: [],
                error: "You've reached your monthly usage limit.",
                errorKind: 'usage-limit',
              },
            },
          ]
    const body = lines.map((line) => JSON.stringify(line) + '\n').join('')
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let sent = false
          return {
            async read() {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: new TextEncoder().encode(body) }
            },
          }
        },
      },
      async text() {
        return body
      },
    }
  }
  throw new Error('unexpected fetch: ' + target)
}

const module = { exports: {} }
const exports = loaderOptions.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
void module

const ctx = {
  get: () => undefined,
  on: () => () => {},
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  slots: {
    inject(_key, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registered.slots.push({ register: options, component })
      return () => {}
    },
  },
  locale: {
    bind: () => (key) => LANG_DICT[key] ?? key,
    register(ns, dicts) {
      registered.locale.push({ ns, dicts })
      Object.assign(LANG_DICT, dicts.zh)
      return () => {}
    },
    getLocale: () => ({ active: 'zh' }),
  },
}

exports.apply(ctx)

let failures = 0
function expect(condition, message) {
  if (condition) console.log('ok  -', message)
  else {
    failures++
    console.error('FAIL:', message)
  }
}

const registrations = registered.slots
const panel = registrations.find((entry) => entry.register.name === 'main')
const icon = registrations.find((entry) => entry.register.name === 'sidebar.panellist')

expect(registered.locale.length === 1, 'registers one locale namespace')
expect(registered.styles.length === 1 && registered.styles[0].textContent.includes('.kcli_host'), 'injects its stylesheet')
expect(registrations.length === 2, 'registers the sidebar row and the main panel')
expect(icon.register.label() === 'Kiro CLI', 'sidebar label resolves through the locale')
expect(registrations.some((entry) => entry.register.name === 'main' && entry.register.key === 'kiro-cli'), 'main panel is keyed kiro-cli')

const mount = () => render(React.createElement(panel.component, {}))
let tree = mount()
expect(textOf(tree).includes(LANG_DICT.title), 'first paint shows the localized title')
expect(!textOf(tree).includes(LANG_DICT.missing), 'loading state does not claim the CLI is missing')

await new Promise((resolve) => setTimeout(resolve, 30))
tree = mount()
expect(textOf(tree).includes('3.1.0'), 'status fetch fills in the CLI version')
expect(textOf(tree).includes('zhihong tang'), 'status fetch fills in the account')
const options = findAll(tree, (node) => node.tag === 'option').map((node) => node.props.value)
expect(options.includes('claude-haiku-4.5'), 'model select lists the CLI models')
expect(options.includes('kirocrew'), 'agent select lists the local agents')

const editor = findAll(tree, (node) => node.tag === 'textarea')[0]
expect(editor !== undefined, 'renders the prompt editor')
editor.props.onChange({ target: { value: 'say bridge-ok' } })
tree = mount()

const runButton = findAll(tree, (node) => node.tag === 'button' && node.props['kcli-variant'] === 'primary')[0]
expect(runButton !== undefined && runButton.props.disabled !== true, 'run button enables once a prompt exists')

runButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 60))
tree = mount()
expect(textOf(tree).includes('bridge-ok'), 'streamed answer renders in the transcript')
expect(textOf(tree).includes('List Directory'), 'Kiro tool calls render as chips')
expect(textOf(tree).includes('sess_test_1'), 'the session id is shown for continuation')
const runRequest = requests.find((entry) => entry.target.includes('/run'))
const sent = JSON.parse(runRequest.body)
expect(sent.prompt === 'say bridge-ok', 'the run request carries the typed prompt')
expect(sent.trustTools === '', 'the default trust setting trusts no Kiro tools')

runMode = 'fail'
const editor2 = findAll(tree, (node) => node.tag === 'textarea')[0]
editor2.props.onChange({ target: { value: 'second question' } })
tree = mount()
const runButton2 = findAll(tree, (node) => node.tag === 'button' && node.props['kcli-variant'] === 'primary')[0]
runButton2.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 60))
tree = mount()
expect(textOf(tree).includes('monthly usage limit'), 'a failed run surfaces the CLI error')
expect(findAll(tree, (node) => node.props['data-state'] === 'error').length > 0, 'the failed answer is marked with the error state')

const stylesBefore = registered.styles.length
dispose()
expect(stylesBefore === 1, 'the component kept exactly one stylesheet while mounted')

console.log(failures === 0 ? '\nRESULT: all client checks passed' : `\nRESULT: ${failures} client check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1

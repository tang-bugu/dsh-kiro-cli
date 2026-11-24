/**
 * Host half of dsh-kiro-cli: bridges the Harness to a locally installed
 * `kiro-cli`, exposes one agent tool and the HTTP API the sidebar panel reads.
 *
 * Everything here talks to the CLI through `node:child_process` — the same
 * approach the shipped plugin manager uses for pnpm — so the plugin needs no
 * dependency on Harness internals and keeps working across composition changes.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'kiro-cli'

const PREFIX = '/api/kiro-cli'
const MAX_PROMPT_BYTES = 256 * 1024
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 32 * 1024
const STATUS_TTL_MS = 30_000

/** Defaults applied when the profile passes no config. */
const DEFAULTS = {
  /** Absolute path to kiro-cli; empty = auto-detect. */
  cliPath: '',
  /** Default model id; empty = whatever kiro-cli picks. */
  defaultModel: '',
  /** Default agent/context profile; empty = kiro-cli's default agent. */
  defaultAgent: '',
  /** `--trust-tools` value. `''` trusts nothing, `'*'` passes `-a`. */
  trustTools: '',
  /** Working directory for runs; empty = Harness default directory. */
  cwd: '',
  /** Ceiling for one chat run. */
  askTimeoutMs: 600_000,
  /** Ceiling for one probe (`--version`, `whoami`, `--list-models`). */
  probeTimeoutMs: 30_000,
  /** Skip the folder-trust prompt (V3 only). */
  trustWorkspace: false,
}

function readConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const read = (key, kind) => {
    const value = source[key]
    return typeof value === kind ? value : DEFAULTS[key]
  }
  const timeout = source.askTimeoutMs
  return {
    cliPath: read('cliPath', 'string'),
    defaultModel: read('defaultModel', 'string'),
    defaultAgent: read('defaultAgent', 'string'),
    trustTools: read('trustTools', 'string'),
    cwd: read('cwd', 'string'),
    askTimeoutMs:
      typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 1000
        ? Math.floor(timeout)
        : DEFAULTS.askTimeoutMs,
    probeTimeoutMs: DEFAULTS.probeTimeoutMs,
    trustWorkspace: source.trustWorkspace === true,
  }
}

function childEnv() {
  const env = { ...process.env }
  // Keep the CLI's own color/telemetry output machine-readable, and never hand
  // Electon's Node switches to a native executable's Bun-based backend.
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  env.FORCE_COLOR = '0'
  env.CLICOLOR = '0'
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

/** Kill one process and its children; the Kiro engine runs as a child. */
function killTree(child) {
  if (child === undefined || child.exitCode !== null) return
  try {
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      return
    }
    child.kill('SIGTERM')
    setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 2_000).unref?.()
  } catch {
    /* the process is already gone */
  }
}

/**
 * Run one `kiro-cli` invocation.
 *
 * @param {string} cli absolute executable path
 * @param {string[]} args argv after the executable
 * @param {object} options
 * @param {string} options.cwd working directory
 * @param {number} options.timeoutMs hard ceiling
 * @param {AbortSignal} [options.signal] caller cancellation
 * @param {string} [options.stdinText] prompt delivered on stdin instead of argv
 * @param {(line: string) => void} [options.onLine] one stdout line at a time
 * @returns {Promise<{code:number|null,signal:string|null,timedOut:boolean,aborted:boolean,stdout:string,stderr:string,durationMs:number,promptTooLong:boolean}>}
 */
function execKiro(cli, args, options) {
  const {
    cwd,
    timeoutMs,
    signal,
    stdinText,
    onLine,
  } = options
  return new Promise((resolvePromise) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(cli, args, {
        cwd,
        env: childEnv(),
        windowsHide: true,
        stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({
        code: null,
        signal: null,
        timedOut: false,
        aborted: false,
        spawnError: error instanceof Error ? error.message : String(error),
        stdout: '',
        stderr: '',
        durationMs: 0,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let lineBuffer = ''

    const settle = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({
        ...outcome,
        timedOut,
        aborted,
        stdout: stdout.length > MAX_STDOUT_BYTES ? stdout.slice(0, MAX_STDOUT_BYTES) : stdout,
        truncatedStdout: stdout.length > MAX_STDOUT_BYTES,
        stderr: stderr.length > MAX_STDERR_BYTES ? stderr.slice(-MAX_STDERR_BYTES) : stderr,
        durationMs: Date.now() - startedAt,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, Math.max(1_000, timeoutMs))

    const onAbort = () => {
      aborted = true
      killTree(child)
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stdout += text
      if (typeof onLine !== 'function') return
      lineBuffer += text
      let index
      while ((index = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, index).replace(/\r$/, '')
        lineBuffer = lineBuffer.slice(index + 1)
        if (line.trim() !== '') onLine(line)
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      settle({
        code: null,
        signal: null,
        spawnError: error instanceof Error ? error.message : String(error),
      })
    })
    child.on('close', (code, signalName) => {
      if (typeof onLine === 'function' && lineBuffer.trim() !== '') {
        onLine(lineBuffer.replace(/\r$/, ''))
        lineBuffer = ''
      }
      settle({ code, signal: signalName })
    })

    if (stdinText !== undefined && child.stdin !== undefined) {
      child.stdin.on('error', () => {
        /* the CLI may close stdin early; that is not a failure */
      })
      child.stdin.end(stdinText)
    }
  })
}

function clampText(value, max) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

/** First JSON value on its own line, for commands that print prose after it. */
function firstJsonLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      continue
    }
  }
  return undefined
}

function parseModels(text) {
  const payload = firstJsonLine(text)
  const list = Array.isArray(payload?.models) ? payload.models : []
  return list
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.model_id === 'string')
    .map((entry) => ({
      id: entry.model_id,
      label: typeof entry.model_name === 'string' ? entry.model_name : entry.model_id,
      description: typeof entry.description === 'string' ? entry.description : '',
      contextWindow: typeof entry.context_window_tokens === 'number' ? entry.context_window_tokens : null,
      multiplier: typeof entry.rate_multiplier === 'number' ? entry.rate_multiplier : null,
    }))
}

function parseWhoami(text) {
  const json = firstJsonLine(text)
  const account = json !== null && typeof json === 'object' ? json : {}
  const rest = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('{'))
    .join('\n')
    .trim()
  const signedIn =
    typeof account.email === 'string' ||
    typeof account.accountType === 'string' ||
    /Profile:\s*\S/.test(rest)
  return {
    signedIn,
    accountType: typeof account.accountType === 'string' ? account.accountType : '',
    email: typeof account.email === 'string' ? account.email : '',
    startUrl: typeof account.startUrl === 'string' ? account.startUrl : '',
    region: typeof account.region === 'string' ? account.region : '',
    detail: clampText(rest, 600),
  }
}

function classifyFailure(message) {
  const text = String(message ?? '')
  if (/SignInRequiredError|Sign in to Kiro/i.test(text)) return 'sign-in-required'
  if (/UsageLimitReached|monthly usage limit/i.test(text)) return 'usage-limit'
  if (/not a terminal/i.test(text)) return 'not-a-terminal'
  if (/ENOENT|not recognized|not found/i.test(text)) return 'cli-missing'
  if (/timed out|timeout/i.test(text)) return 'timeout'
  return 'failed'
}

function parseVersion(text) {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(text ?? ''))
  return match === null ? '' : match[1]
}

/** Names and descriptions of locally defined Kiro agents. */
function listAgents(home) {
  const dirs = [join(home, '.kiro', 'agents')]
  const result = []
  const seen = new Set()
  for (const dir of dirs) {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -'.json'.length)
      if (seen.has(id)) continue
      seen.add(id)
      let description = ''
      try {
        const parsed = JSON.parse(readFileSync(join(dir, entry.name), 'utf8'))
        if (typeof parsed?.description === 'string') description = clampText(parsed.description, 200)
      } catch {
        /* an unreadable agent is still listed by name */
      }
      result.push({ id, description })
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

function findOnPath() {
  const command = process.platform === 'win32' ? 'where' : 'which'
  try {
    const probe = spawnSync(command, ['kiro-cli'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: childEnv(),
    })
    if (probe.status === 0 && typeof probe.stdout === 'string') {
      const first = probe.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== '')
      if (first !== undefined) return first
    }
  } catch {
    /* fall through to the fixed candidates */
  }
  return ''
}

function candidatePaths() {
  const candidates = []
  const local = process.env.LOCALAPPDATA
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env['ProgramFiles(x86)']
  if (local !== undefined && local !== '') candidates.push(join(local, 'Kiro-Cli', 'kiro-cli.exe'))
  if (programFiles !== undefined && programFiles !== '') {
    candidates.push(join(programFiles, 'Kiro-Cli', 'kiro-cli.exe'))
  }
  if (programFilesX86 !== undefined && programFilesX86 !== '') {
    candidates.push(join(programFilesX86, 'Kiro-Cli', 'kiro-cli.exe'))
  }
  candidates.push(join(homedir(), '.local', 'bin', 'kiro-cli'))
  candidates.push('/usr/local/bin/kiro-cli')
  candidates.push('/opt/homebrew/bin/kiro-cli')
  return candidates
}

/**
 * Build the bridge for one plugin activation.
 *
 * @param {object} rawConfig the loader row's config
 * @param {{defaultCwd: () => string}} deps
 */
export function createKiro(rawConfig, deps) {
  const config = readConfig(rawConfig)
  const defaultCwdOf = typeof deps?.defaultCwd === 'function' ? deps.defaultCwd : () => process.cwd()
  let cliCache = { path: '', checkedAt: 0 }
  let statusCache = { at: 0, value: undefined }
  let statusInFlight

  function resolveCli() {
    if (config.cliPath !== '') {
      return existsSync(config.cliPath) ? config.cliPath : ''
    }
    if (cliCache.path !== '' && existsSync(cliCache.path) && Date.now() - cliCache.checkedAt < 60_000) {
      return cliCache.path
    }
    let found = findOnPath()
    if (found === '') {
      for (const candidate of candidatePaths()) {
        if (existsSync(candidate)) {
          found = candidate
          break
        }
      }
    }
    cliCache = { path: found, checkedAt: Date.now() }
    return found
  }

  function workingDirectory(requested) {
    if (typeof requested === 'string' && requested.trim() !== '') return requested.trim()
    if (config.cwd !== '') return config.cwd
    let fallback = ''
    try {
      fallback = defaultCwdOf()
    } catch {
      fallback = ''
    }
    return typeof fallback === 'string' && fallback !== '' ? fallback : process.cwd()
  }

  function effectiveTrust(requested) {
    if (typeof requested === 'string') return requested
    return config.trustTools
  }

  function effectiveModel(requested) {
    if (typeof requested === 'string' && requested.trim() !== '') return requested.trim()
    return config.defaultModel
  }

  function effectiveAgent(requested) {
    if (typeof requested === 'string' && requested.trim() !== '') return requested.trim()
    return config.defaultAgent
  }

  async function probeVersion(cli) {
    const result = await execKiro(cli, ['--version'], {
      cwd: workingDirectory(''),
      timeoutMs: config.probeTimeoutMs,
    })
    return { version: parseVersion(result.stdout), raw: clampText(result.stdout.trim(), 200) }
  }

  async function probeAccount(cli) {
    const result = await execKiro(cli, ['whoami', '--format', 'json'], {
      cwd: workingDirectory(''),
      timeoutMs: config.probeTimeoutMs,
    })
    const combined = `${result.stdout}\n${result.stderr}`
    if (result.code !== 0 && firstJsonLine(result.stdout) === undefined) {
      return { signedIn: false, error: clampText(combined.trim(), 600) }
    }
    return parseWhoami(combined)
  }

  async function probeModels(cli) {
    const result = await execKiro(cli, ['chat', '--list-models', '--format', 'json'], {
      cwd: workingDirectory(''),
      timeoutMs: config.probeTimeoutMs,
    })
    const models = parseModels(result.stdout)
    if (models.length === 0) {
      return { models: [], error: clampText(`${result.stdout}\n${result.stderr}`.trim(), 600) }
    }
    return { models }
  }

  async function status(force = false) {
    if (!force && statusCache.value !== undefined && Date.now() - statusCache.at < STATUS_TTL_MS) {
      return statusCache.value
    }
    if (statusInFlight !== undefined) return statusInFlight
    statusInFlight = (async () => {
      const cli = resolveCli()
      const base = {
        cli: { found: cli !== '', path: cli },
        cwd: workingDirectory(''),
        agents: listAgents(homedir()),
        config: {
          defaultModel: config.defaultModel,
          defaultAgent: config.defaultAgent,
          trustTools: config.trustTools,
          askTimeoutMs: config.askTimeoutMs,
        },
      }
      if (cli === '') {
        const value = {
          ...base,
          cli: {
            ...base.cli,
            hint:
              process.platform === 'win32'
                ? 'Install kiro-cli, or set the plugin config cliPath to its full path.'
                : 'Install kiro-cli, or set the plugin config cliPath to its full path.',
          },
          version: '',
          account: { signedIn: false },
          models: [],
        }
        statusCache = { at: Date.now(), value }
        return value
      }
      const [version, account, models] = await Promise.all([
        probeVersion(cli).catch((error) => ({ version: '', error: String(error) })),
        probeAccount(cli).catch((error) => ({ signedIn: false, error: String(error) })),
        probeModels(cli).catch((error) => ({ models: [], error: String(error) })),
      ])
      const value = {
        ...base,
        version: version.version ?? '',
        account,
        models: models.models ?? [],
        modelsError: models.error ?? '',
      }
      statusCache = { at: Date.now(), value }
      return value
    })().finally(() => {
      statusInFlight = undefined
    })
    return statusInFlight
  }

  function buildChatArgs(request) {
    const prompt = typeof request.prompt === 'string' ? request.prompt : ''
    const args = ['chat', '--no-interactive', '--output-format', 'stream-json']
    const model = effectiveModel(request.model)
    if (model !== '') args.push('--model', model)
    const agent = effectiveAgent(request.agent)
    if (agent !== '') args.push('--agent', agent)
    const trust = effectiveTrust(request.trustTools)
    if (trust === '*') args.push('-a')
    else args.push(`--trust-tools=${trust}`)
    if (config.trustWorkspace) args.push('--trust-workspace')
    if (typeof request.resumeSessionId === 'string' && request.resumeSessionId.trim() !== '') {
      args.push('--resume-id', request.resumeSessionId.trim())
    }
    // Windows caps one command line at 32767 characters; long prompts go on
    // stdin, which the CLI reads when no INPUT argument is present.
    const useStdin = Buffer.byteLength(prompt, 'utf8') > 6_000
    if (!useStdin) args.push(prompt)
    return { args, useStdin }
  }

  /**
   * One chat turn. Streams line events through `onEvent` and resolves with the
   * compact record both the panel and the agent tool consume.
   */
  async function ask(request, options = {}) {
    const cli = resolveCli()
    const prompt = typeof request?.prompt === 'string' ? request.prompt : ''
    const cwd = workingDirectory(request?.cwd)
    const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
    // A refusal before the CLI starts still answers the caller the same way a
    // finished run does, so a streaming consumer always receives its terminal
    // event instead of an empty body.
    const refuse = (kind, message) => {
      const value = {
        ok: false,
        action: 'ask',
        text: '',
        sessionId: '',
        model: effectiveModel(request?.model),
        stopReason: '',
        errorKind: kind,
        error: message,
        durationMs: 0,
        truncated: false,
        tools: [],
        credits: 0,
      }
      onEvent({ kind: 'error', message, errorKind: kind })
      onEvent({ kind: 'done', result: value })
      return value
    }
    if (cli === '') {
      return refuse(
        'cli-missing',
        process.platform === 'win32'
          ? 'kiro-cli is not installed or not on PATH. Set the plugin config cliPath to kiro-cli.exe.'
          : 'kiro-cli is not installed or not on PATH. Set the plugin config cliPath.',
      )
    }
    if (prompt.trim() === '') return refuse('empty-prompt', 'The prompt is empty.')
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      return refuse('prompt-too-large', 'The prompt is larger than the 256 KiB ceiling.')
    }

    const { args, useStdin } = buildChatArgs({ ...request, prompt })
    let sessionId = ''
    let model = effectiveModel(request?.model)
    const chunks = []
    let finalText = ''
    let stopReason = ''
    let status = ''
    let credits = 0
    let errorMessage = ''
    let errorKind = ''
    const toolCalls = new Map()

    onEvent({ kind: 'start', cwd, model, agent: effectiveAgent(request?.agent) })

    const result = await execKiro(cli, args, {
      cwd,
      timeoutMs:
        typeof request?.timeoutMs === 'number' && Number.isFinite(request.timeoutMs)
          ? Math.max(1_000, Math.floor(request.timeoutMs))
          : config.askTimeoutMs,
      signal: options.signal,
      stdinText: useStdin ? prompt : undefined,
      onLine: (line) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) return
        let event
        try {
          event = JSON.parse(trimmed)
        } catch {
          return
        }
        const type = typeof event?.type === 'string' ? event.type : ''
        if (type === 'runStarted') {
          onEvent({ kind: 'engine', engine: event.data?.engine ?? '' })
          return
        }
        if (type === 'runFinished') {
          const data = event.data ?? {}
          if (typeof data.sessionId === 'string') {
            sessionId = data.sessionId
            onEvent({ kind: 'session', sessionId })
          }
          if (typeof data.status === 'string') status = data.status
          if (typeof data.stopReason === 'string') stopReason = data.stopReason
          if (typeof data.finalText === 'string') finalText = data.finalText
          return
        }
        if (type === 'runError') {
          const data = event.data ?? {}
          errorMessage = typeof data.message === 'string' ? data.message : 'kiro-cli reported an error.'
          errorKind = classifyFailure(errorMessage)
          onEvent({ kind: 'error', message: errorMessage, errorKind })
          return
        }
        if (type !== 'sessionUpdate') return
        const update = event.data?.update ?? {}
        const session = event.data?.sessionId
        if (typeof session === 'string' && session !== '' && sessionId === '') {
          sessionId = session
          onEvent({ kind: 'session', sessionId })
        }
        if (update.sessionUpdate === 'agent_message_chunk') {
          const text = typeof update.content?.text === 'string' ? update.content.text : ''
          if (text !== '') {
            chunks.push(text)
            onEvent({ kind: 'delta', text })
          }
          return
        }
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          const id = String(update.toolCallId ?? '')
          const previous = toolCalls.get(id) ?? { id, title: '', kind: '', status: '' }
          const next = {
            ...previous,
            title:
              typeof update.title === 'string' && update.title !== '' ? update.title : previous.title,
            kind: typeof update.kind === 'string' && update.kind !== '' ? update.kind : previous.kind,
            status:
              typeof update.status === 'string' && update.status !== '' ? update.status : previous.status,
          }
          toolCalls.set(id, next)
          onEvent({ kind: 'tool', tool: next })
          return
        }
        if (update.sessionUpdate === 'session_info_update') {
          const kiroMeta = update._meta?.kiro ?? {}
          if (kiroMeta.kind === 'turn_completion') {
            const summary = Array.isArray(kiroMeta.promptTurnSummaries)
              ? kiroMeta.promptTurnSummaries[0]
              : undefined
            if (typeof summary?.usage === 'number') credits = summary.usage
            if (typeof kiroMeta.status === 'string' && kiroMeta.status !== '') status = kiroMeta.status
            onEvent({ kind: 'meta', credits, elapsedMs: kiroMeta.elapsedTime ?? null })
          }
          if (kiroMeta.kind === 'config_option_update') {
            // Not emitted by this CLI build; kept for older ones.
          }
          if (typeof update.title === 'string' && update.title !== '' && kiroMeta.kind === 'focus_update') {
            onEvent({ kind: 'title', title: update.title })
          }
        }
      },
    })

    const text = finalText !== '' ? finalText : chunks.join('')
    let error = errorMessage
    if (error === '' && result.spawnError !== undefined) {
      error = result.spawnError
      errorKind = classifyFailure(error)
    }
    if (error === '' && result.timedOut) {
      error = `kiro-cli did not finish within ${Math.round((result.durationMs || 0) / 1000)}s and was stopped.`
      errorKind = 'timeout'
    }
    if (error === '' && result.aborted) {
      error = 'Stopped by the user.'
      errorKind = 'aborted'
    }
    if (error === '' && result.code !== 0 && text === '') {
      const stderrText = result.stderr.trim()
      error = stderrText !== '' ? clampText(stderrText, 1_200) : `kiro-cli exited with code ${result.code}.`
      errorKind = classifyFailure(error)
    }
    const ok = error === '' && text !== ''
    if (!ok && error === '') {
      error = 'kiro-cli returned no answer.'
      errorKind = 'empty-answer'
    }

    const tools = [...toolCalls.values()]
      .filter((tool) => tool.title !== '' || tool.kind !== '')
      .map((tool) => ({
        title: tool.title,
        kind: tool.kind,
        status: tool.status,
      }))

    const value = {
      ok,
      action: 'ask',
      text,
      sessionId,
      model,
      stopReason,
      errorKind,
      error,
      durationMs: result.durationMs,
      truncated: result.truncatedStdout === true || status === 'error',
      tools,
      credits,
    }
    onEvent({ kind: 'done', result: value })
    return value
  }

  async function sessions(requestedCwd) {
    const cli = resolveCli()
    if (cli === '') return { ok: false, sessions: [], error: 'kiro-cli is not installed.' }
    const result = await execKiro(cli, ['chat', '--list-sessions', '--format', 'json'], {
      cwd: workingDirectory(requestedCwd),
      timeoutMs: config.probeTimeoutMs,
    })
    const payload = firstJsonLine(result.stdout)
    const items = []
    const envelopes = Array.isArray(payload) ? payload : payload === undefined ? [] : [payload]
    for (const envelope of envelopes) {
      const list = Array.isArray(envelope?.sessions) ? envelope.sessions : []
      for (const entry of list) {
        if (entry === null || typeof entry !== 'object') continue
        const id = typeof entry.sessionId === 'string' ? entry.sessionId : ''
        if (id === '') continue
        items.push({
          id,
          title: typeof entry.title === 'string' ? entry.title : '',
          status: typeof entry.status === 'string' ? entry.status : '',
          updatedAt:
            typeof entry.updatedAt === 'string'
              ? entry.updatedAt
              : typeof entry.updated_at === 'string'
                ? entry.updated_at
                : '',
        })
      }
    }
    if (payload === undefined) {
      return {
        ok: false,
        sessions: [],
        error: clampText(`${result.stdout}\n${result.stderr}`.trim(), 600),
      }
    }
    return { ok: true, sessions: items, error: '' }
  }

  return { config, resolveCli, status, ask, sessions }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** The Host's own admission decision, with a loopback-only structural fallback. */
function rejectionFor(ctx, request) {
  let connection
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    connection = undefined
  }
  if (connection !== undefined && connection !== null) {
    try {
      if (typeof connection.admit === 'function') {
        const admission = connection.admit(request)
        const status = admission !== null && typeof admission === 'object' ? admission.rejection : undefined
        return status === undefined ? undefined : status
      }
      if (typeof connection.requestRejection === 'function') {
        const status = connection.requestRejection(request)
        return status === undefined ? undefined : status
      }
    } catch {
      return 503
    }
  }
  const host = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : ''
  if (host !== '') {
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    if (name !== '127.0.0.1' && name !== 'localhost' && name !== '[::1]') return 403
    const origin = request.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      let parsed
      try {
        parsed = new URL(origin)
      } catch {
        return 403
      }
      if (parsed.host !== host && parsed.hostname !== name) return 403
    }
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return 403
  return undefined
}

function readBody(request, limit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectPromise(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolvePromise({})
        return
      }
      try {
        const value = JSON.parse(text)
        resolvePromise(value !== null && typeof value === 'object' ? value : {})
      } catch {
        rejectPromise(new Error('request body is not JSON'))
      }
    })
    request.on('error', rejectPromise)
  })
}

function mountRoutes(ctx, kiro) {
  const handler = async (request, response) => {
    const rejection = rejectionFor(ctx, request)
    if (rejection !== undefined) {
      sendJson(response, rejection, {
        error:
          rejection === 401
            ? 'DSH login required: reopen the URL the Harness printed at startup.'
            : 'This request came from an untrusted origin and was refused.',
      })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || '/' : '/'
    try {
      if (request.method === 'GET' && path === '/status') {
        sendJson(response, 200, await kiro.status(url.searchParams.get('refresh') === '1'))
        return
      }
      if (request.method === 'GET' && path === '/sessions') {
        sendJson(response, 200, await kiro.sessions(url.searchParams.get('cwd') ?? undefined))
        return
      }
      if (request.method === 'POST' && path === '/run') {
        const body = await readBody(request, MAX_PROMPT_BYTES + 16 * 1024)
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/x-ndjson; charset=utf-8',
          'x-accel-buffering': 'no',
        })
        const controller = new AbortController()
        const onClose = () => {
          controller.abort()
        }
        request.on('close', onClose)
        response.on('close', onClose)
        const write = (event) => {
          if (response.writableEnded) return
          try {
            response.write(`${JSON.stringify(event)}\n`)
          } catch {
            controller.abort()
          }
        }
        try {
          await kiro.ask(
            {
              prompt: body.prompt,
              model: body.model,
              agent: body.agent,
              cwd: body.cwd,
              resumeSessionId: body.resumeSessionId,
              trustTools: body.trustTools,
              timeoutMs: body.timeoutMs,
            },
            { onEvent: write, signal: controller.signal },
          )
        } catch (error) {
          write({
            kind: 'error',
            errorKind: 'failed',
            message: error instanceof Error ? error.message : String(error),
          })
        } finally {
          request.removeListener('close', onClose)
          response.removeListener('close', onClose)
          if (!response.writableEnded) response.end()
        }
        return
      }
      sendJson(response, 404, { error: `unknown route: ${path}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!response.headersSent) sendJson(response, 400, { error: clampText(message, 600) })
      else if (!response.writableEnded) response.end()
    }
  }
  return handler
}

function toolDefinition(kiro) {
  return {
    name: 'kiro_cli',
    description:
      'Run the locally installed Kiro CLI (kiro-cli) and return its answer. Use `status` first when the CLI may be signed out, `models` to choose a model, and `ask` to delegate a task to Kiro with its own tools, agents, and workspace. `ask` starts a fresh Kiro session unless `resumeSessionId` is given; the returned sessionId continues that conversation. Work happens in `cwd` (default: the Harness default working directory) and can change files there when `trustTools` allows it. The CLI enforces its own sign-in and usage limits, so failures come back in `error` with an `errorKind`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['ask', 'status', 'models', 'sessions'],
          description: 'ask = one chat turn; status = CLI version, sign-in and model summary; models = model list; sessions = saved Kiro sessions for the directory.',
        },
        prompt: {
          type: 'string',
          description: 'The instruction for Kiro. Required for `ask`; write it as a self-contained task because Kiro does not see this conversation.',
        },
        model: {
          type: 'string',
          description: 'Kiro model id such as `claude-sonnet-5` or `auto`. Omit for the plugin default.',
        },
        agent: {
          type: 'string',
          description: 'Kiro agent/context profile id. Omit for the CLI default agent.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute working directory for the Kiro run. Omit for the Harness default directory.',
        },
        trustTools: {
          type: 'string',
          description: 'Which Kiro tools may run without confirmation: a comma list such as `fs_read,fs_write`, an empty string for none (default), or `*` to trust every tool.',
        },
        resumeSessionId: {
          type: 'string',
          description: 'A sessionId returned by an earlier `ask` to continue that Kiro conversation.',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Ceiling for this run in milliseconds. Omit for the plugin default (10 minutes).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'ok',
          'action',
          'text',
          'sessionId',
          'model',
          'stopReason',
          'errorKind',
          'error',
          'durationMs',
          'truncated',
          'tools',
          'credits',
        ],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          text: { type: 'string' },
          sessionId: { type: 'string' },
          model: { type: 'string' },
          stopReason: { type: 'string' },
          errorKind: { type: 'string' },
          error: { type: 'string' },
          durationMs: { type: 'integer' },
          truncated: { type: 'boolean' },
          credits: { type: 'number' },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        if (value === null || typeof value !== 'object') {
          return [{ type: 'text', text: 'kiro_cli returned no result.' }]
        }
        if (value.ok !== true) {
          return [
            {
              type: 'text',
              text: `kiro_cli ${value.action} failed (${value.errorKind || 'failed'}): ${clampText(value.error, 2_000)}`,
            },
          ]
        }
        const meta = [
          value.model !== '' ? `model ${value.model}` : '',
          value.sessionId !== '' ? `session ${value.sessionId}` : '',
          typeof value.durationMs === 'number' ? `${Math.round(value.durationMs / 1000)}s` : '',
        ]
          .filter(Boolean)
          .join(' · ')
        const toolsLine = Array.isArray(value.tools) && value.tools.length > 0
          ? `\n\nKiro tools: ${value.tools.map((tool) => String(tool)).join(', ')}`
          : ''
        return [
          {
            type: 'text',
            text: `${clampText(value.text, 8_000)}${toolsLine}${meta !== '' ? `\n\n(${meta})` : ''}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : ''
      if (action === 'status') {
        const value = await kiro.status()
        const summary = [
          `cli ${value.cli.found ? value.cli.path : 'not found'}`,
          `version ${value.version || 'unknown'}`,
          `account ${value.account?.signedIn ? value.account.email || 'signed in' : 'not signed in'}`,
          `models ${Array.isArray(value.models) ? value.models.length : 0}`,
          `cwd ${value.cwd}`,
        ].join(' · ')
        return {
          ok: value.cli.found,
          action: 'status',
          text: summary,
          sessionId: '',
          model: '',
          stopReason: '',
          errorKind: value.cli.found ? '' : 'cli-missing',
          error: value.cli.found ? '' : 'kiro-cli was not found.',
          durationMs: 0,
          truncated: false,
          tools: [],
          credits: 0,
        }
      }
      if (action === 'models') {
        const value = await kiro.status()
        const list = Array.isArray(value.models) ? value.models : []
        return {
          ok: list.length > 0,
          action: 'models',
          text: list
            .map((model) => `${model.id}${model.contextWindow ? ` (${Math.round(model.contextWindow / 1000)}k)` : ''}`)
            .join('\n'),
          sessionId: '',
          model: '',
          stopReason: '',
          errorKind: list.length > 0 ? '' : 'failed',
          error: list.length > 0 ? '' : clampText(value.modelsError || 'No models were reported.', 600),
          durationMs: 0,
          truncated: false,
          tools: [],
          credits: 0,
        }
      }
      if (action === 'sessions') {
        const value = await kiro.sessions(args?.cwd)
        return {
          ok: value.ok,
          action: 'sessions',
          text: value.sessions
            .map((session) => `${session.id}${session.title ? ` — ${session.title}` : ''}`)
            .join('\n'),
          sessionId: '',
          model: '',
          stopReason: '',
          errorKind: value.ok ? '' : 'failed',
          error: value.error,
          durationMs: 0,
          truncated: false,
          tools: [],
          credits: 0,
        }
      }
      const result = await kiro.ask(
        {
          prompt: args?.prompt,
          model: args?.model,
          agent: args?.agent,
          cwd: args?.cwd,
          trustTools: args?.trustTools,
          resumeSessionId: args?.resumeSessionId,
          timeoutMs: args?.timeoutMs,
        },
        { signal: exec?.signal },
      )
      return {
        ...result,
        tools: result.tools.map((tool) =>
          [tool.title, tool.kind, tool.status].filter(Boolean).join(':'),
        ),
      }
    },
  }
}

export function apply(ctx, config) {
  const kiro = createKiro(config, {
    defaultCwd: () => {
      let directory = ''
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
        if (service !== undefined && typeof service.defaultDirectory === 'string') {
          directory = service.defaultDirectory
        }
      } catch {
        directory = ''
      }
      return directory !== '' ? directory : process.cwd()
    },
  })

  ctx.inject(['tools'], (scoped) => {
    scoped.effect(() => {
      const definition = toolDefinition(kiro)
      return scoped.tools.register(definition)
    }, 'kiro-cli: agent tool')
  })

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: PREFIX,
          handler: mountRoutes(scoped, kiro),
        }),
      'kiro-cli: http api',
    )
  })
}

// Local harness for the plugin's Host half: exercises createKiro without DSH.
import { createKiro } from '../index.js'

const kiro = createKiro(
  {
    cliPath: process.env.KIRO_CLI ?? '',
    trustTools: 'fs_read',
    askTimeoutMs: 180_000,
  },
  { defaultCwd: () => process.cwd() },
)

const step = process.argv[2] ?? 'status'
const started = Date.now()

if (step === 'status') {
  const value = await kiro.status(true)
  console.log(JSON.stringify({
    cli: value.cli,
    version: value.version,
    account: value.account,
    modelCount: value.models.length,
    firstModels: value.models.slice(0, 3),
    agentCount: value.agents.length,
    firstAgents: value.agents.slice(0, 3),
    cwd: value.cwd,
    modelsError: value.modelsError,
  }, null, 2))
}

if (step === 'sessions') {
  console.log(JSON.stringify(await kiro.sessions(), null, 2))
}

if (step === 'ask') {
  const events = []
  const result = await kiro.ask(
    { prompt: process.argv[3] ?? '鍥炵瓟鍙湁涓や釜瀛楋細鏀跺埌', model: 'claude-haiku-4.5' },
    { onEvent: (event) => { events.push(event.kind) } },
  )
  console.log(JSON.stringify({ result, eventKinds: events }, null, 2))
}

if (step === 'empty') {
  console.log(JSON.stringify(await kiro.ask({ prompt: '   ' }), null, 2))
}

console.log('elapsed ms', Date.now() - started)

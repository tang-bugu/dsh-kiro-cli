# dsh-kiro-cli

Bridge between DeepSeek Harness and a locally installed [Kiro CLI](https://kiro.dev)
(`kiro-cli`). It adds two things to the profile:

- a **sidebar entry and panel** for driving `kiro-cli` from the Harness Web UI;
- a **`kiro_cli` agent tool**, so the agent can hand a self-contained task to
  Kiro with its own tools, agents and workspace.

No build step and no dependencies: both halves are plain ES modules, and the
browser half takes React from the Harness module table.

## Install

Install the bundle from a checkout directory, pointed at this folder:

```text
plugin_manager install_bundle <path-to-this-folder>
```

or from the Harness Web UI: **Plugins → Add → install from a local directory**.
The bundle inserts one row (`kiro-cli`) into the profile and declares its
browser half on that same row, so the sidebar entry appears without restarting
the app.

To remove it, uninstall the `dsh-kiro-cli` bundle from the same page; the panel,
its route, and the tool disappear with it.

## Requirements

- `kiro-cli` installed and signed in (`kiro-cli whoami` must report an account).
- The CLI is found through `PATH`, then common install locations
  (`%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`, `~/.local/bin/kiro-cli`, …). Set
  `cliPath` when it lives somewhere else.

## Configuration

The bundle row in `cordis.patch.yml` takes an optional `config`:

| Key | Default | Meaning |
| --- | --- | --- |
| `cliPath` | autodetect | Absolute path to the executable. |
| `defaultModel` | CLI default | Model id used by the panel and the tool when none is given. |
| `defaultAgent` | CLI default | Agent/context profile id. |
| `trustTools` | `''` — trust nothing | Comma list such as `fs_read,fs_write`; `*` maps to `-a` (trust every tool). |
| `cwd` | Harness working directory | Working directory for runs. |
| `askTimeoutMs` | `600000` | Ceiling for one run; the process tree is killed on expiry. |
| `trustWorkspace` | `false` | Pass `--trust-workspace` (skip the folder-trust prompt). |

```yaml
- id: kiro-cli
  config:
    defaultModel: claude-sonnet-5
    trustTools: fs_read
```

The panel exposes the same choices per run; nothing is persisted from the UI.

## The `kiro_cli` tool

| `action` | Result |
| --- | --- |
| `status` | CLI path, version, signed-in account, model count, working directory. |
| `models` | Model ids with context windows. |
| `sessions` | Saved Kiro sessions for the directory. |
| `ask` | One Kiro turn; returns the answer, `sessionId`, model, duration, credits and the Kiro tools it used. |

`ask` needs `prompt`; `model`, `agent`, `cwd`, `trustTools`, `resumeSessionId`
and `timeoutMs` are optional. Kiro does not see the Harness conversation, so the
prompt must be self-contained; pass a returned `sessionId` back as
`resumeSessionId` to continue that Kiro conversation.

## How it works

Every run is one headless turn:

```
kiro-cli chat --no-interactive --output-format stream-json --model <id> --trust-tools=<list> "<prompt>"
```

The Host half parses the ACP JSON Lines stream (`agent_message_chunk`,
`tool_call`, `turn_completion`, `runFinished`, `runError`), classifies failures
(`sign-in-required`, `usage-limit`, `cli-missing`, `timeout`, …) and returns one
compact result. The browser half reads it from the plugin's own
`/api/kiro-cli/*` routes — admitted by the Harness `connection` service, with a
loopback-only fallback when that service is absent — and streams deltas into the
panel as they arrive. Long prompts (over 6 KB) travel on stdin to stay under the
Windows command-line limit.

## Tests

Both halves run outside DSH:

```powershell
node test\host.test.mjs     # tool + route registration, admission fence, NDJSON stream
node test\client.test.mjs   # panel mount, status fetch, streamed run, failed run
node test\live-probe.mjs status   # reads this machine's real kiro-cli
```

`test/mini-react.mjs` is a small React stand-in that renders the Client bundle's
component tree, so `client.test.mjs` can trigger the panel's own handlers.

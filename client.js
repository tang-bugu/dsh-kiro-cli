/**
 * Browser half of dsh-kiro-cli.
 *
 * Adds a sidebar row and the page it opens: a small console for the locally
 * installed `kiro-cli`. Everything is read from this package's own same-origin
 * `/api/kiro-cli/*` routes, served by the Host half in index.js — the plugin
 * keeps no private state in the browser beyond the current transcript.
 *
 * Hand-written ModuleLoader bundle: no build step, React comes from the shell,
 * and every colour comes from a theme token so light and dark both work.
 */
window.__ModuleLoader__.load({
  id: 'dsh-kiro-cli',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const {
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState,
    } = React

    const NS = 'kiroCli'
    const PANEL_ID = 'kiro-cli'

    // Resolved against the page base, so a reverse-proxied Harness under a path
    // prefix keeps its prefix instead of hitting the site root.
    const API = (() => {
      try {
        return new URL('api/kiro-cli', document.baseURI).pathname
      } catch {
        return '/api/kiro-cli'
      }
    })()

    const CSS = `
.kcli_host{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;padding:calc(28px + var(--dsh-frame-top-clearance,0px)) 24px 20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.kcli_page{display:flex;flex-direction:column;gap:14px;width:100%;max-width:920px;min-height:0;height:100%;margin:0 auto}
.kcli_head{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 16px;min-width:0}
.kcli_headMain{display:flex;align-items:center;gap:10px;min-width:0}
.kcli_mark{display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.kcli_titles{display:flex;flex-direction:column;min-width:0;gap:2px}
.kcli_title{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
.kcli_sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kcli_headTools{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kcli_btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap;transition:background-color .12s,border-color .12s,color .12s}
.kcli_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.kcli_btn:disabled{opacity:.5;cursor:not-allowed}
.kcli_btn[kcli-variant=primary]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base);font-weight:600}
.kcli_btn[kcli-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.06)}
.kcli_btn[kcli-variant=quiet]{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.kcli_btn[kcli-variant=quiet]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.kcli_row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-width:0}
.kcli_field{display:flex;flex-direction:column;gap:4px;min-width:0}
.kcli_label{font-size:11px;line-height:16px;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.kcli_input,.kcli_select{box-sizing:border-box;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;min-width:0}
.kcli_input:focus,.kcli_select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.kcli_input{width:100%}
.kcli_grow{flex:1 1 220px;min-width:160px}
.kcli_badge{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
.kcli_dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.kcli_dot[data-tone=ok]{background:var(--dsw-alias-state-success-primary)}
.kcli_dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}
.kcli_dot[data-tone=bad]{background:var(--dsw-alias-state-error-primary)}
.kcli_notice{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.kcli_notice strong{color:var(--dsw-alias-label-primary);font-weight:600}
.kcli_code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kcli_log{flex:1 1 auto;display:flex;flex-direction:column;gap:12px;min-height:120px;overflow:auto;padding:2px 2px 8px;scroll-behavior:smooth}
.kcli_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;flex:1;min-height:140px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.kcli_turn{display:flex;flex-direction:column;gap:8px}
.kcli_ask{align-self:flex-end;max-width:min(100%,620px);padding:8px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.kcli_answer{padding:12px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:21px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.kcli_answer[data-state=error]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary)}
.kcli_answer[data-state=pending]{color:var(--dsw-alias-label-secondary)}
.kcli_tools{display:flex;flex-wrap:wrap;gap:6px}
.kcli_tool{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kcli_meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.kcli_composer{display:flex;flex-direction:column;gap:8px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}
.kcli_editor{box-sizing:border-box;width:100%;min-height:76px;max-height:220px;resize:vertical;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.kcli_editor:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.kcli_composerRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.kcli_spacer{flex:1 1 auto}
.kcli_hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.kcli_error{color:var(--dsw-alias-state-error-primary)}
@media (max-width:640px){.kcli_host{padding:calc(20px + var(--dsh-frame-top-clearance,0px)) 14px 14px}}
`

    const DICT = {
      en: {
        nav: 'Kiro CLI',
        title: 'Kiro CLI bridge',
        subtitle: 'Runs this machine\u2019s kiro-cli and hands it to the agent as a tool.',
        refresh: 'Refresh',
        missing: 'kiro-cli was not found on this machine. Install it, or set the plugin\u2019s cliPath config to the executable\u2019s full path.',
        signedOut: 'kiro-cli is installed but not signed in. Run the login command in a terminal, then press Refresh.',
        loginHint: 'kiro-cli login',
        version: 'Version',
        account: 'Account',
        signedIn: 'Signed in',
        signedOutShort: 'Not signed in',
        model: 'Model',
        agent: 'Agent',
        cwd: 'Working directory',
        trust: 'Kiro tools',
        trustNone: 'None (read-only answers only)',
        trustRead: 'Read only',
        trustWrite: 'Read and write',
        trustAll: 'Trust every tool',
        resume: 'Continue session',
        resumeOn: 'Continuing {id}',
        newSession: 'New session',
        prompt: 'Ask Kiro',
        placeholder: 'Describe the task. Kiro does not see this conversation, so include what it needs.',
        run: 'Run',
        stop: 'Stop',
        running: 'Running',
        empty: 'No runs yet. Kiro answers appear here.',
        copy: 'Copy session id',
        copied: 'Copied',
        you: 'You',
        kiro: 'Kiro',
        failed: 'The run failed',
        kindSignIn: 'Sign-in required',
        kindUsage: 'Usage limit reached',
        kindMissing: 'kiro-cli not found',
        kindTimeout: 'Timed out',
        kindEmpty: 'Empty prompt',
        kindAborted: 'Stopped',
        credits: '{n} credits',
        duration: '{n}s',
        toolsUsed: 'Tools',
        defaultOption: 'CLI default',
        cwdHint: 'Absolute path. Leave blank to use the Harness working directory.',
        noModels: 'No models reported',
        unknown: 'unknown',
        panelHint: 'Runs headlessly with --no-interactive; each run is one Kiro turn.',
      },
      zh: {
        nav: 'Kiro CLI',
        title: 'Kiro CLI 桥接',
        subtitle: '调用本机 kiro-cli，并把它作为工具交给 Agent 使用。',
        refresh: '刷新',
        missing: '本机未找到 kiro-cli。请先安装，或在插件配置 cliPath 中填写可执行文件的完整路径。',
        signedOut: 'kiro-cli 已安装但未登录。请在终端执行登录命令，然后点击刷新。',
        loginHint: 'kiro-cli login',
        version: '版本',
        account: '账号',
        signedIn: '已登录',
        signedOutShort: '未登录',
        model: '模型',
        agent: 'Agent',
        cwd: '工作目录',
        trust: 'Kiro 工具权限',
        trustNone: '不允许（只作纯问答）',
        trustRead: '只读',
        trustWrite: '读写',
        trustAll: '信任全部工具',
        resume: '延续会话',
        resumeOn: '正在延续 {id}',
        newSession: '新会话',
        prompt: '向 Kiro 提问',
        placeholder: '描述任务。Kiro 看不到当前对话，请把必要背景写进来。',
        run: '运行',
        stop: '停止',
        running: '运行中',
        empty: '还没有运行记录，Kiro 的回答会显示在这里。',
        copy: '复制会话 ID',
        copied: '已复制',
        you: '你',
        kiro: 'Kiro',
        failed: '运行失败',
        kindSignIn: '需要登录',
        kindUsage: '额度已用尽',
        kindMissing: '未找到 kiro-cli',
        kindTimeout: '超时',
        kindEmpty: '提示词为空',
        kindAborted: '已停止',
        credits: '{n} 点额度',
        duration: '{n} 秒',
        toolsUsed: '工具',
        defaultOption: 'CLI 默认',
        cwdHint: '绝对路径。留空则使用 Harness 的工作目录。',
        noModels: '没有获取到模型列表',
        unknown: '未知',
        panelHint: '以 --no-interactive 无头方式运行，每次运行是一轮 Kiro 对话。',
      },
    }

    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active
        return typeof value === 'string' ? value : document.documentElement.lang || 'en'
      } catch {
        return 'en'
      }
    }

    function fill(template, values) {
      let text = template
      for (const [key, value] of Object.entries(values)) text = text.split('{' + key + '}').join(String(value))
      return text
    }

    function PanelMark(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M5 7.5h6.2a3.4 3.4 0 0 1 0 6.8H8.4a3.4 3.4 0 0 0 0 6.8H13',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 18.2, cy: 6.4, r: 2.1, fill: 'currentColor' }),
        h('circle', { cx: 17.4, cy: 17.4, r: 1.6, fill: 'currentColor', opacity: 0.7 }),
      )
    }

    async function readJson(response) {
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        payload = { error: text.slice(0, 300) }
      }
      if (!response.ok) throw new Error(payload?.error ?? 'HTTP ' + response.status)
      return payload
    }

    function StatusDot(props) {
      return h('span', { className: 'kcli_dot', 'data-tone': props.tone })
    }

    function buildModelOptions(status) {
      const models = Array.isArray(status?.models) ? status.models : []
      return models.map((model) => ({
        id: model.id,
        label: model.label && model.label !== model.id ? model.label + ' · ' + model.id : model.id,
      }))
    }

    function KiroPanel(props) {
      const { t, ctx } = props
      const [status, setStatus] = useState(undefined)
      const [statusError, setStatusError] = useState('')
      const [loading, setLoading] = useState(true)
      const [model, setModel] = useState('')
      const [agent, setAgent] = useState('')
      const [cwd, setCwd] = useState('')
      const [trust, setTrust] = useState('none')
      const [prompt, setPrompt] = useState('')
      const [turns, setTurns] = useState([])
      const [running, setRunning] = useState(false)
      const [sessionId, setSessionId] = useState('')
      const [continueSession, setContinueSession] = useState(false)
      const [copied, setCopied] = useState(false)
      const abortRef = useRef(undefined)
      const logRef = useRef(undefined)
      // The stream events arrive asynchronously and index into the turn they
      // belong to; a ref mirror keeps that index valid before React commits.
      const turnsRef = useRef(turns)
      const commitTurns = useCallback((change) => {
        const next = typeof change === 'function' ? change(turnsRef.current) : change
        turnsRef.current = next
        setTurns(next)
        return next
      }, [])

      const trustValue = useCallback(() => {
        if (trust === 'all') return '*'
        if (trust === 'write') return 'fs_read,fs_write'
        if (trust === 'read') return 'fs_read'
        return ''
      }, [trust])

      const loadStatus = useCallback(
        async (force) => {
          setLoading(true)
          setStatusError('')
          try {
            const query = force === true ? '?refresh=1' : ''
            const response = await fetch(API + '/status' + query, { redirect: 'error' })
            const payload = await readJson(response)
            setStatus(payload)
          } catch (error) {
            setStatusError(error instanceof Error ? error.message : String(error))
          } finally {
            setLoading(false)
          }
        },
        [],
      )

      useEffect(() => {
        void loadStatus(false)
      }, [loadStatus])

      useEffect(() => {
        const node = logRef.current
        if (node === undefined || node === null) return
        node.scrollTop = node.scrollHeight
      }, [turns])

      const updateTurn = useCallback(
        (index, patch) => {
          commitTurns((current) =>
            current.map((turn, position) =>
              position === index
                ? { ...turn, ...(typeof patch === 'function' ? patch(turn) : patch) }
                : turn,
            ),
          )
        },
        [commitTurns],
      )

      const stop = useCallback(() => {
        const controller = abortRef.current
        if (controller !== undefined) {
          try {
            controller.abort()
          } catch {
            /* already aborted */
          }
        }
      }, [])

      const run = useCallback(async () => {
        const text = prompt.trim()
        if (text === '' || running) return
        const controller = new AbortController()
        abortRef.current = controller
        setRunning(true)
        setCopied(false)
        const all = commitTurns((current) =>
          current.concat([
            {
              id: 'turn-' + Date.now(),
              prompt: text,
              answer: '',
              state: 'pending',
              tools: [],
              error: '',
              errorKind: '',
              model: model !== '' ? model : status?.config?.defaultModel ?? '',
              sessionId: '',
              credits: 0,
              durationMs: 0,
            },
          ]),
        )
        // Events for this run always address the turn this call appended, even
        // if another turn is added before the stream finishes.
        const index = all.length - 1
        setPrompt('')

        const apply = (event) => {
          if (event.kind === 'delta') {
            updateTurn(index, (turn) => ({ answer: turn.answer + event.text, state: 'pending' }))
            return
          }
          if (event.kind === 'session') {
            setSessionId(event.sessionId)
            updateTurn(index, { sessionId: event.sessionId })
            return
          }
          if (event.kind === 'tool') {
            updateTurn(index, (turn) => {
              const others = turn.tools.filter(
                (tool) => tool.title !== event.tool.title || tool.kind !== event.tool.kind,
              )
              return { tools: others.concat([event.tool]) }
            })
            return
          }
          if (event.kind === 'meta') {
            updateTurn(index, {
              credits: typeof event.credits === 'number' ? event.credits : 0,
            })
            return
          }
          if (event.kind === 'error') {
            updateTurn(index, {
              error: event.message,
              errorKind: event.errorKind ?? 'failed',
            })
            return
          }
          if (event.kind === 'done') {
            const result = event.result ?? {}
            updateTurn(index, {
              answer: typeof result.text === 'string' && result.text !== '' ? result.text : '',
              state: result.ok === true ? 'ok' : 'error',
              error: typeof result.error === 'string' ? result.error : '',
              errorKind: typeof result.errorKind === 'string' ? result.errorKind : '',
              model: typeof result.model === 'string' ? result.model : '',
              durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0,
              credits: typeof result.credits === 'number' ? result.credits : 0,
            })
            if (typeof result.sessionId === 'string' && result.sessionId !== '') setSessionId(result.sessionId)
          }
        }

        const handleLine = (line) => {
          const trimmed = line.trim()
          if (trimmed === '') return
          let event
          try {
            event = JSON.parse(trimmed)
          } catch {
            return
          }
          apply(event)
        }

        try {
          const response = await fetch(API + '/run', {
            method: 'POST',
            redirect: 'error',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: text,
              model,
              agent,
              cwd,
              trustTools: trustValue(),
              resumeSessionId: continueSession && sessionId !== '' ? sessionId : '',
            }),
            signal: controller.signal,
          })
          if (!response.ok) {
            const payload = await readJson(response).catch((error) => ({ error: String(error) }))
            throw new Error(payload?.error ?? 'HTTP ' + response.status)
          }
          if (response.body !== null && typeof response.body?.getReader === 'function') {
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              let cut
              while ((cut = buffer.indexOf('\n')) !== -1) {
                handleLine(buffer.slice(0, cut))
                buffer = buffer.slice(cut + 1)
              }
            }
            if (buffer.trim() !== '') handleLine(buffer)
          } else {
            const body = await response.text()
            for (const line of body.split('\n')) handleLine(line)
          }
        } catch (error) {
          const aborted = error instanceof Error && error.name === 'AbortError'
          updateTurn(index, {
            state: 'error',
            error: aborted ? t('kindAborted') : error instanceof Error ? error.message : String(error),
            errorKind: aborted ? 'aborted' : 'failed',
          })
        } finally {
          abortRef.current = undefined
          setRunning(false)
          updateTurn(index, (turn) =>
            turn.state === 'pending' && turn.error === ''
              ? { state: turn.answer === '' ? 'error' : 'ok', error: turn.answer === '' ? t('failed') : '' }
              : {},
          )
        }
      }, [
        agent,
        commitTurns,
        continueSession,
        cwd,
        model,
        prompt,
        running,
        sessionId,
        status,
        t,
        trustValue,
        updateTurn,
      ])

      const onKeyDown = (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void run()
        }
      }

      const copySession = () => {
        const value = sessionId
        if (value === '') return
        try {
          void navigator.clipboard?.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          setCopied(false)
        }
      }

      const cliFound = status?.cli?.found === true
      const signedIn = status?.account?.signedIn === true
      const modelOptions = useMemo(() => buildModelOptions(status), [status])
      const agentOptions = useMemo(() => {
        const list = Array.isArray(status?.agents) ? status.agents : []
        return list
      }, [status])
      const accountLabel = signedIn
        ? status.account.email !== ''
          ? status.account.email
          : t('signedIn')
        : t('signedOutShort')
      const tone = loading === true ? 'idle' : cliFound !== true ? 'bad' : signedIn === true ? 'ok' : 'warn'
      const stateLabel =
        loading === true
          ? '\u2026'
          : cliFound !== true
            ? t('kindMissing')
            : signedIn === true
              ? t('signedIn')
              : t('signedOutShort')
      const subtitle = loading === true
        ? '\u2026'
        : cliFound !== true
          ? t('missing')
          : t('version') + ' ' + (status?.version !== '' ? status.version : t('unknown')) + ' \u00b7 ' + accountLabel

      return h(
        'div',
        { className: 'kcli_host' },
        h(
          'div',
          { className: 'kcli_page' },
          h(
            'div',
            { className: 'kcli_head' },
            h(
              'div',
              { className: 'kcli_headMain' },
              h('span', { className: 'kcli_mark' }, h(PanelMark, { size: 20 })),
              h(
                'div',
                { className: 'kcli_titles' },
                h('h1', { className: 'kcli_title' }, t('title')),
                h('p', { className: 'kcli_sub' }, subtitle),
              ),
            ),
            h(
              'div',
              { className: 'kcli_headTools' },
              h(
                'span',
                { className: 'kcli_badge' },
                h(StatusDot, { tone }),
                stateLabel,
              ),
              sessionId !== ''
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'kcli_btn',
                      onClick: copySession,
                      title: sessionId,
                    },
                    copied ? t('copied') : t('copy'),
                  )
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'kcli_btn',
                  disabled: loading === true || running === true,
                  onClick: () => void loadStatus(true),
                },
                t('refresh'),
              ),
            ),
          ),
          statusError !== ''
            ? h('div', { className: 'kcli_notice kcli_error' }, statusError)
            : null,
          cliFound !== true && loading !== true
            ? h('div', { className: 'kcli_notice' }, h('span', null, t('missing')))
            : null,
          cliFound === true && signedIn !== true && loading !== true
            ? h(
                'div',
                { className: 'kcli_notice' },
                h(
                  'span',
                  null,
                  t('signedOut'),
                  ' ',
                  h('code', { className: 'kcli_code' }, t('loginHint')),
                ),
              )
            : null,
          h(
            'div',
            { className: 'kcli_row' },
            h(
              'label',
              { className: 'kcli_field kcli_grow' },
              h('span', { className: 'kcli_label' }, t('cwd')),
              h('input', {
                className: 'kcli_input',
                value: cwd,
                placeholder: status?.cwd ?? '',
                spellCheck: false,
                onChange: (event) => setCwd(event.target.value),
                title: t('cwdHint'),
              }),
            ),
            h(
              'label',
              { className: 'kcli_field' },
              h('span', { className: 'kcli_label' }, t('model')),
              h(
                'select',
                {
                  className: 'kcli_select',
                  value: model,
                  onChange: (event) => setModel(event.target.value),
                },
                h('option', { value: '' }, t('defaultOption')),
                modelOptions.map((option) =>
                  h('option', { key: option.id, value: option.id }, option.label),
                ),
              ),
            ),
            h(
              'label',
              { className: 'kcli_field' },
              h('span', { className: 'kcli_label' }, t('agent')),
              h(
                'select',
                {
                  className: 'kcli_select',
                  value: agent,
                  onChange: (event) => setAgent(event.target.value),
                },
                h('option', { value: '' }, t('defaultOption')),
                agentOptions.map((option) =>
                  h('option', { key: option.id, value: option.id }, option.id),
                ),
              ),
            ),
            h(
              'label',
              { className: 'kcli_field' },
              h('span', { className: 'kcli_label' }, t('trust')),
              h(
                'select',
                {
                  className: 'kcli_select',
                  value: trust,
                  onChange: (event) => setTrust(event.target.value),
                },
                h('option', { value: 'none' }, t('trustNone')),
                h('option', { value: 'read' }, t('trustRead')),
                h('option', { value: 'write' }, t('trustWrite')),
                h('option', { value: 'all' }, t('trustAll')),
              ),
            ),
          ),
          h(
            'div',
            { className: 'kcli_log', ref: logRef },
            turns.length === 0
              ? h('div', { className: 'kcli_empty' }, h(PanelMark, { size: 26 }), h('span', null, t('empty')))
              : turns.map((turn, index) =>
                  h(
                    'div',
                    { className: 'kcli_turn', key: turn.id ?? index },
                    h('div', { className: 'kcli_ask' }, turn.prompt),
                    h(
                      'div',
                      {
                        className: 'kcli_answer',
                        'data-state': turn.state === 'error' ? 'error' : turn.state,
                      },
                      turn.answer !== ''
                        ? turn.answer
                        : turn.state === 'error'
                          ? t('failed') + (turn.error !== '' ? ': ' + turn.error : '')
                          : h('span', null, t('running') + '\u2026'),
                    ),
                    turn.tools.length > 0
                      ? h(
                          'div',
                          { className: 'kcli_tools' },
                          turn.tools.map((tool, position) =>
                            h(
                              'span',
                              { className: 'kcli_tool', key: (tool.title || 'tool') + position },
                              h(StatusDot, { tone: tool.status === 'completed' ? 'ok' : 'warn' }),
                              (tool.title || tool.kind || 'tool') +
                                (tool.status !== '' && tool.status !== 'completed' ? ' \u00b7 ' + tool.status : ''),
                            ),
                          ),
                        )
                      : null,
                    turn.state === 'error' && turn.answer !== '' && turn.error !== ''
                      ? h('div', { className: 'kcli_meta kcli_error' }, turn.error)
                      : null,
                    h(
                      'div',
                      { className: 'kcli_meta' },
                      turn.model !== '' ? h('span', null, turn.model) : null,
                      turn.durationMs > 0
                        ? h('span', null, fill(t('duration'), { n: Math.round(turn.durationMs / 1000) }))
                        : null,
                      turn.credits > 0
                        ? h('span', null, fill(t('credits'), { n: Math.round(turn.credits * 100) / 100 }))
                        : null,
                      turn.sessionId !== ''
                        ? h('span', { title: turn.sessionId }, turn.sessionId.slice(0, 22))
                        : null,
                    ),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'kcli_composer' },
            h('textarea', {
              className: 'kcli_editor',
              value: prompt,
              placeholder: t('placeholder'),
              spellCheck: false,
              onChange: (event) => setPrompt(event.target.value),
              onKeyDown,
            }),
            h(
              'div',
              { className: 'kcli_composerRow' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'kcli_btn',
                  onClick: running ? stop : () => void run(),
                  'kcli-variant': running ? undefined : 'primary',
                  disabled: running !== true && (prompt.trim() === '' || cliFound !== true),
                },
                running === true ? t('stop') : t('run'),
              ),
              sessionId !== ''
                ? h(
                    'label',
                    { className: 'kcli_field', style: { flexDirection: 'row', alignItems: 'center', gap: '6px' } },
                    h('input', {
                      type: 'checkbox',
                      checked: continueSession,
                      onChange: (event) => setContinueSession(event.target.checked),
                    }),
                    h('span', { className: 'kcli_hint' }, t('resume')),
                  )
                : null,
              h('span', { className: 'kcli_spacer' }),
              h('span', { className: 'kcli_hint' }, t('panelHint')),
            ),
          ),
        ),
      )
    }

    function apply(ctx) {
      if (typeof ctx.locale?.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { en: DICT.en, zh: DICT.zh }), 'kiro-cli: dictionaries')
      }
      // Bound after the dictionaries exist, so the first render already resolves
      // localized text instead of briefly showing raw keys.
      const t =
        typeof ctx.locale?.bind === 'function'
          ? ctx.locale.bind(NS)
          : (key) => DICT.en[key] ?? key

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-kiro-cli')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'kiro-cli: styles')

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
          },
          () => h(KiroPanel, { t, ctx, locale: localeTag(ctx) }),
        ),
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 5,
            label: () => t('nav'),
            locale: NS,
          },
          (ownerProps = {}) => h(PanelMark, { size: ownerProps.size ?? 16 }),
        ),
      )
    }

    return {
      name: 'kiro-cli',
      inject: ['slots', 'locale'],
      apply,
    }
  },
})

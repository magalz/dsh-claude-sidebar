     /* Run button under shell code blocks. One click opens a fresh terminal tab in the
        session folder and types the fence's command there: no confirm step, the person's
        own permissions. The rail already requires 'slots' and 'sidebarRight'; the terminal
        service is optional and taken with a scoped injection so a host without terminals
        keeps the rest of the bundle and simply shows no Run button. */

     /** The fence slot the shipped markdown renderer exposes (kind 'hoc', scope 'session'). */
     const SLOT = 'conversation.chat.markdown.fence'
     /** One registration id shared by every runnable key, like the shipped diff/patch layers. */
     const LAYER_ID = 'dsh-claude-sidebar/fence/run'
     const DEADLINE_MS = 15_000
     const PROMPT_WAIT_MS = 1_500
     const SENT_MS = 2_000

     /** The exact fence keys that run, and the shell family each one asks for. */
     const RUN_LANGS = {
       bash: 'posix', sh: 'posix', shell: 'posix', zsh: 'posix', console: 'posix',
       powershell: 'powershell', pwsh: 'powershell', ps1: 'powershell',
       cmd: 'cmd', bat: 'cmd',
     }
     const RUN_KEYS = Object.keys(RUN_LANGS)
     const POSIX_OK = ['bash', 'sh', 'zsh', 'fish']
     const POSIX_LISTED = ['bash', 'zsh', 'sh']
     const POWERSHELL_OK = ['pwsh', 'powershell']

     /** The inline styles: the Refresh button's size/border, plus the button row. */
     const S = {
       wrap: { display: 'flex', flexDirection: 'column', gap: 4 },
       row: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
       run: {
         display: 'inline-flex',
         alignItems: 'center',
         flex: 'none',
         padding: '2px 8px',
         borderRadius: 6,
         border: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2))',
         background: 'transparent',
         color: 'var(--dsw-alias-label-primary, inherit)',
         font: 'inherit',
         fontSize: 11.5,
         cursor: 'pointer',
       },
       busy: { opacity: 0.6, cursor: 'default' },
       glyph: { fontSize: 10, lineHeight: 1, marginRight: 4 },
       error: { color: 'var(--dsw-alias-state-error-primary, #d64545)', fontSize: 11 },
     }

     /**
      * The shell family a fence language runs in, or null for every other language.
      * @param {string} lang
      * @returns {'posix' | 'powershell' | 'cmd' | null}
      */
     function runFamily(lang) {
       const key = String(lang).toLowerCase()
       return Object.hasOwn(RUN_LANGS, key) ? RUN_LANGS[key] : null
     }

     /** A discovered shell's basename without '.exe', lower-cased, on either separator. */
     function shellBase(path) {
       if (typeof path !== 'string') return ''
       const normalized = path.replace(/\\/gu, '/')
       const base = normalized.slice(normalized.lastIndexOf('/') + 1)
       return base.replace(/\.exe$/iu, '').toLowerCase()
     }

     /** Plain bash on PATH can resolve to WSL first, where the Windows tools are missing. */
     function isWslBash(path) {
       if (typeof path !== 'string') return false
       const normalized = path.replace(/\\/gu, '/').toLowerCase()
       return normalized.includes('/windows/system32/bash.exe') || normalized.includes('/windowsapps/bash.exe')
     }

     /**
      * Choose the shell path for a family: the remembered choice when it already fits,
      * else the first discovered shell that fits, else the remembered choice again.
      * @param {'posix' | 'powershell' | 'cmd' | null} family
      * @param {{ path: string }[]} shells
      * @param {string} selectedShell
      * @returns {string | undefined}
      */
     function pickShell(family, shells, selectedShell) {
       const list = Array.isArray(shells) ? shells : []
       const selected = typeof selectedShell === 'string' && selectedShell !== '' ? selectedShell : undefined
       const base = shellBase(selected)
       if (family === 'posix') {
         if (POSIX_OK.includes(base)) return selected
         for (const entry of list) {
           const path = entry && entry.path
           if (POSIX_LISTED.includes(shellBase(path)) && !isWslBash(path)) return path
         }
         return selected
       }
       if (family === 'powershell') {
         if (POWERSHELL_OK.includes(base)) return selected
         for (const wanted of POWERSHELL_OK) {
           for (const entry of list) {
             if (shellBase(entry && entry.path) === wanted) return entry.path
           }
         }
         return selected
       }
       if (family === 'cmd') {
         for (const entry of list) {
           if (shellBase(entry && entry.path) === 'cmd') return entry.path
         }
       }
       return selected
     }

     /** Only `$ ` and `> ` lines of a console transcript are commands; the rest is output. */
     const PROMPT = /^[$>][ \t]/u

     /**
      * The bytes an Enter key sends: trailing whitespace removed, line breaks turned into
      * '\r' and one final '\r'. Console fences contribute only their prompt lines.
      * @param {string} lang
      * @param {string} code
      * @returns {string}
      */
     function commandText(lang, code) {
       if (typeof code !== 'string') return ''
       let lines = code.replace(/\r\n?/gu, '\n').split('\n')
       if (lang === 'console') {
         lines = lines.filter(line => PROMPT.test(line)).map(line => line.replace(PROMPT, ''))
       }
       const text = lines.join('\n').replace(/\s+$/u, '').replace(/\n/gu, '\r')
       return text === '' ? '' : text + '\r'
     }

     const TIMEOUT = () => new Error('timed out waiting for the terminal')
     const LIMIT = () => new Error('This session already has the maximum number of terminals; close one and try again.')
     const TOO_LONG = () => new Error('The command is too long to send to a terminal.')

     /**
      * Wait for the terminal's prompt, then type once. TerminalView.state is a
      * SnapshotStore: the listener gets no arguments and the snapshot is read on every
      * notification (and once right after subscribing, for a prompt already present).
      * A connected+writable state arms a 1.5 s fallback; the first output frame writes
      * immediately. A failed/closed phase, the session terminal limit or the deadline
      * fails the run without writing. The written guard makes a connected -> disconnected ->
      * connected flip still produce exactly one write.
      */
     function waitAndWrite(view, text, options) {
       return new Promise(resolve => {
         const { now, setTimer, clearTimer, deadline } = options
         const snapshot = () => view.state.getSnapshot()
         let off = null
         let settleId = null
         let deadlineId = null
         let ready = false
         let written = false

         const cleanup = () => {
           if (settleId !== null) clearTimer(settleId)
           if (deadlineId !== null) clearTimer(deadlineId)
           if (off !== null) off()
         }
         const fail = error => {
           if (written) return
           cleanup()
           resolve({ ok: false, error })
         }
         const write = () => {
           if (written) return
           if (now() >= deadline) return fail(TIMEOUT())
           const state = snapshot()
           const max = state && state.environment && state.environment.maxInputBytes
           if (typeof max === 'number' && new TextEncoder().encode(text).byteLength > max) return fail(TOO_LONG())
           written = true
           cleanup()
           try {
             view.write(text, true)
             resolve({ ok: true })
           } catch (error) {
             resolve({ ok: false, error })
           }
         }
         const armSettle = () => {
           if (settleId === null) settleId = setTimer(write, PROMPT_WAIT_MS)
         }
         const onState = state => {
           if (written) return
           if (now() >= deadline) return fail(TIMEOUT())
           if (state && state.issue === 'terminalLimit') return fail(LIMIT())
           const phase = state && state.phase
           if (phase === 'failed' || phase === 'closed') {
             return fail(new Error(state.error || 'the terminal ' + phase))
           }
           if (phase !== 'connected' || !state.writable) return
           if (!ready) {
             ready = true
             armSettle()
           }
           const frame = state.render && state.render.frame
           if (frame && frame.type === 'output') {
             if (settleId !== null) {
               clearTimer(settleId)
               settleId = null
             }
             write()
           }
         }

         deadlineId = setTimer(() => fail(TIMEOUT()), Math.max(0, deadline - now()))
         try {
           off = view.state.subscribe(() => onState(snapshot()))
           onState(snapshot())
         } catch (error) {
           fail(error)
         }
       })
     }

     /**
      * Open a new terminal tab in the session and type the fence command into its own
      * view. Never calls view.mount(): the tab body mounts the shared instance, and a
      * second mount's detach would cut the tab's attachment.
      * @param {{ sidebarRight: object, webTerminals: object, now?: Function, setTimeout?: Function, clearTimeout?: Function }} deps
      * @param {{ sessionId: string, lang: string, code: string }} task
      * @returns {Promise<{ ok: true } | { ok: false, error: * }>}
      */
     async function runInTerminal(deps, { sessionId, lang, code }) {
       const { sidebarRight, webTerminals } = deps
       if (!sidebarRight || !webTerminals) {
         return { ok: false, error: new Error('the terminal services are not available') }
       }
       const now = deps.now || (() => Date.now())
       const setTimer = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms))
       const clearTimer = deps.clearTimeout || (id => clearTimeout(id))
       const text = commandText(lang, code)
       if (text === '') return { ok: false, error: new Error('there is no command to run') }
       const deadline = now() + DEADLINE_MS
       const controller = typeof AbortController === 'function' ? new AbortController() : null

       let shellPath
       try {
         const shells = await webTerminals.launchShells(sessionId, controller ? controller.signal : undefined)
         shellPath = pickShell(runFamily(lang), shells && shells.shells, shells && shells.selectedShell)
       } catch (error) {
         // No shell lookup: fall back to the remembered/default shell.
         shellPath = undefined
       }
       if (now() >= deadline) return { ok: false, error: new Error('timed out waiting for the terminal') }

       let before = []
       try {
         before = sidebarRight.tabsIn(sessionId) || []
       } catch (error) {
         return { ok: false, error }
       }
       const beforeIds = new Set(before.map(tab => tab.id))
       let tab
       try {
         sidebarRight.openTabIn(sessionId, 'terminal', { params: { shellPath } })
         const after = sidebarRight.tabsIn(sessionId) || []
         tab = after.find(candidate => !beforeIds.has(candidate.id))
       } catch (error) {
         return { ok: false, error }
       }
       if (!tab) return { ok: false, error: new Error('the new terminal tab did not appear') }

       let view
       try {
         view = webTerminals.view(sessionId, tab.id, tab.contentId, undefined, shellPath)
       } catch (error) {
         return { ok: false, error }
       }
       return waitAndWrite(view, text, { now, setTimer, clearTimer, deadline })
     }

     /**
      * Build the fence layer with handles fixed at mount: the slot passes no inject hook,
      * so every dependency (including the fake timer/run seam for tests) is closed over.
      */
     function createRunFenceLayer(deps) {
       const run = deps.run || runInTerminal
       const later = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms))
       const clear = deps.clearTimeout || (id => clearTimeout(id))
       return function RunFenceLayer(props) {
         const { lang, code, streaming, children, sessionId } = props
         const [phase, setPhase] = useState('idle')
         const [error, setError] = useState('')
         const busy = React.useRef(false)
         const mounted = React.useRef(true)
         const sentId = React.useRef(null)
         const clearSent = () => {
           if (sentId.current !== null) {
             clear(sentId.current)
             sentId.current = null
           }
         }
         React.useEffect(() => {
           // A remount (StrictMode, a hidden-then-shown subtree) runs this again after the cleanup.
           mounted.current = true
           return () => {
             mounted.current = false
             clearSent()
           }
         }, [])
         const click = () => {
           if (busy.current) return
           busy.current = true
           setPhase('opening')
           setError('')
           Promise.resolve(run(deps, { sessionId, lang, code })).then(result => {
             busy.current = false
             if (!mounted.current) return
             if (result && result.ok) {
               setPhase('sent')
               sentId.current = later(() => {
                 sentId.current = null
                 if (mounted.current) setPhase('idle')
               }, SENT_MS)
             } else {
               setPhase('idle')
               setError(result && result.error ? messageOf(result.error) : 'the command could not be run')
             }
           })
         }
         const canRun = !streaming && typeof sessionId === 'string' && sessionId !== '' &&
           runFamily(lang) !== null && commandText(lang, code) !== ''
         return h('div', { style: S.wrap },
           children,
           canRun
             ? h('div', { style: S.row },
                 h('button', {
                   type: 'button',
                   style: phase === 'opening' ? { ...S.run, ...S.busy } : S.run,
                   onClick: click,
                   'aria-label': 'Run in a new terminal',
                   title: 'Run in a new terminal',
                   'aria-disabled': phase === 'opening' ? 'true' : undefined,
                 },
                   h('span', { 'aria-hidden': 'true', style: S.glyph }, '▶'),
                   phase === 'opening' ? 'Opening…' : phase === 'sent' ? 'Sent' : 'Run'
                 ),
                 error ? h('span', { role: 'status', style: S.error }, error) : null
               )
             : null
         )
       }
     }

     /** Mount the feature: take the optional terminal service, then register one layer per key. */
     function mount(ctx) {
       if (typeof ctx.inject !== 'function') return
       try {
         ctx.inject(['webTerminals'], inner => {
           const found = inner.webTerminals
           if (!found || typeof found.launchShells !== 'function' || typeof found.view !== 'function') {
             console.warn('dsh-claude-sidebar: Run button: terminal service has an unexpected shape')
             return undefined
           }
           const layer = createRunFenceLayer({ sidebarRight: ctx.sidebarRight, webTerminals: found })
           const dispose = []
           for (const key of RUN_KEYS) {
             dispose.push(ctx.effect(() => ctx.slots.inject(SLOT, () =>
               ctx.slots.register({ name: SLOT, id: LAYER_ID, key }, layer)
             ), 'run button: ' + key))
           }
           return () => {
             for (const stop of dispose) if (typeof stop === 'function') stop()
           }
         })
       } catch (error) {
         console.warn('dsh-claude-sidebar: Run button: webTerminals is unavailable', error)
       }
     }

     registerFeature({ name: 'run', inject: ['slots', 'sidebarRight'], mount })

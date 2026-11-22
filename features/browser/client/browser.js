      /* Browser-open tool view: the chat row for the open_in_browser tool. The Host asks
         the person's dsh window to show a URL in a Browser tab; this part draws the one-line
         row and opens the tab once for a live call, with an Open button to reopen it. */

      const BROWSER_SLOT = 'tool.call.toolview'
      const BROWSER_KEYS = ['open_in_browser', 'mcp__dsh__open_in_browser']
      const BROWSER_OPENED_KEY = 'dsh-claude-sidebar.browser-opened.v1'
      const BROWSER_OPENED_MAX = 200
      const BROWSER_MAX_URL = 16 * 1024
      /** Ids opened in this window, hydrated from localStorage so a reload cannot reopen them. */
      const BROWSER_OPENED = new Set()
      let BROWSER_HYDRATED = false
      /** Only tokens the other parts already use, each with the same plain fallback. */
      const BROWSER_PRIMARY = 'var(--dsw-alias-label-primary, inherit)'
      const BROWSER_SECONDARY = 'var(--dsw-alias-label-secondary, inherit)'
      const BROWSER_BORDER = 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2))'
      const BROWSER_ERROR = 'var(--dsw-alias-state-error-primary, #d64545)'

      const BRS = {
        row: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          fontSize: 13,
          lineHeight: '18px',
          color: BROWSER_SECONDARY,
        },
        glyph: { flex: 'none', width: 14, textAlign: 'center' },
        label: { flex: 'none' },
        labelError: { flex: 'none', color: BROWSER_ERROR },
        host: {
          flex: '0 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: BROWSER_PRIMARY,
        },
        /* The Environment Refresh button's look, reused for the on-demand Open action. */
        open: {
          flex: 'none',
          padding: '2px 8px',
          borderRadius: 6,
          border: '1px solid ' + BROWSER_BORDER,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: 11.5,
          cursor: 'pointer',
        },
      }

      /** The app origin the Browser tab refuses, read lazily and defensively. */
      function browserApplicationOrigin() {
        try {
          if (typeof document === 'undefined' || document === null || document.location == null) return undefined
          const origin = document.location.origin
          return typeof origin === 'string' && origin !== '' && origin !== 'null' ? origin : undefined
        } catch (error) {
          return undefined
        }
      }

      /**
       * Mirror the Browser tab's own address rule (url.ts:25-44): trim, cap at 16 KiB,
       * add https:// when there is no scheme, parse with URL, refuse credentials,
       * anything that is not http(s), and the application's own origin. Parts cannot
       * import url.ts, so this is a copy.
       * @param {unknown} input
       * @param {string | undefined} applicationOrigin
       * @returns {{ url: string, host: string } | null}
       */
      function browserTarget(input, applicationOrigin) {
        if (typeof input !== 'string') return null
        const trimmed = input.trim()
        if (trimmed === '' || trimmed.length > BROWSER_MAX_URL) return null
        const explicit = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u.test(trimmed)
        const candidate = explicit ? trimmed : 'https://' + trimmed
        let url
        try {
          url = new URL(candidate)
        } catch (error) {
          return null
        }
        if (url.username !== '' || url.password !== '') return null
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
        if (applicationOrigin !== undefined) {
          try {
            if (url.origin === new URL(applicationOrigin).origin) return null
          } catch (error) {
            /* An unavailable application origin cannot grant access to a target. */
          }
        }
        return { url: url.href, host: url.hostname }
      }

      /** localStorage in a try/catch: an unavailable store must never break the row. */
      function browserStore() {
        try {
          return typeof localStorage === 'undefined' ? null : localStorage
        } catch (error) {
          return null
        }
      }

      /** Read the persisted ids once per window, on the first settled browser view. */
      function ensureBrowserOpened() {
        if (BROWSER_HYDRATED) return
        BROWSER_HYDRATED = true
        const store = browserStore()
        if (store === null) return
        try {
          const parsed = JSON.parse(store.getItem(BROWSER_OPENED_KEY) ?? '[]')
          if (Array.isArray(parsed)) {
            const recent = parsed.slice(-BROWSER_OPENED_MAX)
            for (const id of recent) if (typeof id === 'string') BROWSER_OPENED.add(id)
          }
        } catch (error) {
          /* Disabled storage or a corrupt value: start with an empty set. */
        }
      }

      /** Remember one auto-opened id in memory and in the capped, best-effort list. */
      function markBrowserOpened(callId) {
        BROWSER_OPENED.add(callId)
        const store = browserStore()
        if (store === null) return
        try {
          let ids = []
          try {
            const parsed = JSON.parse(store.getItem(BROWSER_OPENED_KEY) ?? '[]')
            if (Array.isArray(parsed)) ids = parsed.filter(id => typeof id === 'string')
          } catch (error) {
            ids = []
          }
          if (!ids.includes(callId)) ids.push(callId)
          if (ids.length > BROWSER_OPENED_MAX) ids = ids.slice(ids.length - BROWSER_OPENED_MAX)
          store.setItem(BROWSER_OPENED_KEY, JSON.stringify(ids))
        } catch (error) {
          /* The in-memory set still guards this window; the list is only a reload hint. */
        }
      }

      /** Open the tab at click or settle time, never at render time; sidebarRight is a
       *  service that may not have been present when the view was constructed. Returns
       *  whether the sidebar accepted the open, so a refused one stays unmarked. */
      function openBrowserTab(ctx, sessionId, url) {
        const sidebar = serviceOf(ctx, 'sidebarRight')
        if (sidebar === undefined || sidebar === null) return false
        try {
          if (typeof sidebar.openTabIn === 'function') {
            sidebar.openTabIn(sessionId, 'browser', { params: { url } })
            return true
          }
          if (typeof sidebar.openTab === 'function') {
            sidebar.openTab('browser', { params: { url } })
            return true
          }
        } catch (error) {
          console.warn('browser open: the sidebar could not open the tab', error)
        }
        return false
      }

      /** The chat only opens a Browser tab when that tab type is registered. */
      function browserTabType(ctx) {
        const tabs = serviceOf(ctx, 'sidebarRightTabs')
        return tabs !== undefined && tabs !== null && typeof tabs.get === 'function' ? tabs.get('browser') : undefined
      }

      /** A subagent chat's session is not the one on screen until its store is adopted. */
      function browserSessionOnScreen(ctx, sessionId) {
        const sidebar = serviceOf(ctx, 'sidebarRight')
        const mounted = sidebar === undefined || sidebar === null ? undefined : sidebar.mounted
        return mounted !== undefined && mounted !== null && typeof mounted.getSnapshot === 'function'
          ? mounted.getSnapshot() === sessionId
          : false
      }

      /** One view per tool name, closing over ctx so the service is read at open time. */
      function browserToolView(ctx) {
        return function BrowserToolView(props) {
          const { callId, toolName, phase, block, sessionId, useSession } = props
          const settled = block !== null && typeof block === 'object' && 'kind' in block
          const callFailed = settled && (block.isError === true || (block.error !== undefined && block.error !== null))
          /* A preparing call carries a lazy `args` view and no `argsRaw`; only started
             and settled calls carry the raw JSON string, as the chat blocks do. */
          const rawArgs = settled ? (block.call?.argsRaw ?? '') : (block?.argsRaw ?? '')
          let target = null
          try {
            const args = JSON.parse(rawArgs)
            if (args !== null && typeof args === 'object') target = browserTarget(args.url, browserApplicationOrigin())
          } catch (error) {
            /* Truncated JSON stays visible until the call completes. */
          }
          const url = target === null ? null : target.url
          const host = target === null ? '' : target.host

          /* Without the Browser tab type the chat itself would not open one; say so
             instead of offering a button that silently does nothing. */
          const browserType = browserTabType(ctx)
          const failed = callFailed || (settled && (url === null || browserType === undefined))

          /* Liveness is fixed on the first sight of this call, as the spec requires.
             A lazy useState initializer keeps that first sight across re-renders. */
          const running = typeof useSession === 'function' ? !!useSession(state => state.running) : false
          const [first] = useState(() => ({ phase, running }))
          const live = first.phase === 'preparing' || first.phase === 'start' || first.running

          useEffect(() => {
            if (!settled || callFailed || url === null || typeof callId !== 'string') return
            ensureBrowserOpened()
            if (!live) {
              /* First seen as history: pin it so it cannot open later, even if the
                 session starts running or the row remounts in the meantime. */
              if (!BROWSER_OPENED.has(callId)) markBrowserOpened(callId)
              return
            }
            if (BROWSER_OPENED.has(callId) || browserType === undefined) return
            if (!browserSessionOnScreen(ctx, sessionId)) return
            if (openBrowserTab(ctx, sessionId, url)) markBrowserOpened(callId)
          }, [callId, settled, callFailed, url, live, browserType, sessionId])

          const label = failed ? 'Could not open' : settled ? 'Opened in Browser' : 'Opening…'
          const state = failed
            ? 'failed'
            : phase === 'preparing'
              ? 'preparing'
              : settled
                ? 'opened'
                : 'opening'
          const disabled = url === null || browserType === undefined
          return h(
            'div',
            {
              style: BRS.row,
              'data-tool': toolName === undefined ? 'open_in_browser' : toolName,
              'data-state': state,
            },
            h('span', { style: BRS.glyph, 'aria-hidden': 'true' }, '🌐'),
            h('span', { style: failed ? BRS.labelError : BRS.label }, label),
            host === '' ? null : h('span', { style: BRS.host, title: url }, host),
            h(
              'button',
              {
                type: 'button',
                style: BRS.open,
                disabled,
                'aria-disabled': disabled ? 'true' : undefined,
                onClick: () => {
                  if (!disabled) openBrowserTab(ctx, sessionId, url)
                },
              },
              'Open',
            ),
          )
        }
      }

      function mountBrowser(ctx) {
        const View = browserToolView(ctx)
        for (const key of BROWSER_KEYS) {
          ctx.effect(
            () => ctx.slots.inject(BROWSER_SLOT, () => ctx.slots.register({ name: BROWSER_SLOT, key }, View)),
            'browser open: ' + key,
          )
        }
      }

      registerFeature({ name: 'browser', inject: ['slots', 'sidebarRight'], mount: mountBrowser })

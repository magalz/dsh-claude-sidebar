    /* Environment group 1/4 — environment-base.js: API header, shared constants and S styles. */
    /*
     * The Environment tab: a right-sidebar column that shows, in the style of the Claude
     * desktop environment panel, where the open session runs and what surrounds it: the
     * machine, the folder and branch, the context use, the working tree's changes, the
     * pull requests, the app-wide connectors and the tracker facts. Four collapsible
     * sections can be reordered with the pointer or the keyboard, and the order and the
     * collapsed state survive a remount through localStorage. It fetches this plugin's
     * Host route /dsh-claude-sidebar/environment and renders the answer, asks the
     * dsh-oh-my-claude plugin for a Claude session's context breakdown when that route
     * exists, and types and sends /compact when the user clicks Compact session, so it
     * is not strictly read-only. A failed or closed connector row also offers Reconnect
     * when the Host's MCP manager is reachable, and a row waiting for a credential offers
     * Sign in when the Remote credential service is reachable. This file opens the Environment
     * group of client.js (environment-base, -context, -connectors, -settings, environment.js),
     * whose five files scripts/build-client.mjs concatenates into one block inside the module factory.
     *
     * dsh APIs used (0.2.2-rc.5):
     *   ctx.sidebarRightTabs.register(...)            dsh-client-ui-sidebar-right README.md:85
     *   ctx.slots.inject / ctx.slots.register(...)    README.md:86; dsh-rightbar-quicknav client.js:1170-1177
     *   slot "sidebar.right.pane.tab" body props      README.md:86 (sessionId, useTabInfo, useProjection);
     *                                                  tab-info.ts:29-33 reads standard.sessionId
     *   ctx.inject(['remote', '<service>'], ...)      scoped injection: declare the namespace
     *                                                  and every service read from it (Cordis 4.1
     *                                                  refuses undeclared reads); call it directly,
     *                                                  not inside ctx.effect — it returns a Fiber,
     *                                                  and Cordis runs its callback's cleanup when
     *                                                  the service goes or the plugin disposes.
     *                                                  dsh-mcp-client src/server-context.ts:28-31;
     *                                                  the Remote namespace comes from
     *                                                  @deepseek-ai/dsh-api-remotes
     *   ctx.remote.mcpManager.restart(name)           dsh-mcp-manager src/index.ts:347-355
     *   ctx.remote.credentials.set(name, value)       dsh-client-ui-settings-models
     *                                                  src/client/operations.ts:79; storing a
     *                                                  credential re-resolves and reconnects the
     *                                                  MCP client by itself (dsh-mcp-client
     *                                                  src/connection.ts:239-280) — no restart.
     *   contextPressure projection                   dsh-client-ui-sidebar-right contract/slots.ts:170-173;
     *                                                  the app's own meter uses the same formula
     *   contextBreakdown projection                  the same projection contract (systemTokens,
     *                                                  toolsTokens, messageTokens of the next prompt)
     *   props.useInput / props.inputActions           dsh-client-ui-conversation contract/input.ts:264-326
     *                                                  (draft, attachmentIds, phase; setDraft, submit)
     *   props.useSessionStatus                        dsh-client-ui-conversation session store; the
     *                                                  subagents tab reads the same session-id map
     *   GET /dsh-oh-my-claude/context?session=<id>    the dsh-oh-my-claude plugin's route (MIT,
     *                                                  Copyright (c) 2026 lcestou); same origin
     *   ctx.effect(...)                               dsh-plan-note lib/client.js:590-607
     *   same-origin fetch                             dsh-session-console lib/client.js:381-397
     *   12 s poll, visibility-guarded                 dsh-session-console lib/client.js:583-594
     *   theme tokens with fallbacks                   dsh-rightbar-quicknav client.js:1115-1116;
     *                                                  dsh-doc references/practices.md:34
     * No plugin opens external links itself (dsh-plan-note, dsh-rightbar-quicknav and
     * dsh-session-console have no such call), so a card or a pull request is a plain anchor
     * with target="_blank" rel="noreferrer".
     */

    /** This implementation's identity; also the key its body registers under. */
    const TAB_ID = 'dsh-claude-sidebar/environment'
    /** The type openTab() names. */
    const KIND = 'claude-sidebar-environment'
    const SLOT = 'sidebar.right.pane.tab'
    const ROUTE = '/dsh-claude-sidebar/environment'
    const REFRESH_MS = 12_000
    /** The most change rows the tab lists; the rest becomes one "and n more" note. */
    const MAX_CHANGE_ROWS = 50
    /** The most connector rows the section shows before its Show more button. */
    const MAX_CONNECTOR_ROWS = 3
    /** The sentence a pinned connector row carries in its title. */
    const PINNED_NOTE = 'Pinned servers come from the profile; their live state is not reported.'
    /** The Connectors section's Reconnect action and the most error either action shows. */
    const RECONNECT_LABEL = 'Reconnect'
    const RECONNECT_PENDING_LABEL = 'Reconnecting…'
    const ACTION_ERROR_MAX = 200
    /** The Connectors section's second action, offered only where a credential can be stored. */
    const SIGNIN_LABEL = 'Sign in'
    /**
     * The context route the dsh-oh-my-claude plugin publishes (MIT, Copyright (c)
     * 2026 lcestou): the Claude desktop Context panel's own categories. It is same-
     * origin and independent of this plugin's Host route; a 404 means it is absent.
     */
    const CLAUDE_CONTEXT_ROUTE = '/dsh-oh-my-claude/context'
    /** Why the Compact session button is disabled, depending on what blocks it. */
    const COMPACT_BLOCKED_DRAFT = 'Clear the message box to compact'
    const COMPACT_BLOCKED_BUSY = 'Available when the turn ends'
    /** How long a Compact click stays blocked when the host reports no state change. */
    const COMPACT_GUARD_MS = 2_000
    /** A route answer that never arrives must not pin the poll: the request is aborted. */
    const FETCH_TIMEOUT_MS = 30_000
    /** The Claude desktop column's fixed width, and the strip a narrower pane shows instead. */
    const COLUMN_WIDTH = 320
    const STRIP_WIDTH = 40
    /** The column's four sections, in their default order, and the names their headers show. */
    const COLUMN_SECTIONS = ['environment', 'context', 'connectors', 'changes']
    const COLUMN_TITLES = {
      environment: 'Environment',
      context: 'Context',
      connectors: 'Connectors',
      changes: 'Changes',
    }
    /** Where the column saves its order and its collapsed state. */
    const COLUMN_KEY = 'dsh-claude-sidebar.column.v1'
    /** The drag type a section carries, so a drop outside the column types nothing. */
    const DRAG_TYPE = 'application/x-dsh-claude-sidebar-section'
    /** The warning an off-pattern branch carries in its title. */
    const OFF_PATTERN_WARNING = 'Branch name does not follow <type>/<KEY-N>-<slug>'

    /** Per-body id prefixes, so aria-controls stays unique across mounted panes. */
    let bodySeq = 0
    let signInSeq = 0

    /* Reconnect and Sign in share one idle and one pending style. A row's Reconnect
       button only adds the right-edge alignment; the form's buttons keep the base. */
    const ACTION_BUTTON = {
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: STATE_TONE.warn,
      font: 'inherit',
      fontSize: 12,
      cursor: 'pointer',
    }
    const ACTION_PENDING = {
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      font: 'inherit',
      fontSize: 12,
      cursor: 'default',
    }

    /* Theme tokens only, each with a fallback so a renamed token degrades instead of
       breaking: light/dark both come from the host's --dsw-alias-* aliases. */
    const S = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        width: COLUMN_WIDTH,
        maxWidth: '100%',
        boxSizing: 'border-box',
        position: 'relative',
        marginRight: 'auto',
        padding: '12px 14px',
        minHeight: 0,
        overflow: 'auto',
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      /* The same root element in a too-narrow pane: it must keep spanning the pane so the
         observer still reads the pane's width, and the 40 px strip sits at its left. Like
         the column it keeps the default flex, so the host's flex column can shrink it in
         height and its overflow scrolls. */
      panelNarrow: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        boxSizing: 'border-box',
        padding: '12px 0',
        minHeight: 0,
        overflow: 'auto',
        alignItems: 'flex-start',
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      strip: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        width: STRIP_WIDTH,
        flex: 'none',
      },
      stripItem: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        width: '100%',
        minWidth: 0,
      },
      stripIcon: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        flex: 'none',
        borderRadius: 6,
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      stripPercent: {
        fontSize: 10,
        lineHeight: 1.2,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontVariantNumeric: 'tabular-nums',
      },
      refresh: {
        flex: 'none',
        padding: '2px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 11.5,
        cursor: 'pointer',
      },
      column: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
      columnSection: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      sectionDivider: {
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2))',
        paddingTop: 12,
      },
      sectionHeaderRow: { display: 'flex', alignItems: 'center', minWidth: 0 },
      sectionHeader: {
        display: 'flex',
        alignItems: 'center',
        flex: '1 1 auto',
        minWidth: 0,
        gap: 6,
        width: '100%',
        height: 28,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      sectionName: { fontSize: 13, fontWeight: 500 },
      sectionSummary: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        marginLeft: 'auto',
        flex: 'none',
      },
      contextPercent: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' },
      contextPill: {
        width: 24,
        height: 6,
        borderRadius: 3,
        overflow: 'hidden',
        flex: 'none',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.18))',
      },
      contextPillFill: { display: 'block', height: '100%', borderRadius: 3 },
      contextHeadline: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        minWidth: 0,
      },
      contextHeadlineText: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      contextModel: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' },
      contextHeadlineCount: {
        flex: 'none',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontVariantNumeric: 'tabular-nums',
      },
      contextBar: {
        display: 'flex',
        gap: 1,
        height: 6,
        borderRadius: 3,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.18))',
      },
      contextSegment: { height: '100%', flex: 'none' },
      contextRows: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      contextRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 13 },
      contextSwatch: { width: 8, height: 8, flex: 'none', borderRadius: 2, boxSizing: 'border-box' },
      contextName: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      contextTokens: {
        flex: 'none',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontVariantNumeric: 'tabular-nums',
      },
      contextShare: {
        flex: 'none',
        minWidth: 34,
        textAlign: 'right',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontVariantNumeric: 'tabular-nums',
      },
      contextFooter: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginTop: 4 },
      contextFooterNote: {
        flex: '1 1 auto',
        minWidth: 0,
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      compactButton: {
        flex: 'none',
        marginLeft: 'auto',
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      sectionBody: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      chevron: {
        flex: 'none',
        display: 'inline-block',
        fontSize: 12,
        lineHeight: 1,
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      row: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, height: 32, fontSize: 13 },
      rowButton: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        minWidth: 0,
        height: 32,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        textAlign: 'left',
        cursor: 'pointer',
      },
      rowIcon: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        flex: 'none',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      rowText: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      rowRight: {
        flex: 'none',
        marginLeft: 'auto',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      rowBody: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, paddingLeft: 26 },
      rowSecondary: { color: 'var(--dsw-alias-label-secondary, inherit)' },
      note: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' },
      path: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)', wordBreak: 'break-all' },
      mono: { fontFamily: MONO, fontSize: 12, wordBreak: 'break-all' },
      link: {
        fontSize: 13,
        color: 'var(--dsw-alias-brand-primary, inherit)',
        textDecoration: 'underline',
        textUnderlineOffset: 2,
      },
      warn: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-warn-primary, #c98a00)' },
      error: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary, #d64545)' },
      fileRow: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 },
      letter: {
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.4,
        width: 10,
        flex: 'none',
        textAlign: 'center',
      },
      pullRow: { display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, padding: '2px 0' },
      pullIcon: { display: 'flex', alignItems: 'center', width: 16, height: 16, flex: 'none', marginTop: 2 },
      pullText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 auto' },
      pullTitle: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      pullMeta: {
        minWidth: 0,
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      connectorAvatar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        flex: 'none',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.18))',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: 11,
        lineHeight: 1,
      },
      /* One connector row with, under it, the message a failed action left. */
      connectorItem: { display: 'flex', flexDirection: 'column', minWidth: 0 },
      reconnect: { ...ACTION_BUTTON, flex: 'none', marginLeft: 'auto' },
      reconnectPending: { ...ACTION_PENDING, flex: 'none', marginLeft: 'auto' },
      actionError: {
        margin: 0,
        marginTop: 2,
        paddingLeft: 26,
        fontSize: 12,
        color: STATE_TONE.error,
      },
      /* The always-present live region when there is nothing to announce: no box of its
         own, but still in the tree so a screen reader sees the text when it arrives. */
      actionStatusEmpty: { height: 0, margin: 0, padding: 0, overflow: 'hidden' },
      /* The inline sign-in form under a waiting row. The status region stays its sibling. */
      credentialForm: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginTop: 4,
        paddingLeft: 26,
      },
      credentialLabel: { display: 'flex', flexDirection: 'column', gap: 2 },
      credentialLabelText: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      credentialInput: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '4px 6px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3))',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.18))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
        fontSize: 12,
      },
      credentialActions: { display: 'flex', gap: 12 },
      credentialButton: ACTION_BUTTON,
      credentialPending: ACTION_PENDING,
      visuallyHidden: {
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
        clip: 'rect(0 0 0 0)',
        whiteSpace: 'nowrap',
      },
      showMore: {
        alignSelf: 'flex-start',
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      pre: {
        margin: 0,
        maxHeight: 260,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.45,
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2))',
        borderRadius: 8,
        padding: 8,
      },
    }

    /**
     * One same-origin GET the poll can abandon: the response and its JSON body, null
     * when the text is not JSON. Both routes the tab reads go through here, so they
     * share the cache, credential and timeout handling.
     * @param {string} path
     * @returns {Promise<{ response: Response, body: unknown }>}
     */
    async function fetchJson(path) {
      const response = await fetch(api(path), {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      const raw = await response.text()
      let body = null
      try {
        body = JSON.parse(raw)
      } catch {
        body = null
      }
      return { response, body }
    }

    /** One 16 x 16 line-icon frame, shared by every Environment icon. */
    function iconFrame(size, ...children) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        ...children,
      )
    }

    /** One 16 x 16 row icon: the same frame. */
    function lineIcon(...children) {
      return iconFrame(16, ...children)
    }

    /** The 12 px chevron that points right when closed and down when open. */
    function chevron(expanded) {
      return h(
        'span',
        {
          style: { ...S.chevron, transform: expanded ? 'rotate(90deg)' : undefined },
          'aria-hidden': 'true',
        },
        '›',
      )
    }

    /** One 32 px row: a line icon, the text and an optional right-aligned detail. */
    function row(icon, content, options = {}) {
      return h(
        'div',
        { key: options.key, style: S.row, title: options.title },
        h('span', { style: S.rowIcon }, h(icon)),
        h('span', { style: S.rowText }, content),
        options.right === undefined ? null : h('span', { style: S.rowRight }, options.right),
      )
    }


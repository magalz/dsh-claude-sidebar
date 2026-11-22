    /*
     * The Subagents tab: a right-sidebar tab that shows the tree of subagents the open
     * session started (and their own children), each with its title, live state and
     * model. A press on a row opens that subagent's conversation inside the sidebar; a
     * secondary press opens it full screen. Client-only: it reads the session store's
     * subagentCatalog projections and the session status map, and asks the session
     * service for a child's projections the first time it needs them.
     *
     * dsh APIs used (0.2.2-rc.5):
     *   ctx.sidebarRightTabs.register(...)          dsh-client-ui-sidebar-right README.md:85
     *   ctx.slots.register(...) with inject()       README.md:86; dsh-client-ui-jobs src/client/index.ts:43-50
     *   slot "sidebar.right.pane.tab" body props    (sessionId, useSessions, useSessionStatus, useTabInfo)
     *                                              dsh-client-ui-sidebar-right contract/slots.ts:170-173, 185-220
     *   subagentCatalog projection                  dsh-subagent src/projection-types.ts:92-108
     *   ctx.sessions.refreshProjections(id)         dsh-api-session-controller client/sessions/manager.ts:340-373
     *   tab.actions.openResource(address, options)  dsh-client-ui-sidebar-right contract/slots.ts:156-182
     *   ctx.uiWorkspace.openSession(target)         dsh-client-ui-workspace client/navigation.ts:40-45
     *   theme tokens with fallbacks                 dsh-rightbar-quicknav client.js:1115-1116
     */

    /* React and h come from shared.js; the tree needs a memo and a ref that outlives renders. */
    const { useMemo, useRef } = React

    /** This implementation's identity; also the key its body registers under. */
    const TAB_ID = 'dsh-claude-sidebar/subagents'
    /** The type openTab() names. */
    const KIND = 'claude-sidebar-subagents'
    const SLOT = 'sidebar.right.pane.tab'
    /** How many projection refreshes one body keeps in flight at once. */
    const MAX_IN_FLIGHT = 4
    /** The address prefix the app's subagent tab type claims. */
    const ADDRESS_PREFIX = 'dsh-resource://subagentchat/session/'
    /** One line the tab logs when a projection refresh fails. */
    const REFRESH_WARNING = 'dsh-claude-sidebar: subagents refresh failed'
    /** One tree level's indent, in pixels. */
    const INDENT = 12

    /* Theme tokens only, each with a fallback so a renamed token degrades instead of
       breaking: light/dark both come from the host's --dsw-alias-* aliases. */
    const S = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        minHeight: 0,
        overflow: 'auto',
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      header: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      counts: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, inherit)' },
      refresh: {
        marginLeft: 'auto',
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
      row: { padding: '2px 0' },
      line: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      rowButton: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flex: '1 1 auto',
        minWidth: 0,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      state: { fontSize: 11.5, flex: 'none' },
      title: {
        fontSize: 12.5,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0,
        flex: '1 1 auto',
      },
      model: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        flex: 'none',
        maxWidth: '45%',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      external: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, inherit)', flex: 'none' },
      full: {
        flex: 'none',
        padding: '2px 6px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        font: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      },
      empty: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' },
    }

    /** Each state's dot: the shared tone it uses, and whether it is drawn hollow. */
    const STATE_MARK = {
      running: { tone: 'active', hollow: false },
      completed: { tone: 'success', hollow: false },
      idle: { tone: 'idle', hollow: true },
    }

    /** The label each state shows, exactly as the shipped subagent tree words it. */
    const STATE_LABEL = { running: 'Running', completed: 'Completed', idle: 'Idle' }

    /**
     * The model a session runs on, from its modelSelection projection: the latest
     * request's choice, else the one queued next.
     * @param {object | undefined} summary - a SessionSummary
     * @returns {string | null} "model · effort", "model", or null with no selection
     */
    function modelLabel(summary) {
      const selection = summary?.projectionValues?.modelSelection
      if (selection === null || selection === undefined) return null
      const choice = selection.lastUsed || selection.next
      if (choice === null || choice === undefined) return null
      return choice.reasoningEffort ? choice.model + ' · ' + choice.reasoningEffort : choice.model
    }

    /**
     * A row's title: the catalog label, else the session's display title or title,
     * else the agent name, else the id.
     * @param {object} entry - one subagentCatalog entry
     * @param {object | undefined} summary - the child's SessionSummary
     * @returns {string}
     */
    function titleOf(entry, summary) {
      if (typeof entry.label === 'string' && entry.label !== '') return entry.label
      if (summary !== null && summary !== undefined) {
        if (typeof summary.displayTitle === 'string' && summary.displayTitle !== '') return summary.displayTitle
        if (typeof summary.title === 'string' && summary.title !== '') return summary.title
      }
      if (typeof entry.name === 'string' && entry.name !== '') return entry.name
      return entry.id
    }

    /**
     * A child's live state, derived exactly as the shipped subagent tree derives it:
     * the status map wins over the summary, and only a finished turn marks completion.
     * Failure cannot be told apart from idle.
     * @param {object} entry - one subagentCatalog entry
     * @param {object | undefined} summary - the child's SessionSummary
     * @param {{ running?: boolean } | undefined} status - statuses.get(child id)
     * @returns {'running' | 'completed' | 'idle'}
     */
    function childState(entry, summary, status) {
      const running = status?.running ?? summary?.running
      if (running === true) return 'running'
      const finished = summary?.projectionValues?.subagentTiming?.lastTurnCompleted
      if (entry.mode !== 'external' && finished === true) return 'completed'
      return 'idle'
    }

    /**
     * The sidebar resource address for one child, in the app's internal format; an
     * external child has none because it cannot be opened.
     * @param {string} parentSessionId - the child's direct parent
     * @param {object} entry - one subagentCatalog entry
     * @returns {string | null}
     */
    function subagentAddress(parentSessionId, entry) {
      if (entry.mode === 'external') return null
      const query = new URLSearchParams({ parent: parentSessionId, mode: entry.mode })
      return ADDRESS_PREFIX + encodeURIComponent(entry.id) + '?' + query
    }

    /**
     * The catalog mode the app accepts in an address; anything else is unknown, so an
     * entry with no mode still yields an address the app will open.
     * @param {unknown} mode
     * @returns {'one-shot' | 'continuable' | 'unknown' | 'external'}
     */
    function modeOf(mode) {
      if (mode === 'one-shot' || mode === 'continuable' || mode === 'external') return mode
      return 'unknown'
    }

    /**
     * The display rank of one subtree: running work first, whether it is the child
     * itself or a descendant; otherwise idle before settled.
     * @param {object} node - a child node whose subtree is already ranked
     * @returns {0 | 1 | 2}
     */
    function rankOf(node) {
      if (node.state === 'running') return 0
      if (node.children.some(child => child.rank === 0)) return 0
      if (node.state === 'idle') return 1
      return 2
    }

    /**
     * A catalog entry's creation time, or null when it holds no number.
     * @param {unknown} value
     * @returns {number | null}
     */
    function createdAtOf(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    /**
     * Order one parent's children for display: running subtrees first, then idle, then
     * settled; newest first inside a rank, and untimed entries last in catalog order.
     * @param {object[]} nodes - sibling nodes, in catalog order
     * @returns {object[]} the same nodes, ordered
     */
    function orderSiblings(nodes) {
      return nodes.slice().sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank
        const left = createdAtOf(a.createdAt)
        const right = createdAtOf(b.createdAt)
        if (left === null && right === null) return 0
        if (left === null) return 1
        if (right === null) return -1
        return right - left
      })
    }

    /**
     * Every subagent below `rootId` as flat rows in display order: a sibling that
     * contains running work first, then idle, then settled, newest first inside a
     * rank. A session id is visited once, so a cycle or a repeated entry cannot loop;
     * an external entry is a leaf and is never walked.
     * @param {Record<string, object> | undefined} byId - session summaries by id
     * @param {Record<string, object> | undefined} projections - projection records by session id
     * @param {Map<string, object> | undefined} statuses - live session status by id
     * @param {string} rootId - the open session
     * @returns {{ id: string, parentId: string, depth: number, mode: string, title: string, state: string, model: string | null, loaded: boolean, recordState: string | undefined, formatStatus: string | undefined, createdAt: unknown }[]}
     */
    function buildTree(byId, projections, statuses, rootId) {
      const summaries = byId === null || byId === undefined ? {} : byId
      const catalogues = projections === null || projections === undefined ? {} : projections
      const statusMap = statuses === null || statuses === undefined ? null : statuses
      const rows = []
      const seen = new Set([rootId])

      /* One parent's children as nodes, each carrying its own ordered subtree. */
      const childrenOf = parentId => {
        const record = catalogues[parentId]
        const values = record === null || record === undefined ? null : record.values
        const entries = values === null || values === undefined ? null : values.subagentCatalog
        if (!Array.isArray(entries)) return []
        const nodes = []
        for (const entry of entries) {
          if (entry === null || entry === undefined || seen.has(entry.id)) continue
          seen.add(entry.id)
          const child = summaries[entry.id]
          const status = statusMap === null ? undefined : statusMap.get(entry.id)
          const mode = modeOf(entry.mode)
          const node = {
            id: entry.id,
            parentId,
            mode,
            title: titleOf(entry, child),
            state: childState(entry, child, status),
            model: modelLabel(child),
            loaded: Array.isArray(catalogues[entry.id]?.values?.subagentCatalog),
            recordState: catalogues[entry.id]?.state,
            formatStatus: child?.formatStatus,
            createdAt: entry.createdAt,
            children: [],
          }
          if (mode !== 'external') node.children = childrenOf(entry.id)
          node.rank = rankOf(node)
          nodes.push(node)
        }
        return orderSiblings(nodes)
      }

      const add = (node, depth) => {
        const { children, rank, ...fields } = node
        rows.push({ ...fields, depth })
        for (const child of children) add(child, depth + 1)
      }
      for (const node of childrenOf(rootId)) add(node, 0)
      return rows
    }

    /**
     * Count the rows by state, plus the total.
     * @param {{ state: string }[]} rows - buildTree() rows
     * @returns {{ running: number, completed: number, idle: number, total: number }}
     */
    function countStates(rows) {
      const counts = { running: 0, completed: 0, idle: 0, total: 0 }
      for (const row of rows) {
        counts.total += 1
        if (row.state === 'running') counts.running += 1
        else if (row.state === 'completed') counts.completed += 1
        else counts.idle += 1
      }
      return counts
    }

    /**
     * The ids this loading pass should request: the root when it was never asked
     * for, then every non-external row that has no catalog yet and was not asked
     * for either, up to the number of free refresh slots. A row the app would skip
     * (migration-required or error) is never requested.
     * @param {{ id: string, mode: string, loaded: boolean, recordState?: string, formatStatus?: string }[] | undefined} rows - buildTree() rows
     * @param {string} rootId - the open session
     * @param {Set<string> | undefined} requested - ids asked for by earlier passes
     * @param {number} free - refresh slots not in flight
     * @returns {string[]}
     */
    function idsToRefresh(rows, rootId, requested, free) {
      if (free <= 0) return []
      const asked = requested === null || requested === undefined ? new Set() : requested
      const ids = []
      if (!asked.has(rootId)) ids.push(rootId)
      for (const row of rows === null || rows === undefined ? [] : rows) {
        if (ids.length >= free) break
        if (row.mode === 'external' || row.loaded === true || asked.has(row.id)) continue
        if (row.recordState === 'migration-required' || row.recordState === 'error') continue
        if (row.formatStatus === 'migration-required') continue
        ids.push(row.id)
      }
      return ids
    }

    /**
     * The Subagents tab's guide icon: two linked nodes, drawn in the current text
     * color and sized by props.size.
     * @param {{ size?: number }} [props]
     */
    function SubagentsIcon(props) {
      const size = props.size ?? 16
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
        h('circle', { cx: 4.5, cy: 4, r: 2 }),
        h('circle', { cx: 11.5, cy: 12, r: 2 }),
        h('path', { d: 'M4.5 6v2.5A3.5 3.5 0 0 0 8 12h1.5' }),
      )
    }

    /**
     * Report one failed projection refresh, whether it rejected or threw.
     * @param {unknown} error
     */
    function warnRefresh(error) {
      console.warn(REFRESH_WARNING, error)
    }

    /**
     * One subagent row: an openable row is its primary button plus a full-screen
     * button; an external row is plain text and cannot be opened.
     * @param {object} row - one buildTree() row
     * @param {{ openResource: (address: string, options: object) => void, openFull: (target: object) => void }} view
     */
    function subagentRow(row, view) {
      const style = { ...S.row, paddingLeft: INDENT * row.depth }
      if (row.mode === 'external') {
        return h(
          'div',
          { key: row.id, style },
          h(
            'div',
            { style: S.line },
            h('span', { style: S.external }, 'External'),
            h('span', { style: S.title, title: row.title }, row.title),
            row.model === null ? null : h('span', { style: S.model }, row.model),
          ),
        )
      }
      const address = subagentAddress(row.parentId, row)
      const stateLabel = STATE_LABEL[row.state]
      const mark = STATE_MARK[row.state]
      const accessible =
        row.model === null
          ? stateLabel + ': ' + row.title + ', open in sidebar'
          : stateLabel + ': ' + row.title + ', ' + row.model + ', open in sidebar'
      return h(
        'div',
        { key: row.id, style },
        h(
          'div',
          { style: S.line },
          h(
            'button',
            {
              type: 'button',
              style: S.rowButton,
              'aria-label': accessible,
              onClick: () => view.openResource(address, { kind: 'subagentchat', preferNewPane: true }),
            },
            h('span', { style: stateMark(mark.tone, mark.hollow) }),
            h('span', { style: S.state }, stateLabel),
            h('span', { style: S.title, title: row.title }, row.title),
            row.model === null ? null : h('span', { style: S.model }, row.model),
          ),
          h(
            'button',
            {
              type: 'button',
              style: S.full,
              'aria-label': 'Open ' + row.title + ' full screen',
              onClick: () =>
                view.openFull({ parentSessionId: row.parentId, childSessionId: row.id, mode: row.mode }),
            },
            'Full screen',
          ),
        ),
      )
    }

    /**
     * The tab body. The slot supplies sessionId, useSessions, useSessionStatus and
     * useTabInfo; the registration's inject supplies refreshProjections and openFull.
     * @param {object} props
     */
    function SubagentsBody(props) {
      const sessionId = props.sessionId
      const tabInfo = props.useTabInfo()
      const byId = props.useSessions(state => state.byId)
      const projections = props.useSessions(state => state.projectionsBySession)
      const statuses = props.useSessionStatus(state => state)
      const rows = useMemo(
        () => buildTree(byId, projections, statuses, sessionId),
        [byId, projections, statuses, sessionId],
      )
      const requestedRef = useRef(null)
      if (requestedRef.current === null) requestedRef.current = new Set()
      const inFlightRef = useRef(0)
      const aliveRef = useRef(true)
      const [queueSeq, setQueueSeq] = useState(0)

      /* A settlement that arrives after unmount must not set state. */
      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
        }
      }, [])

      /* One refresh settling frees its slot and wakes the loading effect even when
         the store did not change, so a rejection cannot stall the queue. */
      const settle = () => {
        inFlightRef.current -= 1
        if (aliveRef.current) setQueueSeq(seq => seq + 1)
      }

      /* Ask for the catalogs the tree cannot see yet, at most MAX_IN_FLIGHT at a
         time: the root, then each child that arrived without a catalog. Rows change
         when a catalog arrives and each settlement bumps queueSeq, so this effect
         runs again and reaches the next level. An id is asked for at most once per
         mount, except after Refresh clears the set. */
      useEffect(() => {
        const free = MAX_IN_FLIGHT - inFlightRef.current
        if (free <= 0) return
        for (const id of idsToRefresh(rows, sessionId, requestedRef.current, free)) {
          requestedRef.current.add(id)
          const refreshed = props.refreshProjections(id)
          inFlightRef.current += 1
          refreshed.then(settle, error => {
            warnRefresh(error)
            settle()
          })
        }
      }, [rows, sessionId, queueSeq])

      const counts = countStates(rows)
      const header = []
      if (counts.running > 0) header.push(counts.running + ' running')
      if (counts.completed > 0) header.push(counts.completed + ' completed')
      header.push(counts.total + ' total')

      return h(
        'div',
        { style: S.panel },
        h(
          'div',
          { style: S.header },
          h('span', { style: S.counts }, header.join(' · ')),
          h(
            'button',
            {
              type: 'button',
              style: S.refresh,
              onClick: () => {
                requestedRef.current.clear()
                setQueueSeq(seq => seq + 1)
              },
            },
            'Refresh',
          ),
        ),
        rows.length === 0
          ? h('p', { style: S.empty, role: 'status' }, 'This session has started no subagents')
          : h(
              'div',
              null,
              rows.map(row =>
                subagentRow(row, {
                  openResource: tabInfo.tab.actions.openResource,
                  openFull: props.openFull,
                }),
              ),
            ),
      )
    }

    function mount(ctx) {
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            title: () => 'Subagents',
            guide: [
              {
                id: 'subagents',
                order: 37,
                title: () => 'Subagents',
                description: () => 'Subagents of this session, their state and model',
                icon: SubagentsIcon,
              },
            ],
          }),
        'subagents panel: sidebar tab type',
      )

      // The body seat belongs to the right sidebar; a host without it keeps the plugin quiet.
      try {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              key: TAB_ID,
              inject: () => ({
                refreshProjections: id => ctx.sessions.refreshProjections(id),
                openFull: target => ctx.uiWorkspace.openSession(target),
              }),
            },
            SubagentsBody,
          ),
        )
      } catch (error) {
        console.warn('subagents panel: this host has no "' + SLOT + '" slot', error)
      }
    }

    registerFeature({ name: 'subagents', inject: ['slots', 'sidebarRightTabs', 'sessions', 'uiWorkspace'], mount })

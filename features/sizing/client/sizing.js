/*
 * Automatic sizing of the docked right-sidebar panes.
 *
 * The feature has no public app API: it reads the layout and sidebar services through
 * ctx.get (guarded by shared.js's serviceOf) and only ever writes through
 * panels.setRightbar and store.actions.resizeSplit. The DOM is read, never written.
 *
 * This file is one part of client.js, concatenated inside the module factory by
 * scripts/build-client.mjs. React, the feature registry, serviceOf and PANE_SIZING come
 * from shared.js.
 */

    /** E: 320 px column + 1 px pane border + 3 px margin (the Claude desktop Environment width). */
    const ENV_PANE_PX = 324
    /** dsh clamps setRightbar to [300, 0.7 x viewport]. */
    const MIN_COLUMN_PX = 300
    const COLUMN_CAP_RATIO = 0.7
    /** dsh clamps each split child to at least 0.2; we keep both ends and normalise. */
    const SPLIT_MIN = 0.2
    const SPLIT_MAX = 0.8
    /** An undo-worthy resize is a change of more than this many pixels. */
    const USER_WIDTH_TOLERANCE = 8
    /** A split within this much of its target is already right: no undo step. */
    const SPLIT_EPSILON = 0.01
    /** One queue: every trigger resets this debounce. */
    const APPLY_DELAY_MS = 100
    /** Frames waited for two equal measurements before a write is treated as rendered. */
    const SETTLE_MAX_FRAMES = 10
    /** Startup: retry while the column is not ready; 20 x 500 ms = 10 s, then stop. */
    const STARTUP_RETRY_MS = 500
    const MAX_STARTUP_RETRIES = 20
    const ENV_TAB_KIND = 'claude-sidebar-environment'
    const STORAGE_KEY = 'dsh-claude-sidebar.pane-widths.v1'
    const MAX_REMEMBERED_SESSIONS = 50
    const SIZING_TAG = '[dsh-claude-sidebar sizing]'

    let warnedInternals = false

    /* ================= pure helpers ================= */

    /**
     * Rules 1-3: the width of each docked pane and the width of the column they share.
     * @param {{ available: number, viewport: number,
     *   panes: { paneId: string, tabId: string, kind: string }[],
     *   remembered: Record<string, number> }} input
     * @returns {{ column: number, widths: Record<string, number> }}
     */
    function paneWidths(input) {
      const data = input || {}
      const available = Number(data.available) || 0
      const viewport = Number(data.viewport) || 0
      const panes = (Array.isArray(data.panes) ? data.panes : []).filter(pane => pane && pane.paneId)
      const remembered = data.remembered || {}
      const environment = panes.filter(pane => pane.kind === ENV_TAB_KIND)
      const others = panes.filter(pane => pane.kind !== ENV_TAB_KIND)
      const e = environment.length ? ENV_PANE_PX : 0
      const n = others.length
      const defaultWidth = n > 0 ? (available - e) / (n + 1) : 0
      const widths = {}
      for (const pane of panes) {
        if (pane.kind === ENV_TAB_KIND) {
          widths[pane.paneId] = ENV_PANE_PX
        } else {
          const kept = remembered[pane.tabId]
          widths[pane.paneId] = typeof kept === 'number' && isFinite(kept) ? kept : defaultWidth
        }
      }
      let column = 0
      for (const id of Object.keys(widths)) column += widths[id]
      const cap = Math.max(MIN_COLUMN_PX, Math.round(viewport * COLUMN_CAP_RATIO))
      const clamped = Math.max(MIN_COLUMN_PX, Math.min(column, cap))
      if (clamped !== column) {
        if (clamped < column) {
          // The cap cut the sum: Environment keeps E, the other panes share what is left.
          const envTotal = Math.min(environment.length * ENV_PANE_PX, clamped)
          const rest = Math.max(0, clamped - envTotal)
          for (const pane of environment) widths[pane.paneId] = envTotal / environment.length
          for (const pane of others) widths[pane.paneId] = rest / others.length
        } else {
          // The 300 px floor raised the sum: give the extra to the last pane.
          const last = panes[panes.length - 1]
          if (last) widths[last.paneId] += clamped - column
        }
        column = clamped
      }
      let rounded = 0
      for (const pane of panes) {
        widths[pane.paneId] = Math.round(widths[pane.paneId])
        rounded += widths[pane.paneId]
      }
      if (panes.length && rounded !== column) widths[panes[panes.length - 1].paneId] += column - rounded
      return { column, widths }
    }

    /**
     * Rule 4: fractions for resizeSplit, computed on the frame after setRightbar from
     * what dsh actually rendered. A column that came back narrower keeps Environment at E.
     * @param {{ targets: number[], measured: { column: number, widths: number[],
     *   envIndex: number, envPx?: number } }} input
     * @returns {number[]}
     */
    function splitFractions(input) {
      const data = input || {}
      const targets = (Array.isArray(data.targets) ? data.targets : []).map(value => Number(value) || 0)
      const measured = data.measured || {}
      const widths = (Array.isArray(measured.widths) ? measured.widths : []).map(value => Number(value) || 0)
      let space = 0
      for (const width of widths) space += width
      if (!(space > 0) || targets.length === 0) return targets.map(() => 1 / (targets.length || 1))
      let wanted = targets.slice()
      const column = Number(measured.column) || 0
      let requested = 0
      for (const target of targets) requested += target
      const envIndex = Number.isInteger(measured.envIndex) ? measured.envIndex : -1
      const envPx = typeof measured.envPx === 'number' ? measured.envPx : ENV_PANE_PX
      if (column > 0 && column < requested - 0.5 && envIndex >= 0 && targets.length === 2) {
        wanted[envIndex] = Math.min(envPx, space)
        wanted[1 - envIndex] = Math.max(0, space - wanted[envIndex])
      }
      let fractions = wanted.map(width => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, width / space)))
      let sum = 0
      for (const fraction of fractions) sum += fraction
      if (sum > 0) fractions = fractions.map(fraction => fraction / sum)
      return fractions
    }

    /** Whether a split's current fractions differ enough to be worth an undo step. */
    function fractionsDiffer(current, target) {
      const before = Array.isArray(current) ? current : []
      const after = Array.isArray(target) ? target : []
      if (before.length !== after.length) return true
      for (let i = 0; i < before.length; i += 1) {
        if (Math.abs(Number(before[i]) - Number(after[i])) > SPLIT_EPSILON) return true
      }
      return false
    }

    /** The visible docked panes in order, with each one's effective active tab and kind. */
    function dockedPanes(layout) {
      const data = layout || {}
      const nodes = data.nodes || {}
      const tabs = data.tabs || {}
      const seen = new Set()
      const panes = []
      const visit = id => {
        if (id === undefined || id === null || seen.has(id)) return
        seen.add(id)
        const node = nodes[id]
        if (!node) return
        if (node.kind === 'pane') {
          if (node.host === 'float' || !Array.isArray(node.tabs) || node.tabs.length === 0) return
          const tabId = node.activeTabId || node.tabs[0]
          const tab = tabs[tabId]
          panes.push({ paneId: String(id), tabId, kind: (tab && tab.kind) || '' })
          return
        }
        if (node.kind === 'split' && Array.isArray(node.children)) {
          for (const child of node.children) visit(child)
        }
      }
      visit(data.rootId)
      return panes
    }

    /** Docked panes and their effective active tabs; sizes are ignored. */
    function layoutSignature(layout) {
      return dockedPanes(layout).map(pane => pane.paneId + ':' + pane.tabId).join('|')
    }

    /**
     * Widths the user changed by hand. The baseline carries its session and signature: only
     * a like-for-like comparison (same session, panes, viewport and left sidebar) counts.
     */
    function userWidths(input) {
      const data = input || {}
      const baseline = data.baseline
      if (!baseline) return {}
      if (data.sessionId !== undefined && baseline.sessionId !== data.sessionId) return {}
      if (data.signature !== undefined && baseline.signature !== data.signature) return {}
      if (baseline.viewport !== data.viewportNow || baseline.sidebar !== data.sidebarNow) return {}
      const measured = Array.isArray(data.measured) ? data.measured : []
      const widths = baseline.widths || {}
      const result = {}
      for (const pane of measured) {
        if (!pane || pane.kind === ENV_TAB_KIND) continue
        const before = widths[pane.tabId]
        if (before === undefined) continue
        if (typeof pane.width !== 'number' || !isFinite(pane.width)) continue
        if (Math.abs(pane.width - before) > USER_WIDTH_TOLERANCE) result[pane.tabId] = Math.round(pane.width)
      }
      return result
    }

    /** The split whose children are exactly these panes (the divider the user would drag). */
    function splitOf(layout, paneIds) {
      const nodes = (layout && layout.nodes) || {}
      for (const id of Object.keys(nodes)) {
        const node = nodes[id]
        if (!node || node.kind !== 'split' || !Array.isArray(node.children)) continue
        if (node.children.length !== paneIds.length) continue
        if (node.children.every(child => paneIds.indexOf(child) >= 0)) return node
      }
      return null
    }

    /* ================= the effectful part ================= */

    /**
     * A pane sizer driven entirely by injected deps, so tests fire its frames and timers by
     * hand. Writes go only through layout.panels.setRightbar and store.actions.resizeSplit.
     */
    function createPaneSizing(deps) {
      const layoutService = deps.layout
      const sidebarRight = deps.sidebarRight
      const mounted = sidebarRight && sidebarRight.mounted
      const adopted = sidebarRight && sidebarRight.adopted
      const measure = deps.measure
      const raf = deps.raf
      const cancelRaf = deps.cancelRaf
      const setTimer = deps.setTimeout
      const clearTimer = deps.clearTimeout
      const storage = deps.storage

      let disposed = false
      let sessionId = null
      let store = null
      let offStore = null
      let offMounted = null
      let timer = null
      let phaseOneFrame = null
      let settleFrame = null
      let retryTimer = null
      let applyGeneration = 0
      let lastSignature = null
      let pendingSession = null
      let startupRetries = 0
      let startupOpen = false
      /** sessionId -> { sessionId, signature, viewport, sidebar, widths: { tabId: px } }. */
      let baselines = {}
      let remembered = loadRemembered()
      let savedText = JSON.stringify(remembered)

      function loadRemembered() {
        try {
          const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(STORAGE_KEY) : null
          const parsed = raw ? JSON.parse(raw) : {}
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
        } catch (e) {
          return {}
        }
      }

      function saveRemembered() {
        const text = JSON.stringify(remembered)
        if (text === savedText) return
        savedText = text
        try {
          if (storage && typeof storage.setItem === 'function') storage.setItem(STORAGE_KEY, text)
        } catch (e) {
          savedText = null
        }
      }

      /** The column is shared: a write for one session invalidates every other baseline. */
      function clearOtherBaselines(sessionId) {
        for (const id of Object.keys(baselines)) {
          if (id !== sessionId) delete baselines[id]
        }
      }

      /**
       * Each store's snapshot holds only its own session. Prune just that session's tabs;
       * another session survives a snapshot that does not mention it. A whole session is
       * dropped only when its store is gone from adopted and no remembered tabs are left,
       * or when the store exceeds the size cap (oldest created first: a key keeps its place when updated).
       */
      function pruneRemembered(snapshot, sessionId) {
        let changed = false
        const surface = snapshot && snapshot.bySession && snapshot.bySession[sessionId]
        const layout = surface && surface.layout
        if (layout && layout.tabs) {
          const tabs = layout.tabs
          const perSession = remembered[sessionId]
          if (perSession && typeof perSession === 'object') {
            for (const tabId of Object.keys(perSession)) {
              if (!Object.prototype.hasOwnProperty.call(tabs, tabId)) {
                delete perSession[tabId]
                changed = true
              }
            }
            if (Object.keys(perSession).length === 0) {
              delete remembered[sessionId]
              changed = true
            }
          }
        }
        for (const id of Object.keys(remembered)) {
          if (id === sessionId || storeOf(id)) continue
          const perSession = remembered[id]
          if (!perSession || typeof perSession !== 'object' || Object.keys(perSession).length === 0) {
            delete remembered[id]
            changed = true
          }
        }
        const ids = Object.keys(remembered)
        if (ids.length > MAX_REMEMBERED_SESSIONS) {
          for (const id of ids.slice(0, ids.length - MAX_REMEMBERED_SESSIONS)) delete remembered[id]
          changed = true
        }
        if (changed) saveRemembered()
      }

      function storeOf(id) {
        try {
          if (!adopted || typeof adopted.get !== 'function' || id === undefined || id === null) return null
          const entry = adopted.get(id)
          return entry && entry.store ? entry.store : null
        } catch (e) {
          return null
        }
      }

      function snapshotOf(candidate) {
        try {
          return candidate && typeof candidate.getSnapshot === 'function' ? candidate.getSnapshot() : null
        } catch (e) {
          return null
        }
      }

      function layoutOf(snapshot, id) {
        const bySession = snapshot && snapshot.bySession
        const surface = bySession && bySession[id]
        return (surface && surface.layout) || null
      }

      function mountedId() {
        try {
          return mounted && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined
        } catch (e) {
          return undefined
        }
      }

      function scheduleFrame(fn) {
        try {
          return raf(fn)
        } catch (e) {
          return null
        }
      }

      /** A new request brings its own attempt: release a retry still waiting from an older one. */
      function clearRetryTimer() {
        if (retryTimer !== null) {
          try {
            clearTimer(retryTimer)
          } catch (e) {
            /* ignore */
          }
          retryTimer = null
        }
      }

      /** A write, a fullscreen layout, an exhausted budget or dispose closes startup. */
      function endStartup() {
        startupOpen = false
        clearRetryTimer()
      }

      /**
       * A startup attempt found no column, no layout or pane, or never settled: try again after
       * 500 ms. All attempts share one 20-retry budget; exhausting it closes startup.
       */
      function scheduleStartupRetry() {
        if (disposed) return
        if (startupRetries >= MAX_STARTUP_RETRIES) {
          endStartup()
          return
        }
        startupRetries += 1
        retryTimer = setTimer(() => {
          retryTimer = null
          if (disposed) return
          request(sessionId)
        }, STARTUP_RETRY_MS)
      }

      /**
       * A measurement only counts once two consecutive frames agree: dsh may still be
       * animating a column open, or redrawing panes after resizeSplit. Give up silently.
       */
      function settleMeasure(callback, generation, onUnavailable) {
        let attempts = 0
        let previous = null
        const check = () => {
          if (disposed || generation !== applyGeneration) return
          const measured = safeMeasure()
          if (!measured || !measured.found || !(measured.column > 0)) {
            if (typeof onUnavailable === 'function') onUnavailable()
            return
          }
          const key = JSON.stringify([measured.column, measured.panes])
          if (previous === key) {
            callback(measured)
            return
          }
          previous = key
          attempts += 1
          if (attempts >= SETTLE_MAX_FRAMES) {
            if (typeof onUnavailable === 'function') onUnavailable()
            return
          }
          settleFrame = scheduleFrame(check)
        }
        settleFrame = scheduleFrame(check)
      }

      /** Follow adopted: unsubscribe the old store, subscribe the current one. */
      function subscribeStore(id) {
        const next = storeOf(id)
        if (next === store) return
        if (offStore) {
          try {
            offStore()
          } catch (e) {
            /* ignore */
          }
          offStore = null
        }
        store = next
        if (store && typeof store.subscribe === 'function') {
          try {
            offStore = store.subscribe(() => {
              if (disposed) return
              const snapshot = snapshotOf(store)
              pruneRemembered(snapshot, id)
              const signature = layoutSignature(layoutOf(snapshot, id))
              if (signature !== lastSignature) {
                lastSignature = signature
                request(id)
              }
            })
          } catch (e) {
            offStore = null
          }
        }
        const snapshot = snapshotOf(store)
        pruneRemembered(snapshot, id)
        lastSignature = layoutSignature(layoutOf(snapshot, id))
      }

      function safeMeasure() {
        try {
          return measure()
        } catch (e) {
          return null
        }
      }

      /** First frame: wait for a settled DOM, detect user resizes, write the column. */
      function applyColumn(id, generation, isStartup) {
        settleMeasure(measured => {
          const nowId = mountedId()
          if (nowId === undefined || nowId === null) return
          if (id !== undefined && id !== null && id !== nowId) return
          subscribeStore(nowId)
          const snapshot = snapshotOf(store)
          pruneRemembered(snapshot, nowId)
          const layout = layoutOf(snapshot, nowId)
          if (!layout) {
            if (isStartup) scheduleStartupRetry()
            return
          }
          if (layout.mode === 'fullscreen') {
            if (isStartup) endStartup()
            return
          }
          const panes = dockedPanes(layout)
          if (panes.length === 0) {
            if (isStartup) scheduleStartupRetry()
            return
          }
          const signature = layoutSignature(layout)

          const measuredList = []
          for (const pane of panes) {
            const width = measured.panes && measured.panes[pane.paneId]
            if (typeof width === 'number' && width > 0) {
              measuredList.push({ paneId: pane.paneId, tabId: pane.tabId, kind: pane.kind, width })
            }
          }
          const changes = userWidths({
            baseline: baselines[nowId] || null,
            measured: measuredList,
            viewportNow: measured.viewport,
            sidebarNow: measured.sidebar,
            sessionId: nowId,
            signature,
          })
          const perSession = remembered[nowId] && typeof remembered[nowId] === 'object' ? remembered[nowId] : {}
          if (Object.keys(changes).length > 0) {
            for (const tabId of Object.keys(changes)) perSession[tabId] = changes[tabId]
            remembered[nowId] = perSession
            saveRemembered()
          }

          const sizes = paneWidths({
            available: measured.available,
            viewport: measured.viewport,
            panes,
            remembered: perSession,
          })
          const currentTarget = { sessionId: nowId, signature, panes, widths: sizes.widths, column: sizes.column }
          let wrote = false
          try {
            layoutService.panels.setRightbar(sizes.column)
            wrote = true
          } catch (e) {
            /* never let a host write failure escape into the app */
          }
          if (!wrote && isStartup) {
            scheduleStartupRetry()
            return
          }
          if (wrote) endStartup()
          clearOtherBaselines(nowId)
          settleMeasure(() => applySplit(currentTarget, generation), generation)
        }, generation, () => {
          if (isStartup) scheduleStartupRetry()
        })
      }

      /** Second frame: from a settled measurement, set the split, then record the baseline. */
      function applySplit(current, generation) {
        settleMeasure(measured => {
          const panes = current.panes
          const widths = []
          for (const pane of panes) {
            const width = measured.panes && measured.panes[pane.paneId]
            widths.push(typeof width === 'number' ? width : 0)
          }
          if (panes.length === 2) {
            const fractions = splitFractions({
              targets: panes.map(pane => current.widths[pane.paneId]),
              measured: {
                column: measured.column,
                widths,
                envIndex: panes.findIndex(pane => pane.kind === ENV_TAB_KIND),
              },
            })
            const layout = layoutOf(snapshotOf(store), current.sessionId)
            const split = splitOf(layout, panes.map(pane => pane.paneId))
            if (split && Array.isArray(split.sizes) && split.sizes.length === fractions.length &&
                fractionsDiffer(split.sizes, fractions)) {
              const currentStore = storeOf(current.sessionId)
              if (currentStore && currentStore.actions && typeof currentStore.actions.resizeSplit === 'function') {
                try {
                  currentStore.actions.resizeSplit(current.sessionId, split.id, fractions)
                } catch (e) {
                  /* a failed undoable resize must not break the app */
                }
              }
            }
          }
          // The last write has now rendered: this is the baseline, never our computed target.
          settleMeasure(rendered => {
            const baselineWidths = {}
            for (const pane of panes) {
              const width = rendered.panes && rendered.panes[pane.paneId]
              if (typeof width === 'number' && width > 0) baselineWidths[pane.tabId] = width
            }
            baselines[current.sessionId] = {
              sessionId: current.sessionId,
              signature: current.signature,
              viewport: rendered.viewport,
              sidebar: rendered.sidebar,
              widths: baselineWidths,
            }
          }, generation)
        }, generation)
      }

      /** The one queue every trigger goes through. While startup is open, all attempts are startup attempts. */
      function request(id) {
        if (disposed) return
        const isStartup = startupOpen
        // This request brings its own attempt, so a retry still waiting belongs to an older one.
        clearRetryTimer()
        const wanted = id === undefined || id === null ? sessionId : id
        const nowId = mountedId()
        if (wanted !== undefined && wanted !== null && nowId === wanted) subscribeStore(wanted)
        pendingSession = wanted
        applyGeneration += 1
        const generation = applyGeneration
        if (settleFrame !== null) {
          try {
            cancelRaf(settleFrame)
          } catch (e) {
            /* ignore */
          }
          settleFrame = null
        }
        // A phase-one frame still pending (frames pause in a hidden window) belongs to an older
        // generation and would do nothing when it fires: drop it so this request schedules its own.
        if (phaseOneFrame !== null) {
          try {
            cancelRaf(phaseOneFrame)
          } catch (e) {
            /* ignore */
          }
          phaseOneFrame = null
        }
        if (timer !== null) {
          try {
            clearTimer(timer)
          } catch (e) {
            /* ignore */
          }
        }
        timer = setTimer(() => {
          timer = null
          if (disposed || generation !== applyGeneration) return
          phaseOneFrame = scheduleFrame(() => {
            phaseOneFrame = null
            if (!disposed && generation === applyGeneration) applyColumn(pendingSession, generation, isStartup)
          })
        }, APPLY_DELAY_MS)
      }

      function start() {
        if (disposed) return
        startupOpen = true
        sessionId = mountedId()
        if (sessionId !== undefined && sessionId !== null) subscribeStore(sessionId)
        if (mounted && typeof mounted.subscribe === 'function') {
          try {
            offMounted = mounted.subscribe(() => {
              if (disposed) return
              const next = mountedId()
              if (next === sessionId) return
              sessionId = next
              if (next === undefined || next === null) return
              subscribeStore(next)
              request(next)
            })
          } catch (e) {
            offMounted = null
          }
        }
        // The gate mounts us after an async fetch: the session may already be on screen (apply
        // now) or appear later through the mounted subscription, whose request is also startup.
        if (sessionId !== undefined && sessionId !== null) request(sessionId)
      }

      function dispose() {
        if (disposed) return
        disposed = true
        endStartup()
        if (timer !== null) {
          try {
            clearTimer(timer)
          } catch (e) {
            /* ignore */
          }
          timer = null
        }
        if (phaseOneFrame !== null) {
          try {
            cancelRaf(phaseOneFrame)
          } catch (e) {
            /* ignore */
          }
          phaseOneFrame = null
        }
        if (settleFrame !== null) {
          try {
            cancelRaf(settleFrame)
          } catch (e) {
            /* ignore */
          }
          settleFrame = null
        }
        if (offStore) {
          try {
            offStore()
          } catch (e) {
            /* ignore */
          }
          offStore = null
        }
        if (offMounted) {
          try {
            offMounted()
          } catch (e) {
            /* ignore */
          }
          offMounted = null
        }
        store = null
        sessionId = null
        baselines = {}
      }

      return { start, request, dispose }
    }

    /* ================= host adapters ================= */

    function warnMissingInternals() {
      if (warnedInternals) return
      warnedInternals = true
      try {
        console.warn(SIZING_TAG, 'app internals for pane sizing are missing; automatic sizing is disabled')
      } catch (e) {
        /* ignore */
      }
    }

    /** Read geometry only: the conversation's width for A, the column and its panes. */
    function measureDom() {
      try {
        const column = document.querySelector('[data-rightbar-col="true"]')
        if (!column) return { found: false, column: 0 }
        const columnRect = column.getBoundingClientRect()
        if (!(columnRect.width > 0)) return { found: false, column: 0 }
        const frame = column.parentElement
        if (!frame || !frame.children) return { found: false, column: 0 }
        const frameRect = frame.getBoundingClientRect()
        const children = Array.prototype.slice.call(frame.children)
        const at = children.indexOf(column)
        const conversation = at > 0 ? children[at - 1] : null
        if (!conversation) return { found: false, column: 0 }
        const conversationRect = conversation.getBoundingClientRect()
        if (!(conversationRect.width > 0)) return { found: false, column: 0 }
        const panes = {}
        const nodes = column.querySelectorAll('[data-dockkit-pane]')
        for (const node of nodes) {
          const id = node.getAttribute && node.getAttribute('data-dockkit-pane')
          const width = node.getBoundingClientRect().width
          if (id && width > 0) panes[id] = width
        }
        return {
          found: true,
          viewport: window.innerWidth,
          sidebar: conversationRect.left - frameRect.left,
          available: columnRect.right - conversationRect.left,
          column: columnRect.width,
          panes,
        }
      } catch (e) {
        return { found: false, column: 0 }
      }
    }

    /** The real browser adapters; tests inject their own deps into createPaneSizing instead. */
    function browserDeps(layout, sidebarRight) {
      return {
        layout,
        sidebarRight,
        measure: measureDom,
        raf: fn => requestAnimationFrame(fn),
        cancelRaf: id => cancelAnimationFrame(id),
        setTimeout: (fn, delay) => setTimeout(fn, delay),
        clearTimeout: id => clearTimeout(id),
        storage: typeof localStorage !== 'undefined' ? localStorage : null,
      }
    }

    /**
     * Check the app internals before subscribing to anything. Nothing throws into the app.
     */
    function internalsReady(layout, sidebarRight) {
      const panels = layout.panels
      const adopted = sidebarRight.adopted
      const mounted = sidebarRight.mounted
      if (!panels || typeof panels.setRightbar !== 'function') return false
      if (!adopted || typeof adopted.get !== 'function') return false
      if (!mounted || typeof mounted.getSnapshot !== 'function' || typeof mounted.subscribe !== 'function') return false
      let current = null
      try {
        const id = mounted.getSnapshot()
        const entry = adopted.get(id)
        current = entry && entry.store
      } catch (e) {
        return false
      }
      if (current && (!current.actions || typeof current.actions.resizeSplit !== 'function')) return false
      return true
    }

    /* ================= plugin entry ================= */

    function mountSizing(ctx, injected) {
      return ctx.effect(() => {
        let deps = injected || null
        if (!deps) {
          const layout = serviceOf(ctx, 'layout')
          const sidebarRight = serviceOf(ctx, 'sidebarRight')
          if (!layout || !sidebarRight || !internalsReady(layout, sidebarRight)) {
            warnMissingInternals()
            return () => {}
          }
          deps = browserDeps(layout, sidebarRight)
        }
        const controller = createPaneSizing(deps)
        controller.start()
        PANE_SIZING.apply = sessionId => controller.request(sessionId)
        return () => {
          controller.dispose()
          if (PANE_SIZING.apply) PANE_SIZING.apply = null
        }
      }, 'dsh-claude-sidebar pane sizing')
    }

    registerFeature({ name: 'sizing', inject: [], mount: mountSizing })

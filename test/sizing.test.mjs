/**
 * Acceptance tests for automatic right-sidebar pane sizing (features/sizing/client/sizing.js).
 *
 * The pure helpers are evaluated from the source parts (shared.js first), so a missing
 * helper fails an assertion instead of crashing the file at load. The effectful part is
 * driven through injected deps against a fake DOM that REDRAWS like dsh: setRightbar changes
 * the column, resizeSplit changes the split fractions and pane widths follow fraction x
 * (column - divider). Every redraw lands after a configurable number of frames. This is what
 * makes a baseline taken before the last write observable as a false "user resize".
 * Fakes only; no dsh process.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SHARED = path.join(ROOT, 'client', 'shared.js')
const SIZING = path.join(ROOT, 'features', 'sizing', 'client', 'sizing.js')
const RAIL = path.join(ROOT, 'features', 'rail', 'client', 'rail.js')
const STORAGE_KEY = 'dsh-claude-sidebar.pane-widths.v1'
const ENV_KIND = 'claude-sidebar-environment'
const GIT_KIND = 'claude-sidebar-git'
const ENV_PX = 324
const SID = 'session-1'
const AVAILABLE = 1680 // frame 1920 - left sidebar 240
const CAP = 1344 // 0.7 x 1920
const APPLY_DELAY = 100 // the one apply-queue debounce
const RETRY_DELAY = 500 // startup retry interval
const MAX_STARTUP_RETRIES = 20

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* Loading the parts                                                    */
/* ------------------------------------------------------------------ */

/** A tiny React stub: enough hooks to call Rail() and reach goTab(). */
function makeReact() {
  let hooks = []
  let cursor = 0
  let effects = []
  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
      }
    },
    Component: class {
      constructor(props) {
        this.props = props
        this.state = {}
      }
      setState(next) {
        this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
      }
    },
    Fragment: 'Fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], value => {
        hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(fn) {
      cursor++
      effects.push(fn)
    },
    useLayoutEffect(fn) {
      cursor++
      effects.push(fn)
    },
    useMemo(fn) {
      cursor++
      return fn()
    },
    useCallback(fn) {
      cursor++
      return fn
    },
  }
  return {
    React,
    rewind() {
      cursor = 0
      effects = []
    },
    takeEffects() {
      const pending = effects
      effects = []
      return pending
    },
  }
}

const EXPOSE = `
  paneWidths: typeof paneWidths === 'function' ? paneWidths : null,
  splitFractions: typeof splitFractions === 'function' ? splitFractions : null,
  fractionsDiffer: typeof fractionsDiffer === 'function' ? fractionsDiffer : null,
  layoutSignature: typeof layoutSignature === 'function' ? layoutSignature : null,
  userWidths: typeof userWidths === 'function' ? userWidths : null,
  dockedPanes: typeof dockedPanes === 'function' ? dockedPanes : null,
  createPaneSizing: typeof createPaneSizing === 'function' ? createPaneSizing : null,
  measureDom: typeof measureDom === 'function' ? measureDom : null,
  mount: typeof mountSizing === 'function' ? mountSizing : null,
  PANE_SIZING: typeof PANE_SIZING !== 'undefined' ? PANE_SIZING : null,
  Rail: typeof Rail === 'function' ? Rail : null,
  ENV_PANE_PX: typeof ENV_PANE_PX === 'number' ? ENV_PANE_PX : null,
`

/** Evaluate the given parts as one classic script and return the exposed names. */
function loadParts(files, extra = {}) {
  const stub = makeReact()
  const warnings = []
  const source = files.map(readText).join('\n') + '\nreturn {' + EXPOSE + '}'
  const sandbox = {
    require(name) {
      if (name === 'react') return stub.React
      throw new Error('unexpected require: ' + name)
    },
    console: {
      warn(...args) { warnings.push(args) },
      error() {},
      info() {},
      log() {},
      debug() {},
    },
    window: {
      innerWidth: 1920,
      innerHeight: 1080,
      matchMedia() { return { matches: false } },
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      querySelector() { return null },
      querySelectorAll() { return [] },
      body: {},
      baseURI: 'http://localhost/',
    },
    navigator: { language: 'en-US' },
    setTimeout() { return 0 },
    clearTimeout() {},
    setInterval() { return 0 },
    clearInterval() {},
    requestAnimationFrame() { return 0 },
    cancelAnimationFrame() {},
    localStorage: null,
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle() { return { backgroundColor: '' } },
    URL,
    URLSearchParams,
  }
  Object.assign(sandbox, extra)
  vm.createContext(sandbox)
  const factory = new vm.Script('(function(require){' + source + '\n})', { filename: 'parts.js' }).runInContext(sandbox)
  return { api: factory(sandbox.require), warnings, stub }
}

const API = loadParts([SHARED, SIZING]).api

/* ------------------------------------------------------------------ */
/* Fakes for the effectful part                                        */
/* ------------------------------------------------------------------ */

/** The layout tree of a real split: Environment beside Git, as dsh reports it. */
function dockLayout() {
  return {
    nodes: {
      pane1: { id: 'pane1', kind: 'pane', host: 'dock', tabs: ['tab8'] },
      split13: { id: 'split13', kind: 'split', axis: 'row', children: ['pane1', 'pane12'], sizes: [0.5, 0.5] },
      pane12: { id: 'pane12', kind: 'pane', host: 'dock', tabs: ['tab14'] },
    },
    tabs: {
      tab8: { id: 'tab8', kind: ENV_KIND, contentId: 'tab8', title: 'Environment' },
      tab14: { id: 'tab14', kind: GIT_KIND, contentId: 'tab14', title: 'Git' },
    },
    rootId: 'split13',
    floats: [],
    activePaneId: 'pane1',
    expanded: true,
    mode: 'push',
  }
}

/**
 * A DOM that redraws after writes: setRightbar changes the column (clamped like dsh),
 * resizeSplit changes the fractions, and each pane measures fraction x (column - divider).
 * Writes land after `delay` frames, which the test drives through flushFrame().
 */
function makeDom(options = {}) {
  const state = {
    viewport: options.viewport ?? 1920,
    frameLeft: options.frameLeft ?? 0,
    frameWidth: options.viewport ?? 1920,
    sidebar: options.sidebar ?? 240,
    column: options.column ?? 600,
    divider: options.divider ?? 0,
    fractions: (options.fractions ?? [0.5, 0.5]).slice(),
    paneIds: options.paneIds ?? ['pane1', 'pane12'],
    delay: options.delay ?? 1,
    conversationMissing: options.conversationMissing ?? false,
    frame: 0,
    pending: [],
  }
  const schedule = apply => state.pending.push({ at: state.frame + state.delay, apply })
  const tick = () => {
    state.frame += 1
    for (const item of [...state.pending]) {
      if (item.at <= state.frame) {
        state.pending.splice(state.pending.indexOf(item), 1)
        item.apply()
      }
    }
  }
  const setRightbar = px => {
    const clamped = Math.max(300, Math.min(Math.round(px), Math.round(state.viewport * 0.7)))
    schedule(() => {
      state.column = clamped
    })
  }
  const resizeSplit = (sessionId, splitId, fractions) => {
    schedule(() => {
      state.fractions = fractions.slice()
    })
  }
  const measure = () => {
    if (state.conversationMissing || !(state.column > 0)) return { found: false, column: 0 }
    const conversationLeft = state.frameLeft + state.sidebar
    const columnRight = state.frameLeft + state.frameWidth
    const panes = {}
    const space = state.column - state.divider
    state.paneIds.forEach((id, index) => {
      panes[id] = state.fractions[index] * space
    })
    return {
      found: true,
      viewport: state.viewport,
      sidebar: state.sidebar,
      available: columnRight - conversationLeft,
      column: state.column,
      panes,
    }
  }
  return { state, tick, setRightbar, resizeSplit, measure }
}

/** A session store: subscribe(listener) calls the listener with NO argument. */
function makeStore(sessionId, layout, dom) {
  const listeners = new Set()
  const resizeCalls = []
  let surface = { layout, minted: {}, history: {} }
  const store = {
    actions: {
      resizeSplit(...args) {
        resizeCalls.push(args)
        if (dom) dom.resizeSplit(...args)
        const split = layout.nodes && layout.nodes[args[1]]
        if (split) split.sizes = args[2].slice()
      },
    },
    getSnapshot() {
      return { bySession: { [sessionId]: surface } }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit() {
      for (const listener of [...listeners]) listener()
    },
    resizeCalls,
    listeners,
  }
  return store
}

/** mounted is an observable with a no-argument subscription. */
function makeMounted(initial) {
  let sessionId = initial
  const listeners = new Set()
  return {
    getSnapshot() { return sessionId },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      sessionId = next
      for (const listener of [...listeners]) listener()
    },
    listeners,
  }
}

function makeTimers() {
  let nextId = 1
  const active = new Map()
  const clears = []
  const fired = []
  return {
    setTimeout(fn, delay) {
      const entry = { id: nextId++, delay, fn }
      active.set(entry.id, entry)
      return entry.id
    },
    clearTimeout(id) {
      clears.push(id)
      active.delete(id)
    },
    pending() { return [...active.values()] },
    fireAll() {
      for (const entry of [...active.values()]) {
        active.delete(entry.id)
        fired.push({ id: entry.id, delay: entry.delay })
        entry.fn()
      }
    },
    countFired(delay) { return fired.filter(entry => entry.delay === delay).length },
    clears,
    fired,
  }
}

function makeStorage(options = {}) {
  const values = new Map(options.data ? Object.entries(options.data) : [])
  const writes = []
  return {
    writes,
    getItem(key) {
      if (options.throwGet) throw new Error('storage disabled')
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      if (options.throwSet) throw new Error('storage disabled')
      writes.push(String(value))
      values.set(key, String(value))
    },
    values,
  }
}

/** Build injected deps plus handles the tests drive by hand. */
function makeDeps(options = {}) {
  const sessionId = options.sessionId || SID
  const tree = options.tree || dockLayout()
  const dom = makeDom(options.domOptions || {})
  const store = options.store || makeStore(sessionId, tree, dom)
  const mounted = options.mounted || makeMounted(options.mountedSession ?? sessionId)
  const adopted = options.adopted || new Map([[sessionId, { store, unsubscribe() {} }]])
  const layout = {
    panels: {
      setRightbar(px) {
        dom.setRightbar(px)
        layout.calls.push(px)
      },
    },
    mode: 'push',
    calls: [],
  }
  const sidebarRight = { adopted, mounted }
  const measureCalls = []
  const measure = () => {
    measureCalls.push(true)
    return dom.measure()
  }
  const timers = makeTimers()
  const frames = []
  let frameId = 0
  const raf = fn => {
    const id = ++frameId
    frames.push({ id, fn })
    return id
  }
  const cancelRaf = id => {
    const at = frames.findIndex(frame => frame.id === id)
    if (at >= 0) frames.splice(at, 1)
  }
  const storage = options.storage || makeStorage(options.storageOptions)
  const deps = { layout, sidebarRight, measure, raf, cancelRaf, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, storage }
  return {
    deps,
    sessionId,
    tree,
    store,
    mounted,
    adopted,
    layout,
    sidebarRight,
    dom,
    measureCalls,
    timers,
    frames,
    storage,
  }
}

/** A controller started against a set of fake deps. */
function started(options = {}) {
  const harness = makeDeps(options)
  const controller = API.createPaneSizing(harness.deps)
  harness.controller = controller
  controller.start()
  return { harness, controller }
}

function flushDebounce(harness) {
  harness.timers.fireAll()
}

function flushFrame(harness) {
  const frame = harness.frames.shift()
  if (!frame) throw new Error('no pending animation frame')
  harness.dom.tick() // dsh redraws before the frame callback measures
  frame.fn()
}

/** Drive a request to rest: the debounce, then every settle frame until no work is pending. */
function applyNow(harness) {
  if (harness.timers.pending().length) flushDebounce(harness)
  let guard = 0
  while (harness.frames.length && guard < 40) {
    flushFrame(harness)
    guard += 1
  }
  assert.ok(guard < 40, 'the fake DOM settles')
}

/**
 * Drive one startup apply to rest: fire the debounce (or the retry that scheduled it), settle
 * its frames, and stop as soon as a 500 ms retry timer is all that is left. A present column
 * writes and leaves nothing pending; a missing/0-px column leaves exactly one retry timer.
 */
function pumpAttempt(harness) {
  let guard = 0
  while (guard < 60) {
    let frames = 0
    while (harness.frames.length && frames < 40 && guard < 60) {
      flushFrame(harness)
      frames += 1
      guard += 1
    }
    if (harness.frames.length) break
    const pending = harness.timers.pending()
    if (!pending.length) break
    if (pending.every(entry => entry.delay === RETRY_DELAY)) break
    harness.timers.fireAll()
    guard += 1
  }
  assert.ok(guard < 60, 'the startup attempt settles')
}

/** Fire the pending startup retry and drive the attempt it schedules. */
function advanceRetry(harness) {
  const pending = harness.timers.pending()
  assert.equal(pending.length, 1, 'exactly one timer is pending between startup retries')
  assert.equal(pending[0].delay, RETRY_DELAY, 'the pending timer is the startup retry')
  harness.timers.fireAll()
  pumpAttempt(harness)
}

/** Normalise a cross-realm object before a structural comparison. */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function savedWidths(harness) {
  const raw = harness.storage.values.get(STORAGE_KEY)
  return raw ? JSON.parse(raw) : {}
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

test('paneWidths: one pane alone gets half of A, Environment keeps E, others share equally', () => {
  assert.equal(typeof API.paneWidths, 'function', 'sizing.js must define a pure paneWidths()')
  assert.equal(API.ENV_PANE_PX, ENV_PX, 'the Environment pane constant is 324 px')
  const one = API.paneWidths({
    available: 1200,
    viewport: 1920,
    panes: [{ paneId: 'p1', tabId: 't1', kind: GIT_KIND }],
    remembered: {},
  })
  assert.equal(one.widths.p1, 600, 'one other pane alone is half of A')
  assert.equal(one.column, 600)

  const env = API.paneWidths({
    available: 1200,
    viewport: 1920,
    panes: [{ paneId: 'p1', tabId: 'te', kind: ENV_KIND }],
    remembered: {},
  })
  assert.equal(env.widths.p1, ENV_PX, 'Environment alone keeps E')
  assert.equal(env.column, ENV_PX)

  const pair = API.paneWidths({
    available: 1200,
    viewport: 1920,
    panes: [
      { paneId: 'p1', tabId: 'te', kind: ENV_KIND },
      { paneId: 'p2', tabId: 't1', kind: GIT_KIND },
    ],
    remembered: {},
  })
  assert.equal(pair.widths.p1, ENV_PX, 'Environment keeps E beside another pane')
  assert.equal(pair.widths.p2, 438, 'the other pane gets (A - E) / 2')
  assert.equal(pair.column, ENV_PX + 438, 'the column is the sum of the panes')

  const two = API.paneWidths({
    available: 1200,
    viewport: 1920,
    panes: [
      { paneId: 'p1', tabId: 'a', kind: GIT_KIND },
      { paneId: 'p2', tabId: 'b', kind: 'other' },
    ],
    remembered: {},
  })
  assert.equal(two.widths.p1, 400, 'two other panes split A in thirds')
  assert.equal(two.widths.p2, 400)
  assert.equal(two.column, 800, 'two of them get a third each, so their sum is two thirds of A')
})

test('paneWidths: a remembered tab width replaces the default', () => {
  const result = API.paneWidths({
    available: 1200,
    viewport: 1920,
    panes: [{ paneId: 'p1', tabId: 't1', kind: GIT_KIND }],
    remembered: { t1: 500 },
  })
  assert.equal(result.widths.p1, 500, 'the tab keeps the width the user gave it')
  assert.equal(result.column, 500)
})

test('paneWidths: the 70% cap keeps Environment at E and shares the rest equally', () => {
  const result = API.paneWidths({
    available: 1200,
    viewport: 1000, // cap = 700
    panes: [
      { paneId: 'env', tabId: 'te', kind: ENV_KIND },
      { paneId: 'a', tabId: 'a', kind: GIT_KIND },
      { paneId: 'b', tabId: 'b', kind: 'other' },
    ],
    remembered: {},
  })
  assert.equal(result.column, 700, 'the column is clamped to 0.7 x viewport')
  assert.equal(result.widths.env, ENV_PX, 'Environment keeps E')
  assert.equal(result.widths.a, 188, 'the others share what is left')
  assert.equal(result.widths.b, 188)
})

test('paneWidths: the 300px minimum applies to a narrow available width', () => {
  const result = API.paneWidths({
    available: 200,
    viewport: 1920,
    panes: [{ paneId: 'p1', tabId: 't1', kind: GIT_KIND }],
    remembered: {},
  })
  assert.equal(result.column, 300, 'the column never goes below 300 px')
  assert.equal(result.widths.p1, 300)
})

test('splitFractions: phase two uses measured widths, clamps to 0.2/0.8 and normalises', () => {
  assert.equal(typeof API.splitFractions, 'function', 'sizing.js must define a pure splitFractions()')
  const fractions = API.splitFractions({
    targets: [324, 438],
    measured: { column: 762, widths: [330, 420], envIndex: 0 },
  })
  assert.ok(fractions[0] > 0.4 && fractions[0] < 0.45, 'numerators are targets')
  assert.ok(Math.abs(fractions[0] + fractions[1] - 1) < 1e-9, 'fractions sum to 1')

  const clamped = API.splitFractions({
    targets: [700, 100],
    measured: { column: 1050, widths: [1000, 50], envIndex: -1 },
  })
  assert.ok(clamped.every(fraction => fraction >= 0.2 && fraction <= 0.8), 'each fraction stays in [0.2, 0.8]')
  assert.ok(clamped[0] > 0.7, 'the small share was lifted to the 0.2 floor')
  assert.ok(Math.abs(clamped[0] + clamped[1] - 1) < 1e-9, 'clamped fractions are normalised')
})

test('splitFractions: a narrower measured column still gives Environment E', () => {
  const fractions = API.splitFractions({
    targets: [324, 438],
    measured: { column: 600, widths: [300, 290], envIndex: 0 },
  })
  const space = 300 + 290
  assert.ok(Math.abs(fractions[0] * space - ENV_PX) < 1, 'Environment keeps E out of the shared space')
  assert.ok(Math.abs(fractions[1] * space - (space - ENV_PX)) < 1, 'the other pane takes the rest')
  assert.ok(Math.abs(fractions[0] + fractions[1] - 1) < 1e-9)
})

test('fractionsDiffer: changes within 0.01 are left alone', () => {
  assert.equal(typeof API.fractionsDiffer, 'function')
  assert.equal(API.fractionsDiffer([0.5, 0.5], [0.505, 0.495]), false)
  assert.equal(API.fractionsDiffer([0.5, 0.5], [0.52, 0.48]), true)
})

test('layoutSignature: docked panes and effective tabs, ignoring sizes and floats', () => {
  assert.equal(typeof API.layoutSignature, 'function')
  assert.equal(typeof API.dockedPanes, 'function')
  const layout = dockLayout()
  const signature = API.layoutSignature(layout)
  assert.equal(signature, 'pane1:tab8|pane12:tab14', 'the signature is built from docked panes and their effective tabs')
  layout.nodes.split13.sizes = [0.3, 0.7]
  assert.equal(API.layoutSignature(layout), signature, 'a size-only change keeps the signature')
  layout.nodes.float1 = { id: 'float1', kind: 'pane', host: 'float', tabs: ['tab8'] }
  assert.equal(API.layoutSignature(layout), signature, 'floating panes are ignored')
  layout.nodes.pane1.tabs = []
  assert.equal(API.layoutSignature(layout), 'pane12:tab14', 'a docked pane with no tabs is left out')
  layout.nodes.pane1.tabs = ['tab8']
  layout.tabs.tab15 = { id: 'tab15', kind: 'other', contentId: 'tab15', title: 'Other' }
  layout.nodes.pane12.activeTabId = 'tab15'
  assert.notEqual(API.layoutSignature(layout), signature, 'a new active tab changes the signature')
})

test('userWidths: only a like-for-like manual change is remembered', () => {
  assert.equal(typeof API.userWidths, 'function')
  const signature = 'pane1:tab8'
  const baseline = { sessionId: SID, signature, viewport: 1280, sidebar: 240, widths: { t1: 400 } }
  const measured = [{ paneId: 'p1', tabId: 't1', kind: GIT_KIND, width: 420 }]
  const input = {
    baseline,
    measured,
    viewportNow: 1280,
    sidebarNow: 240,
    sessionId: SID,
    signature,
  }
  assert.deepEqual(plain(API.userWidths(input)), { t1: 420 }, 'a change over 8 px is remembered')
  assert.deepEqual(plain(API.userWidths({ ...input, measured: [{ ...measured[0], width: 405 }] })), {})
  assert.deepEqual(plain(API.userWidths({ ...input, viewportNow: 1300 })), {}, 'a viewport change is not a resize')
  assert.deepEqual(plain(API.userWidths({ ...input, sidebarNow: 300 })), {}, 'a sidebar change is not a resize')
  assert.deepEqual(plain(API.userWidths({ ...input, sessionId: 'session-2' })), {}, 'another session is not compared')
  assert.deepEqual(plain(API.userWidths({ ...input, signature: 'pane1:tab9' })), {}, 'another signature is not compared')
  assert.deepEqual(
    plain(API.userWidths({ ...input, measured: [{ ...measured[0], kind: ENV_KIND }] })),
    {},
    'Environment never gets a remembered width',
  )
})

/* ------------------------------------------------------------------ */
/* The effectful part                                                  */
/* ------------------------------------------------------------------ */

test('apply settles before writing, then sets split fractions from the redrawn panes', () => {
  assert.equal(typeof API.createPaneSizing, 'function')
  const { harness } = started({ domOptions: { delay: 2 } })
  harness.controller.request(SID)
  assert.equal(harness.timers.pending().length, 1, 'a request schedules one debounce timer')
  assert.equal(harness.layout.calls.length, 0, 'nothing is written before the timer')

  flushDebounce(harness)
  flushFrame(harness)
  assert.equal(harness.frames.length > 0, true, 'the measurement settles over more frames')
  assert.equal(harness.layout.calls.length, 0, 'phase one waits for a stable measurement before writing')
  drainRest(harness)
  assert.equal(harness.layout.calls.length, 1, 'the column is applied once')
  assert.equal(harness.layout.calls[0], 1002, 'the target is (1680 - 324) / 2 + 324')
  assert.equal(harness.store.resizeCalls.length, 1, 'the split is resized once')
  const fractions = harness.store.resizeCalls[0][2]
  assert.ok(Math.abs(fractions[0] - 324 / 1002) < 0.01, 'fractions come from the redrawn 1002 px column')
  assert.ok(Math.abs(fractions[0] + fractions[1] - 1) < 1e-9)
})

test('the baseline is recorded after the last write, so no user resize is invented', () => {
  const { harness, controller } = started()
  controller.request(SID)
  applyNow(harness)
  assert.equal(harness.store.resizeCalls.length, 1, 'the first apply resized the split')
  assert.deepEqual(plain(savedWidths(harness)[SID] ?? {}), {}, 'no width is remembered from a passive first apply')

  /* A second, identical apply used to compare the redrawn panes against a baseline taken
     BEFORE resizeSplit, and saved a fake "user" width. */
  controller.request(SID)
  applyNow(harness)
  assert.deepEqual(plain(savedWidths(harness)[SID] ?? {}), {}, 'no width is remembered without a user resize')
})

test('apply skips resizeSplit when every current fraction is already within 0.01', () => {
  const { harness } = started()
  harness.controller.request(SID)
  applyNow(harness)
  assert.equal(harness.store.resizeCalls.length, 1)
  harness.layout.calls.length = 0
  harness.store.resizeCalls.length = 0

  harness.controller.request(SID)
  applyNow(harness)
  assert.equal(harness.layout.calls.length, 1, 'the column is still applied')
  assert.equal(harness.store.resizeCalls.length, 0, 'no undo step for an unchanged split')
})

test('rule 5: nothing happens when closed, fullscreen, without a docked pane or for another session', () => {
  const fullscreen = started()
  fullscreen.harness.tree.mode = 'fullscreen'
  fullscreen.controller.request(SID)
  applyNow(fullscreen.harness)
  assert.equal(fullscreen.harness.layout.calls.length, 0, 'fullscreen is ignored')

  const closed = started({ domOptions: { column: 0 } })
  closed.controller.request(SID)
  applyNow(closed.harness)
  assert.equal(closed.harness.layout.calls.length, 0, 'a zero-width column is ignored')

  const tree = dockLayout()
  tree.nodes.pane1.host = 'float'
  tree.nodes.pane12.host = 'float'
  const floating = started({ tree })
  floating.controller.request(SID)
  applyNow(floating.harness)
  assert.equal(floating.harness.layout.calls.length, 0, 'floating panes are ignored')

  const other = started()
  other.controller.request('session-2')
  applyNow(other.harness)
  assert.equal(other.harness.layout.calls.length, 0, 'a request for another session is ignored')
})

test('a signature change triggers an apply; a sizes-only change does not', () => {
  const { harness } = started()
  harness.controller.request(SID)
  applyNow(harness)
  harness.layout.calls.length = 0

  harness.store.emit()
  assert.equal(harness.timers.pending().length, 0, 'a no-op notification schedules nothing')
  assert.equal(harness.layout.calls.length, 0)

  harness.tree.nodes.split13.sizes = [0.3, 0.7]
  harness.store.emit()
  assert.equal(harness.timers.pending().length, 0, 'a divider drag schedules nothing')
  assert.equal(harness.layout.calls.length, 0, 'a divider drag does not apply')

  harness.tree.tabs.tab15 = { id: 'tab15', kind: 'other', contentId: 'tab15', title: 'Other' }
  harness.tree.nodes.pane12.activeTabId = 'tab15'
  harness.store.emit()
  assert.equal(harness.timers.pending().length, 1, 'a new active tab schedules one apply')
  applyNow(harness)
  assert.ok(harness.layout.calls.length > 0, 'a new active tab applies')
})

test('a session switch re-subscribes to its store; a replaced store is re-subscribed before an apply', () => {
  const { harness } = started()
  harness.controller.request(SID)
  applyNow(harness)

  const tree2 = dockLayout() // tab14 also exists here, but it belongs to another session
  const store2 = makeStore('session-2', tree2, harness.dom)
  harness.adopted.set('session-2', { store: store2, unsubscribe() {} })
  harness.mounted.set('session-2')
  assert.equal(harness.store.listeners.size, 0, 'the old store was released')
  assert.equal(store2.listeners.size, 1, 'the new store is subscribed')
  harness.layout.calls.length = 0
  applyNow(harness)
  assert.equal(harness.layout.calls.length, 1, 'the new session applies')
  assert.deepEqual(plain(savedWidths(harness))['session-2'] ?? {}, {}, 'the old session baseline is not compared')

  harness.dom.state.fractions = [0.5, 0.5]
  tree2.nodes.split13.sizes = [0.5, 0.5]
  const store2b = makeStore('session-2', tree2, harness.dom)
  harness.adopted.set('session-2', { store: store2b, unsubscribe() {} })
  harness.controller.request('session-2')
  assert.equal(store2.listeners.size, 0, 'the replaced store was released')
  assert.equal(store2b.listeners.size, 1, 'the current store is subscribed before the apply')
  applyNow(harness)
  assert.equal(store2b.resizeCalls.length, 1, 'the replacement store received the resize')
})

test('a session switch cannot turn the shared column resize into a remembered width', () => {
  const { harness, controller } = started()
  controller.request(SID)
  applyNow(harness)

  /* A real drag of the divider, kept as this session's remembered width. */
  harness.dom.state.fractions = [1 - 540 / 1002, 540 / 1002]
  harness.tree.nodes.split13.sizes = harness.dom.state.fractions.slice()
  controller.request(SID)
  applyNow(harness)
  assert.equal(savedWidths(harness)[SID].tab14, 540, 'a real drag is remembered')

  /* Session B applies with the same shared column; that must invalidate A's baseline. */
  const store2 = makeStore('session-2', dockLayout(), harness.dom)
  harness.adopted.set('session-2', { store: store2, unsubscribe() {} })
  harness.mounted.set('session-2')
  applyNow(harness)
  assert.ok(harness.layout.calls.length > 0, 'session B applied')

  /* Back in A, the widths B left on screen must not be read as a user resize of A. */
  harness.mounted.set(SID)
  applyNow(harness)
  assert.equal(savedWidths(harness)[SID].tab14, 540, 'A keeps its remembered width')
  assert.deepEqual(Object.keys(savedWidths(harness)[SID]).sort(), ['tab14'], 'no other width was remembered')
})

test('a new apply cancels the previous settle chain so a stale resizeSplit never runs', () => {
  const { harness, controller } = started({ domOptions: { delay: 3 } })
  controller.request(SID)
  flushDebounce(harness)
  let waited = 0
  while (harness.layout.calls.length === 0 && waited < 12) {
    flushFrame(harness)
    waited += 1
  }
  assert.equal(harness.layout.calls.length, 1, 'phase one wrote the column for the two-pane layout')

  /* The structure changes while the first chain is still settling. */
  harness.tree.nodes.pane12.host = 'float'
  controller.request(SID)
  applyNow(harness)
  assert.equal(harness.store.resizeCalls.length, 0, 'the cancelled two-pane chain did not resize the split')
  assert.equal(harness.layout.calls.length, 2, 'only the new one-pane apply wrote the column')
})

test('a changed signature never saves the width of the pane that stayed open', () => {
  const { harness, controller } = started()
  controller.request(SID)
  applyNow(harness)
  assert.deepEqual(plain(savedWidths(harness)[SID] ?? {}), {})

  /* Close the Environment pane. Git stays open but its measured width changes because the
     targets change; the new signature must stop the old baseline being used as a comparison. */
  harness.tree.nodes.pane1.host = 'float'
  controller.request(SID)
  applyNow(harness)
  assert.deepEqual(plain(savedWidths(harness)[SID] ?? {}), {}, 'a signature change cannot invent a remembered width')
})

test('a rail request and a structure change in the same tick apply once', () => {
  const harness = makeDeps()
  const disposers = []
  const ctx = {
    effect(callback) {
      disposers.push(callback())
      return () => {}
    },
  }
  API.mount(ctx, harness.deps)
  assert.equal(typeof API.PANE_SIZING.apply, 'function', 'the sizing feature installs the rail hook')

  API.PANE_SIZING.apply(SID)
  harness.tree.nodes.pane12.activeTabId = 'tab15'
  harness.tree.tabs.tab15 = { id: 'tab15', kind: 'other', contentId: 'tab15', title: 'Other' }
  harness.store.emit()
  assert.equal(harness.timers.pending().length, 1, 'one debounce timer serves both triggers')

  applyNow(harness)
  assert.equal(harness.layout.calls.length, 1, 'the two triggers applied once')
})

test('a request while the phase-one frame is still pending is not lost', () => {
  const harness = makeDeps()
  const ctx = {
    effect(callback) {
      callback()
      return () => {}
    },
  }
  API.mount(ctx, harness.deps)
  API.PANE_SIZING.apply(SID)
  // The debounce fires, but the frame does not (frames pause in a hidden window).
  flushDebounce(harness)
  assert.equal(harness.frames.length, 1, 'the phase-one frame is pending')
  API.PANE_SIZING.apply(SID)
  assert.equal(harness.frames.length, 0, 'the newer request drops the stale phase-one frame')
  applyNow(harness)
  assert.equal(harness.layout.calls.length, 1, 'the newer request still applies, once')
})

test('remembered widths: a manual divider drag is kept, a viewport change is not', () => {
  const { harness, controller } = started()
  controller.request(SID)
  applyNow(harness)

  /* The user drags the divider: fractions change without an automatic resizeSplit. */
  harness.dom.state.fractions = [0.25, 0.75]
  harness.tree.nodes.split13.sizes = [0.25, 0.75]
  harness.store.emit() // a sizes-only change does not trigger an apply
  controller.request(SID)
  applyNow(harness)
  assert.equal(savedWidths(harness)[SID].tab14, 752, 'the >8 px manual change is remembered (0.75 x 1002)')

  harness.dom.state.fractions = [0.3, 0.7]
  harness.dom.state.viewport = 1600
  harness.dom.state.frameWidth = 1600
  controller.request(SID)
  applyNow(harness)
  assert.equal(savedWidths(harness)[SID].tab14, 752, 'a viewport change does not overwrite it')
})

test('remembered widths: Environment is never stored, a closed tab is forgotten', () => {
  const { harness, controller } = started()
  controller.request(SID)
  applyNow(harness)

  harness.dom.state.fractions = [0.6, 0.4]
  controller.request(SID)
  applyNow(harness)
  let saved = savedWidths(harness)
  assert.equal(saved[SID].tab8, undefined, 'Environment never gets a remembered width')
  assert.equal(saved[SID].tab14, 401, 'the other tab was stored before it closed (0.4 x 1002)')

  harness.tree.nodes.pane12.tabs = ['tab15']
  harness.tree.tabs.tab15 = { id: 'tab15', kind: 'other', contentId: 'tab15', title: 'Other' }
  delete harness.tree.tabs.tab14
  controller.request(SID)
  applyNow(harness)
  saved = savedWidths(harness)
  assert.equal((saved[SID] ?? {}).tab14, undefined, 'a tab that left layout.tabs is forgotten')
})

test('pruning reads one store per session and only prunes the session being read', () => {
  const data = {
    [STORAGE_KEY]: JSON.stringify({
      [SID]: { tabX: 222 }, // tabX is not open in SID's layout
      'session-2': { tabY: 333 }, // its store is gone, but it still has a remembered tab
    }),
  }
  const storage = makeStorage({ data })
  const { harness } = started({ storage })
  const pruned = savedWidths(harness)
  assert.equal((pruned[SID] ?? {}).tabX, undefined, 'a tab no longer open in the read session is pruned')
  assert.equal(pruned['session-2'].tabY, 333, 'another session is not erased by this session snapshot')
  const writesAfterPrune = storage.writes.length
  harness.controller.request(SID)
  applyNow(harness)
  assert.equal(storage.writes.length, writesAfterPrune, 'an unchanged remembered value is not written again')
})

test('an absent session with no remembered tabs is dropped, and the store keeps at most 50 sessions', () => {
  const entries = { 'session-old': {} }
  for (let i = 0; i < 51; i += 1) entries['s' + String(i).padStart(2, '0')] = { tabX: i }
  const storage = makeStorage({ data: { [STORAGE_KEY]: JSON.stringify(entries) } })
  const { harness } = started({ storage })
  const pruned = savedWidths(harness)
  assert.equal(pruned['session-old'], undefined, 'an absent session with no remembered tabs is dropped')
  assert.equal(Object.keys(pruned).length, 50, 'at most 50 sessions are kept')
  assert.equal(pruned.s00, undefined, 'the oldest written session is dropped first')
  assert.equal(pruned.s50.tabX, 50, 'the newest session is kept')
})

test('storage failures are tolerated', () => {
  const { harness, controller } = started({ storage: makeStorage({ throwGet: true, throwSet: true }) })
  controller.request(SID)
  applyNow(harness)
  assert.equal(harness.layout.calls.length, 1, 'a storage failure does not stop the feature')
})

test('dispose releases every subscription, timer, frame and the rail hook', () => {
  const harness = makeDeps()
  const disposers = []
  const ctx = {
    effect(callback) {
      disposers.push(callback())
      return () => {}
    },
  }
  API.mount(ctx, harness.deps)
  assert.equal(typeof API.PANE_SIZING.apply, 'function')
  assert.equal(harness.mounted.listeners.size, 1)
  assert.equal(harness.store.listeners.size, 1)

  API.PANE_SIZING.apply(SID)
  assert.equal(harness.timers.pending().length, 1)
  flushDebounce(harness)
  assert.equal(harness.frames.length, 1)

  disposers[0]()
  assert.equal(API.PANE_SIZING.apply, null, 'dispose uninstalls the rail hook')
  assert.equal(harness.mounted.listeners.size, 0)
  assert.equal(harness.store.listeners.size, 0)
  assert.equal(harness.timers.pending().length, 0, 'the debounce timer was cleared')
  assert.equal(harness.frames.length, 0, 'the animation frame was cancelled')
})

/* ------------------------------------------------------------------ */
/* Startup (first load)                                               */
/* ------------------------------------------------------------------ */

function environmentOnlyLayout() {
  return {
    nodes: { pane1: { id: 'pane1', kind: 'pane', host: 'dock', tabs: ['tab8'] } },
    tabs: { tab8: { id: 'tab8', kind: ENV_KIND, contentId: 'tab8', title: 'Environment' } },
    rootId: 'pane1',
    floats: [],
    activePaneId: 'pane1',
    expanded: true,
    mode: 'push',
  }
}

test('startup: a session already on screen applies once on mount, without any other trigger', () => {
  const { harness } = started({
    tree: environmentOnlyLayout(),
    domOptions: { paneIds: ['pane1'], fractions: [1] },
  })
  assert.equal(harness.timers.pending().length, 1, 'start() schedules one startup apply for the mounted session')
  assert.equal(harness.timers.pending()[0].delay, APPLY_DELAY, 'it goes through the same debounced queue')
  pumpAttempt(harness)
  assert.equal(harness.layout.calls.length, 1, 'the column is applied once without a store, rail or mounted trigger')
  assert.equal(harness.layout.calls[0], ENV_PX, 'an Environment-only layout gets its 324 px column')
  assert.equal(harness.timers.pending().length, 0, 'no retry is scheduled when the column is present')
})

test('startup: a fullscreen layout ends startup at once, with no write and no retry', () => {
  const tree = environmentOnlyLayout()
  tree.mode = 'fullscreen'
  const { harness } = started({ tree, domOptions: { paneIds: ['pane1'], fractions: [1] } })
  pumpAttempt(harness)
  assert.equal(harness.layout.calls.length, 0, 'nothing is written while the sidebar is full screen')
  assert.equal(harness.timers.pending().length, 0, 'full screen is an answer, not a reason to retry')

  tree.mode = 'push'
  harness.dom.state.column = 0
  harness.controller.request(harness.sessionId)
  pumpAttempt(harness)
  assert.equal(harness.layout.calls.length, 0, 'a later failing request still writes nothing')
  assert.equal(harness.timers.pending().length, 0, 'fullscreen closed startup, so the failure gets no retry')
})

test('startup: a column absent at first but present on the 3rd retry applies then, with no further retries', () => {
  const { harness } = started({ domOptions: { column: 0 } })
  pumpAttempt(harness) // initial attempt: no column
  assert.equal(harness.layout.calls.length, 0)
  advanceRetry(harness) // retry 1: still no column
  advanceRetry(harness) // retry 2: still no column
  harness.dom.state.column = 600
  advanceRetry(harness) // retry 3: the column is there now
  assert.equal(harness.layout.calls.length, 1, 'the apply happens on the retry that finds the column')
  assert.equal(harness.timers.countFired(RETRY_DELAY), 3, 'exactly three retries were used')
  assert.equal(harness.timers.pending().length, 0, 'a successful apply leaves no retry pending')
  harness.timers.fireAll()
  pumpAttempt(harness)
  assert.equal(harness.layout.calls.length, 1, 'no further attempt runs after a success')
})

test('startup: a column that never appears stops after 20 retries with no timer left', () => {
  const { harness } = started({ domOptions: { column: 0 } })
  pumpAttempt(harness) // initial attempt
  for (let i = 0; i < MAX_STARTUP_RETRIES; i += 1) advanceRetry(harness)
  assert.equal(harness.layout.calls.length, 0, 'nothing was written without a column')
  assert.equal(harness.timers.countFired(RETRY_DELAY), MAX_STARTUP_RETRIES, '20 retries were fired')
  assert.equal(harness.timers.countFired(APPLY_DELAY), MAX_STARTUP_RETRIES + 1, 'one apply per attempt')
  assert.equal(harness.timers.pending().length, 0, 'the retry loop stopped on its own')
  assert.equal(harness.frames.length, 0, 'no frame is left pending')
})

test('startup: dispose during the retry wait leaves no apply and no timer', () => {
  const { harness, controller } = started({ domOptions: { column: 0 } })
  pumpAttempt(harness)
  assert.equal(harness.timers.pending().length, 1, 'a retry is pending when dispose runs')
  controller.dispose()
  assert.equal(harness.layout.calls.length, 0, 'no apply happened')
  assert.equal(harness.timers.pending().length, 0, 'the retry timer was cleared')
  assert.equal(harness.frames.length, 0, 'no frame is left pending')
  harness.timers.fireAll()
  assert.equal(harness.layout.calls.length, 0, 'a fired timer after dispose cannot apply')
})

test('startup: a structure change during the retry wait cancels the pending retry and writes once', () => {
  const { harness } = started({ domOptions: { column: 0 } })
  pumpAttempt(harness)
  assert.equal(harness.timers.pending().length, 1, 'a retry is pending before the structure change')
  assert.equal(harness.timers.pending()[0].delay, RETRY_DELAY)

  harness.dom.state.column = 600
  harness.tree.nodes.pane12.activeTabId = 'tab15'
  harness.tree.tabs.tab15 = { id: 'tab15', kind: 'other', contentId: 'tab15', title: 'Other' }
  harness.store.emit() // startup is still open, so this request is another startup attempt
  applyNow(harness)
  assert.equal(harness.layout.calls.length, 1, 'the structure change applies once')
  assert.equal(harness.timers.countFired(RETRY_DELAY), 0, 'the new request cancelled the pending retry')
  assert.equal(harness.timers.pending().length, 0, 'the successful write closes startup, so no retry is left')
})

test('startup: a layout with no docked pane retries until a pane appears, then writes once', () => {
  const tree = environmentOnlyLayout()
  tree.nodes.pane1.host = 'float'
  tree.floats = ['pane1']
  const { harness } = started({ tree, domOptions: { paneIds: ['pane1'], fractions: [1] } })
  pumpAttempt(harness)
  assert.equal(harness.layout.calls.length, 0, 'a float-only layout writes nothing')
  assert.equal(harness.timers.pending().length, 1, 'a startup retry is pending')
  assert.equal(harness.timers.pending()[0].delay, RETRY_DELAY)

  tree.nodes.pane1.host = 'dock' // the pane docks before the retry fires
  tree.floats = []
  advanceRetry(harness)
  assert.equal(harness.layout.calls.length, 1, 'the retry that finds the pane writes once')
  assert.equal(harness.layout.calls[0], ENV_PX, 'the Environment column gets its size')
  assert.equal(harness.timers.pending().length, 0, 'no retry is left')
})

test('startup: a layout that is not adopted yet retries until the store appears', () => {
  const { harness } = started({ adopted: new Map() })
  pumpAttempt(harness)
  assert.equal(harness.layout.calls.length, 0, 'no layout means no write')
  assert.equal(harness.timers.pending().length, 1, 'a startup retry is pending')
  assert.equal(harness.timers.pending()[0].delay, RETRY_DELAY)

  harness.adopted.set(SID, { store: harness.store, unsubscribe() {} })
  advanceRetry(harness)
  assert.equal(harness.layout.calls.length, 1, 'the retry that finds the store writes once')
  assert.equal(harness.timers.pending().length, 0, 'no retry is left')
})

test('startup: a column still moving at the settle limit retries until it stabilises', () => {
  const base = makeDeps()
  let calls = 0
  // The first settle chain never sees two equal frames; after 10 measurements the column is still.
  const wobble = () => {
    calls += 1
    const measured = base.dom.measure()
    if (measured.found && calls <= 10) return { ...measured, column: measured.column + (calls % 2) }
    return measured
  }
  const controller = API.createPaneSizing({ ...base.deps, measure: wobble })
  base.controller = controller
  controller.start()
  pumpAttempt(base)
  assert.equal(calls, 10, 'the first attempt ran all ten settle measurements')
  assert.equal(base.layout.calls.length, 0, 'an unsettled column is not written')
  assert.equal(base.timers.pending().length, 1, 'the settle give-up schedules a startup retry')
  assert.equal(base.timers.pending()[0].delay, RETRY_DELAY)

  advanceRetry(base)
  assert.equal(base.layout.calls.length, 1, 'the retry on a stable column writes once')
  assert.equal(base.timers.pending().length, 0, 'no retry is left')
})

test('startup: a session appearing after start retries when its column is still moving', () => {
  const base = makeDeps({ mounted: makeMounted(undefined) })
  let measures = 0
  // The first attempt never sees two equal frames; after ten measurements the column is still.
  const wobble = () => {
    measures += 1
    const measured = base.dom.measure()
    if (measured.found && measures <= 10) return { ...measured, column: measured.column + (measures % 2) }
    return measured
  }
  const controller = API.createPaneSizing({ ...base.deps, measure: wobble })
  base.controller = controller
  controller.start()
  assert.equal(base.timers.pending().length, 0, 'start() with no session schedules no timer')
  assert.equal(base.layout.calls.length, 0, 'start() with no session writes nothing')

  base.mounted.set(SID) // the session appears through the mounted subscription
  pumpAttempt(base)
  assert.equal(measures, 10, 'the mounted-session attempt ran all ten settle measurements')
  assert.equal(base.layout.calls.length, 0, 'a column still moving at the settle limit is not written')
  assert.equal(base.timers.pending().length, 1, 'the mounted-session attempt is a startup attempt: it retries')
  assert.equal(base.timers.pending()[0].delay, RETRY_DELAY)

  advanceRetry(base)
  assert.equal(base.layout.calls.length, 1, 'the retry writes once the column is settled')
  assert.equal(base.timers.pending().length, 0, 'the successful write leaves no retry')
  assert.equal(base.timers.countFired(APPLY_DELAY), 2, 'one apply for the mount, one for the retry')
})

test('startup: a structure-change attempt that fails still retries before the first write', () => {
  const tree = environmentOnlyLayout()
  const { harness } = started({ tree, domOptions: { paneIds: ['pane1'], fractions: [1], column: 0 } })
  pumpAttempt(harness)
  assert.equal(harness.layout.calls.length, 0, 'the first attempt found no column')
  assert.equal(harness.timers.pending().length, 1, 'it scheduled a startup retry')

  harness.tree.nodes.pane1.activeTabId = 'tab15'
  harness.tree.tabs.tab15 = { id: 'tab15', kind: 'other', contentId: 'tab15', title: 'Other' }
  harness.store.emit() // the structure change brings its own request while startup is still open
  pumpAttempt(harness)
  assert.equal(harness.layout.calls.length, 0, 'the structure-change attempt also found no column')
  assert.equal(harness.timers.countFired(RETRY_DELAY), 0, 'its request cancelled the pending retry')
  assert.equal(harness.timers.pending().length, 1, 'a failed attempt before any write still schedules a retry')
  assert.equal(harness.timers.pending()[0].delay, RETRY_DELAY)

  harness.dom.state.column = 600
  advanceRetry(harness)
  assert.equal(harness.layout.calls.length, 1, 'the later retry writes once')
  assert.equal(harness.timers.pending().length, 0, 'the successful write leaves no retry')
})

test('startup: mixed triggers share one 20-retry budget and leave no timer', () => {
  const { harness } = started({ domOptions: { column: 0 } })
  pumpAttempt(harness) // first attempt: no column
  let tabNo = 0
  const changeStructure = () => {
    tabNo += 1
    const tab = 'tab' + tabNo
    harness.tree.nodes.pane12.activeTabId = tab
    harness.tree.tabs[tab] = { id: tab, kind: 'other', contentId: tab, title: 'Other' }
    harness.store.emit()
    pumpAttempt(harness)
  }
  for (let i = 0; i < MAX_STARTUP_RETRIES; i += 1) {
    if (i % 2 === 0) changeStructure() // a structure change brings its own attempt
    else advanceRetry(harness) // a retry timer brings its own attempt
    if (i < MAX_STARTUP_RETRIES - 1) {
      assert.equal(harness.timers.pending().length, 1, 'every failed attempt leaves one retry until the budget runs out')
    }
  }
  assert.equal(harness.layout.calls.length, 0, 'no column, so nothing was written')
  assert.equal(harness.timers.countFired(APPLY_DELAY), MAX_STARTUP_RETRIES + 1, 'one apply per attempt')
  assert.equal(harness.timers.pending().length, 0, 'the shared budget is used up with no timer left')
  assert.equal(harness.frames.length, 0, 'no frame is left pending')

  changeStructure() // a later trigger must not reopen the exhausted budget
  assert.equal(harness.timers.pending().length, 0, 'a request after the budget is used up does not retry')
})

test('startup: after the first write, a moving column does not schedule a retry', () => {
  const base = makeDeps()
  let wobbling = false
  let measures = 0
  const measure = () => {
    const measured = base.dom.measure()
    if (!wobbling) return measured
    measures += 1
    if (measures <= 10) return { ...measured, column: measured.column + (measures % 2) }
    return measured
  }
  const controller = API.createPaneSizing({ ...base.deps, measure })
  base.controller = controller
  controller.start()
  pumpAttempt(base)
  assert.equal(base.layout.calls.length, 1, 'the startup attempt wrote once')
  assert.equal(base.timers.pending().length, 0, 'the write closed startup with no retry')

  wobbling = true
  measures = 0
  base.tree.nodes.pane12.activeTabId = 'tab15'
  base.tree.tabs.tab15 = { id: 'tab15', kind: 'other', contentId: 'tab15', title: 'Other' }
  base.store.emit()
  pumpAttempt(base)
  assert.equal(base.layout.calls.length, 1, 'the still-moving column was not written')
  assert.equal(base.timers.pending().length, 0, 'a failure once startup is closed schedules no retry')
})

test('startup: start() with no session schedules no timer and writes nothing', () => {
  const { harness } = started({ mounted: makeMounted(undefined) })
  assert.equal(harness.timers.pending().length, 0, 'no session at start: no timer is scheduled')
  assert.equal(harness.frames.length, 0, 'no session at start: no frame is scheduled')
  harness.timers.fireAll()
  assert.equal(harness.layout.calls.length, 0, 'no session at start: nothing is written')
})

test('startup: a setRightbar that throws retries instead of recording a baseline', () => {
  const base = makeDeps()
  const setRightbar = base.layout.panels.setRightbar
  let throws = 1
  base.layout.panels.setRightbar = px => {
    if (throws > 0) {
      throws -= 1
      throw new Error('dsh rejected the write')
    }
    setRightbar(px)
  }
  const controller = API.createPaneSizing(base.deps)
  base.controller = controller
  controller.start()
  pumpAttempt(base)
  assert.equal(base.layout.calls.length, 0, 'a rejected write is not a successful write')
  assert.equal(base.timers.pending().length, 1, 'a rejected startup write schedules a retry')
  assert.equal(base.timers.pending()[0].delay, RETRY_DELAY)
  assert.deepEqual(savedWidths(base), {}, 'the rejected write recorded no baseline or user width')

  // Move the panes before the retry: had the rejected write recorded a baseline, the retry
  // would read this change as a user resize and save it.
  base.dom.state.fractions = [0.25, 0.75]
  advanceRetry(base)
  assert.equal(base.layout.calls.length, 1, 'the retry writes once')
  assert.equal(base.timers.pending().length, 0, 'the successful write leaves no retry')
  assert.deepEqual(plain(savedWidths(base)), {}, 'no user width was recorded while startup was open')
})

test('startup: a session switch replaces the pending retry and retries for the new session', () => {
  const base = makeDeps({ domOptions: { column: 0 } })
  const controller = API.createPaneSizing(base.deps)
  base.controller = controller
  controller.start()
  pumpAttempt(base)
  assert.equal(base.timers.pending().length, 1, 'the first session is waiting to retry')

  const otherStore = makeStore('session-2', dockLayout(), base.dom)
  base.adopted.set('session-2', { store: otherStore, unsubscribe() {} })
  base.mounted.set('session-2')
  pumpAttempt(base)
  assert.equal(base.timers.countFired(RETRY_DELAY), 0, 'the switch cancelled the pending retry')
  assert.equal(base.timers.pending().length, 1, 'the new session has its own retry pending')

  base.dom.state.column = 600
  advanceRetry(base)
  assert.equal(base.layout.calls.length, 1, 'the retry writes once for the new session')
  assert.equal(base.layout.calls[0], ENV_PX + (AVAILABLE - ENV_PX) / 2, 'the new session gets its own column')
  assert.equal(base.timers.pending().length, 0, 'the successful write leaves no retry')
  assert.deepEqual(savedWidths(base), {}, 'no user width was recorded while startup was open')
})

test('missing internals warn once and register nothing', () => {
  const loaded = loadParts([SHARED, SIZING])
  const absent = {
    get() { return undefined },
    effect(callback) { callback(); return () => {} },
  }
  assert.doesNotThrow(() => loaded.api.mount(absent), 'a host without layout or sidebarRight warns')
  const broken = {
    get(name) {
      if (name === 'layout') return { panels: {} } // no setRightbar
      if (name === 'sidebarRight') {
        return { adopted: new Map(), mounted: { getSnapshot: () => SID, subscribe: () => () => {} } }
      }
      return undefined
    },
    effect(callback) { callback(); return () => {} },
  }
  assert.doesNotThrow(() => loaded.api.mount(broken))
  assert.equal(loaded.warnings.length, 1, 'one warning however many mounts')
  assert.equal(loaded.api.PANE_SIZING.apply, null, 'the rail hook stays uninstalled')
})

/* ------------------------------------------------------------------ */
/* DOM reading                                                         */
/* ------------------------------------------------------------------ */

test('measureDom reads A from the conversation and measures panes inside the column only', () => {
  const inside = { getAttribute: () => 'pane1', getBoundingClientRect: () => ({ width: 324 }) }
  const outside = { getAttribute: () => 'pane-out', getBoundingClientRect: () => ({ width: 999 }) }
  const column = {
    getBoundingClientRect: () => ({ width: 1002, left: 918, right: 1920 }),
    querySelectorAll: () => [inside],
  }
  const conversation = { getBoundingClientRect: () => ({ left: 240, width: 678 }) }
  const frame = {
    getBoundingClientRect: () => ({ left: 0 }),
    children: [{ getBoundingClientRect: () => ({ width: 240 }) }, conversation, column],
    querySelectorAll: () => [outside],
  }
  column.parentElement = frame
  const document = {
    querySelector(selector) { return String(selector).includes('rightbar-col') ? column : null },
    querySelectorAll() { return [outside] },
  }
  const loaded = loadParts([SHARED, SIZING], { document, window: { innerWidth: 1920 } })
  assert.equal(typeof loaded.api.measureDom, 'function')
  const measured = loaded.api.measureDom()
  assert.equal(measured.found, true)
  assert.equal(measured.sidebar, 240, 'sidebar = conversation.left - frame.left')
  assert.equal(measured.available, 1680, 'A = column.right - conversation.left')
  assert.deepEqual(plain(measured.panes), { pane1: 324 }, 'only panes inside the column are measured')

  conversation.getBoundingClientRect = () => ({ left: 240, width: 0 })
  assert.equal(loaded.api.measureDom().found, false, 'a zero-width conversation does nothing')
  frame.children.splice(0, 2) // the column is now the first child: no element precedes it
  conversation.getBoundingClientRect = () => ({ left: 240, width: 678 })
  assert.equal(loaded.api.measureDom().found, false, 'a missing conversation does nothing')
})

test('rail goTab requests an apply for the session on screen', () => {
  const loaded = loadParts([SHARED, SIZING, RAIL])
  const opened = []
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'sidebarRightTabs') {
        return {
          guide: () => [{ kind: GIT_KIND, id: 'e1', title: 'Git', providerId: 'p' }],
          subscribe: () => () => {},
        }
      }
      if (name === 'sidebarRight') {
        return {
          openTab(kind) { opened.push(kind) },
          isExpanded: () => false,
          mounted: { getSnapshot: () => 'session-rail', subscribe: () => () => {} },
        }
      }
      return undefined
    },
    slots: { inject() {}, register() { return () => {} } },
    effect() { return () => {} },
    on() { return () => {} },
  }
  assert.equal(typeof loaded.api.Rail, 'function')
  loaded.api.PANE_SIZING.apply = sessionId => calls.push(sessionId)

  let tree = null
  for (let pass = 0; pass < 2; pass += 1) {
    loaded.stub.rewind()
    tree = loaded.api.Rail({ ctx })
    for (const effect of loaded.stub.takeEffects()) {
      try {
        effect()
      } catch (error) {
        /* the rail guards its own effect bodies */
      }
    }
  }
  const buttons = []
  const collectButtons = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(collectButtons)
      return
    }
    if (node.type === 'button') buttons.push(node)
    ;(node.children || []).forEach(collectButtons)
  }
  collectButtons(tree)
  assert.equal(buttons.length, 1, 'the rail rendered one entry')
  buttons[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(opened, [GIT_KIND], 'openTab still runs')
  assert.deepEqual(calls, ['session-rail'], 'the rail requests an apply for the session on screen')
})

function drainRest(harness) {
  let guard = 0
  while (harness.frames.length && guard < 40) {
    flushFrame(harness)
    guard += 1
  }
  assert.ok(guard < 40, 'the fake DOM settles')
}

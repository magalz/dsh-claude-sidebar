/**
 * Acceptance tests for the icon rail (features/rail/client/rail.js).
 *
 * They drive the real generated client.js through a fake window.__ModuleLoader__, with a
 * minimal React stub that keeps hook state, returns { type, props, children } trees and
 * collects effect exceptions, following the approach of the source plugin's
 * tests/render-smoke.test.mjs. No jsdom, no dsh process.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLIENT = path.join(ROOT, 'client.js')
const SHARED_PART = path.join(ROOT, 'client', 'shared.js')
const RAIL_PART = path.join(ROOT, 'features', 'rail', 'client', 'rail.js')
const RAIL_ID = 'dsh-claude-sidebar/rail'

/** A synchronous feature-list answer: apply() mounts in the same turn, all features on. */
function syncChain(value) {
  const chain = {
    then(fn) {
      try {
        const out = fn(value)
        return out !== null && typeof out === 'object' && typeof out.then === 'function' ? out : syncChain(out)
      } catch (error) {
        return syncChain(error)
      }
    },
    catch() { return chain },
  }
  return chain
}
function featureFetch() {
  return () => syncChain({
    ok: true,
    status: 200,
    json: () => syncChain({ features: ['rail', 'jobs', 'subagents', 'environment', 'run', 'git', 'sizing', 'browser'] }),
  })
}

/** The host's stable DOM markers, the same ones the rail source reads. */
const TOGGLE_ATTR = 'data-sidebar-right-expand'
const PANEL_OPEN_ATTR = 'data-sidebar-right-open'
const PANEL_MODE_ATTR = 'data-sidebar-right-panel'
const PANEL_OPENING_ATTR = 'data-sidebar-right-opening'
const COLUMN_ATTR = 'data-rightbar-col'

/* ------------------------------------------------------------------ */
/* The minimal React stub                                              */
/* ------------------------------------------------------------------ */

function makeReactStub() {
  const hookState = []
  let cursor = 0
  let effects = []
  const stub = {
    createElement(type, props, ...children) {
      const element = {
        type,
        props: props || {},
        children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
      }
      // React attaches object refs before layout effects; the rail writes its position and
      // display to that node, so the element stands in for it with a writable style object.
      const ref = element.props.ref
      if (ref !== null && typeof ref === 'object' && 'current' in ref) {
        element.style = {}
        ref.current = element
      }
      return element
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
      const i = cursor++
      if (!(i in hookState)) hookState[i] = typeof initial === 'function' ? initial() : initial
      const setter = next => {
        hookState[i] = typeof next === 'function' ? next(hookState[i]) : next
      }
      return [hookState[i], setter]
    },
    useRef(initial) {
      const i = cursor++
      if (!(i in hookState)) hookState[i] = { current: initial }
      return hookState[i]
    },
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
    useEffect(fn) {
      effects.push(fn)
    },
    useLayoutEffect(fn) {
      effects.push(fn)
    },
  }
  /** Forget every hook and effect, as a fresh mount of the component would. */
  stub.__reset = () => {
    hookState.length = 0
    cursor = 0
    effects = []
    stub.__errors.length = 0
    stub.__cleanups.length = 0
  }
  /** Keep hook state, reset the cursor and the effect list: the same instance renders again. */
  stub.__nextRender = () => {
    cursor = 0
    effects = []
  }
  /**
   * Run the effects collected by the last render, keeping their cleanups.
   * Exceptions are collected, not swallowed: a throwing effect is a test failure.
   */
  stub.__runEffects = () => {
    const list = effects
    effects = []
    for (const fn of list) {
      try {
        const cleanup = fn()
        if (typeof cleanup === 'function') stub.__cleanups.push(cleanup)
      } catch (error) {
        stub.__errors.push(error)
      }
    }
  }
  /** Run the cleanups returned by the effects, in order; their exceptions are collected too. */
  stub.__runCleanups = () => {
    for (const cleanup of stub.__cleanups.splice(0)) {
      try {
        cleanup()
      } catch (error) {
        stub.__errors.push(error)
      }
    }
  }
  stub.__errors = []
  stub.__cleanups = []
  return stub
}

/* ------------------------------------------------------------------ */
/* The host stub                                                       */
/* ------------------------------------------------------------------ */

/**
 * A ctx with the four things the bundle touches: slots, the two sidebar services, and
 * effect. The locale service is left out, so the rail's optional locale path stays quiet.
 */
function makeCtx(entries, options = {}) {
  const registered = []
  const injected = []
  const tabRegistrations = []
  const opened = []
  // Mutable, like the host service: a test may open the sidebar after the mount.
  let expandedNow = options.expanded === true
  const tabs = {
    guide: () => entries.map((entry, i) => ({
      id: entry.id || 'e' + i,
      kind: entry.kind,
      providerId: entry.providerId || 'p',
      title: () => entry.title,
    })),
    subscribe: () => () => {},
    register(spec) {
      tabRegistrations.push(spec)
      return () => {}
    },
  }
  const sidebarRight = {
    isExpanded: () => expandedNow,
    mounted: {
      // undefined is the service's "no session on screen" snapshot.
      getSnapshot: () => (options.seat === false ? undefined : 'session-1'),
      subscribe: () => () => {},
    },
    openTab(kind) {
      opened.push(kind)
    },
  }
  const ctx = {
    slots: {
      inject(slot, callback) {
        injected.push({ slot, callback })
      },
      register(spec, component) {
        registered.push({ slot: spec.name, spec, component })
        return () => {}
      },
    },
    get(name) {
      if (name === 'sidebarRightTabs') return tabs
      if (name === 'sidebarRight') return sidebarRight
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') ctx.__disposers.push(dispose)
      return () => {}
    },
    sidebarRightTabs: tabs,
    sidebarRight,
    __injected: injected,
    __registered: registered,
    __tabRegistrations: tabRegistrations,
    __opened: opened,
    __setExpanded(value) {
      expandedNow = value === true
    },
    __disposers: [],
  }
  return ctx
}

/** Run every slots.inject callback: the host opening each slot the bundle asked for. */
function flushSlots(ctx) {
  for (const { callback } of ctx.__injected) callback()
}

/** The rail's shell.overlay registration. */
function railRegistration(ctx) {
  const registration = ctx.__registered.find(entry => entry.slot === 'shell.overlay' && entry.spec.id === RAIL_ID)
  assert.ok(registration, 'no rail registered in shell.overlay with id ' + RAIL_ID)
  return registration
}

/* ------------------------------------------------------------------ */
/* Loading and rendering the bundle                                    */
/* ------------------------------------------------------------------ */

/**
 * Evaluate the shared and rail parts as one plain script and return the names this suite
 * calls, with shared.js first so rail.js keeps its single source. A name the part does not
 * declare yet comes back as null: the red test then fails an assertion instead of crashing
 * while the file loads.
 */
function loadRailParts() {
  const source =
    fs.readFileSync(SHARED_PART, 'utf8') +
    '\n' +
    fs.readFileSync(RAIL_PART, 'utf8') +
    '\nreturn {' +
    "  railPlacement: typeof railPlacement === 'function' ? railPlacement : null," +
    "  RAIL_W: typeof RAIL_W === 'number' ? RAIL_W : null," +
    "  OPEN_GAP: typeof OPEN_GAP === 'number' ? OPEN_GAP : null," +
    "  OPEN_TOP: typeof OPEN_TOP === 'number' ? OPEN_TOP : null," +
    "  DEFAULT_TOP: typeof DEFAULT_TOP === 'number' ? DEFAULT_TOP : null," +
    "  RIGHT_GAP: typeof RIGHT_GAP === 'number' ? RIGHT_GAP : null," +
    "  TOP_GAP: typeof TOP_GAP === 'number' ? TOP_GAP : null," +
    '}'
  const factory = new Function('require', source)
  const React = makeReactStub()
  return factory(name => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
}

/**
 * Fake observers: they record their instances, the options, the observed targets and
 * whether cleanup disconnected them. `observe` re-arms a disconnected observer, like the
 * real one.
 */
function makeObserverFakes() {
  const mutations = []
  const resizes = []
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
      this.options = null
      this.disconnected = false
      mutations.push(this)
    }
    observe(target, options) {
      this.target = target
      this.options = options || {}
      this.disconnected = false
    }
    disconnect() {
      this.disconnected = true
    }
  }
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback
      this.targets = []
      this.disconnected = false
      resizes.push(this)
    }
    observe(target) {
      this.disconnected = false
      if (this.targets.indexOf(target) < 0) this.targets.push(target)
    }
    disconnect() {
      this.disconnected = true
      this.targets.length = 0
    }
  }
  return { mutations, resizes, FakeMutationObserver, FakeResizeObserver }
}

/**
 * Evaluate the generated client.js in a fresh context and return the plugin plus stubs.
 * `toggle` is what document.querySelector returns for the host's expand button; null
 * means the button is absent and the rail falls back to its default position. `markers`
 * (or the single `panel`) are the elements carrying the open marker; `column` is the
 * fake right-column container. `doc` is mutable so a test can open the sidebar after the
 * mount, and `runFrames` runs the callbacks the rail scheduled with requestAnimationFrame.
 */
function loadPlugin(options = {}) {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const React = makeReactStub()
  const toggle = options.toggle ?? null
  const observers = makeObserverFakes()
  const doc = {
    markers: options.markers ?? (options.panel ? [options.panel] : []),
    column: options.column ?? null,
  }
  const frames = []
  let frameSeq = 0
  const runFrames = () => {
    const pending = frames.splice(0)
    for (const frame of pending) frame.callback()
  }
  let captured = null
  const listeners = []
  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
    matchMedia: () => ({ matches: false }),
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener(type, fn, options) {
      listeners.push({ action: 'add', type, fn, options })
    },
    removeEventListener(type, fn, options) {
      listeners.push({ action: 'remove', type, fn, options })
    },
  }
  const sandbox = {
    window: windowStub,
    document: {
      body: {},
      baseURI: 'http://127.0.0.1:55122/',
      querySelector(selector) {
        if (selector === '[' + TOGGLE_ATTR + ']') return toggle
        if (selector === '[' + PANEL_OPEN_ATTR + ']') return doc.markers[0] ?? null
        if (selector === '[' + COLUMN_ATTR + ']') return doc.column
        return null
      },
      querySelectorAll(selector) {
        if (selector === '[' + PANEL_OPEN_ATTR + ']') return doc.markers
        return []
      },
      addEventListener() {},
      removeEventListener() {},
    },
    MutationObserver: observers.FakeMutationObserver,
    ResizeObserver: observers.FakeResizeObserver,
    console: { info() {}, warn() {}, error() {}, debug() {}, log() {} },
    requestAnimationFrame(callback) {
      frameSeq += 1
      frames.push({ id: frameSeq, callback })
      return frameSeq
    },
    cancelAnimationFrame(id) {
      const index = frames.findIndex(frame => frame.id === id)
      if (index >= 0) frames.splice(index, 1)
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: { language: 'en-US' },
    URL,
    fetch: featureFetch(),
  }
  // The rail checks window.ResizeObserver before constructing the global one.
  windowStub.ResizeObserver = observers.FakeResizeObserver
  sandbox.globalThis = sandbox
  sandbox.self = sandbox.window

  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: CLIENT })

  assert.ok(captured, 'the bundle did not call window.__ModuleLoader__.load()')
  const plugin = captured.factory(name => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  return { plugin, React, listeners, observers, doc, runFrames }
}

/**
 * Render the registered rail twice: once to mount it and run its effects, once as React
 * would after the entries state was filled. Returns the second tree and effect errors.
 */
function renderRail(React, registration, props) {
  React.__reset()
  const wrapper = registration.component(props)
  const inner = (wrapper.children || [])[0]
  assert.ok(inner && typeof inner.type === 'function', 'the shell.overlay entry does not wrap the rail component')
  inner.type(inner.props)
  React.__runEffects()
  React.__nextRender()
  const wrapperAgain = registration.component(props)
  const innerAgain = (wrapperAgain.children || [])[0]
  return { tree: innerAgain.type(innerAgain.props), errors: React.__errors.slice() }
}

/**
 * Render the registered rail once and run its effects. Unlike renderRail this keeps the
 * first tree, because that is the element the rail's object ref points at and the layout
 * effect writes its position and display into it.
 */
function renderRailOnce(React, registration, props) {
  React.__reset()
  const wrapper = registration.component(props)
  const inner = (wrapper.children || [])[0]
  assert.ok(inner && typeof inner.type === 'function', 'the shell.overlay entry does not wrap the rail component')
  const tree = inner.type(inner.props)
  React.__runEffects()
  return { tree, errors: React.__errors.slice() }
}

/**
 * Mount the rail once with the given host fakes, run its effects and return the host, the
 * ctx and the first tree (the node the rail's ref points at).
 */
function mountRail(entries, hostOptions, ctxOptions = {}) {
  const host = loadPlugin(hostOptions)
  const ctx = makeCtx(entries, ctxOptions)
  host.plugin.apply(ctx)
  flushSlots(ctx)
  const { tree, errors } = renderRailOnce(host.React, railRegistration(ctx), { ctx })
  assert.deepEqual(errorMessages(errors), [], 'no effect may throw')
  return { host, ctx, tree }
}

/** The host expand button the rail anchors to: only the rect placeRail reads. */
function fakeToggle(rect) {
  const toggle = {
    rect: rect || { width: 24, height: 24, top: 8, bottom: 32, left: 1400, right: 1424 },
    getBoundingClientRect: () => toggle.rect,
  }
  return toggle
}

/**
 * The open sidebar panel: `rect`, `mode` and `opening` are mutable, so a test can simulate
 * the user dragging the width handle, a fullscreen switch or the opening transition. `mode`
 * is the value of data-sidebar-right-panel; `opening` mirrors data-sidebar-right-opening.
 */
function fakePanel(rect, mode, options = {}) {
  const panel = {
    rect,
    mode,
    opening: options.opening === true,
    getBoundingClientRect: () => panel.rect,
    getAttribute(name) {
      if (name === PANEL_MODE_ATTR) return panel.mode
      if (name === PANEL_OPENING_ATTR) return panel.opening ? '' : null
      return null
    },
    hasAttribute(name) {
      return name === PANEL_OPENING_ATTR && panel.opening
    },
  }
  return panel
}

/** The window resize handler the rail added; there must be exactly one. */
function resizeHandlerOf(host) {
  const added = host.listeners.filter(event => event.action === 'add' && event.type === 'resize')
  assert.equal(added.length, 1, 'the rail adds one window resize listener')
  return added[0].fn
}

/** A panel rect at a known column position; callers change left/width to resize it. */
function panelRect(left, width) {
  return { left, top: 0, width, height: 900, right: left + width, bottom: 900 }
}

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

function countNodes(node, predicate) {
  let count = 0
  const walk = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (predicate(value)) count += 1
    ;(value.children || []).forEach(walk)
  }
  walk(node)
  return count
}

function collectNodes(node, predicate) {
  const found = []
  const walk = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (predicate(value)) found.push(value)
    ;(value.children || []).forEach(walk)
  }
  walk(node)
  return found
}

function errorMessages(errors) {
  return errors.map(error => (error && error.message ? error.message : String(error)))
}

/** The one semantic glyph name rendered inside a button (defaultIcon passes props.name). */
function glyphNameOf(button) {
  const glyphs = collectNodes(button, node => node.props && typeof node.props.name === 'string')
  assert.equal(glyphs.length, 1, 'each button must render exactly one semantic glyph')
  return glyphs[0].props.name
}

/* ------------------------------------------------------------------ */
/* Acceptance tests                                                    */
/* ------------------------------------------------------------------ */

test('apply registers one rail entry in shell.overlay', () => {
  const entries = [
    { kind: 'files', title: 'Files' },
    { kind: 'git', title: 'Git' },
    { kind: 'memory', title: 'Memory' },
  ]
  const { plugin } = loadPlugin()
  const ctx = makeCtx(entries)

  assert.doesNotThrow(() => plugin.apply(ctx), 'apply must not throw')
  flushSlots(ctx)

  const railEntries = ctx.__registered.filter(entry => entry.slot === 'shell.overlay' && entry.spec.id === RAIL_ID)
  assert.equal(railEntries.length, 1, 'exactly one rail entry is registered in shell.overlay')
  assert.equal(railEntries[0].spec.name, 'shell.overlay')
  assert.equal(railEntries[0].spec.order, 300, 'the rail entry keeps order 300')

  assert.ok(
    ctx.__tabRegistrations.some(
      spec => spec.id === 'dsh-claude-sidebar/environment' && spec.kind === 'claude-sidebar-environment',
    ),
    'the Environment tab type is still registered',
  )
  assert.ok(
    ctx.__registered.some(
      entry => entry.slot === 'sidebar.right.pane.tab' && entry.spec.key === 'dsh-claude-sidebar/environment',
    ),
    'the Environment tab body seat is still registered',
  )
})

test('the collapsed rail renders three buttons in one toolbar', () => {
  const entries = [
    { kind: 'files', title: 'Files' },
    { kind: 'git', title: 'Git' },
    { kind: 'memory', title: 'Memory' },
    { kind: 'terminal', title: 'Terminal' },
    { kind: 'tasks', title: 'Tasks' },
  ]
  const { plugin, React } = loadPlugin()
  const ctx = makeCtx(entries)
  plugin.apply(ctx)
  flushSlots(ctx)
  const registration = railRegistration(ctx)

  const { tree, errors } = renderRail(React, registration, { ctx })
  assert.deepEqual(errorMessages(errors), [], 'no effect may throw')
  assert.equal(countNodes(tree, node => node.type === 'button'), 3, 'the collapsed rail renders exactly 3 buttons')
  assert.equal(countNodes(tree, node => node.props && node.props.role === 'toolbar'), 1, 'the rail declares one toolbar')
})

test('an empty guide list renders no toolbar', () => {
  const { plugin, React } = loadPlugin()
  const ctx = makeCtx([])
  plugin.apply(ctx)
  flushSlots(ctx)
  const registration = railRegistration(ctx)

  const { tree, errors } = renderRail(React, registration, { ctx })
  assert.deepEqual(errorMessages(errors), [], 'no effect may throw')
  assert.equal(countNodes(tree, node => node.props && node.props.role === 'toolbar'), 0, 'an empty rail must not declare a toolbar')
})

test('a click on an item opens that tab', () => {
  const entries = [
    { kind: 'files', title: 'Files' },
    { kind: 'git', title: 'Git' },
    { kind: 'memory', title: 'Memory' },
  ]
  const { plugin, React } = loadPlugin()
  const ctx = makeCtx(entries)
  plugin.apply(ctx)
  flushSlots(ctx)
  const registration = railRegistration(ctx)

  const { tree, errors } = renderRail(React, registration, { ctx })
  assert.deepEqual(errorMessages(errors), [], 'no effect may throw')
  const buttons = collectNodes(tree, node => node.type === 'button')
  assert.equal(buttons.length, 3, 'the rail renders one button per visible entry')

  buttons[1].props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(ctx.__opened, ['git'], 'the click opens the entry kind')
})

test('cleanup removes the resize listener it added', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const { plugin, React, listeners } = loadPlugin()
  const ctx = makeCtx(entries)
  plugin.apply(ctx)
  flushSlots(ctx)
  const registration = railRegistration(ctx)

  const { errors } = renderRail(React, registration, { ctx })
  assert.deepEqual(errorMessages(errors), [], 'no effect may throw')

  const added = listeners.filter(event => event.action === 'add' && event.type === 'resize')
  assert.equal(added.length, 1, 'the rail adds one window resize listener')

  React.__runCleanups()
  const removed = listeners.filter(event => event.action === 'remove' && event.type === 'resize')
  assert.equal(removed.length, 1, 'cleanup removes one window resize listener')
  assert.equal(removed[0].fn, added[0].fn, 'cleanup removes the exact handler that was added')
  assert.deepEqual(errorMessages(React.__errors), [], 'no cleanup may throw')
})

test('a tab with a Chinese title and no icon of its own gets the matching icon', () => {
  const entries = [
    { kind: 'xyz-panel', title: '终端' },
    { kind: 'terminal', title: 'Terminal' },
    { kind: 'xyz-file', title: '文件' },
  ]
  const { plugin, React } = loadPlugin()
  const ctx = makeCtx(entries)
  plugin.apply(ctx)
  flushSlots(ctx)
  const registration = railRegistration(ctx)

  const { tree, errors } = renderRail(React, registration, { ctx })
  assert.deepEqual(errorMessages(errors), [], 'no effect may throw')
  const buttons = collectNodes(tree, node => node.type === 'button')
  assert.equal(buttons.length, 3, 'the rail renders one button per visible entry')

  const names = buttons.map(glyphNameOf)
  assert.equal(names[0], names[1], 'the Chinese terminal title picks the same glyph as the terminal kind')
  assert.notEqual(names[0], names[2], 'the Chinese file title picks a different glyph')
})

test('railPlacement covers closed, open, fullscreen and missing anchors', () => {
  const parts = loadRailParts()
  assert.equal(typeof parts.railPlacement, 'function', 'features/rail/client/rail.js must define a pure railPlacement()')
  const { RAIL_W, RIGHT_GAP, TOP_GAP, OPEN_GAP, OPEN_TOP, DEFAULT_TOP } = parts
  const placement = parts.railPlacement

  const viewport = { width: 1440, height: 900 }
  const button = { top: 8, bottom: 32, width: 24, height: 24 }
  const unusableButton = { top: 200, bottom: 224, width: 24, height: 24 }
  const panel = { left: 1000, top: 0, mode: 'push' }
  const closedLeft = 1440 - RAIL_W - RIGHT_GAP
  const openLeft = 1000 - RAIL_W - OPEN_GAP
  const buttonTop = 32 + TOP_GAP

  const cases = [
    {
      name: 'no session on screen hides the rail',
      input: { seat: false, expanded: false, viewport, button, panel: null, lastTop: null },
      expected: { display: false },
    },
    {
      name: 'closed with a usable button anchors below it at the viewport edge',
      input: { seat: true, expanded: false, viewport, button, panel: null, lastTop: null },
      expected: { display: true, left: closedLeft, top: buttonTop, usedButton: true },
    },
    {
      name: 'closed without a button falls back to the default top',
      input: { seat: true, expanded: false, viewport, button: null, panel: null, lastTop: null },
      expected: { display: true, left: closedLeft, top: DEFAULT_TOP, usedButton: false },
    },
    {
      name: 'closed with an unusable button hides instead of guessing',
      input: { seat: true, expanded: false, viewport, button: unusableButton, panel: null, lastTop: null },
      expected: { display: false },
    },
    {
      name: 'open in push mode sits left of the panel, top from the button',
      input: { seat: true, expanded: true, viewport, button, panel, lastTop: null },
      expected: { display: true, left: openLeft, top: buttonTop, usedButton: true },
    },
    {
      name: 'open without a usable button reuses the last button top',
      input: { seat: true, expanded: true, viewport, button: unusableButton, panel, lastTop: 137 },
      expected: { display: true, left: openLeft, top: 137, usedButton: false },
    },
    {
      name: 'open with neither button nor last top takes the panel top',
      input: {
        seat: true,
        expanded: true,
        viewport,
        button: null,
        panel: { left: 1000, top: 40, mode: 'push' },
        lastTop: null,
      },
      expected: { display: true, left: openLeft, top: 40 + OPEN_TOP, usedButton: false },
    },
    {
      name: 'fullscreen hides the rail',
      input: {
        seat: true,
        expanded: true,
        viewport,
        button,
        panel: { left: 0, top: 0, width: 1440, mode: 'fullscreen' },
        lastTop: null,
      },
      expected: { display: false },
    },
    {
      name: 'expanded with no panel found keeps the closed placement',
      input: { seat: true, expanded: true, viewport, button, panel: null, lastTop: 137 },
      expected: { display: true, left: closedLeft, top: buttonTop, usedButton: true },
    },
    {
      name: 'a panel too wide for the viewport clamps left to 4',
      input: {
        seat: true,
        expanded: true,
        viewport,
        button,
        panel: { left: 20, top: 0, mode: 'push' },
        lastTop: null,
      },
      expected: { display: true, left: 4, top: buttonTop, usedButton: true },
    },
  ]

  for (const item of cases) assert.deepEqual(placement(item.input), item.expected, item.name)
})

test('the rail stays visible beside the open sidebar', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const panel = fakePanel(panelRect(1000, 400), 'push')
  const host = loadPlugin({ toggle: fakeToggle(), panel })
  const ctx = makeCtx(entries, { expanded: true })
  host.plugin.apply(ctx)
  flushSlots(ctx)

  const { tree, errors } = renderRailOnce(host.React, railRegistration(ctx), { ctx })
  assert.deepEqual(errorMessages(errors), [], 'no effect may throw')
  const { RAIL_W, OPEN_GAP } = loadRailParts()
  assert.equal(tree.style.display, 'flex', 'the rail stays visible while the sidebar is expanded')
  assert.equal(tree.style.left, panel.rect.left - RAIL_W - OPEN_GAP + 'px', 'the rail sits just left of the open column')
})

test('the rail follows the column when it is resized', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const panel = fakePanel(panelRect(1000, 400), 'push')
  const host = loadPlugin({ toggle: fakeToggle(), panel })
  const ctx = makeCtx(entries, { expanded: true })
  host.plugin.apply(ctx)
  flushSlots(ctx)

  const { tree, errors } = renderRailOnce(host.React, railRegistration(ctx), { ctx })
  assert.deepEqual(errorMessages(errors), [], 'no effect may throw')
  const { RAIL_W, OPEN_GAP } = loadRailParts()

  const observer = host.observers.resizes[0]
  assert.ok(observer, 'the rail creates a ResizeObserver')
  assert.ok(observer.targets.includes(panel), 'the open panel is observed so a width drag relocates the rail')

  panel.rect = panelRect(1200, 240)
  observer.callback()
  assert.equal(tree.style.left, 1200 - RAIL_W - OPEN_GAP + 'px', 'the rail follows the resized column')
})

test('the rail hides in fullscreen and with no session on screen', () => {
  const entries = [{ kind: 'files', title: 'Files' }]

  const fullHost = loadPlugin({ toggle: fakeToggle(), panel: fakePanel(panelRect(0, 1440), 'fullscreen') })
  const fullCtx = makeCtx(entries, { expanded: true })
  fullHost.plugin.apply(fullCtx)
  flushSlots(fullCtx)
  const full = renderRailOnce(fullHost.React, railRegistration(fullCtx), { ctx: fullCtx })
  assert.deepEqual(errorMessages(full.errors), [], 'no effect may throw')
  assert.equal(full.tree.style.display, 'none', 'the rail hides in fullscreen')

  const emptyHost = loadPlugin({ toggle: fakeToggle() })
  const emptyCtx = makeCtx(entries, { seat: false })
  emptyHost.plugin.apply(emptyCtx)
  flushSlots(emptyCtx)
  const empty = renderRailOnce(emptyHost.React, railRegistration(emptyCtx), { ctx: emptyCtx })
  assert.deepEqual(errorMessages(empty.errors), [], 'no effect may throw')
  assert.equal(empty.tree.style.display, 'none', 'the rail hides when no session is on screen')
})

test('observers watch the open marker and stop on cleanup', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const panel = fakePanel(panelRect(1000, 400), 'push')
  const host = loadPlugin({ toggle: fakeToggle(), panel })
  const ctx = makeCtx(entries, { expanded: true })
  host.plugin.apply(ctx)
  flushSlots(ctx)

  const { errors } = renderRail(host.React, railRegistration(ctx), { ctx })
  assert.deepEqual(errorMessages(errors), [], 'no effect may throw')

  const mutations = host.observers.mutations[0]
  assert.ok(mutations, 'the rail creates a MutationObserver')
  assert.equal(mutations.options.childList, true, 'child-list changes are observed')
  assert.equal(mutations.options.subtree, true, 'the whole body subtree is observed')
  assert.equal(mutations.options.attributes, true, 'attribute changes are observed')
  assert.ok(Array.isArray(mutations.options.attributeFilter), 'the attribute filter is an array')
  assert.deepEqual(
    [...mutations.options.attributeFilter].sort(),
    [PANEL_OPEN_ATTR, PANEL_MODE_ATTR, PANEL_OPENING_ATTR].sort(),
    'the filter is exactly the open, mode and opening panel attributes, with no style',
  )

  const resizes = host.observers.resizes[0]
  assert.ok(resizes, 'the rail creates a ResizeObserver')
  host.React.__runCleanups()
  assert.equal(mutations.disconnected, true, 'cleanup disconnects the MutationObserver')
  assert.equal(resizes.disconnected, true, 'cleanup disconnects the ResizeObserver')
})

test('opening the sidebar through a DOM mutation moves the rail beside the panel', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const panel = fakePanel(panelRect(1000, 400), 'push')
  const { host, ctx, tree } = mountRail(entries, { toggle: fakeToggle() })
  const { RAIL_W, RIGHT_GAP, OPEN_GAP } = loadRailParts()
  assert.equal(tree.style.display, 'flex', 'the rail is visible while the sidebar is closed')
  assert.equal(tree.style.left, 1440 - RAIL_W - RIGHT_GAP + 'px', 'the closed placement starts at the viewport edge')

  // The host flips isExpanded and mounts the panel root; one mutation reports both.
  ctx.__setExpanded(true)
  host.doc.markers = [panel]
  host.observers.mutations[0].callback()
  host.runFrames()

  assert.equal(tree.style.display, 'flex', 'the rail stays visible while the sidebar opens')
  assert.equal(tree.style.left, 1000 - RAIL_W - OPEN_GAP + 'px', 'the rail moves beside the open panel')
})

test('a panel that grows from zero width is followed', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const panel = fakePanel(panelRect(1440, 0), 'push')
  const { host, tree } = mountRail(entries, { toggle: fakeToggle(), panel }, { expanded: true })
  const { RAIL_W, OPEN_GAP } = loadRailParts()

  const observer = host.observers.resizes[0]
  assert.ok(observer, 'the rail creates a ResizeObserver')
  assert.ok(observer.targets.includes(panel), 'the zero-width open panel is observed so growth re-places the rail')

  panel.rect = panelRect(1000, 400)
  observer.callback()
  assert.equal(tree.style.left, 1000 - RAIL_W - OPEN_GAP + 'px', 'the rail moves beside the grown panel')
})

test('the end of the opening transition re-places the rail', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const panel = fakePanel(panelRect(1000, 400), 'push', { opening: true })
  const { host, tree } = mountRail(entries, { toggle: fakeToggle(), panel }, { expanded: true })
  const { RAIL_W, OPEN_GAP } = loadRailParts()
  assert.equal(tree.style.left, 1000 - RAIL_W - OPEN_GAP + 'px', 'the rail starts beside the panel')

  // The transition slides the column without a size change a ResizeObserver would see.
  panel.rect = panelRect(1200, 240)
  panel.opening = false
  host.observers.mutations[0].callback()
  host.runFrames()

  assert.equal(tree.style.left, 1200 - RAIL_W - OPEN_GAP + 'px', 'the end of the opening transition runs one geometry pass')
})

test('a replaced panel element is observed again', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const panelA = fakePanel(panelRect(1000, 400), 'push')
  const panelB = fakePanel(panelRect(1200, 240), 'push')
  const { host, tree } = mountRail(entries, { toggle: fakeToggle(), panel: panelA }, { expanded: true })
  const { RAIL_W, OPEN_GAP } = loadRailParts()

  const observer = host.observers.resizes[0]
  assert.ok(observer, 'the rail creates a ResizeObserver')
  assert.ok(observer.targets.includes(panelA), 'the first open panel is observed')

  host.doc.markers = [panelB]
  resizeHandlerOf(host)()
  host.runFrames()

  assert.ok(observer.targets.includes(panelB), 'the replacement panel is observed')
  assert.ok(!observer.targets.includes(panelA), 'the replaced panel is no longer observed')
  assert.equal(tree.style.left, 1200 - RAIL_W - OPEN_GAP + 'px', 'the rail measures the replacement panel')
})

test('the column container is used when no open marker has a size', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const marker = fakePanel(panelRect(1440, 0), 'push')
  const column = fakePanel(panelRect(980, 460), 'push')
  const { tree } = mountRail(entries, { toggle: fakeToggle(), panel: marker, column }, { expanded: true })
  const { RAIL_W, OPEN_GAP } = loadRailParts()

  assert.equal(tree.style.display, 'flex', 'the rail is visible')
  assert.equal(tree.style.left, 980 - RAIL_W - OPEN_GAP + 'px', 'the column container anchors the rail while no marker has a size')
})

test('the rail keeps its height when the button becomes unusable while open', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const toggle = fakeToggle()
  const panel = fakePanel(panelRect(1000, 400), 'push')
  const { host, tree } = mountRail(entries, { toggle, panel }, { expanded: true })
  const { TOP_GAP } = loadRailParts()
  const buttonTop = 32 + TOP_GAP
  assert.equal(tree.style.top, buttonTop + 'px', 'the rail starts below the usable button')

  // A disabled or clipped button has an empty rect and fails the vertical gate.
  toggle.rect = { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 }
  resizeHandlerOf(host)()
  host.runFrames()

  assert.equal(tree.style.top, buttonTop + 'px', 'the stored button top survives an unusable button')
})

test('a forced pass is not lost behind a pending one', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const panel = fakePanel(panelRect(1000, 400), 'push')
  const { host, tree } = mountRail(entries, { toggle: fakeToggle(), panel }, { expanded: true })
  const { RAIL_W, OPEN_GAP } = loadRailParts()

  // Only geometry sees this: no attribute the change key covers moves.
  panel.rect = panelRect(1200, 240)
  host.observers.mutations[0].callback() // schedules a non-forced pass
  resizeHandlerOf(host)() // a forced pass arrives before that frame runs
  host.runFrames()

  assert.equal(tree.style.left, 1200 - RAIL_W - OPEN_GAP + 'px', 'the forced pass still runs the geometry')
})

test('an open marker that appears after the expansion re-places the rail', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const panel = fakePanel(panelRect(1000, 400), 'push')
  const { host, tree } = mountRail(entries, { toggle: fakeToggle() }, { expanded: true })
  const { RAIL_W, RIGHT_GAP, OPEN_GAP } = loadRailParts()
  assert.equal(tree.style.left, 1440 - RAIL_W - RIGHT_GAP + 'px', 'expanded without a marker keeps the closed placement')

  host.doc.markers = [panel]
  host.observers.mutations[0].callback()
  host.runFrames()

  assert.equal(tree.style.left, 1000 - RAIL_W - OPEN_GAP + 'px', 'the marker presence is part of the change key')
})

test('a mode change while expanded re-places the rail', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const panel = fakePanel(panelRect(1000, 400), 'push')
  const { host, tree } = mountRail(entries, { toggle: fakeToggle(), panel }, { expanded: true })
  assert.equal(tree.style.display, 'flex', 'the rail starts visible beside the push column')

  panel.mode = 'fullscreen'
  panel.rect = panelRect(0, 1440)
  host.observers.mutations[0].callback()
  host.runFrames()

  assert.equal(tree.style.display, 'none', 'the mode is part of the change key, so fullscreen hides the rail')
})

test('the column container is followed when it is the fallback', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const column = fakePanel(panelRect(980, 460), 'push')
  const { host, tree } = mountRail(entries, { toggle: fakeToggle(), column }, { expanded: true })
  const { RAIL_W, OPEN_GAP } = loadRailParts()

  const observer = host.observers.resizes[0]
  assert.ok(observer, 'the rail creates a ResizeObserver')
  assert.ok(observer.targets.includes(column), 'the column fallback is observed so its resize moves the rail')
  assert.equal(tree.style.left, 980 - RAIL_W - OPEN_GAP + 'px', 'the rail starts beside the column')

  column.rect = panelRect(900, 540)
  observer.callback()
  assert.equal(tree.style.left, 900 - RAIL_W - OPEN_GAP + 'px', 'the rail follows the resized column')
})

test('a forced request does not survive cleanup', () => {
  const entries = [{ kind: 'files', title: 'Files' }]
  const column = fakePanel(panelRect(980, 460), 'push')
  const host = loadPlugin({ toggle: fakeToggle(), column })
  const ctx = makeCtx(entries, { expanded: true })
  host.plugin.apply(ctx)
  flushSlots(ctx)
  const registration = railRegistration(ctx)
  const first = renderRailOnce(host.React, registration, { ctx })
  assert.deepEqual(errorMessages(first.errors), [], 'no effect may throw')
  const { RAIL_W, OPEN_GAP } = loadRailParts()

  // A forced pass is queued, but cleanup runs before its frame does.
  resizeHandlerOf(host)()
  host.React.__runCleanups()

  // The same instance sets its effects up again, as a re-run of the effect would.
  host.React.__nextRender()
  const wrapper = registration.component({ ctx })
  const inner = (wrapper.children || [])[0]
  const tree = inner.type(inner.props)
  host.React.__runEffects()
  assert.deepEqual(errorMessages(host.React.__errors), [], 'no effect may throw on the re-run')

  const observer = host.observers.mutations[1]
  assert.ok(observer, 'the re-run creates a fresh MutationObserver')
  column.rect = panelRect(900, 540)
  observer.callback()
  host.runFrames()

  assert.equal(
    tree.style.left,
    980 - RAIL_W - OPEN_GAP + 'px',
    'the forced request from before cleanup did not force a geometry pass',
  )
})

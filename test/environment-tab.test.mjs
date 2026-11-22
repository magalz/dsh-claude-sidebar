/**
 * Acceptance tests for the Environment tab (features/environment/client/environment.js).
 *
 * The tab is driven through the real generated client.js: a fake
 * window.__ModuleLoader__, a minimal React stub that keeps hook state and runs
 * dependency-aware effects, fake useTabInfo / useProjection props, a fake fetch
 * (with deferred answers), fake setInterval/clearInterval and a fake document.
 * The pure helpers are loaded from the source parts, so a missing helper fails
 * an assertion instead of crashing the file at load.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/** This fake host has no layout/sidebar services; the sizing feature's internals warning is not this suite's. */
const ownWarnings = list => list.filter(args => String(args[0] || '').indexOf('dsh-claude-sidebar sizing') < 0)
const CLIENT = path.join(ROOT, 'client.js')
const SHARED_PART = path.join(ROOT, 'client', 'shared.js')
const ENVIRONMENT_PARTS = [
  'environment-base.js',
  'environment-context.js',
  'environment-connectors.js',
  'environment.js',
].map(name => path.join(ROOT, 'features', 'environment', 'client', name))
const SLOT = 'sidebar.right.pane.tab'
const TAB_ID = 'dsh-claude-sidebar/environment'
const KIND = 'claude-sidebar-environment'
const ROUTE = '/dsh-claude-sidebar/environment'
const REFRESH_MS = 12_000
const BRAND = 'var(--dsw-alias-brand-primary, #4f6ef7)'
const WARN = 'var(--dsw-alias-state-warn-primary, #c98a00)'
const ERROR = 'var(--dsw-alias-state-error-primary, #d64545)'
const SUCCESS = 'var(--dsw-alias-state-success-primary, #2e9e5b)'
const SECONDARY = 'var(--dsw-alias-label-secondary, inherit)'
const TRACK = 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.18))'
const IDLE = 'var(--dsw-alias-state-idle-primary, #8a8f98)'
const BORDER_L2 = 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3))'
/** The dsh-oh-my-claude plugin's context route, which the Context section reads for Claude sessions. */
const CLAUDE_ROUTE = '/dsh-oh-my-claude/context'
/** The sentence the spec moves from a visible pinned note into a pinned row's title. */
const PINNED_NOTE = 'Pinned servers come from the profile; their live state is not reported.'
/** The localStorage key and default order the column spec fixes. */
const COLUMN_KEY = 'dsh-claude-sidebar.column.v1'
const DEFAULT_ORDER = ['environment', 'context', 'connectors', 'changes']
const DRAG_TYPE = 'application/x-dsh-claude-sidebar-section'

/** Read a file as UTF-8; a part that does not exist yet reads as empty (the red test). */
function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* A small React stub with instance state and dependency-aware effects */
/* ------------------------------------------------------------------ */

/**
 * Build the fake React module plus the renderer this suite drives. Effects run
 * when their dependency array changed (or always without one); a component that
 * disappears from the next tree is unmounted and its cleanups run first.
 */
function makeRenderer(options = {}) {
  const instances = new Map()
  const errors = []
  const rootWidth = options.rootWidth ?? 320
  let current = null
  /* True while effects commit: a state update there re-renders before paint, as React does. */
  let committing = false

  function instanceOf(key) {
    let instance = instances.get(key)
    if (instance === undefined) {
      instance = {
        key,
        hooks: [],
        cursor: 0,
        effects: [],
        memo: new Map(),
        stored: new Map(),
        dead: false,
      }
      instances.set(key, instance)
    }
    return instance
  }

  function hookIndex() {
    if (current === null) throw new Error('a hook was called outside a component render')
    return current.cursor++
  }

  const React = {
    createElement(type, props, ...children) {
      const element = {
        type,
        props: props || {},
        children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
      }
      // React attaches object refs before its effects and keeps the same DOM node across
      // renders; the Environment tab measures its own root with a ResizeObserver and moves
      // focus into the strip, so the ref target stands in for that node: a readable
      // border-box width (tests move it through emit(), the way layout would), a focus()
      // that records itself, and a contains() a test can point at a focused child.
      const ref = element.props.ref
      if (ref !== null && typeof ref === 'object' && 'current' in ref) {
        if (ref.current === null) {
          const node = { width: rootWidth, focused: false }
          node.getBoundingClientRect = () => ({
            width: node.width,
            height: 0,
            top: 0,
            left: 0,
            right: node.width,
            bottom: 0,
          })
          node.focus = () => {
            node.focused = true
          }
          node.contains = () => false
          ref.current = node
        }
        element.__node = ref.current
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
      const index = hookIndex()
      const instance = current
      if (!(index in instance.hooks)) {
        instance.hooks[index] = typeof initial === 'function' ? initial() : initial
      }
      const setter = next => {
        if (instance.dead) {
          errors.push(new Error('setState after unmount'))
          return
        }
        const value = typeof next === 'function' ? next(instance.hooks[index]) : next
        // React bails out of a same-value update; an update made inside an effect commits
        // before the browser paints, so render() runs one more pass for it.
        if (Object.is(value, instance.hooks[index])) return
        instance.hooks[index] = value
        if (committing) instance.dirty = true
      }
      return [instance.hooks[index], setter]
    },
    useRef(initial) {
      const index = hookIndex()
      if (!(index in current.hooks)) current.hooks[index] = { current: initial }
      return current.hooks[index]
    },
    useEffect(fn, deps) {
      current.effects.push({ index: hookIndex(), fn, deps })
    },
    useLayoutEffect(fn, deps) {
      current.effects.push({ index: hookIndex(), fn, deps })
    },
    useMemo(fn, deps) {
      const index = hookIndex()
      const stored = current.memo.get(index)
      if (stored !== undefined && sameDeps(stored.deps, deps)) return stored.value
      const value = fn()
      current.memo.set(index, { deps, value })
      return value
    },
    useCallback(fn) {
      return fn
    },
  }

  function sameDeps(before, after) {
    if (before === undefined || after === undefined) return false
    if (!Array.isArray(before) || !Array.isArray(after)) return false
    if (before.length !== after.length) return false
    for (let i = 0; i < before.length; i += 1) {
      if (!Object.is(before[i], after[i])) return false
    }
    return true
  }

  function runCleanup(stored) {
    if (typeof stored.cleanup !== 'function') return
    try {
      stored.cleanup()
    } catch (error) {
      errors.push(error)
    }
  }

  function renderInstance(instance, type, props) {
    const previous = current
    current = instance
    instance.cursor = 0
    instance.effects = []
    let tree = null
    try {
      tree = type(props)
    } catch (error) {
      errors.push(error)
    } finally {
      current = previous
    }
    return tree
  }

  function commit(instance) {
    if (instance.dead) return
    const present = new Set(instance.effects.map(effect => effect.index))
    for (const [index, stored] of Array.from(instance.stored.entries())) {
      if (present.has(index)) continue
      runCleanup(stored)
      instance.stored.delete(index)
    }
    committing = true
    try {
      for (const effect of instance.effects) {
        const previous = instance.stored.get(effect.index)
        if (previous !== undefined && sameDeps(previous.deps, effect.deps)) continue
        if (previous !== undefined) runCleanup(previous)
        let cleanup = null
        try {
          cleanup = effect.fn()
        } catch (error) {
          errors.push(error)
        }
        instance.stored.set(effect.index, { deps: effect.deps, cleanup })
      }
    } finally {
      committing = false
    }
  }

  function unmount(instance) {
    if (instance.dead) return
    instance.dead = true
    for (const stored of instance.stored.values()) runCleanup(stored)
    instance.stored.clear()
    if (instances.get(instance.key) === instance) instances.delete(instance.key)
  }

  function resolve(node, nodePath, live, order) {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) {
      return node.map((child, index) => resolve(child, nodePath + '/' + index, live, order))
    }
    if (typeof node.type === 'function') {
      const key = nodePath + '#' + String(node.props.key === undefined ? node.type.name : node.props.key)
      const instance = instanceOf(key)
      live.add(key)
      order.push(instance)
      const output = renderInstance(instance, node.type, node.props)
      return resolve(output, key + '/out', live, order)
    }
    node.children = node.children.map((child, index) => resolve(child, nodePath + '/' + index, live, order))
    return node
  }

  /**
   * Render the root component, reuse the state of every component still in the
   * tree, unmount the rest, then commit their effects. A state update made inside an
   * effect (a layout effect takes the narrow measurement, a transition effect clears the
   * route answer) re-renders before paint, as React does, so the tree this returns is the
   * one the browser would show.
   */
  function render(type, props) {
    let tree = null
    for (let pass = 0; pass < 20; pass += 1) {
      const live = new Set()
      const order = []
      const root = instanceOf('root')
      live.add('root')
      order.push(root)
      const output = renderInstance(root, type, props)
      tree = resolve(output, 'root/out', live, order)
      for (const [key, instance] of Array.from(instances.entries())) {
        if (!live.has(key)) unmount(instance)
      }
      for (const instance of order) instance.dirty = false
      for (const instance of order) commit(instance)
      if (!order.some(instance => instance.dirty)) return tree
    }
    errors.push(new Error('render did not settle after 20 passes'))
    return tree
  }

  function unmountAll() {
    for (const instance of Array.from(instances.values())) unmount(instance)
    instances.clear()
  }

  return {
    React,
    render,
    unmount: unmountAll,
    errors: () => errors.map(error => (error && error.message ? error.message : String(error))),
  }
}

/* ------------------------------------------------------------------ */
/* Loading the bundle and the source parts                             */
/* ------------------------------------------------------------------ */

/** Evaluate shared.js followed by every file of the Environment group; return this suite's names, absent = null. */
function loadEnvironmentParts() {
  const source =
    readText(SHARED_PART) +
    '\n' +
    ENVIRONMENT_PARTS.map(readText).join('\n') +
    '\nreturn {' +
    "  contextUsage: typeof contextUsage === 'function' ? contextUsage : null," +
    "  formatTokens: typeof formatTokens === 'function' ? formatTokens : null," +
    "  platformLabel: typeof platformLabel === 'function' ? platformLabel : null," +
    "  changeLetter: typeof changeLetter === 'function' ? changeLetter : null," +
    "  normalizeOrder: typeof normalizeOrder === 'function' ? normalizeOrder : null," +
    "  moveSection: typeof moveSection === 'function' ? moveSection : null," +
    "  dropSection: typeof dropSection === 'function' ? dropSection : null," +
    "  scaledBreakdown: typeof scaledBreakdown === 'function' ? scaledBreakdown : null," +
    "  contextDisplayPercent: typeof contextDisplayPercent === 'function' ? contextDisplayPercent : null," +
    '}'
  const factory = new Function('require', source)
  const renderer = makeRenderer()
  return factory(name => {
    if (name === 'react') return renderer.React
    throw new Error('unexpected require: ' + name)
  })
}

/* ------------------------------------------------------------------ */
/* Fake timers, document and fetch                                     */
/* ------------------------------------------------------------------ */

/** Fake setTimeout/setInterval: tests see what the tab schedules, and fire or clear it. */
function makeTimers() {
  let nextId = 1
  const active = new Map()
  const intervals = []
  const clears = []
  return {
    setTimeout(fn, delay) {
      const entry = { id: nextId++, delay, fn, kind: 'timeout' }
      active.set(entry.id, entry)
      return entry.id
    },
    clearTimeout(id) {
      clears.push({ kind: 'timeout', id })
      active.delete(id)
    },
    setInterval(fn, delay) {
      const entry = { id: nextId++, delay, fn, kind: 'interval' }
      active.set(entry.id, entry)
      intervals.push(entry)
      return entry.id
    },
    clearInterval(id) {
      clears.push({ kind: 'interval', id })
      active.delete(id)
    },
    pending(kind) {
      return Array.from(active.values()).filter(entry => kind === undefined || entry.kind === kind)
    },
    fire(entry) {
      if (entry.kind === 'timeout') active.delete(entry.id)
      entry.fn()
    },
    clearsFor(kind) {
      return clears.filter(entry => entry.kind === kind)
    },
    intervals,
  }
}

/** A fake document: the visibility the tab reads, plus the listeners it adds and removes. */
function makeDocument() {
  const listeners = new Map()
  return {
    visibilityState: 'visible',
    baseURI: 'http://127.0.0.1:55122/',
    /* A test sets this to the node the host's focus is on. */
    activeElement: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type)
      if (set !== undefined) set.delete(fn)
    },
    dispatch(type) {
      const set = listeners.get(type)
      if (set === undefined) return
      for (const fn of Array.from(set)) fn()
    },
    listenerCount(type) {
      const set = listeners.get(type)
      return set === undefined ? 0 : set.size
    },
  }
}

/**
 * Fake ResizeObserver: records every instance, the one target it observes and whether
 * disconnect() ran. It never calls back by itself: a test fires emit(width) to report a
 * border-box width, as a real observer does after layout, so the mount-time measurement
 * under test is the only path that can make a fresh mount narrow.
 */
function makeResizeObservers() {
  const observers = []
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback
      this.targets = []
      this.disconnected = false
      observers.push(this)
    }
    observe(target) {
      this.disconnected = false
      if (!this.targets.includes(target)) this.targets.push(target)
    }
    disconnect() {
      this.disconnected = true
      this.targets.length = 0
    }
    emit(width) {
      for (const target of this.targets) {
        target.width = width
        this.callback([{ target, contentRect: { width, height: 0 } }], this)
      }
    }
  }
  return { observers, FakeResizeObserver }
}

/** One fake route answer in the shape fetch() returns. */
function reply(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }
}

/**
 * A thenable that settles synchronously. The generated gate chains .then/.catch, so the
 * feature-list fetch returns one of these and apply() mounts inside the same turn.
 */
function settled(failed, value) {
  const chain = {
    then(onOk, onFail) { return failed ? (typeof onFail === 'function' ? run(onFail) : chain) : run(onOk) },
    catch(onFail) { return failed ? run(onFail) : chain },
  }
  function run(fn) {
    if (typeof fn !== 'function') return chain
    try {
      const out = fn(value)
      return out !== null && typeof out === 'object' && typeof out.then === 'function' ? out : resolved(out)
    } catch (error) {
      return rejected(error)
    }
  }
  return chain
}
function resolved(value) { return settled(false, value) }
function rejected(reason) { return settled(true, reason) }

const ALL_FEATURES = ['rail', 'jobs', 'subagents', 'environment', 'run', 'git', 'sizing', 'browser']

/**
 * A fake localStorage: a key/value map, or one whose methods throw, which is how a
 * browser with storage disabled behaves for the tab.
 */
function makeStorage(options = {}) {
  const values = new Map(Object.entries(options.data ?? {}))
  const reads = []
  return {
    reads,
    getItem(key) {
      if (options.throwGet === true) throw new Error('storage is disabled')
      reads.push(key)
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      if (options.throwSet === true) throw new Error('storage is disabled')
      values.set(key, String(value))
    },
    removeItem(key) {
      if (options.throwRemove === true) throw new Error('storage is disabled')
      values.delete(key)
    },
  }
}

/** A promise a test resolves or rejects by hand, to hold a fetch in flight. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

/**
 * A fake message box for the body's useInput. The body hands a selector; the store
 * answers with the selected primitive, and changed() reports whether a store update
 * would move it — i.e. whether the host would re-render the tab.
 */
function makeInputStore(initial) {
  let state = initial
  let selector = null
  let selected
  let renders = 0
  return {
    useInput(next) {
      selector = next
      selected = next(state)
      renders += 1
      return selected
    },
    selected: () => selected,
    setState(next) {
      state = next
    },
    changed() {
      const value = selector(state)
      if (Object.is(value, selected)) return false
      selected = value
      return true
    },
    renders: () => renders,
  }
}

/** The same for the session-status store; its selector returns one boolean. */
function makeStatusStore(initial) {
  let state = initial
  let selector = null
  let selected
  return {
    useSessionStatus(next) {
      selector = next
      selected = next(state)
      return selected
    },
    selected: () => selected,
    setState(next) {
      state = next
    },
    changed() {
      const value = selector(state)
      if (Object.is(value, selected)) return false
      selected = value
      return true
    },
  }
}

/**
 * A recording fake fetch for the two routes the tab reads: the Environment route
 * (`answer`, the list the older tests count) and the dsh-oh-my-claude context route
 * (`contextAnswer`, the list task L.3 counts). The context route defaults to
 * `{ ok: false }`, so a test that says nothing keeps falling back to dsh's projections.
 * Each answer receives (url, init, callNumber) and may return a promise.
 */
function makeFetch(options = {}) {
  const calls = []
  const contextCalls = []
  const featureCalls = []
  /** Every feature is on unless a test names a smaller set; that set is the gate's answer. */
  const names = options.features ?? ALL_FEATURES
  let currentAnswer = options.answer ?? (() => reply(FULL_ANSWER))
  let currentContext = options.contextAnswer ?? (() => reply({ ok: false }))
  /* Not async: the feature-list answer must settle inside apply(), while the two tab
     routes keep returning promises the tests await. Feature calls are kept apart so the
     route counts the older tests assert stay exact. */
  const fetch = (url, init) => {
    if (String(url).endsWith('/dsh-claude-sidebar/features')) {
      featureCalls.push({ url, init })
      return resolved({ ok: true, status: 200, json: () => resolved({ features: names }) })
    }
    if (String(url).startsWith(CLAUDE_ROUTE + '?')) {
      contextCalls.push({ url, init })
      return Promise.resolve(currentContext(url, init, contextCalls.length))
    }
    calls.push({ url, init })
    return Promise.resolve(currentAnswer(url, init, calls.length))
  }
  return {
    fetch,
    calls,
    contextCalls,
    featureCalls,
    setAnswer(next) {
      currentAnswer = next
    },
    setContextAnswer(next) {
      currentContext = next
    },
  }
}

/**
 * Evaluate the generated client.js in a fresh context and apply the plugin. The
 * sandbox console keeps every warning; document and fetch are the tab's browser
 * services; the timers are the fake ones the suite fires by hand.
 */
function mountBundle(options = {}) {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const timers = makeTimers()
  const document = makeDocument()
  const storage = options.storage ?? makeStorage(options.storageData)
  const network = makeFetch({
    answer: options.answer,
    contextAnswer: options.contextAnswer,
    features: options.features,
  })
  const warnings = []
  const logs = []
  let definition = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value
        },
      },
    },
    console: {
      info() {},
      warn(...args) {
        warnings.push(args)
      },
      error() {},
      log(...args) {
        logs.push(args)
      },
      debug() {},
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    document,
    localStorage: storage,
    fetch: network.fetch,
    ResizeObserver: options.resizeObserver,
    navigator: { language: 'en-US' },
    URL,
    URLSearchParams,
    AbortSignal,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: CLIENT })
  assert.ok(definition, 'the bundle did not call window.__ModuleLoader__.load()')

  const renderer = makeRenderer({ rootWidth: options.rootWidth })
  const plugin = definition.factory(name => {
    if (name === 'react') return renderer.React
    throw new Error('unexpected require: ' + name)
  })
  const ctx = makeCtx(options)
  plugin.apply(ctx)
  ctx.__flushSlots()
  return { ctx, plugin, renderer, timers, document, storage, network, warnings, logs }
}

/**
 * Cordis 4.1's injected scope: a service can be read only when its exact name was
 * declared in the inject array. Reading any other top-level property throws the
 * error Cordis raises, instead of quietly handing back an object; a declared
 * namespace exposes only its declared dotted children, so injecting
 * 'remote.mcpManager' alone does not make `inner.remote` readable — both names
 * must be declared. This is what the old lenient fake let a test miss.
 */
function injectedScope(deps, services) {
  const declared = new Set(deps)
  const roots = new Set([...declared].filter(name => !name.includes('.')))
  const target = {}
  for (const root of roots) {
    const children = new Set(
      [...declared].filter(name => name.startsWith(root + '.')).map(name => name.slice(root.length + 1)),
    )
    if (children.size === 0) {
      // A plain service (no declared dotted children) reads as the service value itself.
      Object.defineProperty(target, root, { enumerable: true, get: () => services[root] })
      continue
    }
    const base = {}
    for (const child of children) {
      Object.defineProperty(base, child, { enumerable: true, get: () => services[root]?.[child] })
    }
    const namespace = new Proxy(base, {
      get(object, key) {
        if (typeof key === 'symbol') return undefined
        if (!children.has(key)) throw new Error('cannot get property "' + root + '.' + key + '" without inject')
        return object[key]
      },
    })
    Object.defineProperty(target, root, { enumerable: true, get: () => namespace })
  }
  return new Proxy(target, {
    get(object, key) {
      if (typeof key === 'symbol') return undefined
      if (!roots.has(key)) throw new Error('cannot get property "' + key + '" without inject')
      return object[key]
    },
  })
}

/**
 * The plugin context: the seats every mounted feature touches, recording
 * registrations. `missingSlot` makes `inject` probe the body key its callback
 * registers and throw only for the Environment body, which is how a host
 * without the tab slot behaves for that one feature. `inject` is Cordis' scoped
 * injection: it returns a fiber-like object, declares only the services the
 * callback reads and runs the callback's cleanup on dispose or when the service
 * goes. `restart` supplies the fake remote.mcpManager service and `credentials`
 * the fake remote.credentials.set service; `noInject` drops the seat, as on a
 * client context without scoped injection. `effect` refuses a
 * callback that returns something other than a cleanup function, as Cordis does.
 */
function makeCtx(options = {}) {
  const tabTypes = []
  const registrations = []
  const injections = []
  const scoped = []
  const effects = []
  let effectDepth = 0
  let restart = typeof options.restart === 'function' ? options.restart : null
  let credentials = typeof options.credentials === 'function' ? options.credentials : null
  /* This dsh build's Remote methods resolve { ok, value } or { ok: false, error }; only
     assembly faults reject. Every fake is wrapped in that envelope unless it supplies one. */
  const asRemote = method => (...args) =>
    Promise.resolve(method(...args)).then(value =>
      value !== null && typeof value === 'object' && typeof value.ok === 'boolean'
        ? value
        : { ok: true, value },
    )
  const services = () => {
    const remote = {}
    if (restart !== null) remote.mcpManager = { restart: asRemote(restart) }
    if (credentials !== null) remote.credentials = { set: asRemote(credentials) }
    return Object.keys(remote).length === 0 ? {} : { remote }
  }
  const ctx = {
    sidebarRightTabs: {
      register(definition) {
        tabTypes.push(definition)
        return () => {}
      },
    },
    slots: {
      inject(slot, callback) {
        if (options.missingSlot !== true) {
          injections.push({ slot, callback })
          return () => {}
        }
        // Run the callback against a probing register to learn its body key. The slot
        // either accepts that body (register it for real) or refuses it (throw, as a
        // host without the slot does).
        let key = null
        const realRegister = this.register
        this.register = spec => {
          key = spec.key
          return () => {}
        }
        try {
          callback()
        } finally {
          this.register = realRegister
        }
        if (key === TAB_ID) throw new Error('no such slot: ' + slot)
        callback()
        return () => {}
      },
      register(spec, component) {
        registrations.push({ slot: spec.name, spec, component })
        return () => {}
      },
    },
    effect(callback) {
      const record = { result: undefined }
      effects.push(record)
      effectDepth += 1
      try {
        const dispose = callback()
        record.result = dispose
        if (dispose !== undefined && typeof dispose !== 'function') throw new Error('Invalid effect')
        return typeof dispose === 'function' ? dispose : () => {}
      } finally {
        effectDepth -= 1
      }
    },
    __tabTypes: tabTypes,
    __registrations: registrations,
    __injections: injections,
    __scopedInjections: scoped,
    __effects: effects,
    __flushSlots() {
      for (const { callback } of injections) callback()
    },
  }
  if (options.noInject !== true) {
    ctx.inject = (deps, callback) => {
      const entry = {
        deps,
        callback,
        disposed: false,
        active: false,
        cleanup: null,
        fromEffect: effectDepth > 0,
        fiber: null,
      }
      entry.start = () => {
        if (entry.active || entry.disposed) return
        entry.active = true
        const cleanup = callback(injectedScope(deps, services()))
        if (cleanup !== undefined && typeof cleanup !== 'function') {
          throw new Error('an injected scope must return a cleanup function')
        }
        entry.cleanup = typeof cleanup === 'function' ? cleanup : null
      }
      entry.stop = () => {
        if (!entry.active) return
        entry.active = false
        const cleanup = entry.cleanup
        entry.cleanup = null
        if (typeof cleanup === 'function') cleanup()
      }
      entry.dispose = () => {
        if (entry.disposed) return
        entry.disposed = true
        entry.stop()
      }
      entry.fiber = { dispose: entry.dispose }
      scoped.push(entry)
      // A scope starts only when the services it declares exist in this fake context;
      // this context has no terminal service, so the Run button's scope stays off.
      const present = deps.every(name => {
        if (name === 'remote.credentials') return credentials !== null
        if (name === 'remote.mcpManager') return restart !== null
        if (name === 'webTerminals') return false
        return true
      })
      if (present) entry.start()
      return entry.fiber
    }
    /* A test makes one Remote service appear after mount (pass a function) or go away
       (pass null); Cordis then starts that scope or runs its cleanup. */
    const setService = (name, present) => {
      for (const entry of scoped) {
        if (!entry.deps.includes(name)) continue
        if (present) entry.start()
        else entry.stop()
      }
    }
    ctx.__setRestartService = next => {
      const wasPresent = restart !== null
      restart = typeof next === 'function' ? next : null
      if ((restart !== null) === wasPresent) return
      setService('remote.mcpManager', restart !== null)
    }
    ctx.__setCredentialService = next => {
      const wasPresent = credentials !== null
      credentials = typeof next === 'function' ? next : null
      if ((credentials !== null) === wasPresent) return
      setService('remote.credentials', credentials !== null)
    }
  }
  return ctx
}

/* ------------------------------------------------------------------ */
/* Body props and rendering                                            */
/* ------------------------------------------------------------------ */

/**
 * The body props the slot supplies: the standard session and projection props plus
 * the message-box and running-session readers the Compact button needs. A reader a
 * test does not supply is absent, as on a host that lacks it. The readers apply the
 * selector the body hands them, as the host hooks do.
 */
function makeBodyProps(options = {}) {
  const useInput =
    options.useInput ?? (options.input === undefined ? undefined : selector => selector(options.input))
  const useSessionStatus =
    options.useSessionStatus ?? (options.status === undefined ? undefined : selector => selector(options.status))
  return {
    sessionId: options.sessionId === undefined ? 's1' : options.sessionId,
    useTabInfo: () => ({ tab: { visible: options.visible !== false } }),
    useProjection: key =>
      key === 'contextPressure' ? options.pressure : key === 'contextBreakdown' ? options.breakdown : undefined,
    useInput,
    inputActions: options.inputActions,
    useSessionStatus,
  }
}

/** The Environment tab body registration the plugin made. */
function environmentRegistration(ctx) {
  const found = ctx.__registrations.find(entry => entry.slot === SLOT && entry.spec.key === TAB_ID)
  assert.ok(found, 'no Environment tab body registered in ' + SLOT + ' with key ' + TAB_ID)
  return found
}

/** Render the body once with the props the app's slot supplies and the registration's inject. */
function renderBody(renderer, registration, options = {}) {
  const injected = typeof registration.spec.inject === 'function' ? registration.spec.inject() : undefined
  return renderer.render(registration.component, { ...makeBodyProps(options), ...(injected ?? {}) })
}

/** Let every pending fetch promise settle before the next render shows its answer. */
async function settle() {
  await new Promise(resolve => setImmediate(resolve))
}

/** Render once, let the first fetch settle, then render the answered tree. */
async function loadedBody(renderer, registration, options = {}) {
  renderBody(renderer, registration, options)
  await settle()
  return renderBody(renderer, registration, options)
}

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

function collect(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  for (const child of node.children || []) collect(child, predicate, found)
  return found
}

/** Whether any string anywhere in the rendered tree (including props like an input's value) carries the needle. */
function treeHasText(node, needle) {
  if (typeof node === 'string') return node.includes(needle)
  if (typeof node === 'number') return String(node).includes(needle)
  if (node === null || node === undefined || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(child => treeHasText(child, needle))
  for (const [key, value] of Object.entries(node)) {
    if (key === '__node' || key === 'children') continue
    if (treeHasText(value, needle)) return true
  }
  return node.children === undefined ? false : treeHasText(node.children, needle)
}

function textOf(node) {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children || []).map(textOf).join('')
}

/** The text a sighted user sees: the connector rows' 1 px clipped detail spans are skipped. */
function visibleTextOf(node) {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(visibleTextOf).join('')
  if (node === null || node === undefined || typeof node !== 'object') return ''
  const style = node.props?.style
  if (
    style?.position === 'absolute' &&
    style.width === 1 &&
    style.height === 1 &&
    style.clip === 'rect(0 0 0 0)'
  ) {
    return ''
  }
  return (node.children || []).map(visibleTextOf).join('')
}

/** The single Refresh button the tab renders. */
function refreshButton(tree) {
  const buttons = collect(tree, node => node.type === 'button' && textOf(node).trim() === 'Refresh')
  assert.equal(buttons.length, 1, 'the tab renders one Refresh button')
  return buttons[0]
}

/** The Context header's summary: the aria-hidden inline row with the percent and the pill. */
function contextHeaderSummary(tree) {
  const summaries = collect(
    sectionHeader(tree, 'context'),
    node =>
      node.props !== undefined &&
      node.props['aria-hidden'] === 'true' &&
      node.props.style !== undefined &&
      node.props.style.display === 'inline-flex',
  )
  assert.equal(summaries.length, 1, 'the Context header renders one aria-hidden summary')
  return summaries[0]
}

/** The Context header pill bar: the 24 x 6 px track. */
function contextPill(tree) {
  const pills = collect(
    contextHeaderSummary(tree),
    node =>
      node.type === 'span' &&
      node.props.style !== undefined &&
      node.props.style.width === 24 &&
      node.props.style.height === 6,
  )
  assert.equal(pills.length, 1, 'the Context header renders one 24 x 6 px pill')
  return pills[0]
}

/** The Context bar's filled part, found by its inline width. */
function barFill(tree, percent) {
  const fills = collect(
    tree,
    node => node.type === 'div' && node.props.style !== undefined && node.props.style.width === percent + '%',
  )
  assert.equal(fills.length, 1, 'the Context bar renders one fill at ' + percent + '%')
  return { ...fills[0].props.style }
}

/** The Context body's rows of one kind ('used', 'buffer', 'free' or 'deferred'), in render order. */
function contextRowsOf(tree, kind) {
  return collect(tree, node => node.props !== undefined && node.props['data-context-row'] === kind)
}

/** One Context row's parts: the swatch style, the name, the tokens and the share. */
function contextRowParts(row) {
  const swatch = row.children[0]
  const name = row.children[1]
  const tokens = row.children[2]
  const share = row.children[3]
  return {
    swatch: { ...swatch.props.style },
    swatchAriaHidden: swatch.props['aria-hidden'],
    name: textOf(name),
    nameTitle: name.props.title,
    tokens: textOf(tokens),
    tokensStyle: { ...tokens.props.style },
    share: textOf(share),
    shareStyle: { ...share.props.style },
  }
}

/** The Context body's row groups, in render order, by their marker. */
function contextGroups(tree) {
  return collect(
    tree,
    node => node.props !== undefined && typeof node.props['data-context-group'] === 'string',
  )
}

/** The Context bar's stacked segments, in render order. */
function contextSegments(tree) {
  return collect(tree, node => node.props !== undefined && node.props['data-context-segment'] !== undefined)
}

/** The Context body's headline, marked so its two token spans can be told apart. */
function contextHeadline(tree) {
  const headlines = collect(tree, node => node.props !== undefined && node.props['data-context-headline'] !== undefined)
  assert.equal(headlines.length, 1, 'the Context body renders one headline')
  return headlines[0]
}

/** The Compact session button, or null when the host offers none. */
function compactButton(tree) {
  const buttons = collect(tree, node => node.type === 'button' && textOf(node).trim() === 'Compact session')
  return buttons.length === 0 ? null : buttons[0]
}

/** The panel's aria-busy value; the root div always carries the attribute. */
function panelBusy(tree) {
  const panels = collect(tree, node => node.type === 'div' && Object.hasOwn(node.props, 'aria-busy'))
  assert.equal(panels.length, 1, 'the panel carries one aria-busy attribute')
  return panels[0].props['aria-busy']
}

/** The change-letter spans: one per file row, each exactly 10 px wide. */
function fileRows(tree) {
  return collect(
    tree,
    node => node.type === 'span' && node.props.style !== undefined && node.props.style.width === 10,
  )
}

/** The column's section headers, in render order. */
function sectionHeaders(tree) {
  return collect(tree, node => node.type === 'button' && typeof node.props['data-section'] === 'string')
}

/** The ids of the section headers, in render order. */
function headerIds(tree) {
  return sectionHeaders(tree).map(node => node.props['data-section'])
}

/** The one header of that section. */
function sectionHeader(tree, id) {
  const headers = sectionHeaders(tree).filter(node => node.props['data-section'] === id)
  assert.equal(headers.length, 1, 'the column renders one ' + id + ' header')
  return headers[0]
}

/** The section name each header shows, ignoring the aria-hidden chevron and summary. */
function sectionHeaderName(node) {
  return node.children
    .filter(child => child === null || child === undefined || child.props?.['aria-hidden'] !== 'true')
    .map(textOf)
    .join('')
    .trim()
}

/** The body a section header controls, found through its aria-controls id. */
function sectionBody(tree, id) {
  const header = sectionHeader(tree, id)
  const bodyId = header.props['aria-controls']
  const bodies = collect(tree, node => node.props !== undefined && node.props.id === bodyId)
  assert.equal(bodies.length, 1, 'the ' + id + ' header controls one existing body')
  return bodies[0]
}

/** The section wrapper of one id, which carries the drag drop line. */
function sectionWrapper(tree, id) {
  const wrappers = collect(tree, node => node.type === 'section' && node.props['data-column-section'] === id)
  assert.equal(wrappers.length, 1, 'the column renders one ' + id + ' section')
  return wrappers[0]
}

/** The narrow strip, marked by its data attribute. */
function narrowStrip(tree) {
  const strips = collect(tree, node => node.props !== undefined && node.props['data-column-strip'] !== undefined)
  assert.equal(strips.length, 1, 'the narrow pane renders one strip')
  return strips[0]
}

/** The strip's labeled icons, in render order. */
function stripIcons(tree) {
  return collect(narrowStrip(tree), node => node.props !== undefined && node.props.role === 'img')
}

/** The 10 px secondary percent the strip writes under the Context icon. */
function stripPercent(tree) {
  const percents = collect(
    narrowStrip(tree),
    node => node.props !== undefined && node.props.style !== undefined && node.props.style.fontSize === 10,
  )
  assert.equal(percents.length, 1, 'the strip writes one percent under the Context icon')
  return percents[0]
}

/** Whether any node carries that title attribute (a row's full text). */
function hasTitle(tree, title) {
  return collect(tree, node => node.props !== undefined && node.props.title === title).length > 0
}

/** Every connector row, in render order, by its state marker. */
function connectorRows(tree) {
  return collect(tree, node => node.props !== undefined && typeof node.props['data-connector-state'] === 'string')
}

/** The one connector row whose name text is exactly that connector. */
function connectorRowNamed(tree, name) {
  const rows = connectorRows(tree).filter(row => textOf(row.children[1]) === name)
  assert.equal(rows.length, 1, 'the tree renders one connector row named ' + name)
  return rows[0]
}

/** The Reconnect button of one connector row, or null when the row offers none. */
function reconnectButton(tree, name) {
  const buttons = collect(tree, node => node.type === 'button' && node.props['aria-label'] === 'Reconnect ' + name)
  return buttons.length === 0 ? null : buttons[0]
}

/** Every Reconnect button in the tree, in render order. */
function reconnectButtons(tree) {
  return collect(
    tree,
    node => node.type === 'button' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Reconnect '),
  )
}

/** The Sign in button of one connector row, or null when the row offers none. */
function signInButton(tree, name) {
  const buttons = collect(tree, node => node.type === 'button' && node.props['aria-label'] === 'Sign in to ' + name)
  return buttons.length === 0 ? null : buttons[0]
}

/** Every Sign in button in the tree, in render order. */
function signInButtons(tree) {
  return collect(
    tree,
    node => node.type === 'button' && typeof node.props['aria-label'] === 'string' && node.props['aria-label'].startsWith('Sign in to '),
  )
}

/** The inline credential form of a row, or null when no form is open. */
function signInForm(tree) {
  const forms = collect(sectionBody(tree, 'connectors'), node => node.props !== undefined && node.props['data-credential-form'] !== undefined)
  assert.equal(forms.length <= 1, true, 'at most one credential form is open')
  return forms.length === 0 ? null : forms[0]
}

/** The password inputs inside the open credential form, in render order. */
function credentialInputs(tree) {
  return collect(tree, node => node.type === 'input' && node.props.type === 'password')
}

/** A named button inside the open credential form. */
function formButton(tree, label) {
  const form = signInForm(tree)
  if (form === null) return null
  const buttons = collect(form, node => node.type === 'button' && textOf(node) === label)
  assert.equal(buttons.length, 1, 'the credential form has one "' + label + '" button')
  return buttons[0]
}

/** Every connector-row live region in the Connectors section, empty ones included. */
function connectorStatusRegions(tree) {
  return collect(sectionBody(tree, 'connectors'), node => node.type === 'p' && node.props.role === 'status')
}

/** The status messages with text the Connectors section shows (a failed read or a failed Reconnect). */
function connectorStatusMessages(tree) {
  return connectorStatusRegions(tree).filter(node => textOf(node) !== '')
}

/** The structural path from a tree root to the first node matching a predicate. Each step
 *  records the child index and, when present, the element's key, so a change in an ancestor's
 *  shape shows up as a different path. */
function keyPathOf(node, predicate, path = '') {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const found = keyPathOf(node[i], predicate, path + '/' + i)
      if (found !== null) return found
    }
    return null
  }
  const key = node.props?.key === undefined ? '' : '{' + String(node.props.key) + '}'
  const here = path + '/' + String(node.type ?? '?') + key
  if (predicate(node)) return here
  for (let i = 0; i < (node.children || []).length; i += 1) {
    const found = keyPathOf(node.children[i], predicate, here + '/' + i)
    if (found !== null) return found
  }
  return null
}

/** A connector row's parts: avatar, name, visually hidden details and right-side state. */
function connectorParts(row) {
  const avatar = row.children[0]
  const name = row.children[1]
  const hidden = row.children[2]
  const right = row.children[3]
  return {
    avatar: textOf(avatar),
    avatarHidden: avatar.props['aria-hidden'],
    avatarStyle: { ...avatar.props.style },
    name: textOf(name),
    hidden: hidden === undefined ? null : textOf(hidden),
    hiddenAriaHidden: hidden === undefined ? null : hidden.props['aria-hidden'],
    hiddenStyle: hidden === undefined ? null : { ...hidden.props.style },
    right: right === undefined ? null : textOf(right),
    rightAriaHidden: right === undefined ? null : right.props['aria-hidden'],
    rightStyle: right === undefined ? null : { ...right.props.style },
  }
}

/** The pull-request rows, in render order, by their state marker. */
function pullRows(tree) {
  return collect(tree, node => node.props !== undefined && typeof node.props['data-pull-state'] === 'string')
}

/** The icon tone of one pull-request row: its icon wrapper carries the color. */
function pullTone(row) {
  return row.children[0].props.style.color
}

/** The button that toggles the progress file or the working-tree file list. */
function toggleButton(tree, text) {
  const buttons = collect(
    tree,
    node => node.type === 'button' && typeof node.props['aria-expanded'] === 'string' && textOf(node).includes(text),
  )
  assert.equal(buttons.length, 1, 'the tree renders one "' + text + '" toggle button')
  return buttons[0]
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** A complete Environment route answer: every section carries something to show. */
const FULL_ANSWER = {
  machine: { hostname: 'example-repo-machine', platform: 'win32' },
  cwd: 'D:\\Repos\\Example-App-worktrees\\feat-login',
  task: {
    git: {
      root: 'D:\\Repos\\Example-App-worktrees\\feat-login',
      branch: 'feat/ACL-12-login',
      detached: false,
      linkedWorktree: true,
      mainRoot: 'D:\\Repos\\Example-App',
    },
    repo: 'example-org/example-app',
    link: { state: 'linked', projectRef: 'Example.ACL' },
    card: { key: 'ACL-12', url: 'https://tracker.example.com/example/issue/ACL-12' },
    branchFollowsConvention: true,
    progress: {
      path: 'D:\\Repos\\Example-App-worktrees\\feat-login.progress.md',
      text: '# Progress\n\nStep 1 done.',
      truncated: false,
    },
  },
  changes: {
    upstream: 'origin/feat/ACL-12-login',
    ahead: 2,
    behind: 0,
    staged: 2,
    unstaged: 1,
    untracked: 0,
    conflicted: 0,
    total: 2,
    files: [
      { path: 'src/login.js', index: 'M', worktree: 'M', kind: 'both' },
      { path: 'src/session.js', origPath: 'src/auth.js', index: 'R', worktree: '.', kind: 'staged' },
    ],
  },
  connectors: [
    { name: 'github', configured: true, state: 'connected', toolCount: 7 },
    { name: 'linear', configured: true, state: 'failed', error: 'sse handshake failed' },
  ],
  pullRequests: [
    {
      url: 'https://github.com/example-org/example-app/pull/12',
      number: 12,
      origin: 'created',
      title: 'Add login',
      state: 'open',
      draft: false,
      checks: 'success',
      review: 'approved',
    },
    { url: 'https://github.com/example-org/example-app/pull/13', number: 13, origin: 'referenced' },
  ],
  errors: {},
}

/** A route answer where two sections failed but the rest answered. */
const SECTION_ERRORS_ANSWER = {
  machine: { hostname: 'example-repo-machine', platform: 'linux' },
  cwd: '/home/dev/example-app',
  task: {
    git: null,
    repo: null,
    link: { state: 'unlinked' },
    card: null,
    branchFollowsConvention: null,
    progress: null,
  },
  changes: null,
  connectors: null,
  pullRequests: [],
  errors: {
    changes: 'git status did not answer',
    connectors: 'the MCP manager did not answer',
  },
}

/** The smallest 200 answer: the polling tests only count fetches. */
const PLAIN_ANSWER = {
  machine: { hostname: 'plain-machine', platform: 'linux' },
  cwd: '/work/plain',
  task: {
    git: null,
    repo: null,
    link: { state: 'n/a' },
    card: null,
    branchFollowsConvention: null,
    progress: null,
  },
  changes: null,
  connectors: null,
  pullRequests: [],
  errors: {},
}

/** A route answer with a different machine, for out-of-order request checks. */
const FAST_ANSWER = { ...PLAIN_ANSWER, machine: { hostname: 'fast-machine', platform: 'linux' } }
const SLOW_ANSWER = { ...PLAIN_ANSWER, machine: { hostname: 'slow-machine', platform: 'linux' } }

/** A route answer that is complete but reports the edge value of every row. */
const TASK_EDGE_ANSWER = {
  machine: { hostname: 'edge-machine', platform: 'darwin' },
  cwd: '/edge/folder',
  task: {
    git: { root: '/edge/folder', branch: 'main', detached: false, linkedWorktree: false, mainRoot: null },
    repo: null,
    link: { state: 'n/a' },
    card: null,
    branchFollowsConvention: false,
    progress: null,
  },
  changes: {
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    total: 0,
    files: [],
  },
  connectors: [],
  pullRequests: [],
  errors: {},
}

/** The task facts of an ordinary work tree with a GitHub origin. */
const GIT_TASK = {
  git: { root: '/work/repo', branch: 'main', detached: false, linkedWorktree: false, mainRoot: '/work/repo' },
  repo: 'owner/repo',
  link: { state: 'n/a' },
  card: null,
  branchFollowsConvention: null,
  progress: null,
}

/** An empty change summary, ready for one upstream variant. */
function emptyChanges(overrides = {}) {
  return {
    upstream: null,
    ahead: null,
    behind: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    total: 0,
    files: [],
    ...overrides,
  }
}

/** A plain work-tree answer with every section quiet. */
const GIT_ANSWER = { ...PLAIN_ANSWER, task: GIT_TASK, changes: emptyChanges(), errors: {} }

/** A tracked card with no configured tracker address: a key, but no link. */
const CARD_WITHOUT_LINK_ANSWER = {
  ...GIT_ANSWER,
  task: { ...GIT_TASK, card: { key: 'ACL-12' }, branchFollowsConvention: true },
}

/** A work tree whose row has task facts switched off: the optional keys are absent. */
const OPTED_OUT_ANSWER = {
  ...GIT_ANSWER,
  task: { git: GIT_TASK.git, repo: GIT_TASK.repo },
}

/** A work tree whose upstream is gone and whose connector fleet is absent. */
const GONE_ANSWER = {
  ...PLAIN_ANSWER,
  task: GIT_TASK,
  changes: emptyChanges({ upstream: 'origin/main' }),
  connectors: null,
  errors: {},
}

/** A work tree one commit ahead of its upstream. */
const AHEAD_ANSWER = {
  ...GONE_ANSWER,
  changes: emptyChanges({ upstream: 'origin/main', ahead: 1, behind: 0 }),
}

/** A work tree two commits ahead and one behind. */
const AHEAD_BEHIND_ANSWER = {
  ...GONE_ANSWER,
  changes: emptyChanges({ upstream: 'origin/main', ahead: 2, behind: 1 }),
}

/** A work tree whose upstream is only partly known. */
const PARTIAL_UPSTREAM_ANSWER = {
  ...GONE_ANSWER,
  changes: { ...GONE_ANSWER.changes, behind: 2 },
}

/** A work tree with no upstream at all. */
const NO_UPSTREAM_ANSWER = {
  ...GONE_ANSWER,
  changes: emptyChanges(),
}

/** A work tree sitting at a Windows drive root. */
const DRIVE_ROOT_ANSWER = { ...PLAIN_ANSWER, cwd: 'D:\\' }

/** A card-bearing session whose branch breaks the itsaplan convention. */
const OFF_PATTERN_ANSWER = {
  ...FULL_ANSWER,
  task: { ...FULL_ANSWER.task, branchFollowsConvention: false },
}

/** A session outside git whose task facts still name a repository and a card. */
const HIDDEN_TASK_ANSWER = {
  ...PLAIN_ANSWER,
  task: {
    git: null,
    repo: 'example-org/example-app',
    link: { state: 'linked', projectRef: 'Example.ACL' },
    card: { key: 'ACL-12', url: 'https://tracker.example.com/example/issue/ACL-12' },
    branchFollowsConvention: false,
    progress: null,
  },
}

/** A clean work tree whose pull-request read failed. */
const PULL_ERROR_ONLY_ANSWER = {
  ...GIT_ANSWER,
  errors: { pullRequests: 'the forge did not answer' },
}

/** A session whose progress file was cut at the route's limit. */
const TRUNCATED_PROGRESS_ANSWER = {
  ...FULL_ANSWER,
  task: { ...FULL_ANSWER.task, progress: { ...FULL_ANSWER.task.progress, truncated: true } },
}

/** One uncommitted file, for the singular uncommitted-change label. */
const SINGLE_CHANGE_ANSWER = {
  ...GIT_ANSWER,
  changes: {
    ...emptyChanges({ staged: 1, total: 1 }),
    files: [{ path: 'src/one.js', index: 'M', worktree: '.', kind: 'staged' }],
  },
}

/** Four pull requests whose states cover every icon tone, plus one without a title. */
const PULLS_ANSWER = {
  ...PLAIN_ANSWER,
  task: GIT_TASK,
  changes: emptyChanges(),
  pullRequests: [
    {
      url: 'https://github.com/o/r/pull/1',
      number: 1,
      origin: 'created',
      title: 'Open work',
      state: 'OPEN',
      draft: false,
      checks: 'success',
      review: 'approved',
    },
    { url: 'https://github.com/o/r/pull/2', number: 2, origin: 'referenced', title: 'Merged work', state: 'Merged', checks: 'neutral' },
    { url: 'https://github.com/o/r/pull/3', number: 3, origin: 'referenced', title: 'Closed work', state: 'closed' },
    { url: 'https://github.com/o/r/pull/4', number: 4, origin: 'referenced', title: 'Draft work', state: 'open', draft: true },
    { url: 'https://github.com/o/r/pull/5', number: 5, origin: 'referenced' },
  ],
}

/** Both changes-section reads failed. */
const BOTH_ERRORS_ANSWER = {
  ...PLAIN_ANSWER,
  errors: { changes: 'git status did not answer', pullRequests: 'the forge did not answer' },
}


/** A route answer with more changed files than the tab lists. */
const MANY_FILES_ANSWER = {
  ...GIT_ANSWER,
  changes: {
    upstream: null,
    ahead: null,
    behind: null,
    staged: 51,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    total: 60,
    files: Array.from({ length: 51 }, (unused, index) => ({
      path: 'src/many-' + index + '.js',
      index: 'M',
      worktree: '.',
      kind: 'staged',
    })),
  },
}

/** A route answer with a hollow connector dot beside the filled one. */
const CONNECTOR_ANSWER = {
  ...PLAIN_ANSWER,
  connectors: [
    { name: 'github', configured: true, state: 'connected', toolCount: 7 },
    { name: 'legacy', configured: false, state: 'closed' },
  ],
}

/** A route answer with the manager's servers and the profile's plain dsh-mcp-client rows. */
const PINNED_CONNECTORS_ANSWER = {
  ...PLAIN_ANSWER,
  connectors: [
    { name: 'firecrawl', configured: true, state: 'pinned', toolCount: 2 },
    { name: 'solo', configured: true, state: 'pinned', toolCount: 1 },
    { name: 'github', configured: true, state: 'connected', toolCount: 7 },
  ],
}

/** Every connector state the restyled section renders, plus the avatar edge names. */
const CONNECTOR_STATES_ANSWER = {
  ...PLAIN_ANSWER,
  connectors: [
    { name: 'github', configured: true, state: 'connected', toolCount: 7 },
    { name: 'firecrawl', configured: true, state: 'pinned', toolCount: 2 },
    { name: 'solo', configured: true, state: 'pinned', toolCount: 1 },
    { name: 'connecting', configured: true, state: 'connecting', attempt: 2 },
    { name: 'reconnecting', configured: true, state: 'reconnecting', attempt: 1 },
    { name: 'reconnecting-error', configured: true, state: 'reconnecting', attempt: 3, error: 'socket closed' },
    { name: 'credentials', configured: true, state: 'waiting-credentials', error: 'token expired' },
    { name: 'failed-error', configured: true, state: 'failed', error: 'sse handshake failed' },
    { name: 'failed-reason', configured: true, state: 'failed', reason: 'gave-up' },
    { name: 'reconnect-disabled', configured: true, state: 'failed', reason: 'reconnect-disabled' },
    { name: 'unclosed-generation', configured: true, state: 'failed', reason: 'unclosed-generation' },
    { name: 'unknown-reason', configured: true, state: 'failed', reason: 'handshake timed out' },
    { name: 'plain-failed', configured: true, state: 'failed' },
    { name: 'has-error', configured: true, state: 'failed', reason: 'gave-up', error: 'sse handshake failed' },
    { name: 'disabled', configured: false, state: 'disabled' },
    { name: 'closed', configured: false, state: 'closed' },
    { name: '_x1', configured: false, state: 'disabled' },
    { name: '--', configured: false, state: 'closed' },
    { name: 'ßeta', configured: false, state: 'closed' },
  ],
}

/** One connector of every state the Reconnect rule tells apart. */
const RECONNECT_ANSWER = {
  ...PLAIN_ANSWER,
  connectors: [
    { name: 'github', configured: true, state: 'connected', toolCount: 7 },
    { name: 'linear', configured: true, state: 'failed', error: 'sse handshake failed' },
    { name: 'stopped', configured: false, state: 'closed' },
    { name: 'pinned-failed', configured: true, state: 'pinned', error: 'sse handshake failed' },
    { name: 'connecting', configured: true, state: 'connecting', attempt: 2 },
    { name: 'reconnecting', configured: true, state: 'reconnecting', attempt: 1 },
    { name: 'credentials', configured: true, state: 'waiting-credentials', error: 'token expired' },
    { name: 'disabled', configured: false, state: 'disabled' },
  ],
}

/** Sign in candidates: a waiting row with names, one without, and a connected row with names. */
const SIGNIN_ANSWER = {
  ...PLAIN_ANSWER,
  connectors: [
    { name: 'linear', configured: true, state: 'waiting-credentials', error: 'token expired', credentials: ['LINEAR_TOKEN'] },
    { name: 'plain', configured: true, state: 'waiting-credentials' },
    { name: 'github', configured: true, state: 'connected', toolCount: 3, credentials: ['GH_TOKEN'] },
  ],
}

/** One waiting row whose form has two credential names, for overlapping-value tests. */
const SIGNIN_MULTI_ANSWER = {
  ...PLAIN_ANSWER,
  connectors: [
    { name: 'linear', configured: true, state: 'waiting-credentials', credentials: ['SHORT', 'LONG'] },
  ],
}

/** Two waiting rows, so a form can be moved from one to the other. */
const SIGNIN_TWO_ROWS_ANSWER = {
  ...PLAIN_ANSWER,
  connectors: [
    { name: 'alpha', configured: true, state: 'waiting-credentials', credentials: ['ALPHA_TOKEN'] },
    { name: 'beta', configured: true, state: 'waiting-credentials', credentials: ['BETA_TOKEN'] },
  ],
}

/** Five connected connectors: enough for the section's three-row cap. */
const MANY_CONNECTORS_ANSWER = {
  ...PLAIN_ANSWER,
  connectors: Array.from({ length: 5 }, (unused, index) => ({
    name: 'server-' + index,
    configured: true,
    state: 'connected',
    toolCount: index,
  })),
}

/**
 * The dsh-oh-my-claude context answer the Context section prefers: used categories
 * summing to the route's total, one buffer entry without `kind` (classified by its
 * ending), one deferred entry without `kind` (classified by `deferred`), a free-space
 * row and a used row small enough to need the bar's minimum width. The route's own
 * `percentage` is what the headline shows, rounded: 41.6 becomes 42, which the
 * totals would not compute (they would give 39).
 */
const CLAUDE_CONTEXT_ANSWER = {
  ok: true,
  categories: [
    { name: 'System prompt', tokens: 20_000, kind: 'used' },
    { name: 'Tool definitions', tokens: 48_000, kind: 'used' },
    { name: 'Messages', tokens: 320_000, kind: 'used' },
    { name: 'Memory', tokens: 500, kind: 'used' },
    { name: 'Attachments', tokens: 500, kind: 'used' },
    { name: 'Compact buffer', tokens: 9_000 },
    { name: 'Free space', tokens: 602_000, kind: 'free' },
    { name: 'MCP tools', tokens: 4_000, deferred: true },
    { name: 'Skill details', tokens: 1_000, kind: 'deferred' },
  ],
  totalTokens: 389_000,
  maxTokens: 1_000_000,
  percentage: 41.6,
  model: 'claude-opus-5-5',
}

/** A route answer with a null or non-object entry in every list the tab reads. */
const HOSTILE_ANSWER = {
  ...GIT_ANSWER,
  changes: {
    upstream: null,
    ahead: null,
    behind: null,
    staged: 1,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    total: 1,
    files: [null, 'nope', { path: 'src/ok.js', index: 'M', worktree: '.', kind: 'staged' }],
  },
  connectors: [null, 'nope', { name: 'github', configured: true, state: 'connected', toolCount: 2 }],
  pullRequests: [
    null,
    'nope',
    { url: 'https://github.com/o/r/pull/10', origin: 'referenced' },
    { url: 'https://github.com/o/r/pull/9', number: 9, origin: 'referenced' },
  ],
}

/* ------------------------------------------------------------------ */
/* Acceptance tests                                                    */
/* ------------------------------------------------------------------ */

test('apply registers the Environment tab type and its body', () => {
  const { ctx } = mountBundle()
  const tab = ctx.__tabTypes.find(definition => definition.id === TAB_ID)
  assert.ok(tab, 'no tab type registered with id ' + TAB_ID)
  assert.equal(tab.kind, KIND)
  assert.equal(tab.title(), 'Environment')
  assert.equal(tab.guide.length, 1, 'the Environment tab contributes exactly one guide entry')
  const guide = tab.guide[0]
  assert.equal(guide.id, 'environment')
  assert.equal(guide.order, 30)
  assert.equal(guide.title(), 'Environment')
  assert.equal(
    guide.description(),
    "Machine, folder, branch, context use and changes of this session, and the app's connectors",
  )
  assert.equal(typeof guide.icon, 'function', 'the guide entry draws an icon component')

  const body = ctx.__registrations.find(entry => entry.slot === SLOT && entry.spec.key === TAB_ID)
  assert.ok(body, 'the Environment body is registered in ' + SLOT + ' under ' + TAB_ID)

  const ids = ctx.__tabTypes.map(definition => definition.id)
  for (const id of ['dsh-claude-sidebar/jobs', 'dsh-claude-sidebar/subagents']) {
    assert.ok(ids.includes(id), 'the existing ' + id + ' tab type is still registered')
  }
  const rail = ctx.__registrations.find(
    entry => entry.slot === 'shell.overlay' && entry.spec.id === 'dsh-claude-sidebar/rail',
  )
  assert.ok(rail, 'the rail is still registered in shell.overlay')
})

test('a host without the tab slot keeps the other features and warns once', () => {
  const { ctx, warnings } = mountBundle({ missingSlot: true })
  const ids = ctx.__tabTypes.map(definition => definition.id)
  for (const id of [
    'dsh-claude-sidebar/jobs',
    'dsh-claude-sidebar/subagents',
    'dsh-claude-sidebar/environment',
  ]) {
    assert.ok(ids.includes(id), 'the ' + id + ' tab type is still registered')
  }
  assert.equal(ids.length, 4, 'the three remaining tab types and the Git tab are registered')
  assert.equal(
    ctx.__registrations.filter(entry => entry.slot === SLOT && entry.spec.key === TAB_ID).length,
    0,
    'the Environment body is not registered when its slot is missing',
  )
  assert.equal(
    ctx.__registrations.filter(entry => entry.slot === SLOT && entry.spec.key !== TAB_ID).length,
    3,
    'the Jobs, Subagents and Git tab bodies still register',
  )
  for (const key of ['dsh-claude-sidebar/jobs', 'dsh-claude-sidebar/subagents']) {
    assert.ok(
      ctx.__registrations.some(entry => entry.slot === SLOT && entry.spec.key === key),
      'the ' + key + ' body still registers',
    )
  }
  assert.equal(ownWarnings(warnings).length, 1, 'only the Environment mount reports the missing slot')
  assert.match(
    String(ownWarnings(warnings)[0][0]),
    /^environment panel: this host has no "sidebar\.right\.pane\.tab" slot$/u,
  )
})

test('the pure helpers compute context use, token labels, platform and change letters', () => {
  const parts = loadEnvironmentParts()
  for (const name of ['contextUsage', 'formatTokens', 'platformLabel', 'changeLetter']) {
    assert.equal(typeof parts[name], 'function', 'features/environment/client/environment.js must define a pure ' + name + '()')
  }

  assert.equal(parts.contextUsage(undefined), null, 'no projection is no usage')
  assert.equal(parts.contextUsage(null), null, 'a null projection is no usage')
  assert.equal(parts.contextUsage({ pressureTokens: 50_000 }), null, 'no context window is no usage')
  assert.equal(
    parts.contextUsage({ pressureTokens: 50_000, contextWindow: 0 }),
    null,
    'a zero context window is no usage, not 100%',
  )
  assert.equal(
    parts.contextUsage({ projectedTokens: 50_000, contextWindow: null }),
    null,
    'a null context window is no usage, not 100%',
  )
  assert.equal(
    parts.contextUsage({ pressureTokens: Number.NaN, contextWindow: 200_000 }),
    null,
    'non-finite used tokens are no usage',
  )
  assert.equal(
    parts.contextUsage({ pressureTokens: 50_000, contextWindow: Number.POSITIVE_INFINITY }),
    null,
    'an infinite context window is no usage',
  )
  assert.deepEqual(
    parts.contextUsage({ pressureTokens: 50_000, contextWindow: 200_000 }),
    { usedTokens: 50_000, contextWindow: 200_000, percent: 25 },
  )
  assert.deepEqual(
    parts.contextUsage({ pressureTokens: 50_000, projectedTokens: 100_000, contextWindow: 200_000 }),
    { usedTokens: 100_000, contextWindow: 200_000, percent: 50 },
    'the projected total wins over the pressure reading',
  )
  assert.deepEqual(
    parts.contextUsage({ pressureTokens: 300_000, contextWindow: 200_000 }),
    { usedTokens: 300_000, contextWindow: 200_000, percent: 100 },
    'usage over the window is clamped to 100',
  )

  const tokenCases = [
    { n: 950, expected: '950' },
    { n: 84_100, expected: '84.1k' },
    { n: 200_000, expected: '200k' },
    { n: 999_949, expected: '999.9k' },
    { n: 999_950, expected: '1M' },
    { n: 999_999, expected: '1M' },
    { n: 1_050_000, expected: '1.05M' },
    { n: 2_000_000, expected: '2M' },
  ]
  for (const item of tokenCases) {
    assert.equal(parts.formatTokens(item.n), item.expected, String(item.n))
  }

  assert.equal(parts.platformLabel('win32'), 'Windows')
  assert.equal(parts.platformLabel('darwin'), 'macOS')
  assert.equal(parts.platformLabel('linux'), 'Linux')
  assert.equal(parts.platformLabel('freebsd'), 'freebsd', 'an unknown platform keeps its raw name')

  const letterCases = [
    { file: { path: 'notes.md', index: '?', worktree: '?', kind: 'untracked' }, expected: '?' },
    { file: { path: 'conflict.js', index: 'U', worktree: 'U', kind: 'conflicted' }, expected: '!' },
    { file: { path: 'src/m.js', index: '.', worktree: 'M', kind: 'unstaged' }, expected: 'M' },
    { file: { path: 'src/a.js', index: 'A', worktree: '.', kind: 'staged' }, expected: 'A' },
    { file: { path: 'src/b.js', index: 'M', worktree: 'M', kind: 'both' }, expected: 'M' },
  ]
  for (const item of letterCases) {
    assert.equal(parts.changeLetter(item.file), item.expected, item.file.path)
  }
})

test('the tab renders every section from the route answer and the context projection', async () => {
  const { renderer, ctx, network } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = environmentRegistration(ctx)
  const pressure = { projectedTokens: 84_100, contextWindow: 200_000 }

  let tree = renderBody(renderer, registration, { sessionId: 's 1', pressure })
  await settle()
  tree = renderBody(renderer, registration, { sessionId: 's 1', pressure })
  const text = textOf(tree)

  assert.equal(network.calls.length, 1, 'the visible tab fetches once at mount')
  assert.equal(network.calls[0].url, ROUTE + '?sessionId=' + encodeURIComponent('s 1'))
  assert.equal(network.calls[0].init.cache, 'no-store')
  assert.equal(network.calls[0].init.credentials, 'same-origin')
  assert.ok(
    network.calls[0].init.signal instanceof AbortSignal,
    'the fetch carries an abort signal so a stalled request cannot pin the poll',
  )
  assert.equal(network.calls[0].init.signal.aborted, false)
  assert.equal(panelBusy(tree), undefined, 'the first answer ends the busy state')

  assert.ok(text.includes('42% used'), 'the Context headline reads as the app meter does')
  assert.ok(text.includes('84.1k / 200k'), 'the Context headline shows the used and maximum tokens')
  assert.equal(barFill(tree, 42).background, IDLE, 'without a breakdown the bar is one neutral segment')
  assert.ok(text.includes('This computer'), 'the machine row reads This computer')
  assert.ok(
    hasTitle(tree, 'example-repo-machine · Windows'),
    'the machine row keeps hostname · product platform in its title',
  )
  assert.ok(text.includes('feat-login · D:\\Repos\\Example-App-worktrees'), 'the folder row splits name and parent')
  assert.ok(hasTitle(tree, FULL_ANSWER.cwd), 'the folder row keeps the full path in its title')
  assert.ok(text.includes('feat/ACL-12-login'), 'the branch is shown')
  assert.ok(
    hasTitle(tree, 'feat/ACL-12-login · worktree of D:\\Repos\\Example-App'),
    'a linked worktree names its main root in the title',
  )
  assert.ok(text.includes('↑2'), 'the upstream state is the short ahead arrow')
  assert.equal(text.includes('↓'), false, 'a zero behind count is left out of the upstream state')
  assert.ok(text.includes('example-org/example-app'), 'the repository slug is shown')
  assert.ok(text.includes('2 uncommitted changes'), 'the working-tree row counts the uncommitted files')
  assert.ok(text.includes('2 staged · 1 unstaged'), 'the non-zero change counts are shown at the right')
  assert.equal(text.includes('0 untracked'), false, 'a zero count is left out of the counts line')
  assert.equal(text.includes('0 conflicted'), false, 'a zero count is left out of the counts line')
  assert.equal(text.includes('src/login.js'), false, 'the file list starts collapsed')
  const changesButton = toggleButton(tree, 'uncommitted')
  assert.equal(changesButton.props['aria-expanded'], 'false', 'the working-tree row starts collapsed')
  changesButton.props.onClick()
  tree = renderBody(renderer, registration, { sessionId: 's 1', pressure })
  const expandedText = textOf(tree)
  assert.ok(expandedText.includes('src/login.js'), 'the changed file paths appear after a click')
  assert.ok(expandedText.includes('src/auth.js'), 'a rename shows its original path')
  assert.ok(expandedText.includes('src/auth.js \u2192 src/session.js'), 'a rename shows the arrow')
  const connected = connectorParts(connectorRowNamed(tree, 'github'))
  assert.equal(connected.right, null, 'a connected connector writes nothing at the right')
  assert.ok(
    hasTitle(tree, 'github · connected · 7 tools'),
    'a connected connector keeps its name, state and tool count in the title',
  )
  const failed = connectorParts(connectorRowNamed(tree, 'linear'))
  assert.equal(failed.right, 'Failed', 'a failed connector says Failed at the right')
  assert.ok(
    hasTitle(tree, 'linear · failed · sse handshake failed'),
    'a failed connector keeps its name, state and error in the title',
  )
  assert.ok(expandedText.includes('Add login'), 'a pull request shows its title')
  assert.ok(expandedText.includes('#12 · success · approved'), 'a pull request snapshot starts with its number')
  assert.ok(expandedText.includes('ACL-12'), 'the tracker card key is shown')
  assert.ok(expandedText.includes('Progress file'), 'the progress file is a collapsed row')
  assert.equal(expandedText.includes('Step 1 done.'), false, 'the progress text starts collapsed')
  toggleButton(tree, 'Progress file').props.onClick()
  tree = renderBody(renderer, registration, { sessionId: 's 1', pressure })
  assert.ok(textOf(tree).includes('Step 1 done.'), 'the progress text appears after a click')
  assert.ok(textOf(tree).includes(FULL_ANSWER.task.progress.path), 'the progress row shows its path when open')

  const anchors = collect(tree, node => node.type === 'a')
  const pull12 = anchors.find(node => textOf(node).trim() === 'Add login')
  assert.ok(pull12, 'the first pull request title is its link')
  assert.equal(pull12.props.href, FULL_ANSWER.pullRequests[0].url)
  assert.equal(pull12.props.target, '_blank')
  assert.equal(pull12.props.rel, 'noreferrer', 'an external link never leaks the opener')
  assert.equal(pull12.props['aria-label'], 'Pull request #12: Add login')
  const pull13 = anchors.find(node => textOf(node).trim() === 'Pull request #13')
  assert.ok(pull13, 'a titleless pull request links its generated title')
  assert.equal(pull13.props['aria-label'], 'Pull request #13', 'a titleless pull request still names its number')
  const card = anchors.find(node => textOf(node).trim() === 'ACL-12')
  assert.ok(card, 'the tracker card is a link')
  assert.equal(card.props.href, FULL_ANSWER.task.card.url)
  assert.equal(card.props.target, '_blank')
  assert.equal(card.props.rel, 'noreferrer')

  const pre = collect(tree, node => node.type === 'pre')
  assert.equal(pre.length, 1, 'the progress text is one pre element')
  assert.equal(pre[0].props.tabIndex, 0, 'the scrollable pre is reachable by keyboard')

  const noPressure = textOf(renderBody(renderer, registration, { sessionId: 's 1' }))
  assert.ok(noPressure.includes('Shown after the first model request'))
  assert.equal(noPressure.includes('%'), false, 'the Context section never shows 0% before the first request')
  assert.equal(network.calls.length, 1, 'a projection change does not refetch')
})

test('the first fetch waits for a visible document', async () => {
  const { renderer, ctx, document, network } = mountBundle({ answer: () => reply(PLAIN_ANSWER) })
  const registration = environmentRegistration(ctx)

  document.visibilityState = 'hidden'
  let tree = renderBody(renderer, registration, { pressure: { projectedTokens: 50, contextWindow: 100 } })
  await settle()
  assert.equal(network.calls.length, 0, 'the first fetch waits for a visible document')
  assert.equal(panelBusy(tree), 'true', 'the panel is busy until the first answer')

  document.visibilityState = 'visible'
  document.dispatch('visibilitychange')
  await settle()
  tree = renderBody(renderer, registration, { pressure: { projectedTokens: 50, contextWindow: 100 } })
  assert.equal(network.calls.length, 1, 'the document becoming visible starts the first fetch')
  assert.equal(panelBusy(tree), undefined, 'the first answer ends the busy state')
})

test('a failing section shows its own message and the rest still renders', async () => {
  const { renderer, ctx, network } = mountBundle({ answer: () => reply(SECTION_ERRORS_ANSWER) })
  const registration = environmentRegistration(ctx)
  const pressure = { projectedTokens: 84_100, contextWindow: 200_000 }

  let tree = renderBody(renderer, registration, { pressure })
  await settle()
  tree = renderBody(renderer, registration, { pressure })
  const text = textOf(tree)

  assert.ok(text.includes('git status did not answer'), 'the failed changes section shows its own message')
  assert.ok(text.includes('the MCP manager did not answer'), 'the failed connectors section shows its own message')
  assert.ok(text.includes('example-app · /home/dev'), 'the Environment section still renders')
  assert.equal(text.includes('Not linked'), false, 'the old tracker-link row is gone')
  assert.equal(collect(tree, node => node.type === 'a').length, 0, 'an empty pull-request list renders no links')
  assert.equal(text.includes('No changes'), false, 'a failed changes section is not a clean tree')
  assert.ok(
    textOf(sectionBody(tree, 'changes')).includes('git status did not answer'),
    'the Changes section carries its own error message',
  )

  const boom = mountBundle({ answer: () => reply({ error: 'boom' }, 500) })
  const boomRegistration = environmentRegistration(boom.ctx)
  let boomTree = renderBody(boom.renderer, boomRegistration, { pressure })
  await settle()
  boomTree = renderBody(boom.renderer, boomRegistration, { pressure })
  const boomText = textOf(boomTree)
  assert.ok(boomText.includes('boom'), 'a 500 answer shows the route error text')
  assert.ok(boomText.includes('42% used'), 'the Context section still renders')
  assert.equal(boom.network.calls.length, 1)
  assert.equal(panelBusy(boomTree), undefined, 'a failed answer is still an answer')

  boom.network.setAnswer(() => reply(PLAIN_ANSWER))
  refreshButton(boomTree).props.onClick()
  boomTree = renderBody(boom.renderer, boomRegistration, { pressure })
  await settle()
  boomTree = renderBody(boom.renderer, boomRegistration, { pressure })
  assert.equal(textOf(boomTree).includes('boom'), false, 'a successful refresh clears the error line')
  assert.ok(hasTitle(boomTree, 'plain-machine · Linux'), 'a successful refresh shows the new machine')

  boom.network.setAnswer(() => reply({ error: 'boom' }, 500))
  refreshButton(boomTree).props.onClick()
  boomTree = renderBody(boom.renderer, boomRegistration, { pressure })
  await settle()
  boomTree = renderBody(boom.renderer, boomRegistration, { pressure })
  const keptText = textOf(boomTree)
  assert.ok(keptText.includes('boom'), 'a failed refresh shows its message')
  assert.ok(
    hasTitle(boomTree, 'plain-machine · Linux'),
    'a failed refresh keeps the last good answer below the message',
  )
  assert.equal(boom.network.calls.length, 3)
})

test('a 200 answer that is not a JSON object keeps the last good answer', async () => {
  let calls = 0
  const { renderer, ctx, network } = mountBundle({
    answer: () => {
      calls += 1
      if (calls === 1) return reply(PLAIN_ANSWER)
      if (calls === 2) return reply('not an object')
      return reply([])
    },
  })
  const registration = environmentRegistration(ctx)
  let tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  assert.ok(hasTitle(tree, 'plain-machine · Linux'))

  refreshButton(tree).props.onClick()
  tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  let text = textOf(tree)
  assert.ok(text.includes('unexpected answer from the Environment route'), 'a 200 string answer is an error')
  assert.ok(hasTitle(tree, 'plain-machine · Linux'), 'the last good answer stays below the error')

  refreshButton(tree).props.onClick()
  tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  text = textOf(tree)
  assert.ok(text.includes('unexpected answer from the Environment route'), 'a 200 array answer is an error')
  assert.ok(hasTitle(tree, 'plain-machine · Linux'), 'the last good answer still stays below the error')
  assert.equal(network.calls.length, 3)
})

test('the Environment and Changes rows handle their edge states', async () => {
  const edge = mountBundle({ answer: () => reply(TASK_EDGE_ANSWER) })
  let tree = renderBody(edge.renderer, environmentRegistration(edge.ctx))
  await settle()
  tree = renderBody(edge.renderer, environmentRegistration(edge.ctx))
  let text = textOf(tree)
  assert.ok(hasTitle(tree, 'edge-machine · macOS'), 'the machine row names macOS in its title')
  assert.equal(text.includes('No GitHub origin'), false, 'a work tree without a GitHub origin omits the repository row')
  assert.equal(text.includes('name off-pattern'), false, 'no card means no branch-name warning')
  assert.ok(text.includes('up to date'), 'zero ahead and behind is up to date')
  assert.equal(text.includes('↑'), false, 'an up-to-date upstream shows no arrow')
  assert.ok(text.includes('No changes'), 'a clean tree with no pull requests says so')
  assert.ok(text.includes('No connectors'), 'an empty connector fleet says so')
  assert.equal(text.includes('Progress file'), false, 'a missing progress file omits its row')
  assert.equal(collect(tree, node => node.type === 'a').length, 0, 'an empty pull-request list renders no links')

  const gone = mountBundle({ answer: () => reply(GONE_ANSWER) })
  tree = renderBody(gone.renderer, environmentRegistration(gone.ctx))
  await settle()
  tree = renderBody(gone.renderer, environmentRegistration(gone.ctx))
  text = textOf(tree)
  assert.ok(text.includes('gone'), 'a null ahead and behind is a gone upstream')
  assert.equal(text.includes('up to date'), false, 'a gone upstream is never up to date')
  assert.equal(textOf(sectionBody(tree, 'connectors')), '', 'a null connector fleet without an error leaves the body empty')

  const partial = mountBundle({ answer: () => reply(PARTIAL_UPSTREAM_ANSWER) })
  tree = renderBody(partial.renderer, environmentRegistration(partial.ctx))
  await settle()
  tree = renderBody(partial.renderer, environmentRegistration(partial.ctx))
  text = textOf(tree)
  assert.ok(text.includes('↓2'), 'only the known upstream count is shown')
  assert.equal(text.includes('↑'), false, 'a null ahead count is not treated as zero')

  const many = mountBundle({ answer: () => reply(MANY_FILES_ANSWER) })
  tree = renderBody(many.renderer, environmentRegistration(many.ctx))
  await settle()
  tree = renderBody(many.renderer, environmentRegistration(many.ctx))
  toggleButton(tree, 'uncommitted').props.onClick()
  tree = renderBody(many.renderer, environmentRegistration(many.ctx))
  text = textOf(tree)
  assert.equal(fileRows(tree).length, 50, 'the tab lists at most 50 change rows')
  assert.ok(text.includes('and 10 more'), 'the rows past the cap are counted')
  assert.equal(text.includes('src/many-0.js'), true)

  const connector = mountBundle({ answer: () => reply(CONNECTOR_ANSWER) })
  tree = renderBody(connector.renderer, environmentRegistration(connector.ctx))
  await settle()
  tree = renderBody(connector.renderer, environmentRegistration(connector.ctx))
  const connectedConnector = connectorParts(connectorRowNamed(tree, 'github'))
  assert.equal(connectedConnector.right, null, 'a connected connector writes nothing at the right')
  const closedConnector = connectorParts(connectorRowNamed(tree, 'legacy'))
  assert.equal(closedConnector.right, 'Off', 'a closed connector says Off')
  assert.equal(closedConnector.rightStyle.color, SECONDARY, 'Off stays secondary')
})

test('the Repository row appears only when the origin names a repository', async () => {
  const outside = mountBundle({ answer: () => reply(PLAIN_ANSWER) })
  let tree = renderBody(outside.renderer, environmentRegistration(outside.ctx))
  await settle()
  tree = renderBody(outside.renderer, environmentRegistration(outside.ctx))
  let text = textOf(sectionBody(tree, 'environment'))
  assert.equal(text.includes('No GitHub origin'), false, 'no fallback repository value outside a git work tree')
  assert.ok(text.includes('Not a git folder'), 'outside a git work tree the branch row says so')
  assert.ok(text.includes('plain · /work'), 'the folder still renders')

  const inside = mountBundle({ answer: () => reply(TASK_EDGE_ANSWER) })
  tree = renderBody(inside.renderer, environmentRegistration(inside.ctx))
  await settle()
  tree = renderBody(inside.renderer, environmentRegistration(inside.ctx))
  assert.equal(
    textOf(sectionBody(tree, 'environment')).includes('No GitHub origin'),
    false,
    'a work tree without a GitHub origin omits the repository row',
  )
  assert.equal(hasTitle(tree, 'No GitHub origin'), false)

  const linked = mountBundle({ answer: () => reply(FULL_ANSWER) })
  tree = renderBody(linked.renderer, environmentRegistration(linked.ctx))
  await settle()
  tree = renderBody(linked.renderer, environmentRegistration(linked.ctx))
  assert.ok(
    textOf(sectionBody(tree, 'environment')).includes('example-org/example-app'),
    'a GitHub origin shows its owner/repo slug',
  )
  assert.ok(hasTitle(tree, 'example-org/example-app'), 'the repository row carries its slug as the title')
})

test('the Context header shows the percent and a pill bar in both states', async () => {
  const { renderer, ctx } = mountBundle({ answer: () => reply(PLAIN_ANSWER) })
  const registration = environmentRegistration(ctx)
  const pressure = { projectedTokens: 84_100, contextWindow: 200_000 }
  let tree = await loadedBody(renderer, registration, { pressure })

  let header = sectionHeader(tree, 'context')
  assert.equal(header.props['aria-label'], 'Context, 42% used', 'the header accessible name carries the percent')
  let summary = contextHeaderSummary(tree)
  assert.equal(summary.props['aria-hidden'], 'true', 'the summary is hidden from the accessible name')
  assert.equal(textOf(summary), '42%', 'the header shows the percent text')
  assert.equal(header.children.length, 3, 'the header holds the name, the chevron and the summary')
  assert.equal(textOf(header.children[0]), 'Context', 'the name comes first')
  assert.equal(textOf(header.children[1]), '›', 'the chevron follows the name')
  assert.equal(header.children[2], summary, 'the summary comes after the chevron')
  assert.equal(summary.props.style.marginLeft, 'auto', 'the summary is pushed to the right')
  const percents = collect(summary, node => node.type === 'span' && node !== summary && textOf(node) === '42%')
  assert.equal(percents.length, 1, 'the percent is one text span')
  assert.equal(percents[0].props.style.fontSize, 12, 'the percent is 12 px')
  assert.equal(percents[0].props.style.color, SECONDARY, 'the percent is secondary text')

  let pill = contextPill(tree)
  assert.equal(pill.props.style.width, 24, 'the pill is 24 px wide')
  assert.equal(pill.props.style.height, 6, 'the pill is 6 px tall')
  assert.equal(pill.props.style.borderRadius, 3, 'the pill has a 3 px radius')
  assert.equal(pill.props.style.background, TRACK, 'the pill track uses the layer-2 token')
  assert.equal(pill.children.length, 1)
  assert.equal(pill.children[0].props.style.width, '42%', 'the fill reaches the percent')
  assert.equal(pill.children[0].props.style.background, BRAND, 'below 80% the fill is brand')

  const at = tokens => renderBody(renderer, registration, { pressure: { projectedTokens: tokens, contextWindow: 100 } })
  assert.equal(contextPill(at(79)).children[0].props.style.background, BRAND, '79% stays brand')
  assert.equal(contextPill(at(80)).children[0].props.style.background, WARN, '80% warns')
  assert.equal(contextPill(at(95)).children[0].props.style.background, ERROR, '95% errors')

  tree = at(80)
  sectionHeader(tree, 'context').props.onClick()
  tree = renderBody(renderer, registration, { pressure })
  assert.equal(sectionHeader(tree, 'context').props['aria-expanded'], 'false', 'a click still collapses the section')
  assert.equal(textOf(contextHeaderSummary(tree)), '42%', 'the collapsed header keeps its summary')
  assert.equal(contextPill(tree).children[0].props.style.width, '42%', 'the collapsed header keeps the pill')
  sectionHeader(tree, 'context').props.onClick()
  tree = renderBody(renderer, registration, { pressure })
  assert.equal(sectionHeader(tree, 'context').props['aria-expanded'], 'true', 'a second click expands it again')
  assert.equal(contextPill(tree).children[0].props.style.width, '42%', 'the expanded header shows the pill')

  header = sectionHeader(tree, 'context')
  assert.equal(header.props.draggable, true, 'the header is still a drag handle')
  for (const name of ['onClick', 'onKeyDown', 'onDragStart', 'onDragOver', 'onDragLeave', 'onDrop', 'onDragEnd']) {
    assert.equal(typeof header.props[name], 'function', 'the header keeps its ' + name + ' handler')
  }
  header.props.onKeyDown({ altKey: true, key: 'ArrowUp', preventDefault() {} })
  tree = renderBody(renderer, registration, { pressure })
  assert.equal(headerIds(tree)[0], 'context', 'Alt+ArrowUp still moves the section')

  tree = renderBody(renderer, registration)
  header = sectionHeader(tree, 'context')
  assert.equal(header.props['aria-label'], 'Context', 'without pressure the header names the section alone')
  assert.equal(textOf(header).includes('%'), false, 'no percent before the first model request')
  const summaries = collect(
    header,
    node => node.props !== undefined && node.props['aria-hidden'] === 'true' && node.props.style?.display === 'inline-flex',
  )
  assert.equal(summaries.length, 0, 'no summary before the first model request')
  assert.equal(collect(header, node => node.props.style?.width === 24).length, 0, 'no pill before the first request')
})

test('connector rows show an avatar, the name and the state text the spec gives', async () => {
  const { renderer, ctx } = mountBundle({ answer: () => reply(CONNECTOR_STATES_ANSWER) })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  assert.equal(connectorRows(tree).length, 3, 'only the first three rows show at first')
  toggleButton(tree, 'Show more').props.onClick()
  tree = renderBody(renderer, registration)
  assert.equal(connectorRows(tree).length, CONNECTOR_STATES_ANSWER.connectors.length, 'Show more reveals every row')
  assert.equal(visibleTextOf(tree).includes(PINNED_NOTE), false, 'the pinned note is never visible text')

  const cases = [
    { name: 'github', avatar: 'G', details: 'connected · 7 tools', right: null, color: null },
    { name: 'firecrawl', avatar: 'F', details: 'pinned · 2 tools. ' + PINNED_NOTE, right: null, color: null },
    { name: 'solo', avatar: 'S', details: 'pinned · 1 tool. ' + PINNED_NOTE, right: null, color: null },
    { name: 'connecting', avatar: 'C', details: 'connecting · attempt 2', right: 'Connecting…', color: SECONDARY },
    { name: 'reconnecting', avatar: 'R', details: 'reconnecting · attempt 1', right: 'Connecting…', color: SECONDARY },
    {
      name: 'reconnecting-error',
      avatar: 'R',
      details: 'reconnecting · attempt 3 · socket closed',
      right: 'Connecting…',
      color: SECONDARY,
    },
    {
      name: 'credentials',
      avatar: 'C',
      details: 'waiting for credentials · token expired',
      right: 'Sign in',
      color: WARN,
    },
    { name: 'failed-error', avatar: 'F', details: 'failed · sse handshake failed', right: 'Failed', color: WARN },
    { name: 'failed-reason', avatar: 'F', details: 'failed · gave up reconnecting', right: 'Failed', color: WARN },
    { name: 'reconnect-disabled', avatar: 'R', details: 'failed · reconnect disabled', right: 'Failed', color: WARN },
    {
      name: 'unclosed-generation',
      avatar: 'U',
      details: 'failed · previous connection did not close',
      right: 'Failed',
      color: WARN,
    },
    { name: 'unknown-reason', avatar: 'U', details: 'failed · handshake timed out', right: 'Failed', color: WARN },
    { name: 'plain-failed', avatar: 'P', details: 'failed', right: 'Failed', color: WARN },
    { name: 'has-error', avatar: 'H', details: 'failed · sse handshake failed', right: 'Failed', color: WARN },
    { name: 'disabled', avatar: 'D', details: 'off', right: 'Off', color: SECONDARY },
    { name: 'closed', avatar: 'C', details: 'off', right: 'Off', color: SECONDARY },
    { name: '_x1', avatar: 'X', details: 'off', right: 'Off', color: SECONDARY },
    { name: '--', avatar: '?', details: 'off', right: 'Off', color: SECONDARY },
    { name: 'ßeta', avatar: 'S', details: 'off', right: 'Off', color: SECONDARY },
  ]
  assert.equal(cases.length, CONNECTOR_STATES_ANSWER.connectors.length, 'every fixture row is checked')
  for (const item of cases) {
    const row = connectorRowNamed(tree, item.name)
    const parts = connectorParts(row)
    assert.equal(parts.avatar, item.avatar, item.name + ' avatar letter')
    assert.equal(parts.avatarHidden, 'true', item.name + ' avatar is decorative')
    assert.equal(parts.avatarStyle.width, 18, item.name + ' avatar width')
    assert.equal(parts.avatarStyle.height, 18, item.name + ' avatar height')
    assert.equal(parts.avatarStyle.borderRadius, 4, item.name + ' avatar radius')
    assert.equal(parts.avatarStyle.fontSize, 11, item.name + ' avatar font size')
    assert.equal(parts.avatarStyle.color, SECONDARY, item.name + ' avatar color')
    assert.equal(parts.avatarStyle.background, TRACK, item.name + ' avatar background')
    assert.equal(parts.name, item.name, item.name + ' name')
    assert.equal(parts.hidden, item.details, item.name + ' accessible details')
    assert.equal(parts.hiddenAriaHidden, undefined, item.name + ' details are available to screen readers')
    assert.equal(parts.hiddenStyle.position, 'absolute', item.name + ' details are visually hidden')
    assert.equal(parts.hiddenStyle.width, 1)
    assert.equal(parts.hiddenStyle.height, 1)
    assert.equal(parts.hiddenStyle.overflow, 'hidden')
    assert.equal(parts.hiddenStyle.clip, 'rect(0 0 0 0)')
    assert.equal(parts.hiddenStyle.whiteSpace, 'nowrap')
    assert.equal(parts.right, item.right, item.name + ' right-side text')
    if (item.right === null) {
      assert.equal(parts.rightStyle, null, item.name + ' has no right-side element')
    } else {
      assert.equal(parts.rightStyle.color, item.color, item.name + ' right-side color')
      assert.equal(parts.rightStyle.fontSize, 12, item.name + ' right-side font size')
    }
    assert.equal(row.props.title, item.name + ' · ' + item.details, item.name + ' title')
  }
})

test('only three connectors show until Show more', async () => {
  const { renderer, ctx, storage } = mountBundle({ answer: () => reply(MANY_CONNECTORS_ANSWER) })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  assert.equal(connectorRows(tree).length, 3, 'three rows show first')
  assert.equal(
    connectorRows(tree).some(row => textOf(row).includes('server-3')),
    false,
    'the fourth row is hidden until Show more',
  )
  let button = toggleButton(tree, 'Show more')
  assert.equal(button.props.type, 'button', 'Show more is a real button')
  assert.equal(button.props.style.color, SECONDARY, 'Show more is secondary text')
  assert.equal(button.props.style.fontSize, 12, 'Show more is 12 px')
  assert.equal(button.props['aria-expanded'], 'false', 'Show more starts collapsed')
  const bodyId = button.props['aria-controls']
  assert.equal(typeof bodyId, 'string', 'Show more controls the extra rows')
  const controlled = collect(tree, node => node.props !== undefined && node.props.id === bodyId)
  assert.equal(controlled.length, 1, 'the controlled extra-row body exists')
  assert.equal(controlled[0].props.hidden, true, 'the extra-row body starts hidden')

  button.props.onClick()
  tree = renderBody(renderer, registration)
  assert.equal(connectorRows(tree).length, 5, 'a click shows the other rows')
  button = toggleButton(tree, 'Show less')
  assert.equal(button.props['aria-expanded'], 'true', 'Show less says the list is open')
  assert.equal(storage.getItem(COLUMN_KEY), null, 'showing more is not saved')
  button.props.onClick()
  tree = renderBody(renderer, registration)
  assert.equal(connectorRows(tree).length, 3, 'a second click hides the extra rows')
  assert.equal(toggleButton(tree, 'Show more').props['aria-expanded'], 'false', 'Show more starts collapsed again')

  const two = mountBundle({ answer: () => reply(CONNECTOR_ANSWER) })
  tree = await loadedBody(two.renderer, environmentRegistration(two.ctx))
  assert.equal(connectorRows(tree).length, 2, 'two connectors render two rows')
  assert.equal(
    collect(sectionBody(tree, 'connectors'), node => node.type === 'button').length,
    0,
    'two connectors need no Show more button',
  )
})

test('two mounted Connectors sections own different Show more ids', async () => {
  const { renderer, ctx } = mountBundle({ answer: () => reply(MANY_CONNECTORS_ANSWER) })
  const registration = environmentRegistration(ctx)
  const h = renderer.React.createElement
  function TwoBodies() {
    return h(
      'div',
      null,
      h(registration.component, { ...makeBodyProps(), key: 'left' }),
      h(registration.component, { ...makeBodyProps(), key: 'right' }),
    )
  }
  renderer.render(TwoBodies, {})
  await settle()
  const tree = renderer.render(TwoBodies, {})
  assert.deepEqual(renderer.errors(), [], 'two Connectors sections render together')
  const buttons = collect(tree, node => node.type === 'button' && textOf(node) === 'Show more')
  assert.equal(buttons.length, 2, 'each mounted body renders its own Show more')
  const ids = buttons.map(button => button.props['aria-controls'])
  assert.equal(typeof ids[0], 'string', 'the left Show more controls a body')
  assert.equal(typeof ids[1], 'string', 'the right Show more controls a body')
  assert.notEqual(ids[0], ids[1], 'the two Show more buttons control different bodies')
  tree.children.forEach((panel, index) => {
    const idsInPanel = new Set(
      collect(panel, node => node.props !== undefined && typeof node.props.id === 'string').map(node => node.props.id),
    )
    assert.ok(idsInPanel.has(ids[index]), 'each Show more controls a body inside its own tab')
  })
})

test('the Connectors section keeps its empty and error states', async () => {
  const empty = mountBundle({ answer: () => reply(TASK_EDGE_ANSWER) })
  let tree = await loadedBody(empty.renderer, environmentRegistration(empty.ctx))
  const emptyNote = collect(
    sectionBody(tree, 'connectors'),
    node => node.type === 'span' && textOf(node) === 'No connectors',
  )
  assert.equal(emptyNote.length, 1, 'an empty fleet says No connectors')
  assert.equal(emptyNote[0].props.style.color, SECONDARY, 'the empty note is secondary text')
  assert.equal(sectionHeaderName(sectionHeader(tree, 'connectors')), 'Connectors', 'the header names the section')

  const missing = mountBundle({ answer: () => reply(GONE_ANSWER) })
  tree = await loadedBody(missing.renderer, environmentRegistration(missing.ctx))
  assert.equal(
    textOf(sectionBody(tree, 'connectors')),
    '',
    'a null fleet without an error leaves the body empty',
  )
  assert.equal(sectionHeaderName(sectionHeader(tree, 'connectors')), 'Connectors', 'the header stays')
  assert.deepEqual(missing.renderer.errors(), [], 'a null fleet does not crash')

  const failed = mountBundle({ answer: () => reply(SECTION_ERRORS_ANSWER) })
  tree = await loadedBody(failed.renderer, environmentRegistration(failed.ctx))
  const messages = collect(
    sectionBody(tree, 'connectors'),
    node => node.type === 'p' && textOf(node) === 'the MCP manager did not answer',
  )
  assert.equal(messages.length, 1, 'a failed read shows its message')
  assert.equal(messages[0].props.style.color, ERROR, 'a failed read uses the error token')
  assert.equal(messages[0].props.role, 'status', 'a failed read is announced as a status')
  assert.equal(textOf(tree).includes('(app-wide)'), false, 'the app-wide suffix is gone')
  assert.equal(visibleTextOf(tree).includes(PINNED_NOTE), false, 'no visible pinned note')

  const pinned = mountBundle({ answer: () => reply(PINNED_CONNECTORS_ANSWER) })
  tree = await loadedBody(pinned.renderer, environmentRegistration(pinned.ctx))
  const text = textOf(tree)
  assert.equal(text.includes('(app-wide)'), false, 'the app-wide suffix is gone from a pinned fleet')
  assert.equal(visibleTextOf(tree).includes(PINNED_NOTE), false, 'the pinned note is not visible text')
  assert.ok(
    hasTitle(tree, 'firecrawl · pinned · 2 tools. ' + PINNED_NOTE),
    'the pinned note lives in the row title',
  )
  assert.ok(text.includes('firecrawl'), 'the pinned row still names its connector')
})

test('a malformed list entry is skipped instead of crashing the panel', async () => {
  const { renderer, ctx } = mountBundle({ answer: () => reply(HOSTILE_ANSWER) })
  const registration = environmentRegistration(ctx)
  let tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  toggleButton(tree, 'uncommitted').props.onClick()
  tree = renderBody(renderer, registration)
  const text = textOf(tree)
  assert.deepEqual(renderer.errors(), [], 'no list entry crashes the render')
  assert.ok(text.includes('src/ok.js'), 'the valid change row still renders')
  assert.ok(text.includes('github'), 'the valid connector still renders')
  assert.ok(hasTitle(tree, 'github · connected · 2 tools'), 'the valid connector keeps its detail in the title')
  assert.ok(text.includes('#9'), 'the valid pull request still renders')
  assert.equal(text.includes('#undefined'), false, 'a pull request without a number is skipped')
})

test('a session switch never shows the previous session\'s answer', async () => {
  const second = deferred()
  let calls = 0
  const { renderer, ctx, network } = mountBundle({
    answer: () => {
      calls += 1
      if (calls === 1) return reply(FULL_ANSWER)
      if (calls === 2) return second.promise
      return reply({ error: 'no session with a working directory: s2' }, 404)
    },
  })
  const registration = environmentRegistration(ctx)

  let tree = renderBody(renderer, registration, { sessionId: 's1' })
  await settle()
  tree = renderBody(renderer, registration, { sessionId: 's1' })
  assert.ok(textOf(sectionBody(tree, 'environment')).includes('feat-login'), 's1 answers first')

  tree = renderBody(renderer, registration, { sessionId: 's2' })
  let text = textOf(tree)
  assert.equal(text.includes('feat-login'), false, 's1 folder is gone while s2 loads')
  assert.equal(textOf(sectionBody(tree, 'connectors')), '', 's1 connectors are gone while s2 loads')
  assert.equal(panelBusy(tree), 'true', 'the panel is busy until s2 answers')

  second.resolve(reply({ error: 'no session with a working directory: s2' }, 404))
  await settle()
  tree = renderBody(renderer, registration, { sessionId: 's2' })
  text = textOf(tree)
  assert.ok(text.includes('no session with a working directory: s2'), 'the s2 error is shown')
  assert.equal(text.includes('feat-login'), false, 's1 folder never appears under the s2 error')
  assert.equal(panelBusy(tree), undefined)

  tree = renderBody(renderer, registration, { sessionId: '' })
  text = textOf(tree)
  assert.ok(text.includes('No session'))
  assert.equal(text.includes('feat-login'), false, 'no previous answer appears without a session')
  assert.equal(text.includes('no session with a working directory: s2'), false, 'no previous error either')
  assert.equal(network.calls.length, 2, 'an empty session fetches nothing')
})

test('the tab polls only while it is visible and Refresh asks again', async () => {
  const { renderer, ctx, timers, document, network } = mountBundle({ answer: () => reply(PLAIN_ANSWER) })
  const registration = environmentRegistration(ctx)
  const props = visible => ({ visible })

  let tree = renderBody(renderer, registration, props(false))
  await settle()
  assert.equal(network.calls.length, 0, 'a hidden tab does not fetch at mount')
  assert.equal(timers.pending('interval').length, 0, 'a hidden tab schedules no poll')
  assert.equal(document.listenerCount('visibilitychange'), 0, 'a hidden tab listens to nothing')

  tree = renderBody(renderer, registration, props(true))
  await settle()
  tree = renderBody(renderer, registration, props(true))
  assert.equal(network.calls.length, 1, 'becoming visible fetches once')
  const polls = timers.pending('interval')
  assert.equal(polls.length, 1, 'a visible tab schedules one poll')
  assert.equal(polls[0].delay, REFRESH_MS)
  assert.equal(document.listenerCount('visibilitychange'), 1, 'a visible tab watches document visibility')

  timers.fire(polls[0])
  await settle()
  tree = renderBody(renderer, registration, props(true))
  assert.equal(network.calls.length, 2, 'a tick while the tab and the document are visible fetches')

  document.visibilityState = 'hidden'
  timers.fire(timers.pending('interval')[0])
  await settle()
  assert.equal(network.calls.length, 2, 'a tick while the document is hidden fetches nothing')
  document.dispatch('visibilitychange')
  await settle()
  assert.equal(network.calls.length, 2, 'a hidden document does not fetch')
  document.visibilityState = 'visible'
  document.dispatch('visibilitychange')
  await settle()
  assert.equal(network.calls.length, 3, 'the document becoming visible again fetches')

  tree = renderBody(renderer, registration, props(true))
  refreshButton(tree).props.onClick()
  tree = renderBody(renderer, registration, props(true))
  await settle()
  tree = renderBody(renderer, registration, props(true))
  assert.equal(network.calls.length, 4, 'Refresh fetches at once')

  const clearedTick = timers.intervals[timers.intervals.length - 1]
  tree = renderBody(renderer, registration, props(false))
  assert.equal(timers.pending('interval').length, 0, 'hiding the tab clears the poll')
  assert.equal(document.listenerCount('visibilitychange'), 0, 'hiding the tab removes the listener')
  clearedTick.fn()
  await settle()
  assert.equal(network.calls.length, 4, 'a tick of the cleared interval fetches nothing')

  tree = renderBody(renderer, registration, props(true))
  await settle()
  tree = renderBody(renderer, registration, props(true))
  assert.equal(network.calls.length, 5, 'the tab becoming visible again fetches')
  assert.equal(timers.pending('interval').length, 1)
  assert.equal(document.listenerCount('visibilitychange'), 1)

  renderer.unmount()
  assert.equal(timers.pending('interval').length, 0, 'unmount clears the poll')
  assert.equal(document.listenerCount('visibilitychange'), 0, 'unmount removes the visibilitychange listener')
  assert.ok(timers.clearsFor('interval').length >= 1, 'the tab cleared its interval explicitly')
  assert.deepEqual(renderer.errors(), [], 'no state update lands after unmount')
})

test('a request in flight is never overlapped and unmount ignores its answer', async () => {
  const first = deferred()
  let calls = 0
  const guarded = mountBundle({
    answer: () => {
      calls += 1
      return calls === 1 ? first.promise : reply(PLAIN_ANSWER)
    },
  })
  const registration = environmentRegistration(guarded.ctx)
  let tree = renderBody(guarded.renderer, registration)
  await settle()
  assert.equal(guarded.network.calls.length, 1)

  guarded.timers.pending('interval')[0].fn()
  await settle()
  assert.equal(guarded.network.calls.length, 1, 'a tick during an in-flight request starts nothing')

  first.resolve(reply(PLAIN_ANSWER))
  await settle()
  tree = renderBody(guarded.renderer, registration)
  assert.ok(hasTitle(tree, 'plain-machine · Linux'))
  guarded.timers.pending('interval')[0].fn()
  await settle()
  assert.equal(guarded.network.calls.length, 2, 'a tick after the answer fetches again')

  const slow = deferred()
  const fast = deferred()
  let outCalls = 0
  const outOfOrder = mountBundle({
    answer: () => {
      outCalls += 1
      return outCalls === 1 ? slow.promise : fast.promise
    },
  })
  const outRegistration = environmentRegistration(outOfOrder.ctx)
  tree = renderBody(outOfOrder.renderer, outRegistration)
  await settle()
  refreshButton(tree).props.onClick()
  tree = renderBody(outOfOrder.renderer, outRegistration)
  assert.equal(outOfOrder.network.calls.length, 2, 'the refresh starts a second request')
  fast.resolve(reply(FAST_ANSWER))
  await settle()
  tree = renderBody(outOfOrder.renderer, outRegistration)
  assert.ok(hasTitle(tree, 'fast-machine · Linux'))
  slow.resolve(reply(SLOW_ANSWER))
  await settle()
  tree = renderBody(outOfOrder.renderer, outRegistration)
  const text = textOf(tree)
  assert.ok(hasTitle(tree, 'fast-machine · Linux'), 'the newer answer stays')
  assert.equal(hasTitle(tree, 'slow-machine · Linux'), false, 'the older answer is dropped')

  const pending = deferred()
  const gone = mountBundle({ answer: () => pending.promise })
  const goneRegistration = environmentRegistration(gone.ctx)
  renderBody(gone.renderer, goneRegistration)
  await settle()
  assert.equal(gone.network.calls.length, 1)
  gone.renderer.unmount()
  pending.resolve(reply(PLAIN_ANSWER))
  await settle()
  assert.deepEqual(gone.renderer.errors(), [], 'an answer after unmount does not set state')
})

test('a rejected fetch frees the in-flight guard so the next tick retries', async () => {
  let calls = 0
  const { renderer, ctx, timers, network } = mountBundle({
    answer: () => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('The operation was aborted'))
      return reply(PLAIN_ANSWER)
    },
  })
  const registration = environmentRegistration(ctx)
  let tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  assert.ok(textOf(tree).includes('The operation was aborted'), 'the aborted request shows its error')
  assert.equal(panelBusy(tree), undefined, 'an aborted request is still an answer')
  assert.equal(timers.pending('interval').length, 1)

  timers.pending('interval')[0].fn()
  await settle()
  tree = renderBody(renderer, registration)
  assert.equal(network.calls.length, 2, 'the next tick retries after the rejection')
  assert.ok(hasTitle(tree, 'plain-machine · Linux'))
  assert.equal(textOf(tree).includes('The operation was aborted'), false, 'a successful retry clears the error')
})

/* ------------------------------------------------------------------ */
/* The column: frame, order and state (task L.1)                       */
/* ------------------------------------------------------------------ */

test('the column shows four sections in the saved order and remembers what is collapsed', async () => {
  const first = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = environmentRegistration(first.ctx)
  let tree = await loadedBody(first.renderer, registration)
  assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'the default order is Environment, Context, Connectors, Changes')
  assert.deepEqual(
    sectionHeaders(tree).map(sectionHeaderName),
    ['Environment', 'Context', 'Connectors', 'Changes'],
    'the column names the four sections',
  )
  for (const id of DEFAULT_ORDER) {
    assert.equal(sectionHeader(tree, id).props['aria-expanded'], 'true', 'the ' + id + ' section starts expanded')
    assert.equal(sectionBody(tree, id).props.hidden, undefined, 'the ' + id + ' body starts visible')
  }
  assert.equal(first.storage.reads.length, 1, 'the column reads localStorage once per mount')
  const columns = collect(tree, node => node.type === 'div' && node.children.includes(sectionWrapper(tree, 'environment')))
  assert.equal(columns.length, 1, 'the sections sit in one column')
  assert.equal(columns[0].props.style.gap, 12, 'the sections sit 12 px apart')
  assert.equal(sectionHeader(tree, 'environment').props.style.height, 28, 'a section header is 28 px tall')
  tree = renderBody(first.renderer, registration)
  tree = renderBody(first.renderer, registration)
  assert.equal(first.storage.reads.length, 1, 'a rerender does not read localStorage again')
  assert.equal(first.storage.getItem(COLUMN_KEY), null, 'mounting writes no state')

  sectionHeader(tree, 'context').props.onClick()
  tree = renderBody(first.renderer, registration)
  assert.equal(sectionHeader(tree, 'context').props['aria-expanded'], 'false', 'a header click collapses its section')
  assert.equal(sectionBody(tree, 'context').props.hidden, true, 'the collapsed body is hidden')
  assert.equal(textOf(sectionBody(tree, 'context')), '', 'the collapsed body renders no content')
  assert.equal(sectionHeader(tree, 'environment').props['aria-expanded'], 'true', 'the other sections stay open')
  const saved = JSON.parse(first.storage.getItem(COLUMN_KEY))
  assert.deepEqual(saved.order, DEFAULT_ORDER, 'the order is saved')
  assert.equal(saved.collapsed.context, true, 'the collapsed section is saved')
  assert.equal(saved.collapsed.environment, false, 'an expanded section is saved as expanded')

  const readsBeforeRemount = first.storage.reads.length
  first.renderer.unmount()
  tree = renderBody(first.renderer, registration)
  assert.equal(
    first.storage.reads.length,
    readsBeforeRemount + 1,
    'a remount reads the saved state once',
  )
  tree = renderBody(first.renderer, registration)
  assert.equal(
    first.storage.reads.length,
    readsBeforeRemount + 1,
    'the remounted column keeps its one read',
  )
  assert.equal(sectionHeader(tree, 'context').props['aria-expanded'], 'false', 'a remount reads the collapsed state back')
  assert.equal(sectionBody(tree, 'context').props.hidden, true, 'the remounted body is hidden')
  assert.equal(sectionHeader(tree, 'environment').props['aria-expanded'], 'true', 'a remount keeps the rest expanded')

  const garbage = mountBundle({ storage: makeStorage({ data: { [COLUMN_KEY]: 'not json' } }) })
  tree = await loadedBody(garbage.renderer, environmentRegistration(garbage.ctx))
  assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'stored garbage falls back to the default order')
  for (const id of DEFAULT_ORDER) {
    assert.equal(sectionHeader(tree, id).props['aria-expanded'], 'true', 'stored garbage leaves ' + id + ' expanded')
  }

  const mixed = mountBundle({
    storage: makeStorage({
      data: {
        [COLUMN_KEY]: JSON.stringify({
          order: ['changes', 'unknown', 'environment'],
          collapsed: { connectors: true, unknown: true },
        }),
      },
    }),
  })
  tree = await loadedBody(mixed.renderer, environmentRegistration(mixed.ctx))
  assert.deepEqual(
    headerIds(tree),
    ['changes', 'environment', 'context', 'connectors'],
    'an unknown id is dropped and a missing id is appended in default order',
  )
  assert.equal(sectionHeader(tree, 'connectors').props['aria-expanded'], 'false', 'the stored collapsed state is read')
  assert.equal(sectionHeader(tree, 'context').props['aria-expanded'], 'true', 'a missing collapsed entry means expanded')

  const denied = mountBundle({ storage: makeStorage({ throwGet: true, throwSet: true }) })
  tree = await loadedBody(denied.renderer, environmentRegistration(denied.ctx))
  assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'an unavailable localStorage keeps the default order')
  sectionHeader(tree, 'changes').props.onClick()
  tree = renderBody(denied.renderer, environmentRegistration(denied.ctx))
  assert.equal(sectionHeader(tree, 'changes').props['aria-expanded'], 'false', 'the column still toggles without storage')
  assert.deepEqual(denied.renderer.errors(), [], 'storage failures never reach the renderer')
  assert.deepEqual(garbage.renderer.errors(), [], 'garbage storage never reaches the renderer')
})

test('two mounted Environment bodies own different ids and aria-controls', async () => {
  const { renderer, ctx } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = environmentRegistration(ctx)
  const h = renderer.React.createElement
  function TwoBodies() {
    return h(
      'div',
      null,
      h(registration.component, { ...makeBodyProps(), key: 'left' }),
      h(registration.component, { ...makeBodyProps(), key: 'right' }),
    )
  }
  renderer.render(TwoBodies, {})
  await settle()
  const tree = renderer.render(TwoBodies, {})
  assert.deepEqual(renderer.errors(), [], 'two Environment bodies render together')
  assert.equal(tree.children.length, 2, 'the two bodies render two panels')

  const idsOf = root =>
    collect(root, node => node.props !== undefined && typeof node.props.id === 'string').map(
      node => node.props.id,
    )
  const controlsOf = root =>
    collect(
      root,
      node => node.props !== undefined && typeof node.props['aria-controls'] === 'string',
    ).map(node => node.props['aria-controls'])
  const leftIds = idsOf(tree.children[0])
  const rightIds = idsOf(tree.children[1])
  assert.equal(leftIds.length, 6, 'a tab owns four section bodies plus the progress and changes bodies')
  assert.equal(rightIds.length, 6, 'the second tab owns the same six bodies')
  assert.equal(
    new Set([...leftIds, ...rightIds]).size,
    12,
    'every body id is unique across the two mounted tabs',
  )
  for (const panel of tree.children) {
    const ids = idsOf(panel)
    for (const control of controlsOf(panel)) {
      assert.ok(ids.includes(control), 'every aria-controls names a body inside its own tab')
    }
  }
})

test('sections move by keyboard and by drag and drop', async () => {
  const parts = loadEnvironmentParts()
  for (const name of ['normalizeOrder', 'moveSection', 'dropSection']) {
    assert.equal(typeof parts[name], 'function', 'features/environment/client/environment.js must define a pure ' + name + '()')
  }
  assert.deepEqual(parts.normalizeOrder(undefined, DEFAULT_ORDER), DEFAULT_ORDER, 'no stored order is the default')
  assert.deepEqual(parts.normalizeOrder('garbage', DEFAULT_ORDER), DEFAULT_ORDER, 'a non-list order is the default')
  assert.deepEqual(
    parts.normalizeOrder(['changes', 'unknown', 'environment'], DEFAULT_ORDER),
    ['changes', 'environment', 'context', 'connectors'],
    'unknown ids drop and missing ids append in default order',
  )
  assert.deepEqual(
    parts.normalizeOrder(['environment', 'environment', 'changes'], DEFAULT_ORDER),
    ['environment', 'changes', 'context', 'connectors'],
    'a repeated id appears once',
  )
  assert.deepEqual(
    parts.moveSection(DEFAULT_ORDER, 'context', -1),
    ['context', 'environment', 'connectors', 'changes'],
    'a section moves one place up',
  )
  assert.deepEqual(
    parts.moveSection(DEFAULT_ORDER, 'context', 1),
    ['environment', 'connectors', 'context', 'changes'],
    'a section moves one place down',
  )
  assert.deepEqual(parts.moveSection(DEFAULT_ORDER, 'environment', -1), DEFAULT_ORDER, 'the first section cannot move up')
  assert.deepEqual(parts.moveSection(DEFAULT_ORDER, 'changes', 1), DEFAULT_ORDER, 'the last section cannot move down')
  assert.deepEqual(parts.moveSection(DEFAULT_ORDER, 'unknown', 1), DEFAULT_ORDER, 'an unknown section does not move')
  assert.deepEqual(
    parts.dropSection(DEFAULT_ORDER, 'connectors', 'environment', 'before'),
    ['connectors', 'environment', 'context', 'changes'],
    'a section dropped above the first one goes first',
  )
  assert.deepEqual(
    parts.dropSection(DEFAULT_ORDER, 'environment', 'changes', 'before'),
    ['context', 'connectors', 'environment', 'changes'],
    'a section dropped above a later one goes immediately before it',
  )
  assert.deepEqual(
    parts.dropSection(DEFAULT_ORDER, 'environment', 'changes', 'after'),
    ['context', 'connectors', 'changes', 'environment'],
    'a section dropped below the last one goes last',
  )
  assert.deepEqual(
    parts.dropSection(DEFAULT_ORDER, 'environment', 'context', 'after'),
    ['context', 'environment', 'connectors', 'changes'],
    'dropping a section below the next one moves it after that section',
  )
  assert.deepEqual(
    parts.dropSection(DEFAULT_ORDER, 'environment', 'environment', 'after'),
    DEFAULT_ORDER,
    'dropping on itself changes nothing',
  )
  assert.deepEqual(
    parts.dropSection(DEFAULT_ORDER, 'unknown', 'environment', 'before'),
    DEFAULT_ORDER,
    'an unknown section does not move',
  )

  const keyboard = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = environmentRegistration(keyboard.ctx)
  let tree = await loadedBody(keyboard.renderer, registration)
  const keyEvent = {
    altKey: true,
    key: 'ArrowDown',
    prevented: 0,
    preventDefault() {
      this.prevented += 1
    },
  }
  /* Chromium drops focus from a node React moves with insertBefore, so the moved header
     must take it back after the reorder has committed. */
  const movedHeader = {
    focused: false,
    focus() {
      this.focused = true
    },
  }
  tree.__node.querySelector = selector =>
    selector === '[data-section="environment"]' ? movedHeader : null
  sectionHeader(tree, 'environment').props.onKeyDown(keyEvent)
  tree = renderBody(keyboard.renderer, registration)
  assert.deepEqual(
    headerIds(tree),
    ['context', 'environment', 'connectors', 'changes'],
    'Alt+ArrowDown on the Environment header puts it after Context',
  )
  assert.equal(movedHeader.focused, true, 'the moved header takes focus back after Alt+ArrowDown')
  assert.equal(keyEvent.prevented, 1, 'the header consumes the reorder key')
  assert.deepEqual(
    JSON.parse(keyboard.storage.getItem(COLUMN_KEY)).order,
    ['context', 'environment', 'connectors', 'changes'],
    'the keyboard order is saved',
  )

  const up = mountBundle({ answer: () => reply(FULL_ANSWER) })
  tree = await loadedBody(up.renderer, environmentRegistration(up.ctx))
  sectionHeader(tree, 'connectors').props.onKeyDown({ altKey: true, key: 'ArrowUp', preventDefault() {} })
  tree = renderBody(up.renderer, environmentRegistration(up.ctx))
  assert.deepEqual(
    headerIds(tree),
    ['environment', 'connectors', 'context', 'changes'],
    'Alt+ArrowUp moves a section one place up',
  )

  const guarded = mountBundle({ answer: () => reply(FULL_ANSWER) })
  tree = await loadedBody(guarded.renderer, environmentRegistration(guarded.ctx))
  const guardedKeys = [
    { key: 'ArrowDown' },
    { altKey: true, shiftKey: true, key: 'ArrowDown' },
    { altKey: true, ctrlKey: true, key: 'ArrowDown' },
    { altKey: true, metaKey: true, key: 'ArrowDown' },
  ]
  for (const guardedKey of guardedKeys) {
    let prevented = 0
    sectionHeader(tree, 'environment').props.onKeyDown({
      ...guardedKey,
      preventDefault() {
        prevented += 1
      },
    })
    tree = renderBody(guarded.renderer, environmentRegistration(guarded.ctx))
    assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'only Alt without Shift, Ctrl or Meta moves a section')
    assert.equal(prevented, 0, 'a key the column ignores is not consumed')
  }

  const overEvent = (clientY, inside = false) => ({
    clientY,
    currentTarget: {
      getBoundingClientRect: () => ({ top: 100, height: 28 }),
      contains: () => inside,
    },
    dataTransfer: { dropEffect: null },
    relatedTarget: inside ? { node: 'child' } : null,
    prevented: 0,
    preventDefault() {
      this.prevented += 1
    },
  })

  const drag = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const dragRegistration = environmentRegistration(drag.ctx)
  tree = await loadedBody(drag.renderer, dragRegistration)
  const transfers = []
  const startEvent = {
    dataTransfer: {
      effectAllowed: null,
      setData(type, value) {
        transfers.push([type, value])
      },
    },
  }
  sectionHeader(tree, 'connectors').props.onDragStart(startEvent)
  assert.deepEqual(
    transfers,
    [[DRAG_TYPE, 'connectors']],
    'a drag carries its section under the plugin own type, not text/plain',
  )
  assert.equal(startEvent.dataTransfer.effectAllowed, 'move', 'a dragged section is a move')
  const overBefore = overEvent(100)
  sectionHeader(tree, 'environment').props.onDragOver(overBefore)
  assert.equal(overBefore.dataTransfer.dropEffect, 'move', 'dragover asks for a move cursor')
  // Without preventDefault on dragover a browser never fires drop on the header.
  assert.equal(overBefore.prevented, 1, 'dragover over a section header accepts the drop')
  tree = renderBody(drag.renderer, dragRegistration)
  assert.equal(
    sectionWrapper(tree, 'environment').props.style.boxShadow,
    'inset 0 2px 0 ' + BRAND,
    'a drop above the midpoint marks the top edge',
  )
  assert.equal(
    sectionWrapper(tree, 'environment').props.style.borderTop,
    undefined,
    'the marker never shifts the layout',
  )

  sectionHeader(tree, 'environment').props.onDragLeave({
    currentTarget: { contains: () => false },
    relatedTarget: { node: 'outside' },
  })
  tree = renderBody(drag.renderer, dragRegistration)
  assert.equal(
    sectionWrapper(tree, 'environment').props.style.boxShadow,
    undefined,
    'dragging out of a header clears the marker',
  )

  sectionHeader(tree, 'environment').props.onDragOver(overEvent(100))
  tree = renderBody(drag.renderer, dragRegistration)
  sectionHeader(tree, 'environment').props.onDragLeave({
    currentTarget: { contains: () => true },
    relatedTarget: { node: 'child' },
  })
  tree = renderBody(drag.renderer, dragRegistration)
  assert.equal(
    sectionWrapper(tree, 'environment').props.style.boxShadow,
    'inset 0 2px 0 ' + BRAND,
    'moving onto a child of the header keeps the marker',
  )

  const dropEvent = overEvent(100)
  sectionHeader(tree, 'environment').props.onDrop(dropEvent)
  assert.equal(dropEvent.prevented, 1, 'the drop is handled by the column, not by the browser')
  tree = renderBody(drag.renderer, dragRegistration)
  assert.deepEqual(
    headerIds(tree),
    ['connectors', 'environment', 'context', 'changes'],
    'a drag of Connectors dropped above Environment puts Connectors first',
  )
  assert.deepEqual(
    JSON.parse(drag.storage.getItem(COLUMN_KEY)).order,
    ['connectors', 'environment', 'context', 'changes'],
    'the dropped order is saved',
  )
  assert.equal(
    sectionWrapper(tree, 'environment').props.style.boxShadow,
    undefined,
    'the marker clears after the drop',
  )

  const below = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const belowRegistration = environmentRegistration(below.ctx)
  tree = await loadedBody(below.renderer, belowRegistration)
  sectionHeader(tree, 'environment').props.onDragStart({
    dataTransfer: { effectAllowed: null, setData() {} },
  })
  sectionHeader(tree, 'changes').props.onDragOver(overEvent(130))
  tree = renderBody(below.renderer, belowRegistration)
  assert.equal(
    sectionWrapper(tree, 'changes').props.style.boxShadow,
    'inset 0 -2px 0 ' + BRAND,
    'a drop below the midpoint marks the bottom edge',
  )
  sectionHeader(tree, 'changes').props.onDrop(overEvent(130))
  tree = renderBody(below.renderer, belowRegistration)
  assert.deepEqual(
    headerIds(tree),
    ['context', 'connectors', 'changes', 'environment'],
    'dropping Environment below Changes puts it last',
  )
  assert.deepEqual(
    JSON.parse(below.storage.getItem(COLUMN_KEY)).order,
    ['context', 'connectors', 'changes', 'environment'],
    'the order dropped last is saved',
  )

  const self = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const selfRegistration = environmentRegistration(self.ctx)
  tree = await loadedBody(self.renderer, selfRegistration)
  sectionHeader(tree, 'environment').props.onDragStart({
    dataTransfer: { effectAllowed: null, setData() {} },
  })
  sectionHeader(tree, 'environment').props.onDragOver(overEvent(130))
  tree = renderBody(self.renderer, selfRegistration)
  assert.equal(
    sectionWrapper(tree, 'environment').props.style.boxShadow,
    undefined,
    'the dragged section itself never shows a drop marker',
  )

  const cancelled = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const cancelledRegistration = environmentRegistration(cancelled.ctx)
  tree = await loadedBody(cancelled.renderer, cancelledRegistration)
  sectionHeader(tree, 'environment').props.onDragStart({
    dataTransfer: { effectAllowed: null, setData() {} },
  })
  sectionHeader(tree, 'changes').props.onDragOver(overEvent(130))
  tree = renderBody(cancelled.renderer, cancelledRegistration)
  assert.equal(
    sectionWrapper(tree, 'changes').props.style.boxShadow,
    'inset 0 -2px 0 ' + BRAND,
    'the marker is up before a cancelled drag',
  )
  sectionHeader(tree, 'changes').props.onDragEnd()
  tree = renderBody(cancelled.renderer, cancelledRegistration)
  assert.equal(
    sectionWrapper(tree, 'changes').props.style.boxShadow,
    undefined,
    'dragend clears the marker',
  )
})


test('the Environment section lists the computer, folder, branch, repository, card and progress file', async () => {
  const { renderer, ctx } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = environmentRegistration(ctx)
  const pressure = { projectedTokens: 84_100, contextWindow: 200_000 }
  let tree = await loadedBody(renderer, registration, { pressure })
  const body = sectionBody(tree, 'environment')
  const text = textOf(body)
  assert.ok(text.includes('This computer'), 'the machine row reads This computer')
  assert.ok(hasTitle(tree, 'example-repo-machine · Windows'), 'the machine row keeps hostname · platform in its title')
  assert.ok(
    text.includes('feat-login · D:\\Repos\\Example-App-worktrees'),
    'the folder row shows the name and the parent',
  )
  assert.ok(hasTitle(tree, FULL_ANSWER.cwd), 'the folder row keeps the full path in its title')
  assert.ok(text.includes('feat/ACL-12-login'), 'the branch row shows the branch')
  assert.ok(
    hasTitle(tree, 'feat/ACL-12-login · worktree of D:\\Repos\\Example-App'),
    'a linked worktree adds the main root to the branch title',
  )
  assert.ok(text.includes('↑2'), 'the upstream state is the short ahead arrow')
  assert.equal(text.includes('↓'), false, 'a zero behind part is left out')
  assert.equal(text.includes('2 ahead'), false, 'the upstream state is not the long form')
  assert.ok(text.includes('example-org/example-app'), 'the repository slug is shown')
  assert.ok(text.includes('ACL-12'), 'the card key is shown')
  assert.ok(text.includes('Progress file'), 'the progress file row is shown')
  assert.equal(text.includes('name off-pattern'), false, 'a branch on the convention has no warning')

  const icons = collect(body, node => node.type === 'svg')
  assert.ok(icons.length >= 6, 'the Environment rows draw line icons')
  for (const icon of icons) {
    assert.equal(icon.props.viewBox, '0 0 16 16', 'every row icon is drawn on the 16 x 16 grid')
    assert.equal(icon.props.stroke, 'currentColor', 'every row icon takes the text color')
    assert.equal(icon.props['aria-hidden'], 'true', 'a row icon is decorative')
  }

  const anchors = collect(body, node => node.type === 'a')
  const card = anchors.find(node => textOf(node).trim() === 'ACL-12')
  assert.ok(card, 'the card key is a link')
  assert.equal(card.props.href, FULL_ANSWER.task.card.url)
  assert.equal(card.props.target, '_blank')
  assert.equal(card.props.rel, 'noreferrer')

  const progressButton = toggleButton(body, 'Progress file')
  assert.equal(progressButton.props['aria-expanded'], 'false', 'the progress row starts collapsed')
  assert.equal(collect(body, node => node.type === 'pre').length, 0, 'a collapsed progress row renders no pre')
  progressButton.props.onClick()
  tree = renderBody(renderer, registration, { pressure })
  const openBody = sectionBody(tree, 'environment')
  assert.equal(toggleButton(openBody, 'Progress file').props['aria-expanded'], 'true', 'a click expands the progress row')
  const pre = collect(openBody, node => node.type === 'pre')
  assert.equal(pre.length, 1, 'the expanded progress row shows one pre')
  assert.equal(pre[0].props.tabIndex, 0, 'the progress pre is focusable')
  assert.ok(textOf(openBody).includes('Step 1 done.'), 'the expanded progress row shows the text')
  assert.ok(textOf(openBody).includes(FULL_ANSWER.task.progress.path), 'the expanded progress row shows the path')
  const pathNode = collect(openBody, node => node.type === 'span' && textOf(node) === FULL_ANSWER.task.progress.path)
  assert.equal(pathNode.length, 1, 'the progress path is one span')
  assert.equal(pathNode[0].props.style.fontSize, 12, 'secondary path text is 12 px, not smaller')
  assert.equal(textOf(openBody).includes('Truncated to 6000 characters'), false, 'an uncut progress file has no note')

  const truncated = mountBundle({ answer: () => reply(TRUNCATED_PROGRESS_ANSWER) })
  tree = await loadedBody(truncated.renderer, environmentRegistration(truncated.ctx))
  toggleButton(tree, 'Progress file').props.onClick()
  tree = renderBody(truncated.renderer, environmentRegistration(truncated.ctx))
  assert.ok(textOf(tree).includes('Truncated to 6000 characters'), 'a cut progress file says it was truncated')

  const variants = [
    { answer: AHEAD_ANSWER, expected: '↑1', absent: ['↓', 'up to date', 'gone'] },
    { answer: AHEAD_BEHIND_ANSWER, expected: '↑2 ↓1', absent: ['up to date', 'gone'] },
    { answer: TASK_EDGE_ANSWER, expected: 'up to date', absent: ['↑', '↓', 'gone'] },
    { answer: GONE_ANSWER, expected: 'gone', absent: ['↑', '↓', 'up to date'] },
    { answer: NO_UPSTREAM_ANSWER, expected: null, absent: ['↑', '↓', 'up to date', 'gone'] },
  ]
  for (const variant of variants) {
    const mounted = mountBundle({ answer: () => reply(variant.answer) })
    const variantTree = await loadedBody(mounted.renderer, environmentRegistration(mounted.ctx))
    const variantText = textOf(sectionBody(variantTree, 'environment'))
    if (variant.expected !== null) {
      assert.ok(variantText.includes(variant.expected), 'the upstream state reads ' + variant.expected)
    }
    for (const absent of variant.absent) {
      assert.equal(variantText.includes(absent), false, 'the upstream state never reads ' + absent)
    }
  }

  const drive = mountBundle({ answer: () => reply(DRIVE_ROOT_ANSWER) })
  tree = await loadedBody(drive.renderer, environmentRegistration(drive.ctx))
  const driveBody = sectionBody(tree, 'environment')
  assert.ok(textOf(driveBody).includes('D:\\'), 'a drive root is its own folder name')
  assert.ok(hasTitle(tree, 'D:\\'), 'the drive root is its own full title')
  assert.equal(textOf(driveBody).includes(' \u00b7 '), false, 'a drive root has no parent part')

  const outside = mountBundle({ answer: () => reply(PLAIN_ANSWER) })
  tree = await loadedBody(outside.renderer, environmentRegistration(outside.ctx))
  const outsideBody = sectionBody(tree, 'environment')
  const outsideText = textOf(outsideBody)
  assert.ok(outsideText.includes('Not a git folder'), 'outside a git folder the branch row says so')
  assert.equal(outsideText.includes('example-org/example-app'), false, 'no repository row outside a git folder')
  assert.equal(outsideText.includes('ACL-12'), false, 'no card row outside a git folder')
  assert.equal(outsideText.includes('Progress file'), false, 'no progress row outside a git folder')
  assert.equal(collect(outsideBody, node => node.type === 'a').length, 0, 'no card link outside a git folder')

  const hidden = mountBundle({ answer: () => reply(HIDDEN_TASK_ANSWER) })
  tree = await loadedBody(hidden.renderer, environmentRegistration(hidden.ctx))
  const hiddenBody = sectionBody(tree, 'environment')
  const hiddenText = textOf(hiddenBody)
  assert.ok(hiddenText.includes('Not a git folder'), 'outside git the branch row says so even with task facts')
  assert.equal(
    hiddenText.includes('example-org/example-app'),
    false,
    'no repository row follows Not a git folder',
  )
  assert.equal(hiddenText.includes('ACL-12'), false, 'no card row follows Not a git folder')
  assert.equal(collect(hiddenBody, node => node.type === 'a').length, 0, 'no card link follows Not a git folder')

  const off = mountBundle({ answer: () => reply(OFF_PATTERN_ANSWER) })
  tree = await loadedBody(off.renderer, environmentRegistration(off.ctx))
  const offBody = sectionBody(tree, 'environment')
  assert.ok(textOf(offBody).includes('name off-pattern'), 'an off-pattern branch warns beside the card')
  const warning = collect(
    offBody,
    node => node.props !== undefined && node.props.title === 'Branch name does not follow <type>/<KEY-N>-<slug>',
  )
  assert.equal(warning.length, 1, 'the warning keeps the full rule in its title')
  assert.equal(warning[0].props.style.color, WARN, 'the warning uses the warn token')
})

test('a card without a tracker address shows its key as plain text, not a link', async () => {
  const mounted = mountBundle({ answer: () => reply(CARD_WITHOUT_LINK_ANSWER) })
  const tree = await loadedBody(mounted.renderer, environmentRegistration(mounted.ctx))
  const body = sectionBody(tree, 'environment')
  assert.ok(textOf(body).includes('ACL-12'), 'the card key is shown')
  assert.equal(collect(body, node => node.type === 'a').length, 0, 'a card without a URL is not a link')
})

test('a task with the optional facts switched off shows no card or progress rows', async () => {
  const mounted = mountBundle({ answer: () => reply(OPTED_OUT_ANSWER) })
  const tree = await loadedBody(mounted.renderer, environmentRegistration(mounted.ctx))
  const body = sectionBody(tree, 'environment')
  const text = textOf(body)
  assert.equal(text.includes('ACL-12'), false, 'no card row')
  assert.equal(text.includes('Progress file'), false, 'no progress row')
  assert.equal(collect(body, node => node.type === 'a').length, 0, 'no card link')
})

test('the Changes section lists pull requests first, then the uncommitted files', async () => {
  const pulls = mountBundle({ answer: () => reply(PULLS_ANSWER) })
  let tree = await loadedBody(pulls.renderer, environmentRegistration(pulls.ctx))
  let body = sectionBody(tree, 'changes')
  const rows = pullRows(body)
  assert.deepEqual(
    rows.map(row => row.props['data-pull-state']),
    ['open', 'merged', 'closed', 'draft', 'unknown'],
    'a pull request state is matched case-insensitively, and draft wins over its state',
  )
  assert.deepEqual(
    rows.map(pullTone),
    [SUCCESS, BRAND, SECONDARY, SECONDARY, SECONDARY],
    'the pull-request icon tone follows open, merged, closed and draft',
  )
  const anchors = collect(body, node => node.type === 'a')
  assert.equal(anchors.length, 5, 'every pull request is a link')
  assert.equal(textOf(anchors[0]).trim(), 'Open work', 'the pull-request title is the link text')
  assert.equal(anchors[0].props.href, PULLS_ANSWER.pullRequests[0].url)
  assert.equal(anchors[0].props.target, '_blank')
  assert.equal(anchors[0].props.rel, 'noreferrer')
  assert.equal(anchors[0].props['aria-label'], 'Pull request #1: Open work')
  assert.equal(
    anchors[0].props.title,
    'Pull request #1: Open work',
    'the cut pull-request link keeps its full label in the title',
  )
  assert.equal(textOf(anchors[4]).trim(), 'Pull request #5', 'a titleless pull request links a generated title')
  assert.equal(anchors[4].props['aria-label'], 'Pull request #5')
  assert.equal(anchors[4].props.title, 'Pull request #5', 'a titleless pull request titles its generated label')
  const pullsText = textOf(body)
  assert.ok(pullsText.includes('#1 · success · approved'), 'the second line joins the number, checks and review')
  assert.ok(pullsText.includes('#2 · neutral'), 'only the present parts of the second line appear')
  assert.ok(hasTitle(body, '#1 · success · approved'), 'the cut meta line keeps its full text in the title')
  assert.ok(hasTitle(body, '#2 · neutral'), 'a meta line without review keeps its full text in the title')
  assert.equal(pullsText.includes('#3 · '), false, 'a pull request with nothing else shows only its number')
  assert.equal(pullsText.includes('No changes'), false, 'pull requests alone are something to show')

  const full = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const fullRegistration = environmentRegistration(full.ctx)
  tree = await loadedBody(full.renderer, fullRegistration)
  body = sectionBody(tree, 'changes')
  const fullText = textOf(body)
  assert.ok(fullText.indexOf('Add login') < fullText.indexOf('2 uncommitted changes'), 'pull requests render before the working tree')
  assert.ok(fullText.includes('2 uncommitted changes'), 'the working-tree row counts the changes')
  assert.ok(fullText.includes('2 staged · 1 unstaged'), 'the non-zero counts sit at the right')
  assert.equal(fullText.includes('src/login.js'), false, 'the file list starts collapsed')
  assert.equal(toggleButton(body, 'uncommitted').props['aria-expanded'], 'false', 'the working-tree row starts collapsed')
  assert.equal(fileRows(body).length, 0, 'a collapsed working-tree row renders no file rows')
  toggleButton(body, 'uncommitted').props.onClick()
  tree = renderBody(full.renderer, fullRegistration)
  body = sectionBody(tree, 'changes')
  const expandedText = textOf(body)
  assert.equal(toggleButton(body, 'uncommitted').props['aria-expanded'], 'true', 'a click expands the working-tree row')
  assert.equal(fileRows(body).length, 2, 'the expanded row lists each changed file')
  assert.ok(expandedText.includes('src/login.js'), 'the file list shows the changed paths')
  assert.ok(expandedText.includes('src/auth.js \u2192 src/session.js'), 'a rename keeps its arrow')

  const single = mountBundle({ answer: () => reply(SINGLE_CHANGE_ANSWER) })
  tree = await loadedBody(single.renderer, environmentRegistration(single.ctx))
  const singleText = textOf(sectionBody(tree, 'changes'))
  assert.ok(singleText.includes('1 uncommitted change'), 'one change is singular')
  assert.equal(singleText.includes('1 uncommitted changes'), false, 'one change never reads as a plural')

  const clean = mountBundle({ answer: () => reply(TASK_EDGE_ANSWER) })
  tree = await loadedBody(clean.renderer, environmentRegistration(clean.ctx))
  assert.ok(textOf(sectionBody(tree, 'changes')).includes('No changes'), 'a clean tree with no pull requests says No changes')

  const outside = mountBundle({ answer: () => reply(PLAIN_ANSWER) })
  tree = await loadedBody(outside.renderer, environmentRegistration(outside.ctx))
  assert.ok(textOf(sectionBody(tree, 'changes')).includes('Not a git folder'), 'outside a git folder the Changes section says so')

  const pullFailed = mountBundle({ answer: () => reply(PULL_ERROR_ONLY_ANSWER) })
  tree = await loadedBody(pullFailed.renderer, environmentRegistration(pullFailed.ctx))
  const pullFailedText = textOf(sectionBody(tree, 'changes'))
  assert.ok(pullFailedText.includes('the forge did not answer'), 'the pull-request error shows on a clean tree')
  assert.equal(pullFailedText.includes('No changes'), false, 'a failed pull-request read is not "No changes"')

  const failed = mountBundle({ answer: () => reply(BOTH_ERRORS_ANSWER) })
  tree = await loadedBody(failed.renderer, environmentRegistration(failed.ctx))
  body = sectionBody(tree, 'changes')
  const failedText = textOf(body)
  assert.ok(failedText.includes('git status did not answer'), 'the changes error shows in the Changes section')
  assert.ok(failedText.includes('the forge did not answer'), 'the pull-request error shows in the Changes section')
  assert.equal(failedText.includes('No changes'), false, 'a failed read is not a clean tree')
  const messages = collect(body, node => node.type === 'p' && textOf(node).includes('did not answer'))
  assert.equal(messages.length, 2, 'both section errors render')
  for (const message of messages) {
    assert.equal(message.props.style.color, ERROR, 'a section error uses the error token')
  }
})

test('the Changes section offers Git only when the git feature is switched on', async () => {
  const gitOn = mountBundle({ answer: () => reply(FULL_ANSWER), features: ['environment', 'git'] })
  let tree = await loadedBody(gitOn.renderer, environmentRegistration(gitOn.ctx))
  let body = sectionBody(tree, 'changes')
  assert.ok(textOf(body).includes('Open in Git'), 'with git on the Changes section offers Open in Git')
  toggleButton(body, 'uncommitted').props.onClick()
  tree = renderBody(gitOn.renderer, environmentRegistration(gitOn.ctx))
  body = sectionBody(tree, 'changes')
  const rows = collect(body, node => node.props !== undefined && typeof node.props['data-git-path'] === 'string')
  assert.ok(rows.length > 0, 'the working tree renders its file rows')
  assert.ok(rows.some(row => row.type === 'button'), 'file rows are buttons that open the Git tab when git is on')

  const gitOff = mountBundle({ answer: () => reply(FULL_ANSWER), features: ['environment'] })
  tree = await loadedBody(gitOff.renderer, environmentRegistration(gitOff.ctx))
  body = sectionBody(tree, 'changes')
  assert.equal(textOf(body).includes('Open in Git'), false, 'with git off there is no Open in Git button')
  toggleButton(body, 'uncommitted').props.onClick()
  tree = renderBody(gitOff.renderer, environmentRegistration(gitOff.ctx))
  body = sectionBody(tree, 'changes')
  const plain = collect(body, node => node.props !== undefined && typeof node.props['data-git-path'] === 'string')
  assert.ok(plain.length > 0, 'the file rows still render with git off')
  assert.ok(plain.every(row => row.type === 'div'), 'file rows are plain rows, like folder rows, when git is off')
})

test('the old headings are gone and the pinned connector note lives in the row title', async () => {
  const { renderer, ctx } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = environmentRegistration(ctx)
  const tree = await loadedBody(renderer, registration)

  assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'the column renders the four sections in default order')
  assert.deepEqual(
    sectionHeaders(tree).map(sectionHeaderName),
    ['Environment', 'Context', 'Connectors', 'Changes'],
    'the section headers carry the four names',
  )
  for (const old of ['Machine', 'Folder', 'Pull requests', 'Task']) {
    const headings = collect(tree, node => ['h3', 'h2', 'h4'].includes(node.type) && textOf(node).trim() === old)
    assert.equal(headings.length, 0, 'the old ' + old + ' heading is gone')
    const exact = collect(tree, node => ['span', 'p', 'div'].includes(node.type) && textOf(node).trim() === old)
    assert.equal(exact.length, 0, 'no element renders the old ' + old + ' heading text')
  }

  const pinned = mountBundle({ answer: () => reply(PINNED_CONNECTORS_ANSWER) })
  const pinnedTree = await loadedBody(pinned.renderer, environmentRegistration(pinned.ctx))
  const pinnedConnectors = textOf(sectionBody(pinnedTree, 'connectors'))
  const visiblePinnedConnectors = visibleTextOf(sectionBody(pinnedTree, 'connectors'))
  assert.ok(pinnedConnectors.includes('firecrawl'), 'the Connectors body keeps its pinned rows')
  assert.equal(visiblePinnedConnectors.includes(PINNED_NOTE), false, 'the pinned note leaves the visible text')
  assert.ok(
    hasTitle(pinnedTree, 'firecrawl · pinned · 2 tools. ' + PINNED_NOTE),
    'the pinned note moves into the row title',
  )
})

/* ------------------------------------------------------------------ */
/* The Context section's detailed body and Compact button (task L.3)   */
/* ------------------------------------------------------------------ */

test('the Context body shows the Claude breakdown when the oh-my-claude route answers', async () => {
  const { renderer, ctx, network } = mountBundle({ contextAnswer: () => reply(CLAUDE_CONTEXT_ANSWER) })
  const registration = environmentRegistration(ctx)
  /* dsh's own reading disagrees with the route on purpose: the route wins in both the
     body headline and the header summary. */
  const pressure = { projectedTokens: 50_000, contextWindow: 200_000 }
  const tree = await loadedBody(renderer, registration, { sessionId: 's 1', pressure })

  assert.equal(network.contextCalls.length, 1, 'an expanded, visible Context section asks the route once')
  const call = network.contextCalls[0]
  assert.equal(call.url, CLAUDE_ROUTE + '?session=' + encodeURIComponent('s 1'), 'the session id is encoded')
  assert.equal(call.init.cache, 'no-store')
  assert.equal(call.init.credentials, 'same-origin')
  assert.ok(call.init.signal instanceof AbortSignal, 'a stalled context request is aborted')
  assert.equal(network.calls.length, 1, 'the Environment route is still fetched once')

  const body = sectionBody(tree, 'context')
  const text = textOf(body)
  assert.ok(text.includes('42% used · claude-opus-5-5'), 'the route percentage rounds and carries its model')
  assert.equal(text.includes('25% used'), false, "the body never shows dsh's projection while the route answers")
  assert.equal(text.includes('389k / 1M'), true, 'the headline shows the route used and maximum tokens')

  const header = sectionHeader(tree, 'context')
  assert.equal(header.props['aria-label'], 'Context, 42% used', 'the header names the route percent')
  assert.equal(textOf(contextHeaderSummary(tree)), '42%', 'the header summary shows the route percent')
  assert.equal(contextPill(tree).children[0].props.style.width, '42%', 'the pill fills to the route percent')

  const headline = contextHeadline(body)
  assert.equal(textOf(headline.children[0]), '42% used · claude-opus-5-5')
  assert.equal(headline.children[0].props.style.fontSize, 13, 'the percent is 13 px')
  const count = headline.children[1]
  assert.equal(textOf(count), '389k / 1M')
  assert.equal(count.props.style.fontSize, 12, 'the token count is 12 px')
  assert.equal(count.props.style.color, SECONDARY, 'the token count is secondary text')
  assert.equal(count.props.style.fontVariantNumeric, 'tabular-nums', 'the token count is tabular')
  const model = headline.children[0].children[1]
  assert.equal(textOf(model), ' · claude-opus-5-5')
  assert.equal(model.props.style.fontSize, 12, 'the model is 12 px')
  assert.equal(model.props.style.color, SECONDARY, 'the model is secondary text')

  const used = contextRowsOf(body, 'used')
  assert.deepEqual(
    used.map(row => contextRowParts(row).name),
    ['Messages', 'Tool definitions', 'System prompt', 'Memory', 'Attachments'],
    'the used rows sort by tokens, largest first',
  )
  const usedParts = used.map(contextRowParts)
  assert.deepEqual(usedParts.map(part => part.tokens), ['320k', '48k', '20k', '500', '500'])
  assert.deepEqual(usedParts.map(part => part.share), ['32.0%', '4.8%', '2.0%', '0.1%', '0.1%'])
  assert.deepEqual(
    usedParts.map(part => part.swatch.background),
    [BRAND, WARN, SUCCESS, SECONDARY, IDLE],
    'the swatches take brand, warn, success, label-secondary and idle by position',
  )
  for (const part of usedParts) {
    assert.equal(part.swatch.width, 8, 'a swatch is 8 px wide')
    assert.equal(part.swatch.height, 8, 'a swatch is 8 px tall')
    assert.equal(part.swatch.borderRadius, 2, 'a swatch has a 2 px radius')
    assert.equal(part.swatchAriaHidden, 'true', 'a swatch is decorative')
    assert.equal(part.tokensStyle.fontSize, 12, 'the row tokens are 12 px')
    assert.equal(part.tokensStyle.color, SECONDARY, 'the row tokens are secondary text')
    assert.equal(part.shareStyle.fontSize, 12, 'the share is 12 px')
    assert.equal(part.shareStyle.color, SECONDARY, 'the share is secondary text')
  }

  const groups = contextGroups(body)
  assert.deepEqual(
    groups.map(group => group.props['data-context-group']),
    ['used', 'extra', 'deferred'],
    'the used, buffer/free and deferred rows sit in three groups',
  )
  const extra = groups.find(group => group.props['data-context-group'] === 'extra')
  assert.deepEqual(
    extra.children.map(child => child.props['data-context-row']),
    ['buffer', 'free'],
    'the buffer row comes before the free-space row',
  )
  assert.equal(extra.props.style.marginTop, 4, 'the buffer/free group is spaced from the rows above')
  const buffer = contextRowParts(contextRowsOf(body, 'buffer')[0])
  assert.equal(buffer.name, 'Compact buffer', 'a name ending in buffer is a buffer row even without kind')
  assert.equal(buffer.tokens, '9k')
  assert.equal(buffer.share, '0.9%')
  assert.equal(buffer.swatch.background, BORDER_L2, 'the buffer swatch uses the border-l2 token')
  const free = contextRowParts(contextRowsOf(body, 'free')[0])
  assert.equal(free.name, 'Free space')
  assert.equal(free.tokens, '602k')
  assert.equal(free.share, '60.2%')
  assert.equal(free.swatch.background, TRACK, 'the free swatch uses the layer-2 token')
  assert.equal(free.swatch.border, '1px solid ' + BORDER_L2, 'the free swatch has a border-l2 border')

  const deferredGroup = groups.find(group => group.props['data-context-group'] === 'deferred')
  assert.equal(deferredGroup.props.style.marginTop, 4, 'the deferred group is spaced from the rows above')
  const deferred = contextRowsOf(body, 'deferred')
  assert.deepEqual(
    deferred.map(row => contextRowParts(row).name),
    ['MCP tools', 'Skill details'],
    'a deferred flag without kind is a deferred row; a deferred kind is one too',
  )
  assert.deepEqual(deferred.map(row => contextRowParts(row).share), ['—', '—'], 'a deferred row has no share')
  assert.deepEqual(
    deferred.map(row => contextRowParts(row).swatch.background),
    [IDLE, IDLE],
    'deferred rows use the idle swatch',
  )

  const bar = collect(
    body,
    node => node.props !== undefined && node.props.role === 'progressbar' && node.props.style?.height === 6,
  )
  assert.equal(bar.length, 1, 'the body renders one 6 px context bar')
  assert.equal(bar[0].props.style.borderRadius, 3, 'the bar has a 3 px radius')
  assert.equal(bar[0].props.style.gap, 1, 'the bar segments are 1 px apart')
  assert.equal(bar[0].props.style.background, TRACK, 'the bar track uses the layer-2 token')
  assert.equal(bar[0].props['aria-valuenow'], 42, 'the bar announces the route percent')
  const segments = contextSegments(body)
  assert.deepEqual(
    segments.map(segment => Number.parseFloat(segment.props.style.width)),
    [32, 4.8, 2, 0.4, 0.4],
    'the segments follow the row order and keep the 0.4% minimum width',
  )
  assert.deepEqual(
    segments.map(segment => segment.props.style.background),
    [BRAND, WARN, SUCCESS, SECONDARY, IDLE],
    'each segment takes its row swatch color',
  )
})

test('the collapsed Context header follows contextPressure, not the stale route answer', async () => {
  const answer = { ...CLAUDE_CONTEXT_ANSWER, percentage: 37 }
  const { renderer, ctx } = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply(answer) })
  const registration = environmentRegistration(ctx)
  const low = { projectedTokens: 50_000, contextWindow: 200_000 }
  const high = { projectedTokens: 180_000, contextWindow: 200_000 }
  let tree = await loadedBody(renderer, registration, { pressure: low })
  assert.equal(
    sectionHeader(tree, 'context').props['aria-label'],
    'Context, 37% used',
    'the open section follows the route percent',
  )

  sectionHeader(tree, 'context').props.onClick()
  tree = renderBody(renderer, registration, { pressure: high })
  assert.equal(
    sectionHeader(tree, 'context').props['aria-label'],
    'Context, 90% used',
    'a collapsed section follows contextPressure, so the warn colors can appear',
  )
  assert.equal(textOf(contextHeaderSummary(tree)), '90%', 'the collapsed header shows the pressure percent')
  assert.equal(
    contextPill(tree).children[0].props.style.background,
    WARN,
    'the collapsed pill warns at 90%',
  )

  sectionHeader(tree, 'context').props.onClick()
  tree = renderBody(renderer, registration, { pressure: high })
  assert.equal(
    sectionHeader(tree, 'context').props['aria-label'],
    'Context, 90% used',
    'a re-expanded section falls back to contextPressure until a fresh route answer arrives',
  )
  await settle()
  tree = renderBody(renderer, registration, { pressure: high })
  assert.equal(
    sectionHeader(tree, 'context').props['aria-label'],
    'Context, 37% used',
    'the refreshed route answer replaces the pressure percent',
  )
})

test("the Context body falls back to dsh's projections", async () => {
  const pressure = { projectedTokens: 84_100, contextWindow: 200_000 }
  const breakdown = { systemTokens: 10_000, toolsTokens: 20_000, messageTokens: 70_000 }

  const fallbacks = [
    { label: 'an ok:false answer', options: { contextAnswer: () => reply({ ok: false }) } },
    { label: 'an ok that is not true', options: { contextAnswer: () => reply({ ...CLAUDE_CONTEXT_ANSWER, ok: 'yes' }) } },
    { label: 'a 404', options: { contextAnswer: () => reply({ error: 'not available' }, 404) } },
    { label: 'a failed fetch', options: { contextAnswer: () => Promise.reject(new Error('offline')) } },
  ]
  for (const item of fallbacks) {
    const { renderer, ctx } = mountBundle({ answer: () => reply(PLAIN_ANSWER), ...item.options })
    const tree = await loadedBody(renderer, environmentRegistration(ctx), { pressure, breakdown })
    const body = sectionBody(tree, 'context')
    const text = textOf(body)
    assert.ok(text.includes('42% used'), item.label + ': the headline comes from contextPressure')
    assert.ok(text.includes('84.1k / 200k'), item.label + ': the headline shows the dsh tokens')
    assert.equal(text.includes('·'), false, item.label + ': no model name without the Claude route')

    const used = contextRowsOf(body, 'used')
    assert.deepEqual(
      used.map(row => contextRowParts(row).name),
      ['Messages', 'Tool definitions', 'System prompt'],
      item.label + ": the breakdown's three rows show, sorted",
    )
    const parts = used.map(contextRowParts)
    assert.deepEqual(
      parts.map(part => part.tokens),
      ['58.9k', '16.8k', '8.4k'],
      item.label + ': scaled to the used tokens',
    )
    assert.deepEqual(parts.map(part => part.share), ['29.4%', '8.4%', '4.2%'], item.label + ': the shares are of the window')
    assert.deepEqual(
      parts.map(part => part.swatch.background),
      [BRAND, WARN, SUCCESS],
      item.label + ': the swatches take the first three positions',
    )
    const free = contextRowsOf(body, 'free')
    assert.equal(free.length, 1, item.label + ': the free space row follows')
    assert.equal(contextRowParts(free[0]).name, 'Free space')
    assert.equal(contextRowParts(free[0]).tokens, '115.9k', item.label + ': free is window minus used')
    assert.equal(contextRowParts(free[0]).share, '58.0%')
    const segments = contextSegments(body)
    assert.deepEqual(
      segments.map(segment => Number.parseFloat(segment.props.style.width)),
      [29.435, 8.41, 4.205],
      item.label + ': the bar segments mirror the three rows',
    )
  }

  const neutral = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply({ ok: false }) })
  const neutralTree = await loadedBody(neutral.renderer, environmentRegistration(neutral.ctx), { pressure })
  const neutralBody = sectionBody(neutralTree, 'context')
  assert.equal(contextRowsOf(neutralBody, 'used').length, 0, 'without a breakdown no used row shows')
  assert.equal(contextRowsOf(neutralBody, 'free').length, 0, 'without a breakdown no free row shows')
  assert.equal(contextGroups(neutralBody).length, 0, 'without a breakdown no row group renders')
  const neutralSegments = contextSegments(neutralBody)
  assert.equal(neutralSegments.length, 1, 'without a breakdown the bar is one segment')
  assert.equal(Number.parseFloat(neutralSegments[0].props.style.width), 42, 'the neutral segment reaches the percent')
  assert.equal(neutralSegments[0].props.style.background, IDLE, 'the neutral segment uses the idle token')
  assert.ok(textOf(neutralBody).includes('42% used'), 'the headline still shows the percent')

  const zero = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply({ ok: false }) })
  const zeroTree = await loadedBody(zero.renderer, environmentRegistration(zero.ctx), {
    pressure: { projectedTokens: 0, contextWindow: 200_000 },
  })
  const zeroSegments = contextSegments(sectionBody(zeroTree, 'context'))
  assert.equal(zeroSegments.length, 1, 'a zero reading still draws the neutral segment')
  assert.equal(
    Number.parseFloat(zeroSegments[0].props.style.width),
    0.4,
    'the neutral segment keeps the 0.4% minimum',
  )

  const none = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply({ ok: false }) })
  const noneTree = await loadedBody(none.renderer, environmentRegistration(none.ctx))
  const noneBody = sectionBody(noneTree, 'context')
  assert.ok(
    textOf(noneBody).includes('Shown after the first model request'),
    'with neither source the body keeps the pre-request note',
  )
  assert.equal(
    collect(noneBody, node => node.props !== undefined && node.props['data-context-headline'] !== undefined).length,
    0,
    'no headline renders before the first request',
  )
  assert.equal(contextSegments(noneBody).length, 0, 'no bar renders before the first request')
  assert.equal(contextRowsOf(noneBody, 'used').length, 0, 'no rows render before the first request')

  const over = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply({ ok: false }) })
  const overTree = await loadedBody(over.renderer, environmentRegistration(over.ctx), {
    pressure: { projectedTokens: 250_000, contextWindow: 200_000 },
    breakdown,
  })
  const overFree = contextRowsOf(sectionBody(overTree, 'context'), 'free')
  assert.equal(overFree.length, 1, 'a reading over the window still shows the free row')
  assert.equal(contextRowParts(overFree[0]).tokens, '0', 'free space never goes negative')
  assert.equal(contextRowParts(overFree[0]).share, '0.0%')
})

test('the route is asked only while the Context section is open and visible', async () => {
  const open = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply(CLAUDE_CONTEXT_ANSWER) })
  const registration = environmentRegistration(open.ctx)
  let tree = renderBody(open.renderer, registration)
  await settle()
  tree = renderBody(open.renderer, registration)
  assert.equal(open.network.contextCalls.length, 1, 'an open, visible section asks at mount')

  sectionHeader(tree, 'context').props.onClick()
  tree = renderBody(open.renderer, registration)
  await settle()
  assert.equal(open.network.contextCalls.length, 1, 'collapsing asks nothing new')
  assert.equal(open.timers.pending('interval').length, 1, 'the single poll survives the collapse')
  open.timers.pending('interval')[0].fn()
  await settle()
  assert.equal(open.network.contextCalls.length, 1, 'a tick while collapsed asks nothing')

  sectionHeader(tree, 'context').props.onClick()
  tree = renderBody(open.renderer, registration)
  await settle()
  assert.equal(open.network.contextCalls.length, 2, 'expanding asks at once')
  open.timers.pending('interval')[0].fn()
  await settle()
  assert.equal(open.network.contextCalls.length, 3, 'a poll tick while open asks once')
  open.document.visibilityState = 'hidden'
  open.timers.pending('interval')[0].fn()
  await settle()
  assert.equal(open.network.contextCalls.length, 3, 'a tick while the document is hidden asks nothing')
  open.document.visibilityState = 'visible'
  open.document.dispatch('visibilitychange')
  await settle()
  assert.equal(open.network.contextCalls.length, 4, 'becoming visible again asks once')

  const hidden = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply(CLAUDE_CONTEXT_ANSWER) })
  const hiddenRegistration = environmentRegistration(hidden.ctx)
  renderBody(hidden.renderer, hiddenRegistration, { visible: false })
  await settle()
  assert.equal(hidden.network.contextCalls.length, 0, 'a hidden tab asks nothing')
  renderBody(hidden.renderer, hiddenRegistration, { visible: true })
  await settle()
  assert.equal(hidden.network.contextCalls.length, 1, 'becoming visible asks once')

  const missing = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    contextAnswer: () => reply({ error: 'not available' }, 404),
  })
  const missingRegistration = environmentRegistration(missing.ctx)
  tree = renderBody(missing.renderer, missingRegistration)
  await settle()
  tree = renderBody(missing.renderer, missingRegistration)
  assert.equal(missing.network.contextCalls.length, 1, 'the 404 route is asked once')
  missing.timers.pending('interval')[0].fn()
  await settle()
  assert.equal(missing.network.contextCalls.length, 1, 'a tick after the 404 asks nothing')
  sectionHeader(tree, 'context').props.onClick()
  tree = renderBody(missing.renderer, missingRegistration)
  sectionHeader(tree, 'context').props.onClick()
  tree = renderBody(missing.renderer, missingRegistration)
  await settle()
  assert.equal(missing.network.contextCalls.length, 1, 'expanding again after the 404 asks nothing')

  /* The previous session's data is hidden the moment the session changes, before the
     new session's route answer arrives. */
  let switchCalls = 0
  const heldNew = deferred()
  const switching = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    contextAnswer: () => {
      switchCalls += 1
      return switchCalls === 1 ? reply(CLAUDE_CONTEXT_ANSWER) : heldNew.promise
    },
  })
  const switchRegistration = environmentRegistration(switching.ctx)
  let switchedTree = renderBody(switching.renderer, switchRegistration, { sessionId: 's1' })
  await settle()
  switchedTree = renderBody(switching.renderer, switchRegistration, { sessionId: 's1' })
  assert.equal(
    textOf(sectionBody(switchedTree, 'context')).includes('claude-opus-5-5'),
    true,
    's1 shows its route answer',
  )
  switchedTree = renderBody(switching.renderer, switchRegistration, { sessionId: 's2' })
  assert.equal(
    textOf(sectionBody(switchedTree, 'context')).includes('claude-opus-5-5'),
    false,
    "the previous session's route data is hidden as soon as the session changes",
  )
  await settle()
  switchedTree = renderBody(switching.renderer, switchRegistration, { sessionId: 's2' })
  assert.equal(
    textOf(sectionBody(switchedTree, 'context')).includes('claude-opus-5-5'),
    false,
    'and stays hidden while the new session request is pending',
  )
  heldNew.resolve(reply(CLAUDE_CONTEXT_ANSWER))
  await settle()
  switchedTree = renderBody(switching.renderer, switchRegistration, { sessionId: 's2' })
  assert.equal(
    textOf(sectionBody(switchedTree, 'context')).includes('claude-opus-5-5'),
    true,
    'the new session shows its own answer',
  )
  assert.equal(switching.network.contextCalls.length, 2, 'the new session asked once')
  assert.deepEqual(switching.renderer.errors(), [], 'no state update throws after the switch')

  /* An answer for the old session arriving after the switch never lands. */
  const heldOld = deferred()
  const late = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    contextAnswer: () => heldOld.promise,
  })
  const lateRegistration = environmentRegistration(late.ctx)
  renderBody(late.renderer, lateRegistration, { sessionId: 's1' })
  await settle()
  assert.equal(late.network.contextCalls.length, 1, 's1 asked and is pending')
  renderBody(late.renderer, lateRegistration, { sessionId: 's2' })
  assert.equal(late.network.contextCalls.length, 1, 'the new session waits for the pending request')
  heldOld.resolve(reply(CLAUDE_CONTEXT_ANSWER))
  await settle()
  const lateTree = renderBody(late.renderer, lateRegistration, { sessionId: 's2' })
  assert.equal(
    textOf(sectionBody(lateTree, 'context')).includes('claude-opus-5-5'),
    false,
    "the previous session's late answer is ignored",
  )
  assert.deepEqual(late.renderer.errors(), [], 'the late answer sets no state')

  const pending = deferred()
  const gone = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => pending.promise })
  const goneRegistration = environmentRegistration(gone.ctx)
  renderBody(gone.renderer, goneRegistration)
  await settle()
  assert.equal(gone.network.contextCalls.length, 1, 'the mounted section asked')
  gone.renderer.unmount()
  pending.resolve(reply(CLAUDE_CONTEXT_ANSWER))
  await settle()
  assert.deepEqual(gone.renderer.errors(), [], 'an answer after unmount sets no state')
})

test('at most one oh-my-claude request is pending per mount', async () => {
  const held = deferred()
  let calls = 0
  const { renderer, ctx, network, timers } = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    contextAnswer: () => {
      calls += 1
      return calls === 1 ? held.promise : reply(CLAUDE_CONTEXT_ANSWER)
    },
  })
  const registration = environmentRegistration(ctx)
  let tree = renderBody(renderer, registration)
  await settle()
  assert.equal(network.contextCalls.length, 1, 'the mount asked once')

  refreshButton(tree).props.onClick()
  tree = renderBody(renderer, registration)
  await settle()
  assert.equal(network.contextCalls.length, 1, 'a Refresh while the request is pending starts no second request')

  held.resolve(reply(CLAUDE_CONTEXT_ANSWER))
  await settle()
  tree = renderBody(renderer, registration)
  refreshButton(tree).props.onClick()
  tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  assert.equal(network.contextCalls.length, 2, 'once nothing is pending, Refresh asks again')
  assert.ok(
    textOf(sectionBody(tree, 'context')).includes('claude-opus-5-5'),
    'the request after the pending one answers',
  )
  assert.equal(timers.pending('interval').length, 1, 'the mount still polls once')
})

test('a failed Claude fetch falls back to the projections', async () => {
  let calls = 0
  const { renderer, ctx, timers } = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    contextAnswer: () => {
      calls += 1
      return calls === 1 ? reply(CLAUDE_CONTEXT_ANSWER) : Promise.reject(new Error('offline'))
    },
  })
  const registration = environmentRegistration(ctx)
  const pressure = { projectedTokens: 50_000, contextWindow: 200_000 }
  const breakdown = { systemTokens: 10_000, toolsTokens: 20_000, messageTokens: 70_000 }
  let tree = await loadedBody(renderer, registration, { pressure, breakdown })
  assert.ok(textOf(sectionBody(tree, 'context')).includes('claude-opus-5-5'), 'the route answers first')
  assert.equal(sectionHeader(tree, 'context').props['aria-label'], 'Context, 42% used', 'the header follows the route')

  timers.pending('interval')[0].fn()
  await settle()
  tree = renderBody(renderer, registration, { pressure, breakdown })
  const body = textOf(sectionBody(tree, 'context'))
  assert.equal(body.includes('claude-opus-5-5'), false, 'a failed fetch drops the old Claude answer')
  assert.ok(body.includes('25% used'), 'the fallback headline uses the dsh projection')
  assert.ok(body.includes('50k / 200k'), 'the fallback shows the dsh tokens')
  assert.ok(body.includes('System prompt'), 'the breakdown rows return')
  assert.equal(
    sectionHeader(tree, 'context').props['aria-label'],
    'Context, 25% used',
    'the header returns to the dsh projection',
  )
  assert.equal(textOf(contextHeaderSummary(tree)), '25%', 'the header summary returns to the projection')
})

test('Compact session runs /compact only when the message box is empty and the session is idle', async () => {
  const calls = []
  const inputActions = {
    setDraft(text) {
      calls.push(['setDraft', text])
    },
    submit() {
      calls.push(['submit'])
    },
  }
  const idle = new Map([['s1', { running: false }]])
  const running = new Map([['s1', { running: true }]])
  const pressure = { projectedTokens: 84_100, contextWindow: 200_000 }
  const emptyInput = { draft: '', attachmentIds: [], phase: 'plain' }

  const enabled = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply({ ok: false }) })
  const registration = environmentRegistration(enabled.ctx)
  const atOptions = options => renderBody(enabled.renderer, registration, { pressure, ...options })

  let tree = await loadedBody(enabled.renderer, registration, {
    pressure,
    input: emptyInput,
    inputActions,
    status: idle,
  })
  let button = compactButton(tree)
  assert.ok(button, 'an empty idle message box still offers Compact session')
  assert.equal(button.props.disabled, undefined, 'the button is enabled')
  assert.equal(button.props.style.fontSize, 12, 'the button text is 12 px')
  assert.equal(button.props.style.borderRadius, 6, 'the button has a 6 px radius')
  assert.equal(button.props.style.padding, '4px 10px', 'the button is padded 4 x 10')
  assert.equal(button.props.style.border, '1px solid ' + BORDER_L2, 'the button has a border-l2 border')
  button.props.onClick()
  assert.deepEqual(calls, [['setDraft', '/compact'], ['submit']], 'the click types /compact, then sends it')

  /* A whitespace-only draft counts as empty. A fresh mount has no Compact guard from
     the click above (the guard holds for 2 s when the host reports no state change). */
  const spaceCalls = []
  const spaceActions = {
    setDraft(text) {
      spaceCalls.push(['setDraft', text])
    },
    submit() {
      spaceCalls.push(['submit'])
    },
  }
  const spaces = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply({ ok: false }) })
  tree = await loadedBody(spaces.renderer, environmentRegistration(spaces.ctx), {
    pressure,
    input: { ...emptyInput, draft: '   ' },
    inputActions: spaceActions,
    status: idle,
  })
  button = compactButton(tree)
  assert.equal(button.props.disabled, undefined, 'a whitespace-only draft is empty')
  button.props.onClick()
  assert.deepEqual(spaceCalls, [['setDraft', '/compact'], ['submit']], 'a whitespace draft still compacts')

  calls.length = 0
  tree = atOptions({ input: { ...emptyInput, draft: 'hello' }, inputActions, status: idle })
  button = compactButton(tree)
  assert.equal(button.props.disabled, true, 'a draft disables the button')
  assert.ok(
    textOf(sectionBody(tree, 'context')).includes('Clear the message box to compact'),
    'the note says to clear the message box',
  )
  button.props.onClick()
  assert.deepEqual(calls, [], 'a disabled click never replaces the draft')

  calls.length = 0
  tree = atOptions({ input: { ...emptyInput, attachmentIds: ['a1'] }, inputActions, status: idle })
  button = compactButton(tree)
  assert.equal(button.props.disabled, true, 'an attachment disables the button')
  button.props.onClick()
  assert.deepEqual(calls, [], 'a disabled click with an attachment does nothing')

  tree = atOptions({ input: { ...emptyInput, phase: 'sending' }, inputActions, status: idle })
  button = compactButton(tree)
  assert.equal(button.props.disabled, true, 'a sending message box disables the button')
  assert.ok(
    textOf(sectionBody(tree, 'context')).includes('Available when the turn ends'),
    'a non-plain phase says the turn must end',
  )

  tree = atOptions({ input: emptyInput, inputActions, status: running })
  button = compactButton(tree)
  assert.equal(button.props.disabled, true, 'a running session disables the button')
  assert.ok(
    textOf(sectionBody(tree, 'context')).includes('Available when the turn ends'),
    'a running session says the turn must end',
  )

  tree = atOptions({ input: { ...emptyInput, draft: 'hello' }, inputActions, status: running })
  button = compactButton(tree)
  assert.equal(button.props.disabled, true)
  assert.ok(
    textOf(sectionBody(tree, 'context')).includes('Clear the message box to compact'),
    'the draft note wins over the turn note',
  )

  const noActions = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply({ ok: false }) })
  tree = await loadedBody(noActions.renderer, environmentRegistration(noActions.ctx), {
    pressure,
    input: emptyInput,
    status: idle,
  })
  assert.equal(compactButton(tree), null, 'a host without inputActions gets no Compact button')
  assert.deepEqual(noActions.renderer.errors(), [], 'the missing actions never throw')

  tree = atOptions({ input: emptyInput, status: idle })
  assert.equal(compactButton(tree), null, 'a host that cannot read the draft gets no Compact button')
  tree = atOptions({ input: emptyInput, inputActions })
  assert.equal(compactButton(tree), null, 'a host that cannot read the running state gets no Compact button')
  assert.deepEqual(enabled.renderer.errors(), [], 'missing message-box props never throw')

  /* A host that keeps the phase plain after submit: a double click must still send once. */
  const twiceCalls = []
  const twiceActions = {
    setDraft(text) {
      twiceCalls.push(['setDraft', text])
    },
    submit() {
      twiceCalls.push(['submit'])
    },
  }
  const twice = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply({ ok: false }) })
  const twiceRegistration = environmentRegistration(twice.ctx)
  const twiceTree = await loadedBody(twice.renderer, twiceRegistration, {
    pressure,
    input: emptyInput,
    inputActions: twiceActions,
    status: idle,
  })
  const twiceButton = compactButton(twiceTree)
  twiceButton.props.onClick()
  twiceButton.props.onClick()
  assert.deepEqual(twiceCalls, [['setDraft', '/compact'], ['submit']], 'a double click sends /compact once')
})

test('a phase change re-arms the Compact button after a click', async () => {
  const calls = []
  const inputActions = {
    setDraft(text) {
      calls.push(['setDraft', text])
    },
    submit() {
      calls.push(['submit'])
    },
  }
  const idle = new Map([['s1', { running: false }]])
  const pressure = { projectedTokens: 84_100, contextWindow: 200_000 }
  const emptyInput = { draft: '', attachmentIds: [], phase: 'plain' }
  const { renderer, ctx } = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply({ ok: false }) })
  const registration = environmentRegistration(ctx)
  const options = { pressure, input: emptyInput, inputActions, status: idle }

  let tree = await loadedBody(renderer, registration, options)
  compactButton(tree).props.onClick()
  assert.deepEqual(calls, [['setDraft', '/compact'], ['submit']], 'the first click sends')

  tree = renderBody(renderer, registration, { ...options, input: { ...emptyInput, phase: 'sending' } })
  assert.equal(compactButton(tree).props.disabled, true, 'the button is disabled during the send')
  tree = renderBody(renderer, registration, options)
  compactButton(tree).props.onClick()
  assert.deepEqual(
    calls,
    [
      ['setDraft', '/compact'],
      ['submit'],
      ['setDraft', '/compact'],
      ['submit'],
    ],
    'the phase change re-arms the button within the 2 s window',
  )
})

test('the body calls the message-box hooks on every render, whatever the session', () => {
  const calls = []
  const input = { draft: '', attachmentIds: [], phase: 'plain' }
  const status = new Map([['s1', { running: false }]])
  const { renderer, ctx } = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply({ ok: false }) })
  const registration = environmentRegistration(ctx)
  const options = {
    inputActions: { setDraft() {}, submit() {} },
    useInput: selector => {
      calls.push('input')
      return selector(input)
    },
    useSessionStatus: selector => {
      calls.push('status')
      return selector(status)
    },
  }
  renderBody(renderer, registration, { sessionId: '', ...options })
  assert.deepEqual(calls, ['input', 'status'], 'an empty session still calls both hooks, in order')
  calls.length = 0
  renderBody(renderer, registration, { sessionId: 's1', ...options })
  assert.deepEqual(calls, ['input', 'status'], 'the session arriving keeps the same hook order')
  assert.deepEqual(renderer.errors(), [], 'no hook-order error across the session change')
})

test('the Compact footer subscribes to primitives, so a keystroke does not re-render the tab', async () => {
  const inputStore = makeInputStore({ draft: 'a', attachmentIds: [], phase: 'plain' })
  const statusStore = makeStatusStore(
    new Map([
      ['s1', { running: false }],
      ['s2', { running: false }],
    ]),
  )
  const { renderer, ctx } = mountBundle({ answer: () => reply(PLAIN_ANSWER), contextAnswer: () => reply({ ok: false }) })
  const registration = environmentRegistration(ctx)
  const options = {
    inputActions: { setDraft() {}, submit() {} },
    useInput: inputStore.useInput,
    useSessionStatus: statusStore.useSessionStatus,
  }
  const pressure = { projectedTokens: 84_100, contextWindow: 200_000 }
  await loadedBody(renderer, registration, { pressure, ...options })
  const renders = inputStore.renders()
  assert.equal(inputStore.selected(), 'draft', 'the input subscription is a primitive signal')

  inputStore.setState({ draft: 'ab', attachmentIds: [], phase: 'plain' })
  if (inputStore.changed()) renderBody(renderer, registration, { pressure, ...options })
  assert.equal(inputStore.renders(), renders, 'another character in a non-empty draft does not re-render the body')

  inputStore.setState({ draft: '', attachmentIds: [], phase: 'sending' })
  assert.equal(inputStore.changed(), true, 'leaving the plain phase changes the input signal')
  renderBody(renderer, registration, { pressure, ...options })

  assert.equal(statusStore.selected(), false, 'the status subscription is a boolean')
  statusStore.setState(
    new Map([
      ['s1', { running: false }],
      ['s2', { running: true }],
    ]),
  )
  assert.equal(statusStore.changed(), false, 'another session starting does not re-render this tab')
  statusStore.setState(
    new Map([
      ['s1', { running: true }],
      ['s2', { running: true }],
    ]),
  )
  assert.equal(statusStore.changed(), true, 'this session starting changes the status signal')
})

test('the fallback breakdown splits the used tokens exactly', () => {
  const parts = loadEnvironmentParts()
  assert.equal(typeof parts.scaledBreakdown, 'function', 'features/environment/client/environment.js must define a pure scaledBreakdown()')
  assert.equal(parts.scaledBreakdown(undefined, 100), null, 'no breakdown is no split')
  assert.equal(
    parts.scaledBreakdown({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 }, 100),
    null,
    'an empty breakdown is no split',
  )
  assert.deepEqual(parts.scaledBreakdown({ systemTokens: 10_000, toolsTokens: 20_000, messageTokens: 70_000 }, 84_100), [
    { name: 'System prompt', tokens: 8_410 },
    { name: 'Tool definitions', tokens: 16_820 },
    { name: 'Messages', tokens: 58_870 },
  ])
  assert.deepEqual(
    parts.scaledBreakdown({ systemTokens: 1, toolsTokens: 1, messageTokens: 0 }, 1),
    [
      { name: 'System prompt', tokens: 1 },
      { name: 'Tool definitions', tokens: 0 },
      { name: 'Messages', tokens: 0 },
    ],
    'the tied largest remainder goes to the first row and the rows add up to one',
  )

  let seed = 123456789
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let index = 0; index < 300; index += 1) {
    const counts = [
      Math.floor(random() * 1_000_000),
      Math.floor(random() * 1_000_000),
      Math.floor(random() * 1_000_000),
    ]
    const used = Math.floor(random() * 2_000_000)
    const rows = parts.scaledBreakdown(
      { systemTokens: counts[0], toolsTokens: counts[1], messageTokens: counts[2] },
      used,
    )
    const total = counts[0] + counts[1] + counts[2]
    if (total === 0) {
      assert.equal(rows, null, 'a zero composition is no split')
      continue
    }
    assert.equal(
      rows.reduce((sum, row) => sum + row.tokens, 0),
      used,
      'the rows add up exactly to the used tokens',
    )
    assert.ok(
      rows.every(row => Number.isInteger(row.tokens) && row.tokens >= 0),
      'every row is a whole, non-negative count',
    )
    for (const [rowIndex, row] of rows.entries()) {
      const exact = (counts[rowIndex] / total) * used
      assert.ok(Math.abs(row.tokens - exact) < 1, 'each row is a floor or one more of its exact share')
    }
  }
})

test('connector state words are hidden from screen readers', async () => {
  const { renderer, ctx } = mountBundle({ answer: () => reply(CONNECTOR_STATES_ANSWER) })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  toggleButton(tree, 'Show more').props.onClick()
  tree = renderBody(renderer, registration)

  const rowsWithState = connectorRows(tree).filter(row => connectorParts(row).right !== null)
  assert.ok(rowsWithState.length >= 4, 'the fixture renders several state words')
  for (const row of rowsWithState) {
    const parts = connectorParts(row)
    assert.equal(
      parts.rightAriaHidden,
      'true',
      parts.name + ': the visible state word is hidden from screen readers',
    )
    assert.equal(
      parts.hiddenAriaHidden,
      undefined,
      parts.name + ': the details span stays available to screen readers',
    )
  }

  const visible = visibleTextOf(sectionBody(tree, 'connectors'))
  for (const word of ['Connecting…', 'Sign in', 'Failed', 'Off']) {
    assert.ok(visible.includes(word), 'a sighted user still sees ' + word)
  }
})

/* ------------------------------------------------------------------ */
/* A.1: Reconnect on failed and closed managed connectors              */
/* ------------------------------------------------------------------ */

test('failed and closed managed connectors offer Reconnect', async () => {
  const { renderer, ctx } = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: async () => {},
  })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  assert.equal(connectorRows(tree).length, 3, 'the fixture starts with its first three rows')

  const failed = reconnectButton(tree, 'linear')
  assert.ok(failed, 'a failed managed connector offers Reconnect')
  assert.equal(failed.props.type, 'button', 'Reconnect is a real button')
  assert.equal(textOf(failed), 'Reconnect', 'the button says Reconnect')
  assert.equal(failed.props['aria-label'], 'Reconnect linear', 'its accessible name is Reconnect <name>')
  assert.equal(failed.props.style.color, WARN, 'Reconnect uses the warn token')
  assert.equal(failed.props.style.fontSize, 12, 'Reconnect is 12 px')
  assert.equal(connectorParts(connectorRowNamed(tree, 'linear')).right, 'Reconnect', 'it replaces Failed')

  const closed = reconnectButton(tree, 'stopped')
  assert.ok(closed, 'a closed managed connector offers Reconnect')
  assert.equal(closed.props['aria-label'], 'Reconnect stopped', 'a closed row names its own connector')
  assert.equal(connectorParts(connectorRowNamed(tree, 'stopped')).right, 'Reconnect', 'it replaces Off')
  assert.equal(
    connectorParts(connectorRowNamed(tree, 'github')).right,
    null,
    'a connected connector offers nothing at the right',
  )

  toggleButton(tree, 'Show more').props.onClick()
  tree = renderBody(renderer, registration)
  assert.equal(connectorRows(tree).length, RECONNECT_ANSWER.connectors.length, 'Show more reveals every row')
  for (const name of ['pinned-failed', 'connecting', 'reconnecting', 'credentials', 'disabled']) {
    assert.equal(reconnectButton(tree, name), null, name + ' offers no Reconnect')
  }
  assert.equal(
    connectorParts(connectorRowNamed(tree, 'github')).right,
    null,
    'a connected row keeps its empty right side',
  )
  assert.equal(connectorParts(connectorRowNamed(tree, 'connecting')).right, 'Connecting…', 'connecting keeps its word')
  assert.equal(connectorParts(connectorRowNamed(tree, 'reconnecting')).right, 'Connecting…', 'reconnecting keeps its word')
  assert.equal(connectorParts(connectorRowNamed(tree, 'credentials')).right, 'Sign in', 'credentials keep Sign in')
  assert.equal(connectorParts(connectorRowNamed(tree, 'disabled')).right, 'Off', 'a disabled row keeps Off')
  const visible = visibleTextOf(sectionBody(tree, 'connectors'))
  for (const word of ['Connecting…', 'Sign in', 'Off']) {
    assert.ok(visible.includes(word), 'a sighted user still sees ' + word)
  }
  assert.equal(visible.includes('Failed'), false, 'a failed row shows the action instead of the state word')

  const plain = mountBundle({ answer: () => reply(RECONNECT_ANSWER) })
  const plainRegistration = environmentRegistration(plain.ctx)
  let plainTree = await loadedBody(plain.renderer, plainRegistration)
  toggleButton(plainTree, 'Show more').props.onClick()
  plainTree = renderBody(plain.renderer, plainRegistration)
  assert.equal(reconnectButtons(plainTree).length, 0, 'without restartConnector no row offers Reconnect')
  assert.equal(
    connectorParts(connectorRowNamed(plainTree, 'linear')).right,
    'Failed',
    'without restartConnector a failed row keeps Failed',
  )
  assert.equal(
    connectorParts(connectorRowNamed(plainTree, 'stopped')).right,
    'Off',
    'without restartConnector a closed row keeps Off',
  )
})

test('Reconnect restarts once, refreshes, and shows its error', async () => {
  const calls = []
  const pending = deferred()
  const { renderer, ctx, network } = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: name => {
      calls.push(name)
      return pending.promise
    },
  })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  const asked = network.calls.length
  let button = reconnectButton(tree, 'linear')
  assert.ok(button, 'the failed row offers the action')
  button.props.onClick()
  button.props.onClick()
  assert.deepEqual(calls, ['linear'], 'a second click while pending restarts nothing')
  assert.deepEqual(renderer.errors(), [], 'the action throws nothing')
  tree = renderBody(renderer, registration)
  button = reconnectButton(tree, 'linear')
  assert.equal(textOf(button), 'Reconnecting…', 'the pending row says Reconnecting…')
  assert.equal(button.props.style.color, SECONDARY, 'the pending text is secondary')
  assert.equal(button.props['aria-disabled'], 'true', 'the pending button is marked disabled')
  assert.equal(button.props.disabled, undefined, 'the pending button stays focusable')
  button.props.onClick()
  assert.deepEqual(calls, ['linear'], 'a click on the pending button still restarts nothing')

  pending.resolve()
  await settle()
  tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  assert.equal(network.calls.length, asked + 1, 'a resolve asks the Environment route at once')
  assert.equal(reconnectButton(tree, 'linear').props['aria-disabled'], undefined, 'the button is enabled again')

  // A rejection shows the service's message under the row and re-enables the action.
  const rejected = deferred()
  const failing = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: () => rejected.promise,
  })
  const failingRegistration = environmentRegistration(failing.ctx)
  let failingTree = await loadedBody(failing.renderer, failingRegistration)
  reconnectButton(failingTree, 'linear').props.onClick()
  failingTree = renderBody(failing.renderer, failingRegistration)
  rejected.reject(new Error('cleanup for "linear" is incomplete; restart the Host'))
  await settle()
  failingTree = renderBody(failing.renderer, failingRegistration)
  const status = connectorStatusMessages(failingTree)
  assert.equal(status.length, 1, 'the failure is one status message')
  assert.equal(textOf(status[0]), 'cleanup for "linear" is incomplete; restart the Host')
  assert.equal(status[0].props.style.color, ERROR, 'the message uses the error token')
  assert.equal(status[0].props.style.fontSize, 12, 'the message is 12 px')
  const again = reconnectButton(failingTree, 'linear')
  assert.equal(again.props['aria-disabled'], undefined, 'a rejected restart re-enables the button')
  assert.equal(textOf(again), 'Reconnect', 'the button says Reconnect again')

  // The next poll with a new state clears the message.
  failing.network.setAnswer(() =>
    reply({
      ...RECONNECT_ANSWER,
      connectors: RECONNECT_ANSWER.connectors.map(connector =>
        connector.name === 'linear' ? { ...connector, state: 'connecting', attempt: 1 } : connector,
      ),
    }),
  )
  failing.timers.fire(failing.timers.pending('interval')[0])
  await settle()
  failingTree = renderBody(failing.renderer, failingRegistration)
  assert.deepEqual(connectorStatusMessages(failingTree), [], 'a new state clears the message')
  assert.equal(reconnectButton(failingTree, 'linear'), null, 'a connecting row offers no Reconnect')

  // A row that leaves the list drops its message, and a returning row does not bring it back.
  failing.network.setAnswer(() => reply(RECONNECT_ANSWER))
  failing.timers.fire(failing.timers.pending('interval')[0])
  await settle()
  failingTree = renderBody(failing.renderer, failingRegistration)
  reconnectButton(failingTree, 'linear').props.onClick()
  await settle()
  failingTree = renderBody(failing.renderer, failingRegistration)
  assert.equal(connectorStatusMessages(failingTree).length, 1, 'a second failure shows its message again')
  failing.network.setAnswer(() =>
    reply({
      ...RECONNECT_ANSWER,
      connectors: RECONNECT_ANSWER.connectors.filter(connector => connector.name !== 'linear'),
    }),
  )
  failing.timers.fire(failing.timers.pending('interval')[0])
  await settle()
  failingTree = renderBody(failing.renderer, failingRegistration)
  assert.deepEqual(connectorStatusMessages(failingTree), [], 'a row that disappears drops its message')
  failing.network.setAnswer(() => reply(RECONNECT_ANSWER))
  failing.timers.fire(failing.timers.pending('interval')[0])
  await settle()
  failingTree = renderBody(failing.renderer, failingRegistration)
  assert.deepEqual(connectorStatusMessages(failingTree), [], 'a returning row does not bring the old message back')

  // A long failure message is bounded to 200 characters.
  const long = 'e'.repeat(260)
  const longMount = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: async () => {
      throw new Error(long)
    },
  })
  const longRegistration = environmentRegistration(longMount.ctx)
  let longTree = await loadedBody(longMount.renderer, longRegistration)
  reconnectButton(longTree, 'linear').props.onClick()
  await settle()
  longTree = renderBody(longMount.renderer, longRegistration)
  const longStatus = connectorStatusMessages(longTree)
  assert.equal(longStatus.length, 1, 'the long failure is one status message')
  assert.equal(textOf(longStatus[0]), long.slice(0, 200), 'the message is bounded to 200 characters')
})

test('the Environment feature takes remote.mcpManager optionally', async () => {
  const calls = []
  const restart = async name => {
    calls.push(name)
  }
  const mounted = mountBundle({ answer: () => reply(RECONNECT_ANSWER), restart })
  const scoped = mounted.ctx.__scopedInjections.filter(entry => entry.deps[0] === 'remote')
  assert.equal(scoped.length, 2, 'the mount takes one scoped injection per optional action')
  assert.deepEqual(
    [...scoped[0].deps],
    ['remote', 'remote.mcpManager'],
    'it declares the Remote namespace and the MCP manager service it reads',
  )
  assert.deepEqual(
    [...scoped[1].deps],
    ['remote', 'remote.credentials'],
    'it declares the Remote namespace and the credential service it reads',
  )
  assert.equal(
    mounted.plugin.inject.includes('remote.mcpManager'),
    false,
    'the service is not in the bundle-wide required inject list',
  )
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.ok(Array.isArray(pkg.dsh?.client?.inject), 'dsh.client.inject is a list')
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'),
    'the manifest ships the Remote namespace package',
  )

  const registration = environmentRegistration(mounted.ctx)
  const injected = registration.spec.inject()
  assert.equal(typeof injected.restartConnector, 'function', 'the body receives restartConnector')
  assert.equal(typeof injected.saveCredential, 'function', 'the body receives saveCredential')
  await injected.restartConnector('linear')
  assert.deepEqual(calls, ['linear'], 'restartConnector calls remote.mcpManager.restart(name)')

  let tree = await loadedBody(mounted.renderer, registration)
  assert.ok(reconnectButton(tree, 'linear'), 'the body offers Reconnect while the service exists')

  scoped[0].dispose()
  // The handle is fixed at mount (the slot may evaluate inject() once); it reports the service gone.
  assert.equal(
    registration.spec.inject().restartConnector.available(),
    false,
    'the handle reports that remote.mcpManager went away',
  )
  tree = await loadedBody(mounted.renderer, registration)
  toggleButton(tree, 'Show more').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(reconnectButtons(tree).length, 0, 'no row offers Reconnect without the service')
  assert.equal(
    registration.spec.inject().saveCredential.available(),
    false,
    'the credential handle reports no service when remote.credentials is absent',
  )

  const bare = mountBundle({ answer: () => reply(RECONNECT_ANSWER), noInject: true })
  assert.equal(typeof bare.ctx.inject, 'undefined', 'a client context without scoped injection is modeled')
  const bareRegistration = environmentRegistration(bare.ctx)
  tree = await loadedBody(bare.renderer, bareRegistration)
  toggleButton(tree, 'Show more').props.onClick()
  tree = renderBody(bare.renderer, bareRegistration)
  assert.equal(reconnectButtons(tree).length, 0, 'a host without ctx.inject keeps the read-only rows')
  assert.deepEqual(bare.renderer.errors(), [], 'the missing scoped injection does not crash the mount')
})

test('the service appearing after mount repaints and offers Reconnect', async () => {
  const calls = []
  const { renderer, ctx } = mountBundle({ answer: () => reply(RECONNECT_ANSWER) })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  assert.equal(reconnectButton(tree, 'linear'), null, 'without the service no row offers Reconnect')

  ctx.__setRestartService(name => {
    calls.push(name)
    return Promise.resolve()
  })
  tree = renderBody(renderer, registration)
  assert.ok(reconnectButton(tree, 'linear'), 'the body repaints and offers Reconnect when the service appears')
  assert.deepEqual(calls, [], 'the appearance alone never restarts a connector')

  reconnectButton(tree, 'linear').props.onClick()
  assert.deepEqual(calls, ['linear'], 'a click after the service appeared restarts once')
})

test('the service going drops the action and a stale click does nothing', async () => {
  const calls = []
  const { renderer, ctx } = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: name => {
      calls.push(name)
      return Promise.resolve()
    },
  })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  const stale = reconnectButton(tree, 'linear')
  assert.ok(stale, 'the row offers Reconnect while the service exists')

  ctx.__setRestartService(null)
  tree = renderBody(renderer, registration)
  assert.equal(reconnectButton(tree, 'linear'), null, 'the body stops offering Reconnect when the service goes')
  assert.equal(
    connectorParts(connectorRowNamed(tree, 'linear')).right,
    'Failed',
    'the row shows its failed state again',
  )
  stale.props.onClick()
  tree = renderBody(renderer, registration)
  assert.deepEqual(calls, [], 'a stale click does not call restart')
  assert.deepEqual(connectorStatusMessages(tree), [], 'a stale click shows no error')
  assert.deepEqual(renderer.errors(), [], 'a stale click throws nothing')
})

test('a Reconnect click held since the row recovered restarts nothing', async () => {
  const calls = []
  const mounted = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: name => {
      calls.push(name)
      return Promise.resolve()
    },
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  const stale = reconnectButton(tree, 'linear')
  assert.ok(stale, 'the failed row offers Reconnect')

  // A poll recovers the row while the click is held; the button the user pressed is stale.
  mounted.network.setAnswer(() =>
    reply({
      ...RECONNECT_ANSWER,
      connectors: RECONNECT_ANSWER.connectors.map(connector =>
        connector.name === 'linear' ? { ...connector, state: 'connected' } : connector,
      ),
    }),
  )
  mounted.timers.fire(mounted.timers.pending('interval')[0])
  await settle()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(reconnectButton(tree, 'linear'), null, 'the recovered row offers no Reconnect')

  stale.props.onClick()
  await settle()
  assert.deepEqual(calls, [], 'the held click does not restart a recovered row')
  assert.deepEqual(connectorStatusMessages(tree), [], 'it shows no error')
  assert.deepEqual(mounted.renderer.errors(), [], 'the held click throws nothing')
})

test('restartConnector rejects when the MCP manager is gone', async () => {
  const mounted = mountBundle({ answer: () => reply(RECONNECT_ANSWER), restart: async () => {} })
  const handle = environmentRegistration(mounted.ctx).spec.inject().restartConnector
  assert.equal(handle.available(), true, 'the handle starts with the manager available')
  mounted.ctx.__setRestartService(null)
  assert.equal(handle.available(), false, 'the handle reports the manager gone')
  // The error crosses the vm context, so match its message rather than its realm's class.
  await assert.rejects(() => handle('linear'), /the MCP manager is not available/u)
})

test('the mount does not pass ctx.inject\'s return value to ctx.effect', async () => {
  const mounted = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: async () => {},
    credentials: async () => {},
  })
  const entries = mounted.ctx.__scopedInjections
  assert.equal(entries.length, 3, 'one scoped injection per optional action (two Environment actions, the Run button\'s webTerminals) was made')
  for (const entry of entries) {
    assert.equal(entry.fromEffect, false, 'ctx.inject is called from mount, not from an effect callback')
    assert.equal(
      mounted.ctx.__effects.some(effect => effect.result === entry.fiber),
      false,
      'no ctx.effect callback returns the injection fiber',
    )
  }
  assert.deepEqual(ownWarnings(mounted.warnings), [], 'the mount does not warn about an invalid effect')
})

test('saveCredential rejects when the credential service is gone', async () => {
  const calls = []
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: (name, value) => {
      calls.push([name, value])
    },
  })
  const handle = environmentRegistration(mounted.ctx).spec.inject().saveCredential
  assert.equal(handle.available(), true, 'the handle starts with the credential service available')
  await handle('LINEAR_TOKEN', 'token-value')
  assert.deepEqual(calls, [['LINEAR_TOKEN', 'token-value']], 'the handle calls remote.credentials.set')
  mounted.ctx.__setCredentialService(null)
  assert.equal(handle.available(), false, 'the handle reports the service gone')
  await assert.rejects(() => handle('LINEAR_TOKEN', 'token-value'), /credential storage is not available/u)
})

test('restart is never called without a click', async () => {
  const calls = []
  const { renderer, ctx, timers, network } = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: async name => {
      calls.push(name)
    },
  })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  toggleButton(tree, 'Show more').props.onClick()
  tree = renderBody(renderer, registration)
  assert.ok(reconnectButton(tree, 'linear'), 'the failed row offers the action')

  refreshButton(tree).props.onClick()
  await settle()
  tree = renderBody(renderer, registration)
  for (const interval of timers.pending('interval')) timers.fire(interval)
  await settle()
  tree = renderBody(renderer, registration)

  network.setAnswer(() =>
    reply({
      ...RECONNECT_ANSWER,
      connectors: RECONNECT_ANSWER.connectors.map(connector =>
        connector.name === 'linear' ? { ...connector, error: 'socket closed' } : connector,
      ),
    }),
  )
  for (const interval of timers.pending('interval')) timers.fire(interval)
  await settle()
  tree = renderBody(renderer, registration)
  assert.ok(reconnectButton(tree, 'linear'), 'the failed row still offers the action after its state changed')
  assert.deepEqual(calls, [], 'no restart happened on mount, refresh, poll or a state change')
})

test('a failure message leaves the Reconnect button at the same tree position', async () => {
  const rejected = deferred()
  const { renderer, ctx } = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: () => rejected.promise,
  })
  const registration = environmentRegistration(ctx)
  const isLinearButton = node => node.type === 'button' && node.props['aria-label'] === 'Reconnect linear'
  let tree = await loadedBody(renderer, registration)
  const before = keyPathOf(tree, isLinearButton)
  assert.ok(before, 'the row offers Reconnect before the failure')

  reconnectButton(tree, 'linear').props.onClick()
  tree = renderBody(renderer, registration)
  rejected.reject(new Error('restart refused'))
  await settle()
  tree = renderBody(renderer, registration)
  assert.equal(connectorStatusMessages(tree).length, 1, 'the failure message is shown')
  const after = keyPathOf(tree, isLinearButton)
  assert.deepEqual(after, before, 'the button keeps its key path when the message appears')
})

test('a service appearing between render and subscribe repaints without a poll', async () => {
  let available = false
  const stable = () => Promise.resolve()
  stable.available = () => available
  stable.subscribe = () => () => {}
  const mounted = mountBundle({ answer: () => reply(RECONNECT_ANSWER) })
  const registration = environmentRegistration(mounted.ctx)
  registration.spec.inject = () => ({ restartConnector: stable })
  let tree = await loadedBody(mounted.renderer, registration)
  assert.equal(reconnectButton(tree, 'linear'), null, 'no action while the handle reports unavailable')

  const calls = []
  let racyAvailable = false
  const racy = name => {
    calls.push(name)
    return Promise.resolve()
  }
  racy.available = () => racyAvailable
  racy.subscribe = () => {
    racyAvailable = true
    return () => {}
  }
  registration.spec.inject = () => ({ restartConnector: racy })
  tree = renderBody(mounted.renderer, registration)
  assert.equal(racyAvailable, true, 'the service appeared while the body subscribed')
  assert.ok(reconnectButton(tree, 'linear'), 'the body repaints with Reconnect without waiting for a poll')
  assert.deepEqual(calls, [], 'the appearance alone never restarts')
})

test('a later successful restart clears the previous error', async () => {
  const rejected = deferred()
  let fail = true
  const { renderer, ctx } = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: () => (fail ? rejected.promise : Promise.resolve()),
  })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  reconnectButton(tree, 'linear').props.onClick()
  await settle()
  tree = renderBody(renderer, registration)
  rejected.reject(new Error('first failure'))
  await settle()
  tree = renderBody(renderer, registration)
  assert.equal(connectorStatusMessages(tree).length, 1, 'the failed click left its message')

  fail = false
  reconnectButton(tree, 'linear').props.onClick()
  await settle()
  tree = renderBody(renderer, registration)
  assert.deepEqual(connectorStatusMessages(tree), [], 'a successful click clears the message')
  assert.equal(reconnectButton(tree, 'linear').props['aria-disabled'], undefined, 'the button is enabled again')
})

test('the subscription is released when the body unmounts', async () => {
  let unsubscribed = 0
  const handle = () => Promise.resolve()
  handle.available = () => true
  handle.subscribe = () => () => {
    unsubscribed += 1
  }
  const mounted = mountBundle({ answer: () => reply(RECONNECT_ANSWER) })
  const registration = environmentRegistration(mounted.ctx)
  registration.spec.inject = () => ({ restartConnector: handle })
  const tree = await loadedBody(mounted.renderer, registration)
  assert.ok(reconnectButton(tree, 'linear'), 'the body subscribed while mounted')
  assert.equal(unsubscribed, 0, 'the subscription stays live while mounted')
  mounted.renderer.unmount()
  assert.equal(unsubscribed, 1, 'unmount calls the unsubscribe once')
})

test('a synchronous restart throw is caught and shown like a rejection', async () => {
  const { renderer, ctx } = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: () => {
      throw new Error('sync failure')
    },
  })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  reconnectButton(tree, 'linear').props.onClick()
  tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  const status = connectorStatusMessages(tree)
  assert.equal(status.length, 1, 'the synchronous throw is shown as one status')
  assert.equal(textOf(status[0]), 'sync failure', 'it shows the thrown message')
  assert.equal(reconnectButton(tree, 'linear').props['aria-disabled'], undefined, 'the button is re-enabled')
  assert.deepEqual(renderer.errors(), [], 'the throw does not escape the click handler')
})

test('each connector row keeps an empty live region that fills on failure', async () => {
  const rejected = deferred()
  const { renderer, ctx } = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: () => rejected.promise,
  })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  const regions = connectorStatusRegions(tree)
  assert.equal(regions.length, 3, 'one live region per visible row')
  assert.ok(regions.every(region => textOf(region) === ''), 'the regions start empty')
  assert.ok(
    regions.every(region => region.props.style.height === 0 && region.props.style.margin === 0),
    'an empty region keeps no height and no margin',
  )

  reconnectButton(tree, 'linear').props.onClick()
  tree = renderBody(renderer, registration)
  rejected.reject(new Error('now it fails'))
  await settle()
  tree = renderBody(renderer, registration)
  const filled = connectorStatusRegions(tree).filter(region => textOf(region) !== '')
  assert.equal(filled.length, 1, 'the failure fills one region')
  assert.equal(textOf(filled[0]), 'now it fails', 'it announces the message')
  assert.equal(filled[0].props.style.color, ERROR, 'the message uses the error token')
  assert.equal(connectorStatusRegions(tree).length, 3, 'the other rows keep their empty regions')
})

/* ------------------------------------------------------------------ */
/* L.4: the fixed 320 px column and its narrow strip                   */
/* ------------------------------------------------------------------ */

test('the column is 320 px wide and does not stretch', async () => {
  const resize = makeResizeObservers()
  const { renderer, ctx } = mountBundle({
    answer: () => reply(FULL_ANSWER),
    resizeObserver: resize.FakeResizeObserver,
  })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)

  assert.equal(tree.props.style.width, 320, 'the column is exactly 320 px wide')
  assert.equal(tree.props.style.boxSizing, 'border-box', 'the 14 px padding sits inside the 320 px')
  assert.equal(tree.props.style.padding, '12px 14px', 'the column keeps its 14 px side padding')
  assert.equal(
    tree.props.style.position,
    'relative',
    'the column contains the connectors rows absolutely positioned visually hidden spans',
  )
  assert.equal(
    tree.props.style.flex,
    undefined,
    'the host flex column can shrink the root in height, so its overflow:auto scrolls',
  )
  assert.equal(tree.props.style.maxWidth, '100%', 'a narrower pane can shrink the measured box')
  assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'a wide body renders the four sections')

  assert.equal(resize.observers.length, 1, 'the tab creates one ResizeObserver per mount')
  resize.observers[0].emit(900)
  tree = renderBody(renderer, registration)
  assert.equal(tree.props.style.width, 320, 'a 900 px body still renders the column at 320 px')
  assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'the 900 px body keeps the column')
  assert.equal(
    collect(tree, node => node.props !== undefined && node.props['data-column-strip'] !== undefined).length,
    0,
    'no strip renders in a wide pane',
  )
  assert.equal(renderer.errors().length, 0, 'measuring the wide pane throws nothing')
})

test('a pane narrower than the column shows the strip', async () => {
  const resize = makeResizeObservers()
  const storage = makeStorage({
    data: {
      [COLUMN_KEY]: JSON.stringify({ order: ['changes', 'context', 'environment', 'connectors'], collapsed: {} }),
    },
  })
  const { renderer, ctx } = mountBundle({
    answer: () => reply(FULL_ANSWER),
    resizeObserver: resize.FakeResizeObserver,
    storage,
  })
  const registration = environmentRegistration(ctx)
  const pressure = { projectedTokens: 84_100, contextWindow: 200_000 }
  let tree = renderBody(renderer, registration, { pressure })
  await settle()
  const firstRoot = tree
  tree = renderBody(renderer, registration, { pressure })
  assert.equal(tree.props.style.width, 320, 'a pane wide enough renders the column')
  assert.equal(resize.observers.length, 1, 'the tab creates one ResizeObserver per mount')
  const observer = resize.observers[0]
  assert.equal(observer.targets.length, 1, 'the observer watches exactly one element')
  assert.equal(observer.targets[0], firstRoot.__node, "the observed element is the tab body's own root")

  observer.emit(319)
  tree = renderBody(renderer, registration, { pressure })
  assert.equal(
    collect(tree, node => node.type === 'section' && node.props['data-column-section'] !== undefined).length,
    0,
    'no section renders in a 319 px pane',
  )
  assert.equal(
    collect(tree, node => node.type === 'button' && textOf(node).trim() === 'Refresh').length,
    0,
    'the Refresh row belongs to the column, not to the strip',
  )
  assert.equal(
    tree.props.style.width,
    '100%',
    'the narrow root keeps spanning its pane, so the observer can still see it widen',
  )
  const strip = narrowStrip(tree)
  assert.equal(strip.props.style.width, 40, 'the strip is 40 px wide')
  assert.equal(strip.props.role, 'group', 'the strip is a labeled group')
  assert.equal(strip.props['aria-label'], 'Sections', 'the group names what it holds')
  assert.equal(strip.props.tabIndex, -1, 'the strip can take focus when the column disappears')
  const icons = stripIcons(tree)
  assert.equal(icons.length, 4, 'the strip shows one icon per section')
  assert.deepEqual(
    icons.map(icon => icon.props['aria-label']),
    ['Changes', 'Context, 42% used', 'Environment', 'Connectors'],
    'the icons follow the saved order and name their sections',
  )
  for (const icon of icons) {
    assert.equal(icon.type, 'span', 'a strip icon is a plain element, not a button')
    assert.equal(icon.props.role, 'img', 'the icon carries its section name as an image label')
    assert.equal(icon.props.title, icon.props['aria-label'], 'each icon repeats its name in the title')
    assert.equal(icon.props.style.width, 32, 'each icon box is 32 px wide')
    assert.equal(icon.props.style.height, 32, 'each icon box is 32 px tall')
    assert.equal(icon.props.onClick, undefined, 'a strip icon starts nothing')
  }
  const tab = ctx.__tabTypes.find(definition => definition.id === TAB_ID)
  const guideIcon = tab.guide[0].icon({ size: 16 })
  const environmentIcon = icons.find(icon => icon.props['aria-label'] === 'Environment')
  assert.deepEqual(
    environmentIcon.children[0],
    guideIcon,
    "the strip's Environment icon is the tab's guide icon, not the laptop",
  )
  const percent = stripPercent(tree)
  assert.equal(textOf(percent), '42%', 'the Context percent sits under its icon')
  assert.equal(percent.props.style.color, SECONDARY, 'the strip percent is secondary text')
  assert.equal(percent.props['aria-hidden'], 'true', 'the icon label already carries the percent')
  assert.equal(strip.children[1].props['data-strip-section'], 'context', 'the percent follows the Context icon')

  observer.emit(320)
  tree = renderBody(renderer, registration, { pressure })
  assert.equal(tree.props.style.width, 320, 'a 320 px pane brings the 320 px column back')
  assert.deepEqual(
    headerIds(tree),
    ['changes', 'context', 'environment', 'connectors'],
    'a 320 px pane brings the saved column back',
  )
  assert.equal(
    collect(tree, node => node.props !== undefined && node.props['data-column-strip'] !== undefined).length,
    0,
    'the strip is gone at 320 px',
  )

  assert.equal(resize.observers.length, 1, 'the observer is created once per mount')
  assert.equal(observer.targets.length, 1, 'the observer still watches only the root element')
  assert.equal(observer.disconnected, false, 'the observer stays connected while mounted')
  renderer.unmount()
  assert.equal(observer.disconnected, true, 'unmount disconnects the observer')

  const bare = mountBundle({ answer: () => reply(FULL_ANSWER) })
  tree = await loadedBody(bare.renderer, environmentRegistration(bare.ctx))
  assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'without a ResizeObserver the column always shows')
  assert.deepEqual(bare.renderer.errors(), [], 'a missing ResizeObserver throws nothing')
})

test('the strip keeps the data flowing', async () => {
  const resize = makeResizeObservers()
  const { renderer, ctx, network, timers } = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    contextAnswer: () => reply(CLAUDE_CONTEXT_ANSWER),
    resizeObserver: resize.FakeResizeObserver,
    rootWidth: 319,
  })
  const registration = environmentRegistration(ctx)
  const pressure = used => ({ projectedTokens: used, contextWindow: 100_000 })
  let tree = renderBody(renderer, registration, { pressure: pressure(42_000) })
  assert.equal(stripIcons(tree).length, 4, 'a 319 px mount paints the strip before any observer callback')
  await settle()
  tree = renderBody(renderer, registration, { pressure: pressure(42_000) })
  assert.equal(stripIcons(tree).length, 4, 'the tab stays narrow on the first answer')
  assert.equal(network.calls.length, 1, 'the Environment route is still polled in narrow mode')
  assert.equal(
    network.contextCalls.length,
    0,
    'the oh-my-claude route is not asked while the Context section is not visible',
  )
  assert.equal(
    stripIcons(tree)[1].props['aria-label'],
    'Context, 42% used',
    'the strip starts at the projected percent',
  )

  timers.fire(timers.pending('interval')[0])
  await settle()
  assert.equal(network.calls.length, 2, 'the 12 s poll keeps running in narrow mode')
  assert.equal(network.contextCalls.length, 0, 'a poll tick asks nothing of oh-my-claude in narrow mode')

  tree = renderBody(renderer, registration, { pressure: pressure(84_000) })
  assert.equal(
    stripIcons(tree)[1].props['aria-label'],
    'Context, 84% used',
    'a contextPressure change moves the strip label',
  )
  assert.equal(textOf(stripPercent(tree)), '84%', 'a contextPressure change moves the percent under the icon')
  assert.equal(network.contextCalls.length, 0, 'the projection change asks no route')
  assert.equal(renderer.errors().length, 0, 'the narrow mode throws nothing')
})

test('a narrow mount is the strip on its first render and asks no route', async () => {
  const resize = makeResizeObservers()
  const { renderer, ctx, network } = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    contextAnswer: () => reply(CLAUDE_CONTEXT_ANSWER),
    resizeObserver: resize.FakeResizeObserver,
    rootWidth: 300,
  })
  const registration = environmentRegistration(ctx)
  const pressure = { projectedTokens: 20_000, contextWindow: 100_000 }
  const tree = renderBody(renderer, registration, { pressure })

  assert.equal(
    stripIcons(tree).length,
    4,
    'the mount measures synchronously, so the tree before paint is already the strip',
  )
  assert.equal(network.calls.length, 1, 'the Environment route is asked once at mount')
  assert.equal(
    network.contextCalls.length,
    0,
    'a narrow mount never asks the oh-my-claude route, even with Context open',
  )
  assert.equal(resize.observers.length, 1, 'the observer is created after the first measurement')
  assert.equal(observerTargetWidth(resize), 300, 'the observer is installed on the measured root')
  await settle()
  const answered = renderBody(renderer, registration, { pressure })
  assert.equal(stripIcons(answered).length, 4, 'the first answer keeps the strip')
  assert.equal(network.contextCalls.length, 0, 'the first poll tick asks no route in narrow mode')
  assert.deepEqual(renderer.errors(), [], 'the narrow mount throws nothing')
})

test('widening back asks the route at once and never shows the old answer', async () => {
  const resize = makeResizeObservers()
  const held = deferred()
  let contextReads = 0
  const { renderer, ctx, network } = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    contextAnswer: () => {
      contextReads += 1
      return contextReads === 1 ? reply(CLAUDE_CONTEXT_ANSWER) : held.promise
    },
    resizeObserver: resize.FakeResizeObserver,
  })
  const registration = environmentRegistration(ctx)
  const pressure = { projectedTokens: 20_000, contextWindow: 100_000 }
  let tree = renderBody(renderer, registration, { pressure })
  await settle()
  tree = renderBody(renderer, registration, { pressure })
  assert.ok(
    textOf(sectionBody(tree, 'context')).includes('claude-opus-5-5'),
    'the wide mount shows the route answer',
  )
  assert.equal(network.contextCalls.length, 1, 'the wide mount asked the route once')

  resize.observers[0].emit(300)
  tree = renderBody(renderer, registration, { pressure })
  assert.equal(
    stripIcons(tree)[1].props['aria-label'],
    'Context, 20% used',
    'the strip follows contextPressure even while the old route answer is still in state',
  )
  assert.equal(
    collect(tree, node => node.props !== undefined && node.props['data-aria-hidden'] === 'x').length,
    0,
    'no column remains at 300 px',
  )

  resize.observers[0].emit(400)
  tree = renderBody(renderer, registration, { pressure })
  assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'widening brings the column back')
  assert.equal(network.contextCalls.length, 2, 'widening back with Context open asks the route at once')
  assert.equal(
    textOf(contextHeaderSummary(tree)),
    '20%',
    'the header follows contextPressure until the fresh answer arrives',
  )
  assert.ok(
    textOf(sectionBody(tree, 'context')).includes('20% used'),
    'the body follows contextPressure until the fresh answer arrives',
  )

  held.resolve(reply({ ...CLAUDE_CONTEXT_ANSWER, percentage: 55, totalTokens: 550_000 }))
  await settle()
  tree = renderBody(renderer, registration, { pressure })
  assert.equal(textOf(contextHeaderSummary(tree)), '55%', 'the fresh route answer replaces the fallback')
  assert.ok(
    textOf(sectionBody(tree, 'context')).includes('claude-opus-5-5'),
    'the body shows the fresh route answer',
  )
  assert.deepEqual(renderer.errors(), [], 'the widening transition throws nothing')
})

test('a zero width is not a measurement and keeps the current mode', async () => {
  const resize = makeResizeObservers()
  const wide = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    resizeObserver: resize.FakeResizeObserver,
  })
  const wideRegistration = environmentRegistration(wide.ctx)
  let tree = await loadedBody(wide.renderer, wideRegistration)
  assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'a wide mount starts as the column')
  resize.observers[0].emit(0)
  tree = renderBody(wide.renderer, wideRegistration)
  assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'a measured zero keeps the column')
  assert.equal(
    collect(tree, node => node.props !== undefined && node.props['data-column-strip'] !== undefined).length,
    0,
    'a measured zero never shows the strip in a wide mount',
  )

  const narrowResize = makeResizeObservers()
  const narrow = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    resizeObserver: narrowResize.FakeResizeObserver,
    rootWidth: 300,
  })
  const narrowRegistration = environmentRegistration(narrow.ctx)
  tree = await loadedBody(narrow.renderer, narrowRegistration)
  assert.equal(stripIcons(tree).length, 4, 'the narrow mount starts as the strip')
  narrowResize.observers[0].emit(0)
  tree = renderBody(narrow.renderer, narrowRegistration)
  assert.equal(stripIcons(tree).length, 4, 'a measured zero keeps the strip')
  assert.deepEqual(wide.renderer.errors(), [], 'the wide zero-width case throws nothing')
  assert.deepEqual(narrow.renderer.errors(), [], 'the narrow zero-width case throws nothing')
})

test('narrowing moves focus from the column into the strip', async () => {
  const resize = makeResizeObservers()
  const { renderer, ctx, document } = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    resizeObserver: resize.FakeResizeObserver,
  })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  const rootNode = tree.__node
  const focusedHeader = { focus() {} }
  rootNode.contains = candidate => candidate === focusedHeader
  document.activeElement = focusedHeader

  resize.observers[0].emit(300)
  tree = renderBody(renderer, registration)
  const strip = narrowStrip(tree)
  assert.equal(
    strip.__node.focused,
    true,
    'focus moves to the strip container instead of falling to the document body',
  )
  assert.deepEqual(renderer.errors(), [], 'moving focus throws nothing')
})

test('narrowing leaves focus alone when it is outside the tab', async () => {
  const resize = makeResizeObservers()
  const { renderer, ctx, document } = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    resizeObserver: resize.FakeResizeObserver,
  })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  const rootNode = tree.__node
  // The user is typing in the chat: the focused element is not inside the tab.
  const chatInput = { focus() {} }
  rootNode.contains = () => false
  document.activeElement = chatInput

  resize.observers[0].emit(300)
  tree = renderBody(renderer, registration)
  const strip = narrowStrip(tree)
  assert.notEqual(strip.__node.focused, true, 'the strip does not take focus away from the chat')
  assert.equal(document.activeElement, chatInput, 'focus stays where the user left it')
  assert.deepEqual(renderer.errors(), [], 'narrowing throws nothing')
})

/** The border-box width of the one element the fake observer watches. */
function observerTargetWidth(resize) {
  const observer = resize.observers[0]
  return observer.targets[0].getBoundingClientRect().width
}

test('the narrow strip percent ignores a route answer and the column prefers it', () => {
  const parts = loadEnvironmentParts()
  assert.equal(
    typeof parts.contextDisplayPercent,
    'function',
    'features/environment/client/environment.js must define a pure contextDisplayPercent()',
  )
  const options = { narrow: true, open: true, claude: { percent: 42 }, usage: { percent: 20 } }
  assert.equal(parts.contextDisplayPercent(options), 20, 'the strip uses contextPressure, not the route answer')
  assert.equal(
    parts.contextDisplayPercent({ ...options, narrow: false }),
    42,
    'the open column prefers the route answer',
  )
  assert.equal(
    parts.contextDisplayPercent({ ...options, open: false, narrow: false }),
    20,
    'a collapsed column still follows contextPressure',
  )
  assert.equal(parts.contextDisplayPercent({ ...options, usage: null }), null, 'no pressure means no percent')
})

test('an answer requested before the strip appears never lands', async () => {
  const resize = makeResizeObservers()
  const first = deferred()
  const second = deferred()
  let reads = 0
  const { renderer, ctx, network } = mountBundle({
    answer: () => reply(PLAIN_ANSWER),
    contextAnswer: () => {
      reads += 1
      return reads === 1 ? first.promise : second.promise
    },
    resizeObserver: resize.FakeResizeObserver,
  })
  const registration = environmentRegistration(ctx)
  const pressure = { projectedTokens: 20_000, contextWindow: 100_000 }
  let tree = renderBody(renderer, registration, { pressure })
  assert.equal(network.contextCalls.length, 1, 'the wide mount asked the route and is waiting for it')

  resize.observers[0].emit(300)
  tree = renderBody(renderer, registration, { pressure })
  assert.equal(stripIcons(tree).length, 4, 'the strip is up while the request is still pending')
  first.resolve(reply(CLAUDE_CONTEXT_ANSWER))
  await settle()
  tree = renderBody(renderer, registration, { pressure })
  assert.equal(
    stripIcons(tree)[1].props['aria-label'],
    'Context, 20% used',
    'an answer for the wide period does not change the strip',
  )

  resize.observers[0].emit(400)
  tree = renderBody(renderer, registration, { pressure })
  assert.deepEqual(headerIds(tree), DEFAULT_ORDER, 'the column returns')
  assert.equal(network.contextCalls.length, 2, 'widening asks a fresh answer')
  assert.equal(
    textOf(contextHeaderSummary(tree)),
    '20%',
    'the late answer is not reused as the fresh route answer',
  )
  second.resolve(reply({ ...CLAUDE_CONTEXT_ANSWER, percentage: 55, totalTokens: 550_000 }))
  await settle()
  tree = renderBody(renderer, registration, { pressure })
  assert.equal(textOf(contextHeaderSummary(tree)), '55%', 'the fresh answer is shown when it arrives')
  assert.deepEqual(renderer.errors(), [], 'the late answer throws nothing')
})

/* ------------------------------------------------------------------ */
/* A.2: Sign in on connectors waiting for a credential                 */
/* ------------------------------------------------------------------ */

test('Sign in opens a form and stores the credential', async () => {
  const calls = []
  const pending = deferred()
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: (name, value) => {
      calls.push([name, value])
      return pending.promise
    },
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  const asked = mounted.network.calls.length
  const button = signInButton(tree, 'linear')
  assert.ok(button, 'a waiting row with credential names offers Sign in')
  assert.equal(button.props.type, 'button', 'Sign in is a real button')
  assert.equal(button.props.style.color, WARN, 'Sign in uses the warn token')
  assert.equal(button.props.style.fontSize, 12, 'Sign in is 12 px')
  assert.equal(button.props['aria-expanded'], 'false', 'the button starts collapsed')
  assert.equal(connectorParts(connectorRowNamed(tree, 'linear')).right, 'Sign in', 'it replaces the state word')

  button.props.onClick()
  tree = renderBody(mounted.renderer, registration)
  assert.ok(signInForm(tree), 'a click opens the form under the row')
  assert.equal(signInButton(tree, 'linear').props['aria-expanded'], 'true', 'the button reports the form open')
  const inputs = credentialInputs(tree)
  assert.equal(inputs.length, 1, 'the form has one password input per name')
  assert.equal(inputs[0].props.type, 'password', 'the input hides what is typed')
  assert.equal(inputs[0].props.autoComplete, 'off', 'password managers stay out')
  assert.equal(inputs[0].props.spellCheck, false, 'the name is not spell-checked')
  const labels = collect(signInForm(tree), node => node.type === 'label')
  assert.equal(labels.length, 1, 'the input is labeled')
  assert.equal(textOf(labels[0]), 'LINEAR_TOKEN', 'the label is the credential name')
  assert.equal(calls.length, 0, 'opening the form stores nothing')

  inputs[0].props.onChange({ target: { value: 'secret-1' } })
  tree = renderBody(mounted.renderer, registration)
  assert.equal(credentialInputs(tree)[0].props.value, 'secret-1', 'the controlled input shows what was typed')
  formButton(tree, 'Save').props.onClick()
  assert.deepEqual(calls, [['LINEAR_TOKEN', 'secret-1']], 'Save stores the value once')
  tree = renderBody(mounted.renderer, registration)
  assert.equal(credentialInputs(tree)[0].props.value, '', 'the input clears on the attempt, before it settles')
  assert.equal(credentialInputs(tree)[0].props.readOnly, true, 'the form is read-only while saving')
  assert.equal(credentialInputs(tree)[0].props['aria-disabled'], 'true', 'the input is marked disabled')
  assert.equal(credentialInputs(tree)[0].props.disabled, undefined, 'the input stays focusable')
  pending.resolve()
  await settle()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(signInForm(tree), null, 'a successful save closes the form')
  assert.equal(mounted.network.calls.length, asked + 1, 'success asks the Environment route at once')
  assert.deepEqual(mounted.renderer.errors(), [], 'the action throws nothing')

  // An empty Save never reaches the service.
  const before = calls.length
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  formButton(tree, 'Save').props.onClick()
  await settle()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(calls.length, before, 'Save with an empty input calls nothing')
  assert.ok(signInForm(tree), 'the form stays open when there is nothing to save')
})

test('a failed save shows its error and never the secret', async () => {
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: async () => {
      throw new Error('nope')
    },
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  credentialInputs(tree)[0].props.onChange({ target: { value: 'secret-1' } })
  tree = renderBody(mounted.renderer, registration)
  formButton(tree, 'Save').props.onClick()
  await settle()
  tree = renderBody(mounted.renderer, registration)
  const status = connectorStatusMessages(tree)
  assert.equal(status.length, 1, 'the failure is one status message')
  assert.equal(textOf(status[0]), 'nope', 'the service message is shown')
  assert.equal(status[0].props.style.color, ERROR, 'the message uses the error token')
  assert.equal(status[0].props.style.fontSize, 12, 'the message is 12 px')
  assert.equal(credentialInputs(tree)[0].props.value, '', 'the input is cleared after a failure')
  assert.equal(credentialInputs(tree)[0].props.readOnly, false, 'the form is usable again')
  assert.equal(treeHasText(tree, 'secret-1'), false, 'the value appears nowhere in the rendered tree')
  assert.deepEqual(ownWarnings(mounted.warnings), [], 'the failure is not warned')
  assert.deepEqual(mounted.logs, [], 'the failure is not logged')
})

test('Sign in is offered only where it can work', async () => {
  // No credentials service: the waiting row keeps its plain state word.
  const bare = mountBundle({ answer: () => reply(SIGNIN_ANSWER), restart: async () => {} })
  let tree = await loadedBody(bare.renderer, environmentRegistration(bare.ctx))
  assert.equal(signInButtons(tree).length, 0, 'without remote.credentials no row offers Sign in')
  assert.equal(connectorParts(connectorRowNamed(tree, 'linear')).right, 'Sign in', 'the row keeps the word')
  assert.deepEqual(bare.renderer.errors(), [])

  // The service exists but the row carries no credential names.
  const noList = mountBundle({ answer: () => reply(RECONNECT_ANSWER), credentials: async () => {} })
  let noListTree = await loadedBody(noList.renderer, environmentRegistration(noList.ctx))
  toggleButton(noListTree, 'Show more').props.onClick()
  noListTree = renderBody(noList.renderer, environmentRegistration(noList.ctx))
  assert.equal(signInButtons(noListTree).length, 0, 'without a credential list no row offers Sign in')
  assert.equal(
    connectorParts(connectorRowNamed(noListTree, 'credentials')).right,
    'Sign in',
    'a waiting row without names keeps the word',
  )

  // The service appears after mount: the button appears without a poll or a save.
  const calls = []
  const late = mountBundle({ answer: () => reply(SIGNIN_ANSWER) })
  const registration = environmentRegistration(late.ctx)
  tree = await loadedBody(late.renderer, registration)
  assert.equal(signInButton(tree, 'linear'), null, 'no button before the service appears')
  late.ctx.__setCredentialService((name, value) => {
    calls.push([name, value])
    return Promise.resolve()
  })
  tree = renderBody(late.renderer, registration)
  assert.ok(signInButton(tree, 'linear'), 'the body repaints when the service appears')
  assert.deepEqual(calls, [], 'the appearance alone stores nothing')

  // Cancel discards what was typed, closes, and never restarts a connector.
  const restarts = []
  const writes = []
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    restart: name => {
      restarts.push(name)
      return Promise.resolve()
    },
    credentials: (name, value) => {
      writes.push([name, value])
      return Promise.resolve()
    },
  })
  let cancelTree = await loadedBody(mounted.renderer, environmentRegistration(mounted.ctx))
  const failed = connectorRowNamed(cancelTree, 'github')
  assert.equal(connectorParts(failed).right, null, 'a connected row with names keeps its empty right side')
  signInButton(cancelTree, 'linear').props.onClick()
  cancelTree = renderBody(mounted.renderer, environmentRegistration(mounted.ctx))
  credentialInputs(cancelTree)[0].props.onChange({ target: { value: 'discard-me' } })
  cancelTree = renderBody(mounted.renderer, environmentRegistration(mounted.ctx))
  formButton(cancelTree, 'Cancel').props.onClick()
  cancelTree = renderBody(mounted.renderer, environmentRegistration(mounted.ctx))
  assert.equal(signInForm(cancelTree), null, 'Cancel closes the form')
  assert.equal(treeHasText(cancelTree, 'discard-me'), false, 'Cancel clears the input')
  assert.deepEqual(writes, [], 'Cancel stores nothing')
  assert.deepEqual(restarts, [], 'Sign in never calls the MCP manager restart')
})

test('the credential form moves focus to its first input and back to Sign in', async () => {
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: async () => {},
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  const button = signInButton(tree, 'linear')
  assert.ok(button, 'the row offers the action')
  button.props.onClick()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(credentialInputs(tree)[0].__node.focused, true, 'opening focuses the first password input')
  formButton(tree, 'Cancel').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(signInButton(tree, 'linear').__node.focused, true, 'closing returns focus to Sign in')
  assert.deepEqual(mounted.renderer.errors(), [], 'focus handling throws nothing')
})

/* ------------------------------------------------------------------ */
/* Remote result envelopes, error text and form lifecycle              */
/* ------------------------------------------------------------------ */

test('a refused save keeps its error visible and does not refresh', async () => {
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: async () => ({ ok: false, error: { message: 'denied by provider' } }),
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  const asked = mounted.network.calls.length
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  credentialInputs(tree)[0].props.onChange({ target: { value: 'secret-1' } })
  tree = renderBody(mounted.renderer, registration)
  formButton(tree, 'Save').props.onClick()
  await settle()
  tree = renderBody(mounted.renderer, registration)
  const status = connectorStatusMessages(tree)
  assert.equal(status.length, 1, 'a refused save shows one message')
  assert.equal(textOf(status[0]), 'denied by provider', 'the Remote error message is shown')
  assert.ok(signInForm(tree), 'the form stays open after a refusal')
  assert.equal(credentialInputs(tree)[0].props.value, '', 'the value is cleared')
  assert.equal(credentialInputs(tree)[0].props.readOnly, false, 'the form is usable again')
  assert.equal(mounted.network.calls.length, asked, 'a refusal does not refresh the route')
  assert.deepEqual(mounted.renderer.errors(), [])
})

test('a refused restart shows its message like a rejection', async () => {
  const mounted = mountBundle({
    answer: () => reply(RECONNECT_ANSWER),
    restart: async () => ({ ok: false, error: { message: 'restart refused by host' } }),
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  reconnectButton(tree, 'linear').props.onClick()
  await settle()
  tree = renderBody(mounted.renderer, registration)
  const status = connectorStatusMessages(tree)
  assert.equal(status.length, 1, 'a refused restart shows one message')
  assert.equal(textOf(status[0]), 'restart refused by host', 'the Remote error message is shown')
})

test('credential errors are scrubbed before the 200-character bound', async () => {
  const secret = 'SECRET-VALUE'
  const message = 'e'.repeat(194) + secret + 'z'.repeat(80)
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: async () => ({ ok: false, error: { message } }),
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  credentialInputs(tree)[0].props.onChange({ target: { value: secret } })
  tree = renderBody(mounted.renderer, registration)
  formButton(tree, 'Save').props.onClick()
  await settle()
  tree = renderBody(mounted.renderer, registration)
  const text = textOf(connectorStatusMessages(tree)[0])
  assert.equal(text.length, 200, 'the message is still bounded to 200 characters')
  assert.equal(text.includes('SECR'), false, 'not even a 4-character prefix of the straddling secret survives')
  assert.equal(text.endsWith('[redac'), true, 'the cut lands inside the redaction marker, not inside the secret')
  assert.equal(treeHasText(tree, secret), false, 'the value is nowhere in the rendered tree')
})

test('the longest value is scrubbed before its substrings', async () => {
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_MULTI_ANSWER),
    credentials: async () => ({ ok: false, error: { message: 'denied abc and abcdef-XYZ' } }),
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  const inputs = credentialInputs(tree)
  inputs[0].props.onChange({ target: { value: 'abc' } })
  tree = renderBody(mounted.renderer, registration)
  credentialInputs(tree)[1].props.onChange({ target: { value: 'abcdef-XYZ' } })
  tree = renderBody(mounted.renderer, registration)
  formButton(tree, 'Save').props.onClick()
  await settle()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(connectorStatusMessages(tree).length, 1, 'the refusal has a status message')
  const text = textOf(connectorStatusMessages(tree)[0])
  assert.equal(text.includes('abc'), false, 'the short value is gone')
  assert.equal(text.includes('def-XYZ'), false, 'no suffix of the long value survives the short scrub')
})

test('leaving waiting clears the typed value when the row returns', async () => {
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: async () => ({ ok: true }),
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  credentialInputs(tree)[0].props.onChange({ target: { value: 'typed-secret' } })
  tree = renderBody(mounted.renderer, registration)
  mounted.network.setAnswer(() =>
    reply({
      ...SIGNIN_ANSWER,
      connectors: SIGNIN_ANSWER.connectors.map(connector =>
        connector.name === 'linear' ? { ...connector, state: 'connected' } : connector,
      ),
    }),
  )
  mounted.timers.fire(mounted.timers.pending('interval')[0])
  await settle()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(signInForm(tree), null, 'the form closes when the row leaves waiting')
  mounted.network.setAnswer(() => reply(SIGNIN_ANSWER))
  mounted.timers.fire(mounted.timers.pending('interval')[0])
  await settle()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(treeHasText(tree, 'typed-secret'), false, 'the typed value is gone when the row returns')
})

test('the credential service going away clears the typed value', async () => {
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: async () => ({ ok: true }),
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  credentialInputs(tree)[0].props.onChange({ target: { value: 'typed-secret' } })
  tree = renderBody(mounted.renderer, registration)
  mounted.ctx.__setCredentialService(null)
  tree = renderBody(mounted.renderer, registration)
  assert.equal(signInForm(tree), null, 'the form goes with the service')
  mounted.ctx.__setCredentialService(async () => ({ ok: true }))
  tree = renderBody(mounted.renderer, registration)
  assert.equal(treeHasText(tree, 'typed-secret'), false, 'the value does not come back with the service')
})

test('a stale Save after the row stops waiting stores nothing', async () => {
  const calls = []
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: async (name, value) => {
      calls.push([name, value])
      return { ok: true }
    },
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  credentialInputs(tree)[0].props.onChange({ target: { value: 'stale-value' } })
  tree = renderBody(mounted.renderer, registration)
  const staleSave = formButton(tree, 'Save')
  mounted.network.setAnswer(() =>
    reply({
      ...SIGNIN_ANSWER,
      connectors: SIGNIN_ANSWER.connectors.map(connector =>
        connector.name === 'linear' ? { ...connector, state: 'connected' } : connector,
      ),
    }),
  )
  mounted.timers.fire(mounted.timers.pending('interval')[0])
  await settle()
  tree = renderBody(mounted.renderer, registration)
  staleSave.props.onClick()
  await settle()
  assert.deepEqual(calls, [], 'a click held from the old row never reaches the service')
})

test('a second Save or Sign in click during a save is ignored', async () => {
  const calls = []
  const pending = deferred()
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: (name, value) => {
      calls.push([name, value])
      return pending.promise
    },
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  credentialInputs(tree)[0].props.onChange({ target: { value: 'secret-1' } })
  tree = renderBody(mounted.renderer, registration)
  formButton(tree, 'Save').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(signInButton(tree, 'linear').props['aria-disabled'], 'true', 'Sign in is marked disabled while saving')
  assert.equal(signInButton(tree, 'linear').props.disabled, undefined, 'Sign in stays focusable while saving')
  assert.equal(formButton(tree, 'Save').props['aria-disabled'], 'true', 'Save is marked disabled while saving')
  assert.equal(formButton(tree, 'Save').props.disabled, undefined, 'Save stays focusable while saving')
  formButton(tree, 'Save').props.onClick()
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(credentialInputs(tree)[0].props.readOnly, true, 'the form stays in its saving state')
  assert.equal(credentialInputs(tree)[0].props['aria-disabled'], 'true', 'the input stays marked disabled')
  assert.deepEqual(calls, [['LINEAR_TOKEN', 'secret-1']], 'only the first click reached the service')
  pending.resolve()
  await settle()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(signInForm(tree), null, 'one save closed the form')
  assert.deepEqual(calls, [['LINEAR_TOKEN', 'secret-1']], 'no second save was started')
})

test('focus follows the open row and Cancel returns to its button', async () => {
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_TWO_ROWS_ANSWER),
    credentials: async () => ({ ok: true }),
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  signInButton(tree, 'alpha').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(credentialInputs(tree)[0].__node.focused, true, 'alpha takes focus')
  credentialInputs(tree)[0].__node.focused = false
  signInButton(tree, 'beta').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(credentialInputs(tree)[0].__node.focused, true, 'switching rows focuses beta')
  formButton(tree, 'Cancel').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(signInButton(tree, 'beta').__node.focused, true, 'Cancel returns focus to beta')
  assert.equal(signInButton(tree, 'alpha').__node.focused, false, 'alpha does not take it back')
})

test('a second Sign in click on the open row closes and clears the form', async () => {
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: async () => ({ ok: true }),
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  const button = signInButton(tree, 'linear')
  button.props.onClick()
  tree = renderBody(mounted.renderer, registration)
  const form = signInForm(tree)
  assert.ok(form.props.id, 'the form has an id')
  assert.equal(signInButton(tree, 'linear').props['aria-controls'], form.props.id, 'the open Sign in points at its form')
  credentialInputs(tree)[0].props.onChange({ target: { value: 'discard-me' } })
  tree = renderBody(mounted.renderer, registration)
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(signInForm(tree), null, 'a second click closes the form')
  assert.equal(treeHasText(tree, 'discard-me'), false, 'and clears what was typed')
})

test('clearing a typed value back to empty saves nothing', async () => {
  const calls = []
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: async (name, value) => {
      calls.push([name, value])
      return { ok: true }
    },
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  credentialInputs(tree)[0].props.onChange({ target: { value: 'secret-1' } })
  tree = renderBody(mounted.renderer, registration)
  assert.equal(credentialInputs(tree)[0].props.value, 'secret-1', 'the value was typed')
  credentialInputs(tree)[0].props.onChange({ target: { value: '' } })
  tree = renderBody(mounted.renderer, registration)
  assert.equal(credentialInputs(tree)[0].props.value, '', 'the input is empty again')
  formButton(tree, 'Save').props.onClick()
  await settle()
  tree = renderBody(mounted.renderer, registration)
  assert.deepEqual(calls, [], 'an empty value never reaches the service')
  assert.ok(signInForm(tree), 'the form stays open')
})

test('two Save clicks in one render store once', async () => {
  const calls = []
  const pending = deferred()
  const mounted = mountBundle({
    answer: () => reply(SIGNIN_ANSWER),
    credentials: (name, value) => {
      calls.push([name, value])
      return pending.promise
    },
  })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  signInButton(tree, 'linear').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  credentialInputs(tree)[0].props.onChange({ target: { value: 'secret-1' } })
  tree = renderBody(mounted.renderer, registration)
  const save = formButton(tree, 'Save')
  save.props.onClick()
  save.props.onClick()
  assert.deepEqual(calls, [['LINEAR_TOKEN', 'secret-1']], 'the second click in the same render is ignored')
  pending.resolve()
  await settle()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(signInForm(tree), null, 'the one save closed the form')
})

test('Refresh sits in the Environment header row, beside the header button', async () => {
  const mounted = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = environmentRegistration(mounted.ctx)
  const tree = await loadedBody(mounted.renderer, registration)

  const refresh = refreshButton(tree)
  const section = sectionWrapper(tree, 'environment')
  const header = sectionHeader(tree, 'environment')
  assert.equal(collect(section, node => node === refresh).length, 1, 'Refresh lives inside the Environment section')
  assert.equal(collect(header, node => node === refresh).length, 0, 'Refresh is a sibling, not a child, of the header button')
  const rows = collect(
    section,
    node => node.type === 'div' && node.children.includes(header) && node.children.includes(refresh),
  )
  assert.equal(rows.length, 1, 'the header and Refresh share one row')
  assert.equal(rows[0].props.style.display, 'flex', 'the header row is a flex row')
  assert.equal(rows[0].props.style.alignItems, 'center', 'the header row centers its items vertically')
  assert.equal(header.props.style.flex, '1 1 auto', 'the header takes the remaining width')
  assert.equal(header.props.style.minWidth, 0, 'the header can shrink in a narrow pane')
  assert.equal(refresh.props.style.flex, 'none', 'Refresh keeps its own width')
  assert.equal(refresh.props.type, 'button', 'Refresh is still a button')
  assert.equal(
    collect(tree, node => node.props !== undefined && node.props.style?.justifyContent === 'flex-end').length,
    0,
    'the old right-aligned toolbar row is gone',
  )
})

test('Refresh follows the Environment section when the saved order changes', async () => {
  const storage = makeStorage({
    data: {
      [COLUMN_KEY]: JSON.stringify({ order: ['context', 'environment', 'connectors', 'changes'], collapsed: {} }),
    },
  })
  const mounted = mountBundle({ answer: () => reply(FULL_ANSWER), storage })
  const registration = environmentRegistration(mounted.ctx)
  const tree = await loadedBody(mounted.renderer, registration)
  assert.deepEqual(headerIds(tree), ['context', 'environment', 'connectors', 'changes'], 'Environment is not first')
  const refresh = refreshButton(tree)
  assert.equal(
    collect(sectionWrapper(tree, 'environment'), node => node === refresh).length,
    1,
    'Refresh moved with the Environment section',
  )
  assert.equal(
    collect(sectionWrapper(tree, 'context'), node => node === refresh).length,
    0,
    'Refresh did not stay with the first section',
  )
})

test('collapsing the Environment section keeps its Refresh visible', async () => {
  const mounted = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  sectionHeader(tree, 'environment').props.onClick()
  tree = renderBody(mounted.renderer, registration)
  assert.equal(sectionHeader(tree, 'environment').props['aria-expanded'], 'false', 'the section is collapsed')
  assert.equal(sectionBody(tree, 'environment').props.hidden, true, 'only the body hides')
  const refresh = refreshButton(tree)
  assert.equal(
    collect(sectionWrapper(tree, 'environment'), node => node === refresh).length,
    1,
    'Refresh stays in the collapsed header row',
  )
})

test('a divider separates every section but the first in the order', async () => {
  const divider = '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.2))'
  const mounted = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = environmentRegistration(mounted.ctx)
  let tree = await loadedBody(mounted.renderer, registration)
  assert.equal(sectionWrapper(tree, 'environment').props.style.borderTop, undefined, 'the first section has no line')
  for (const id of ['context', 'connectors', 'changes']) {
    assert.equal(sectionWrapper(tree, id).props.style.borderTop, divider, 'the ' + id + ' section starts with a line')
    assert.equal(sectionWrapper(tree, id).props.style.paddingTop, 12, 'the ' + id + ' section pads above the line')
  }

  sectionHeader(tree, 'environment').props.onKeyDown({ altKey: true, key: 'ArrowDown', preventDefault() {} })
  tree = renderBody(mounted.renderer, registration)
  assert.deepEqual(headerIds(tree), ['context', 'environment', 'connectors', 'changes'], 'the order changed')
  assert.equal(sectionWrapper(tree, 'context').props.style.borderTop, undefined, 'the new first section loses its line')
  assert.equal(sectionWrapper(tree, 'environment').props.style.borderTop, divider, 'the moved section gains the line')

  const storage = makeStorage({
    data: {
      [COLUMN_KEY]: JSON.stringify({ order: ['changes', 'context', 'environment', 'connectors'], collapsed: {} }),
    },
  })
  const saved = mountBundle({ answer: () => reply(FULL_ANSWER), storage })
  const savedTree = await loadedBody(saved.renderer, environmentRegistration(saved.ctx))
  assert.equal(sectionWrapper(savedTree, 'changes').props.style.borderTop, undefined, 'a saved first section has no line')
  for (const id of ['context', 'environment', 'connectors']) {
    assert.equal(sectionWrapper(savedTree, id).props.style.borderTop, divider, 'the saved ' + id + ' has the line')
    assert.equal(sectionWrapper(savedTree, id).props.style.paddingTop, 12)
  }
})

/**
 * Acceptance tests for the Subagents tab (features/subagents/client/subagents.js).
 *
 * The tab is driven through the real generated client.js: a fake
 * window.__ModuleLoader__, a minimal React stub that keeps hook state and runs
 * dependency-aware effects, fake useSessions / useSessionStatus / useTabInfo props,
 * and fake ctx.sessions / ctx.uiWorkspace that record calls. The pure helpers are
 * loaded from the source parts, so a missing helper fails an assertion instead of
 * crashing the file at load.
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
const SUBAGENTS_PART = path.join(ROOT, 'features', 'subagents', 'client', 'subagents.js')
const SLOT = 'sidebar.right.pane.tab'
const TAB_ID = 'dsh-claude-sidebar/subagents'
const KIND = 'claude-sidebar-subagents'

/** A synchronous feature-list answer so the gated apply() mounts in the same turn. */
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
const REFRESH_WARNING = 'dsh-claude-sidebar: subagents refresh failed'

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
function makeRenderer() {
  const instances = new Map()
  const errors = []
  let current = null

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
        instance.hooks[index] = typeof next === 'function' ? next(instance.hooks[index]) : next
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
   * tree, unmount the rest, then commit their effects.
   */
  function render(type, props) {
    const live = new Set()
    const order = []
    const root = instanceOf('root')
    live.add('root')
    order.push(root)
    const output = renderInstance(root, type, props)
    const tree = resolve(output, 'root/out', live, order)
    for (const [key, instance] of Array.from(instances.entries())) {
      if (!live.has(key)) unmount(instance)
    }
    for (const instance of order) commit(instance)
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

/** Evaluate shared.js followed by subagents.js; return this suite's names, absent = null. */
function loadSubagentParts() {
  const source =
    readText(SHARED_PART) +
    '\n' +
    readText(SUBAGENTS_PART) +
    '\nreturn {' +
    "  modelLabel: typeof modelLabel === 'function' ? modelLabel : null," +
    "  childState: typeof childState === 'function' ? childState : null," +
    "  subagentAddress: typeof subagentAddress === 'function' ? subagentAddress : null," +
    "  buildTree: typeof buildTree === 'function' ? buildTree : null," +
    "  countStates: typeof countStates === 'function' ? countStates : null," +
    "  idsToRefresh: typeof idsToRefresh === 'function' ? idsToRefresh : null," +
    '}'
  const factory = new Function('require', source)
  const renderer = makeRenderer()
  return factory(name => {
    if (name === 'react') return renderer.React
    throw new Error('unexpected require: ' + name)
  })
}

/* ------------------------------------------------------------------ */
/* The fake plugin context                                             */
/* ------------------------------------------------------------------ */

/**
 * A ctx with the services the bundle touches, recording every registration and
 * every call the Subagents tab makes. `options.refreshProjections` replaces the
 * default resolved refresh outcome.
 */
function makeCtx(options = {}) {
  const tabTypes = []
  const registrations = []
  const injections = []
  const disposers = []
  const calls = { refresh: [], openResource: [], openFull: [] }
  const ctx = {
    sidebarRightTabs: {
      register(definition) {
        tabTypes.push(definition)
        return () => {}
      },
    },
    slots: {
      inject(slot, callback) {
        injections.push({ slot, callback })
        return () => {}
      },
      register(spec, component) {
        registrations.push({ slot: spec.name, spec, component })
        return () => {}
      },
    },
    sessions: {
      refreshProjections(id) {
        calls.refresh.push(id)
        const result = options.refreshProjections === undefined ? undefined : options.refreshProjections(id)
        return result === undefined ? Promise.resolve() : result
      },
    },
    uiWorkspace: {
      openSession(target) {
        // Copy into this realm so assert.deepEqual compares plain objects, not a
        // cross-realm prototype difference.
        calls.openFull.push({ ...target })
      },
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    calls,
    __tabTypes: tabTypes,
    __registrations: registrations,
    __injections: injections,
    __disposers: disposers,
    __flushSlots() {
      for (const { callback } of injections) callback()
    },
  }
  return ctx
}

/**
 * Evaluate the generated client.js in a fresh context and apply the plugin. The
 * sandbox console keeps every warning; URLSearchParams is a browser global the
 * bundle's address builder needs and a VM context does not carry.
 */
function mountBundle(options = {}) {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const warnings = []
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
      log() {},
      debug() {},
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    navigator: { language: 'en-US' },
    URLSearchParams,
    fetch: featureFetch(),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: CLIENT })
  assert.ok(definition, 'the bundle did not call window.__ModuleLoader__.load()')

  const renderer = makeRenderer()
  const plugin = definition.factory(name => {
    if (name === 'react') return renderer.React
    throw new Error('unexpected require: ' + name)
  })
  const ctx = makeCtx(options)
  plugin.apply(ctx)
  ctx.__flushSlots()
  return { plugin, ctx, renderer, warnings }
}

/* ------------------------------------------------------------------ */
/* Standard props and the body registration                            */
/* ------------------------------------------------------------------ */

/** A fake session store: the three standard props read these fields. */
function makeStore(overrides = {}) {
  return {
    sessionId: 'root',
    byId: {},
    projections: {},
    statuses: new Map(),
    ...overrides,
  }
}

/** The body props the slot supplies: standard props plus the registration's inject(). */
function makeBodyProps(registration, store, ctx) {
  const injection = registration.spec.inject()
  return {
    sessionId: store.sessionId,
    useSessions: selector => selector({ byId: store.byId, projectionsBySession: store.projections, phase: 'ready' }),
    useSessionStatus: selector => selector(store.statuses),
    useTabInfo: () => ({
      tab: {
        actions: {
          openResource(address, options) {
            // Copy into this realm so assert.deepEqual compares plain objects, not a
            // cross-realm prototype difference.
            ctx.calls.openResource.push([address, { ...options }])
          },
        },
      },
    }),
    refreshProjections: injection.refreshProjections,
    openFull: injection.openFull,
  }
}

/** The Subagents tab body registration the plugin made. */
function subagentsRegistration(ctx) {
  const found = ctx.__registrations.find(entry => entry.slot === SLOT && entry.spec.key === TAB_ID)
  assert.ok(found, 'no Subagents tab body registered in ' + SLOT + ' with key ' + TAB_ID)
  return found
}

/** Render the body once with the props the app's slot supplies. */
function renderBody(renderer, registration, store, ctx) {
  return renderer.render(registration.component, makeBodyProps(registration, store, ctx))
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

function textOf(node) {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children || []).map(textOf).join('')
}

/** Every subagent row, in render order: the row div carries the depth indent. */
function rowNodes(tree) {
  return collect(
    tree,
    node => node.type === 'div' && node.props.style !== undefined && Object.hasOwn(node.props.style, 'paddingLeft'),
  )
}

/** The one span whose title attribute carries a row's full title. */
function rowTitle(node) {
  const spans = collect(node, child => child.type === 'span' && typeof child.props.title === 'string')
  assert.ok(spans.length > 0, 'a subagent row carries its full title in a title attribute')
  return spans[0].props.title
}

/** The one status dot inside a rendered row: a span drawn as a filled or hollow circle. */
function markOf(node) {
  const dots = collect(
    node,
    child =>
      child.type === 'span' &&
      child.props.style !== undefined &&
      child.props.style.borderRadius === '50%',
  )
  assert.equal(dots.length, 1, 'a row carries exactly one status dot')
  return { ...dots[0].props.style }
}

/** The row's state label span, whose whole text is exactly this label. */
function stateLabelOf(button, label) {
  const spans = collect(button, child => child.type === 'span' && textOf(child) === label)
  assert.equal(spans.length, 1, 'the row carries one "' + label + '" state label')
  return spans[0]
}

/** The single button with exactly this aria-label. */
function buttonByLabel(tree, label) {
  const buttons = collect(tree, node => node.type === 'button' && node.props['aria-label'] === label)
  assert.equal(buttons.length, 1, 'no single button with aria-label "' + label + '"')
  return buttons[0]
}

/** The single Refresh control: a button whose whole text is "Refresh". */
function refreshButton(tree) {
  const buttons = collect(tree, node => node.type === 'button' && textOf(node).trim() === 'Refresh')
  assert.equal(buttons.length, 1, 'the tab renders one Refresh button')
  return buttons[0]
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function entry(id, mode, extra = {}) {
  return { id, createdAt: 1, mode, ...extra }
}

/** A summary carrying only what the tab reads. */
function summary(overrides = {}) {
  return { displayTitle: overrides.displayTitle || 'Session ' + (overrides.id || '?'), running: false, ...overrides }
}

/** A model selection projection with lastUsed and next. */
function selection(lastUsed, next) {
  return { projectionValues: { modelSelection: { lastUsed, next } } }
}

/** A projection record holding one session's direct children. */
function catalog(entries) {
  return { values: { subagentCatalog: entries } }
}

/* ------------------------------------------------------------------ */
/* Acceptance tests                                                    */
/* ------------------------------------------------------------------ */

test('the pure helpers label, classify, address, walk and count', () => {
  const parts = loadSubagentParts()
  for (const name of ['modelLabel', 'childState', 'subagentAddress', 'buildTree', 'countStates', 'idsToRefresh']) {
    assert.equal(typeof parts[name], 'function', 'features/subagents/client/subagents.js must define a pure ' + name + '()')
  }

  /* modelLabel: lastUsed || next, "model · effort", null when there is no selection. */
  const modelCases = [
    {
      name: 'last used wins over next, with its effort',
      summary: selection({ provider: 'p', model: 'deepseek-chat', reasoningEffort: 'high' }, { provider: 'p', model: 'other' }),
      expected: 'deepseek-chat · high',
    },
    {
      name: 'next only is used when nothing ran yet',
      summary: selection(null, { provider: 'p', model: 'deepseek-reasoner' }),
      expected: 'deepseek-reasoner',
    },
    {
      name: 'an effort is appended after a middle dot',
      summary: selection({ provider: 'p', model: 'm1', reasoningEffort: 'low' }, null),
      expected: 'm1 · low',
    },
    {
      name: 'no selection is null',
      summary: selection(null, null),
      expected: null,
    },
    {
      name: 'no modelSelection projection is null',
      summary: { displayTitle: 'Plain' },
      expected: null,
    },
    {
      name: 'a missing summary is null',
      summary: undefined,
      expected: null,
    },
  ]
  for (const item of modelCases) {
    assert.equal(parts.modelLabel(item.summary), item.expected, item.name)
  }

  /* childState: the status map wins, the summary is the fallback, external never completes. */
  const stateCases = [
    {
      name: 'the status map running true wins over a stopped summary',
      entry: entry('a', 'continuable'),
      summary: summary({ running: false }),
      status: { running: true },
      expected: 'running',
    },
    {
      name: 'the status map running false wins over a running summary',
      entry: entry('a', 'continuable'),
      summary: summary({ running: true }),
      status: { running: false },
      expected: 'idle',
    },
    {
      name: 'without a status the summary running field decides',
      entry: entry('a', 'continuable'),
      summary: summary({ running: true }),
      status: undefined,
      expected: 'running',
    },
    {
      name: 'not running with lastTurnCompleted exactly true is completed',
      entry: entry('a', 'one-shot'),
      summary: summary({ projectionValues: { subagentTiming: { lastTurnCompleted: true } } }),
      status: undefined,
      expected: 'completed',
    },
    {
      name: 'lastTurnCompleted false stays idle',
      entry: entry('a', 'one-shot'),
      summary: summary({ projectionValues: { subagentTiming: { lastTurnCompleted: false } } }),
      status: undefined,
      expected: 'idle',
    },
    {
      name: 'a truthy non-true lastTurnCompleted stays idle',
      entry: entry('a', 'one-shot'),
      summary: summary({ projectionValues: { subagentTiming: { lastTurnCompleted: 'yes' } } }),
      status: undefined,
      expected: 'idle',
    },
    {
      name: 'a running session is never completed',
      entry: entry('a', 'one-shot'),
      summary: summary({ running: true, projectionValues: { subagentTiming: { lastTurnCompleted: true } } }),
      status: { running: true },
      expected: 'running',
    },
    {
      name: 'an external entry is never completed',
      entry: entry('ext', 'external'),
      summary: summary({ projectionValues: { subagentTiming: { lastTurnCompleted: true } } }),
      status: undefined,
      expected: 'idle',
    },
    {
      name: 'nothing known is idle',
      entry: entry('a', 'unknown'),
      summary: undefined,
      status: undefined,
      expected: 'idle',
    },
  ]
  for (const item of stateCases) {
    assert.equal(parts.childState(item.entry, item.summary, item.status), item.expected, item.name)
  }

  /* subagentAddress: the app's exact internal format; external has no address. */
  const addressCases = [
    {
      name: 'a one-shot child id is encoded and the parent and mode go in the query',
      parent: 'parent',
      entry: entry('child/one two', 'one-shot'),
      expected: 'dsh-resource://subagentchat/session/child%2Fone%20two?parent=parent&mode=one-shot',
    },
    {
      name: 'a continuable mode is carried through',
      parent: 'root',
      entry: entry('kid', 'continuable'),
      expected: 'dsh-resource://subagentchat/session/kid?parent=root&mode=continuable',
    },
    {
      name: 'an unknown mode is carried through',
      parent: 'root',
      entry: entry('kid', 'unknown'),
      expected: 'dsh-resource://subagentchat/session/kid?parent=root&mode=unknown',
    },
    {
      name: 'an external entry cannot be opened',
      parent: 'root',
      entry: entry('kid', 'external'),
      expected: null,
    },
  ]
  for (const item of addressCases) {
    assert.equal(parts.subagentAddress(item.parent, item.entry), item.expected, item.name)
  }

  /* buildTree: depth-first catalog order, correct depth and parent, repeated ids once. */
  const treeById = {
    a: summary({ displayTitle: 'Alpha display' }),
    b: summary({ title: 'Beta title', displayTitle: '' }),
    c: {},
    x: summary({ displayTitle: 'X display' }),
    z: {},
    'cycle-root': {},
  }
  const treeProjections = {
    root: catalog([
      entry('a', 'continuable', { label: 'A' }),
      entry('b', 'one-shot'),
      entry('a', 'one-shot', { label: 'Repeated' }),
      entry('x', 'unknown'),
      entry('z', 'one-shot', { name: 'Zed' }),
    ]),
    a: catalog([entry('c', 'one-shot', { label: 'C' }), entry('root', 'one-shot', { label: 'Cycle' })]),
  }
  const tree = parts.buildTree(treeById, treeProjections, new Map(), 'root')
  assert.deepEqual(
    tree.map(row => [row.id, row.parentId, row.depth, row.title]),
    [
      ['a', 'root', 0, 'A'],
      ['c', 'a', 1, 'C'],
      ['b', 'root', 0, 'Beta title'],
      ['x', 'root', 0, 'X display'],
      ['z', 'root', 0, 'Zed'],
    ],
    'catalog order, depth, parent id, and the label/displayTitle/name title chain',
  )
  assert.deepEqual(
    tree.map(row => row.loaded),
    [true, false, false, false, false],
    'loaded means the session catalog is a known array, not that some summary record exists',
  )
  assert.deepEqual(
    tree.map(row => row.mode),
    ['continuable', 'one-shot', 'one-shot', 'unknown', 'one-shot'],
    'each row keeps its catalog mode',
  )
  assert.deepEqual(
    tree.map(row => row.state),
    ['idle', 'idle', 'idle', 'idle', 'idle'],
    'nothing running or completed is idle',
  )
  assert.deepEqual(
    tree.map(row => row.model),
    [null, null, null, null, null],
    'no selection means no model label',
  )

  const missingCases = [
    { name: 'undefined projections give an empty tree', projections: undefined },
    { name: 'a missing root record gives an empty tree', projections: {} },
    { name: 'a record without values gives an empty tree', projections: { root: {} } },
    { name: 'a record without a catalog gives an empty tree', projections: { root: { values: {} } } },
  ]
  for (const item of missingCases) {
    assert.deepEqual(parts.buildTree(treeById, item.projections, new Map(), 'root'), [], item.name)
  }

  /* A summary-only projection record is not a loaded catalog: the real store gives
     every session such a record before its subagentCatalog arrives. */
  const summaryOnly = parts.buildTree(
    { child: summary({ displayTitle: 'Child' }) },
    { root: catalog([entry('child', 'continuable', { label: 'Child' })]), child: { state: 'idle', values: { title: 't' } } },
    new Map(),
    'root',
  )
  assert.deepEqual(
    summaryOnly.map(row => [row.id, row.loaded]),
    [['child', false]],
    'a record without a subagentCatalog array does not count as loaded',
  )

  /* The catalog mode is normalized: only the four the app accepts stay; an entry
     with no mode still builds an address the app will open. */
  const modeTree = parts.buildTree(
    {},
    {
      root: catalog([
        { id: 'mode-less', createdAt: 1 },
        entry('future', 'future-mode'),
        entry('cont', 'continuable'),
      ]),
    },
    new Map(),
    'root',
  )
  assert.deepEqual(
    modeTree.map(row => row.mode),
    ['unknown', 'unknown', 'continuable'],
    'a missing or unexpected mode normalizes to unknown',
  )
  assert.equal(
    parts.subagentAddress('root', modeTree[0]),
    'dsh-resource://subagentchat/session/mode-less?parent=root&mode=unknown',
    'a normalized mode builds an address the app accepts',
  )

  /* External entries are leaves: their own catalog is never walked. */
  const externalLeaf = parts.buildTree(
    {},
    {
      root: catalog([entry('ext', 'external')]),
      ext: catalog([entry('inside-external', 'one-shot')]),
    },
    new Map(),
    'root',
  )
  assert.deepEqual(externalLeaf.map(row => row.id), ['ext'], 'an external entry is a leaf and is not walked')

  /* countStates: one bucket per state plus the total. */
  assert.deepEqual(
    parts.countStates([
      { state: 'running' },
      { state: 'completed' },
      { state: 'idle' },
      { state: 'idle' },
    ]),
    { running: 1, completed: 1, idle: 2, total: 4 },
    'each state is counted and the total adds up',
  )
  assert.deepEqual(parts.countStates([]), { running: 0, completed: 0, idle: 0, total: 0 }, 'no rows is an empty count')

  /* idsToRefresh: root first, then unloaded non-external rows not asked for yet,
     no more than the free refresh slots. */
  const refreshRows = [
    { id: 'a', mode: 'continuable', loaded: false },
    { id: 'e', mode: 'external', loaded: false },
    { id: 'b', mode: 'one-shot', loaded: true },
    { id: 'c', mode: 'unknown', loaded: false },
  ]
  assert.deepEqual(
    parts.idsToRefresh(refreshRows, 'root', new Set(), 10),
    ['root', 'a', 'c'],
    'root first, external and loaded skipped',
  )
  assert.deepEqual(
    parts.idsToRefresh(refreshRows, 'root', new Set(['root', 'a']), 10),
    ['c'],
    'ids already requested are skipped',
  )
  assert.deepEqual(parts.idsToRefresh([], 'root', undefined, 1), ['root'], 'a missing requested set means nothing was asked yet')
  assert.deepEqual(
    parts.idsToRefresh(undefined, 'root', new Set(['root']), 4),
    [],
    'no rows and a requested root asks nothing',
  )
  assert.deepEqual(parts.idsToRefresh(refreshRows, 'root', new Set(), 0), [], 'no free slot starts nothing')

  const manyRows = Array.from({ length: 60 }, (unused, index) => ({
    id: 'r' + index,
    mode: 'one-shot',
    loaded: false,
  }))
  const capped = parts.idsToRefresh(manyRows, 'root', new Set(), 4)
  assert.equal(capped.length, 4, 'no more ids than free refresh slots are returned')
  assert.deepEqual(capped, ['root', 'r0', 'r1', 'r2'], 'the root and the first unloaded rows fill the free slots')
})

test('apply registers the Subagents tab type and its body', () => {
  const { plugin, ctx, warnings } = mountBundle()

  const tabType = ctx.__tabTypes.find(entry => entry.id === TAB_ID)
  assert.ok(tabType, 'no sidebar tab type registered with id ' + TAB_ID)
  assert.equal(tabType.kind, KIND, 'the Subagents tab type has its own kind')
  assert.equal(tabType.title(), 'Subagents', 'the tab title is Subagents')
  assert.equal(tabType.guide.length, 1, 'the tab type contributes exactly one guide entry')
  const guide = tabType.guide[0]
  assert.equal(guide.id, 'subagents')
  assert.equal(guide.order, 37)
  assert.equal(guide.title(), 'Subagents')
  assert.equal(guide.description(), 'Subagents of this session, their state and model')
  assert.equal(typeof guide.icon, 'function', 'the guide entry carries an icon component')

  const registrations = ctx.__registrations.filter(entry => entry.slot === SLOT && entry.spec.key === TAB_ID)
  assert.equal(registrations.length, 1, 'exactly one Subagents tab body seat is registered')
  const registration = registrations[0]
  assert.equal(typeof registration.component, 'function', 'the tab body is a component')
  assert.equal(typeof registration.spec.inject, 'function', 'the body registration supplies its own props')
  const injection = registration.spec.inject()
  assert.equal(typeof injection.refreshProjections, 'function', 'inject supplies refreshProjections')
  assert.equal(typeof injection.openFull, 'function', 'inject supplies openFull')
  injection.refreshProjections('root')
  assert.deepEqual(ctx.calls.refresh, ['root'], 'refreshProjections reaches ctx.sessions')
  injection.openFull({ parentSessionId: 'root', childSessionId: 'child', mode: 'one-shot' })
  assert.deepEqual(
    ctx.calls.openFull,
    [{ parentSessionId: 'root', childSessionId: 'child', mode: 'one-shot' }],
    'openFull reaches ctx.uiWorkspace',
  )
  assert.equal(
    ctx.__injections.filter(entry => entry.slot === SLOT).length,
    4,
    'the Jobs, Subagents, Environment and Git bodies all register through slots.inject',
  )

  assert.ok(
    ctx.__tabTypes.some(entry => entry.id === 'dsh-claude-sidebar/environment'),
    'the Environment tab type is still registered',
  )
  assert.ok(
    ctx.__registrations.some(entry => entry.slot === SLOT && entry.spec.key === 'dsh-claude-sidebar/environment'),
    'the Environment tab body is still registered',
  )
  assert.ok(
    ctx.__registrations.some(entry => entry.slot === 'shell.overlay' && entry.spec.id === 'dsh-claude-sidebar/rail'),
    'the rail is still registered',
  )
  assert.ok(
    ctx.__registrations.some(entry => entry.slot === SLOT && entry.spec.key === 'dsh-claude-sidebar/jobs'),
    'the Jobs tab body is still registered',
  )
  assert.ok(plugin.inject.includes('sessions'), 'the merged inject list contains sessions')
  assert.ok(plugin.inject.includes('uiWorkspace'), 'the merged inject list contains uiWorkspace')
  assert.ok(plugin.inject.includes('jobs'), 'the merged inject list still contains jobs')
  assert.deepEqual(ownWarnings(warnings), [], 'every feature mounts without a warning')
})

test('the tab shows the tree with states and models and loads deeper levels', async () => {
  const { ctx, renderer, warnings } = mountBundle()
  const registration = subagentsRegistration(ctx)
  const store = makeStore({
    byId: {
      a: {
        displayTitle: 'Alpha',
        running: true,
        projectionValues: { modelSelection: { lastUsed: { provider: 'p', model: 'deepseek-chat', reasoningEffort: 'high' }, next: null } },
      },
      b: {
        displayTitle: 'Beta',
        running: false,
        projectionValues: {
          modelSelection: { lastUsed: null, next: { provider: 'p', model: 'deepseek-reasoner' } },
          subagentTiming: { lastTurnCompleted: true },
        },
      },
      c: { displayTitle: 'Gamma', projectionValues: { modelSelection: { lastUsed: null, next: null } } },
    },
    projections: {
      root: catalog([entry('a', 'continuable', { label: 'Alpha' }), entry('b', 'one-shot')]),
    },
  })

  try {
    let tree = renderBody(renderer, registration, store, ctx)
    assert.deepEqual(renderer.errors(), [], 'no render or effect may throw')
    assert.deepEqual(
      ctx.calls.refresh,
      ['root', 'a', 'b'],
      'the root and each non-external unloaded child are asked for once, in tree order',
    )
    assert.deepEqual(rowNodes(tree).map(rowTitle), ['Alpha', 'Beta'], 'the two direct children render in catalog order')
    assert.deepEqual(
      rowNodes(tree).map(row => row.props.style.paddingLeft),
      [0, 0],
      'direct children are not indented',
    )
    assert.match(textOf(rowNodes(tree)[0]), /Running/, 'the running child shows Running')
    assert.match(textOf(rowNodes(tree)[0]), /deepseek-chat · high/, 'the running child shows its last used model and effort')
    assert.match(textOf(rowNodes(tree)[1]), /Completed/, 'a settled child with lastTurnCompleted shows Completed')
    assert.match(textOf(rowNodes(tree)[1]), /deepseek-reasoner/, 'the settled child shows the next model without an effort')
    assert.match(textOf(tree), /1 running · 1 completed · 2 total/, 'the header counts the states')
    assert.ok(
      buttonByLabel(tree, 'Running: Alpha, deepseek-chat · high, open in sidebar'),
      'the row accessible name carries the model when there is one',
    )
    assert.equal(ctx.calls.openResource.length, 0, 'rendering opens nothing')

    store.projections = {
      ...store.projections,
      a: catalog([entry('c', 'one-shot', { label: 'Gamma' })]),
    }
    tree = renderBody(renderer, registration, store, ctx)
    assert.deepEqual(renderer.errors(), [], 'the deeper render may not throw')
    assert.deepEqual(
      ctx.calls.refresh,
      ['root', 'a', 'b', 'c'],
      'the grandchild is asked for once its parent catalog arrives, and nobody is asked twice',
    )
    assert.deepEqual(
      rowNodes(tree).map(rowTitle),
      ['Alpha', 'Gamma', 'Beta'],
      'depth-first order puts the grandchild directly after its parent',
    )
    assert.deepEqual(
      rowNodes(tree).map(row => row.props.style.paddingLeft),
      [0, 12, 0],
      'each level indents one more 12 px step',
    )
    assert.match(textOf(rowNodes(tree)[1]), /Idle/, 'a grandchild without a completed turn is idle')
    assert.ok(!/deepseek/.test(textOf(rowNodes(tree)[1])), 'a grandchild with no selection shows no model')
    assert.match(textOf(tree), /1 running · 1 completed · 3 total/, 'the header now counts three subagents')

    renderBody(renderer, registration, store, ctx)
    assert.deepEqual(
      ctx.calls.refresh,
      ['root', 'a', 'b', 'c'],
      'an unchanged tree asks for nothing a second time',
    )

    store.projections = { root: catalog([]) }
    tree = renderBody(renderer, registration, store, ctx)
    assert.match(textOf(tree), /This session has started no subagents/, 'a session with no subagents says so')
    assert.deepEqual(rowNodes(tree), [], 'the empty state renders no rows')
  } finally {
    renderer.unmount()
  }
  assert.deepEqual(ownWarnings(warnings), [], 'the resolved refreshes warn about nothing')

  /* A rejected refresh is reported once, and never becomes an unhandled rejection. */
  const failing = mountBundle({ refreshProjections: () => Promise.reject(new Error('refresh failed')) })
  const failingRegistration = subagentsRegistration(failing.ctx)
  try {
    const failingTree = renderBody(failing.renderer, failingRegistration, makeStore({
      byId: { a: { displayTitle: 'Alpha' } },
      projections: { root: catalog([entry('a', 'continuable')]) },
    }), failing.ctx)
    assert.ok(failingTree, 'the body renders even when a refresh rejects')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(failing.renderer.errors(), [], 'a rejected refresh is not a render or effect error')
    assert.equal(ownWarnings(failing.warnings).length, 2, 'one warning per rejected refresh (root and the child)')
    for (const args of ownWarnings(failing.warnings)) {
      assert.equal(args[0], REFRESH_WARNING, 'the warning names the subagents refresh')
      assert.equal(args[1].message, 'refresh failed', 'the warning carries the rejection reason')
    }
  } finally {
    failing.renderer.unmount()
  }
})

test('a row opens the subagent in the sidebar and the secondary button opens it full screen', () => {
  const { ctx, renderer } = mountBundle()
  const registration = subagentsRegistration(ctx)
  const store = makeStore({
    byId: {
      parent: { displayTitle: 'Parent agent' },
      'child/one two': { displayTitle: 'Encoded child' },
      'ext-1': { displayTitle: 'Outside helper' },
    },
    projections: {
      root: catalog([entry('parent', 'continuable', { label: 'Parent agent' })]),
      parent: catalog([
        entry('child/one two', 'one-shot', { label: 'Encoded child' }),
        entry('ext-1', 'external', { label: 'Outside helper', name: 'helper' }),
      ]),
    },
  })

  try {
    const tree = renderBody(renderer, registration, store, ctx)
    assert.deepEqual(renderer.errors(), [], 'no render or effect may throw')

    const row = buttonByLabel(tree, 'Idle: Encoded child, open in sidebar')
    row.props.onClick()
    const address =
      'dsh-resource://subagentchat/session/child%2Fone%20two?parent=parent&mode=one-shot'
    assert.deepEqual(
      ctx.calls.openResource,
      [[address, { kind: 'subagentchat', preferNewPane: true }]],
      'the row opens the child in the sidebar with the direct parent and the one-shot mode',
    )

    const secondary = buttonByLabel(tree, 'Open Encoded child full screen')
    secondary.props.onClick()
    assert.deepEqual(
      ctx.calls.openFull,
      [{ parentSessionId: 'parent', childSessionId: 'child/one two', mode: 'one-shot' }],
      'the secondary button opens the child full screen once with its direct parent',
    )
    assert.equal(ctx.calls.openResource.length, 1, 'the secondary button does not trigger the row action')

    const externalRow = rowNodes(tree).find(node => textOf(node).includes('External'))
    assert.ok(externalRow, 'the external child renders a row labelled External')
    assert.match(textOf(externalRow), /Outside helper/, 'the external row still shows its title')
    assert.deepEqual(collect(externalRow, node => node.type === 'button'), [], 'an external row is not a button')
  } finally {
    renderer.unmount()
  }
})

test('Refresh asks again for every level', async () => {
  const { ctx, renderer } = mountBundle()
  const registration = subagentsRegistration(ctx)
  const store = makeStore({
    byId: { a: { displayTitle: 'Alpha' }, b: { displayTitle: 'Beta' } },
    projections: {
      root: catalog([entry('a', 'continuable'), entry('b', 'one-shot')]),
    },
  })

  try {
    let tree = renderBody(renderer, registration, store, ctx)
    assert.deepEqual(ctx.calls.refresh, ['root', 'a', 'b'], 'the first render asks for the root and both children')
    await new Promise(resolve => setImmediate(resolve))

    refreshButton(tree).props.onClick()
    tree = renderBody(renderer, registration, store, ctx)
    assert.deepEqual(
      ctx.calls.refresh,
      ['root', 'a', 'b', 'root', 'a', 'b'],
      'Refresh clears what was asked and asks again for the root and every unloaded child',
    )

    renderBody(renderer, registration, store, ctx)
    assert.deepEqual(
      ctx.calls.refresh,
      ['root', 'a', 'b', 'root', 'a', 'b'],
      'after Refresh the ids are requested once more, not on every render',
    )
    assert.ok(tree, 'the body renders after Refresh')
  } finally {
    renderer.unmount()
  }
})

test('a child that only has a summary entry is still refreshed', () => {
  const parts = loadSubagentParts()
  const { ctx, renderer } = mountBundle()
  const registration = subagentsRegistration(ctx)
  const store = makeStore({
    byId: { child: { displayTitle: 'Child' }, grand: { displayTitle: 'Grand' } },
    projections: {
      root: catalog([entry('child', 'continuable', { label: 'Child' })]),
      child: { state: 'idle', values: { title: 'summary only' } },
    },
  })

  try {
    const rows = parts.buildTree(store.byId, store.projections, store.statuses, 'root')
    assert.equal(rows[0].loaded, false, 'a summary-only projection entry is not a loaded catalog')
    assert.deepEqual(
      parts.idsToRefresh(rows, 'root', new Set(), 4),
      ['root', 'child'],
      'the summary-only child is still refreshed',
    )

    let tree = renderBody(renderer, registration, store, ctx)
    assert.deepEqual(ctx.calls.refresh, ['root', 'child'], 'the body asks for the summary-only child')

    store.projections = {
      ...store.projections,
      child: {
        state: 'idle',
        values: {
          title: 'summary only',
          subagentCatalog: [entry('grand', 'one-shot', { label: 'Grand' })],
        },
      },
    }
    tree = renderBody(renderer, registration, store, ctx)
    assert.deepEqual(
      ctx.calls.refresh,
      ['root', 'child', 'grand'],
      'the grandchild is requested once its parent catalog is a real array',
    )
    assert.deepEqual(
      rowNodes(tree).map(rowTitle),
      ['Child', 'Grand'],
      'the grandchild renders after its parent catalog arrives',
    )
    assert.deepEqual(
      rowNodes(tree).map(row => row.props.style.paddingLeft),
      [0, 12],
      'the grandchild is one level deeper',
    )
  } finally {
    renderer.unmount()
  }
})

test('at most four refreshes are in flight', async () => {
  const pending = []
  const { ctx, renderer } = mountBundle({
    refreshProjections: id => new Promise((resolve, reject) => pending.push({ id, resolve, reject })),
  })
  const registration = subagentsRegistration(ctx)
  const children = Array.from({ length: 10 }, (unused, index) =>
    entry('c' + index, 'one-shot', { label: 'Child ' + index }),
  )
  const store = makeStore({ projections: { root: catalog(children) } })

  try {
    renderBody(renderer, registration, store, ctx)
    assert.equal(ctx.calls.refresh.length, 4, 'the first pass starts exactly four refreshes')
    assert.deepEqual(
      ctx.calls.refresh,
      ['root', 'c0', 'c1', 'c2'],
      'the root and the first three children fill the four slots',
    )

    let settled = 0
    while (ctx.calls.refresh.length < 11) {
      assert.ok(pending.length > 0, 'a request is pending while the queue advances')
      pending.shift().resolve()
      settled += 1
      await new Promise(resolve => setImmediate(resolve))
      renderBody(renderer, registration, store, ctx)
      assert.equal(ctx.calls.refresh.length, 4 + settled, 'each settlement starts exactly one more refresh')
    }
    assert.deepEqual(
      ctx.calls.refresh,
      ['root', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'],
      'every id is asked for once, in tree order',
    )
    assert.equal(new Set(ctx.calls.refresh).size, ctx.calls.refresh.length, 'no id is requested twice')
    assert.equal(pending.length, 4, 'four requests are still in flight at the end')
  } finally {
    renderer.unmount()
    for (const request of pending.splice(0)) request.resolve()
  }
})

test('a rejected refresh does not stall the queue', async () => {
  const pending = []
  const { ctx, renderer, warnings } = mountBundle({
    refreshProjections: id => new Promise((resolve, reject) => pending.push({ id, resolve, reject })),
  })
  const registration = subagentsRegistration(ctx)
  const children = Array.from({ length: 5 }, (unused, index) => entry('r' + index, 'one-shot'))
  const store = makeStore({ projections: { root: catalog(children) } })

  try {
    renderBody(renderer, registration, store, ctx)
    assert.deepEqual(ctx.calls.refresh, ['root', 'r0', 'r1', 'r2'], 'four requests are in flight')

    pending.shift().reject(new Error('refresh failed'))
    await new Promise(resolve => setImmediate(resolve))
    renderBody(renderer, registration, store, ctx)

    assert.deepEqual(
      ctx.calls.refresh,
      ['root', 'r0', 'r1', 'r2', 'r3'],
      'the rejected slot frees and the next id starts',
    )
    assert.equal(ownWarnings(warnings).length, 1, 'the rejection is reported once')
    assert.equal(ownWarnings(warnings)[0][0], REFRESH_WARNING, 'the warning names the subagents refresh')
    assert.equal(ownWarnings(warnings)[0][1].message, 'refresh failed', 'the warning carries the rejection reason')
    assert.deepEqual(renderer.errors(), [], 'the rejection is not an effect or render error')
  } finally {
    renderer.unmount()
    for (const request of pending.splice(0)) request.resolve()
  }
})

test('children in migration-required or error state are not requested', () => {
  const parts = loadSubagentParts()
  const { ctx, renderer } = mountBundle()
  const registration = subagentsRegistration(ctx)
  const store = makeStore({
    byId: {
      ok: { displayTitle: 'Ok' },
      moving: { displayTitle: 'Moving' },
      broken: { displayTitle: 'Broken' },
      format: { displayTitle: 'Format', formatStatus: 'migration-required' },
    },
    projections: {
      root: catalog([
        entry('ok', 'continuable', { label: 'Ok' }),
        entry('moving', 'unknown', { label: 'Moving' }),
        entry('broken', 'unknown', { label: 'Broken' }),
        entry('format', 'one-shot', { label: 'Format' }),
      ]),
      moving: { state: 'migration-required', values: {} },
      broken: { state: 'error', values: {} },
    },
  })

  try {
    const rows = parts.buildTree(store.byId, store.projections, store.statuses, 'root')
    assert.deepEqual(
      rows.map(row => row.recordState),
      [undefined, 'migration-required', 'error', undefined],
      'each row carries its projection record state, not a catalog entry state',
    )
    assert.deepEqual(
      rows.map(row => row.formatStatus),
      [undefined, undefined, undefined, 'migration-required'],
      'each row carries the summary format status',
    )
    assert.deepEqual(rows.map(row => row.loaded), [false, false, false, false], 'none has a catalog array')
    assert.deepEqual(
      parts.idsToRefresh(rows, 'root', new Set(), 10),
      ['root', 'ok'],
      'records in migration-required or error, and summaries in migration-required, are not requested',
    )

    const tree = renderBody(renderer, registration, store, ctx)
    assert.deepEqual(ctx.calls.refresh, ['root', 'ok'], 'the body only asks for the root and the healthy child')
    assert.equal(rowNodes(tree).length, 4, 'the skipped entries still render as rows')
  } finally {
    renderer.unmount()
  }
})

test('a settlement advances the queue even when the store did not change', async () => {
  const pending = []
  const { ctx, renderer } = mountBundle({
    refreshProjections: id => new Promise((resolve, reject) => pending.push({ id, resolve, reject })),
  })
  const registration = subagentsRegistration(ctx)
  const store = makeStore({
    projections: {
      root: catalog(Array.from({ length: 6 }, (unused, index) => entry('q' + index, 'one-shot'))),
    },
  })
  const byIdBefore = store.byId
  const projectionsBefore = store.projections
  const statusesBefore = store.statuses

  try {
    renderBody(renderer, registration, store, ctx)
    assert.deepEqual(ctx.calls.refresh, ['root', 'q0', 'q1', 'q2'], 'four refreshes are in flight')

    pending.shift().resolve()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(store.byId, byIdBefore, 'the store summaries did not change')
    assert.equal(store.projections, projectionsBefore, 'the store projections did not change')
    assert.equal(store.statuses, statusesBefore, 'the store statuses did not change')

    renderBody(renderer, registration, store, ctx)
    assert.deepEqual(
      ctx.calls.refresh,
      ['root', 'q0', 'q1', 'q2', 'q3'],
      'the settlement alone starts the next request although the memoized rows are identical',
    )
  } finally {
    renderer.unmount()
    for (const request of pending.splice(0)) request.resolve()
  }
})

test('a settlement after unmount sets no state', async () => {
  const pending = []
  const { ctx, renderer } = mountBundle({
    refreshProjections: id => new Promise((resolve, reject) => pending.push({ id, resolve, reject })),
  })
  const registration = subagentsRegistration(ctx)
  const store = makeStore({ projections: { root: catalog([entry('late', 'one-shot')]) } })

  renderBody(renderer, registration, store, ctx)
  assert.equal(pending.length, 2, 'the root and the child are in flight')

  renderer.unmount()
  for (const request of pending.splice(0)) request.resolve()
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(renderer.errors(), [], 'a settlement after unmount sets no state')
})

test('the state marks of the Subagents tab differ for running, idle and completed', () => {
  const { ctx, renderer } = mountBundle()
  const registration = subagentsRegistration(ctx)
  const store = makeStore({
    byId: {
      run: { displayTitle: 'Runner', running: true },
      done: { displayTitle: 'Finisher', projectionValues: { subagentTiming: { lastTurnCompleted: true } } },
      wait: { displayTitle: 'Waiter' },
    },
    projections: {
      root: catalog([
        entry('done', 'one-shot', { label: 'Finisher' }),
        entry('wait', 'continuable', { label: 'Waiter' }),
        entry('run', 'continuable', { label: 'Runner' }),
      ]),
    },
  })

  try {
    const tree = renderBody(renderer, registration, store, ctx)
    assert.deepEqual(renderer.errors(), [], 'no render or effect may throw')
    const runningButton = buttonByLabel(tree, 'Running: Runner, open in sidebar')
    const idleButton = buttonByLabel(tree, 'Idle: Waiter, open in sidebar')
    const completedButton = buttonByLabel(tree, 'Completed: Finisher, open in sidebar')
    const running = markOf(runningButton)
    const idle = markOf(idleButton)
    const completed = markOf(completedButton)

    assert.notDeepEqual(running, idle, 'the running and idle marks differ')
    assert.notDeepEqual(running, completed, 'the running and completed marks differ')
    assert.notDeepEqual(idle, completed, 'the idle and completed marks differ')
    assert.notEqual(running.background, completed.background, 'running and completed use different color tones')
    assert.equal(idle.background, 'transparent', 'the idle mark has a transparent background')
    assert.ok(
      typeof idle.border === 'string' && idle.border.includes('solid'),
      'the idle mark is drawn by its border',
    )
    assert.equal(idle.boxSizing, 'border-box', 'the hollow mark keeps its 8 px size inside its border')
    assert.equal(running.border, undefined, 'the running mark is filled, not bordered')
    assert.equal(completed.border, undefined, 'the completed mark is filled, not bordered')

    for (const [button, label] of [
      [runningButton, 'Running'],
      [idleButton, 'Idle'],
      [completedButton, 'Completed'],
    ]) {
      assert.equal(
        stateLabelOf(button, label).props.style.color,
        undefined,
        'the ' + label + ' label keeps the ordinary text color',
      )
    }
  } finally {
    renderer.unmount()
  }
})

test('the Subagents tree lists running first, then idle, then completed, newest first', () => {
  const parts = loadSubagentParts()

  /* One parent whose children are, in catalog order: completed, idle, running,
     completed, idle, running; each catalog entry is newer than the one before it. */
  const sixChildren = parts.buildTree(
    {
      c1: summary({ projectionValues: { subagentTiming: { lastTurnCompleted: true } } }),
      c2: summary(),
      c3: summary({ running: true }),
      c4: summary({ projectionValues: { subagentTiming: { lastTurnCompleted: true } } }),
      c5: summary(),
      c6: summary({ running: true }),
    },
    {
      root: catalog([
        entry('c1', 'one-shot', { createdAt: 1 }),
        entry('c2', 'one-shot', { createdAt: 2 }),
        entry('c3', 'one-shot', { createdAt: 3 }),
        entry('c4', 'one-shot', { createdAt: 4 }),
        entry('c5', 'one-shot', { createdAt: 5 }),
        entry('c6', 'one-shot', { createdAt: 6 }),
      ]),
    },
    new Map(),
    'root',
  )
  assert.deepEqual(
    sixChildren.map(row => [row.id, row.state, row.createdAt]),
    [
      ['c6', 'running', 6],
      ['c3', 'running', 3],
      ['c5', 'idle', 5],
      ['c2', 'idle', 2],
      ['c4', 'completed', 4],
      ['c1', 'completed', 1],
    ],
    'running first, then idle, then completed, newest first inside each rank',
  )
  assert.deepEqual(
    Object.keys(sixChildren[0]).sort(),
    [
      'createdAt',
      'depth',
      'formatStatus',
      'id',
      'loaded',
      'mode',
      'model',
      'parentId',
      'recordState',
      'state',
      'title',
    ].sort(),
    'a row carries exactly its documented fields, without the build-time tree fields',
  )

  /* A subtree that contains running work floats up even when its root has settled. */
  const nested = parts.buildTree(
    {
      finished: summary({ projectionValues: { subagentTiming: { lastTurnCompleted: true } } }),
      grand: summary({ running: true }),
      sibling: summary(),
    },
    {
      root: catalog([
        entry('sibling', 'one-shot', { createdAt: 2 }),
        entry('finished', 'continuable', { createdAt: 1 }),
      ]),
      finished: catalog([entry('grand', 'one-shot', { createdAt: 3 })]),
    },
    new Map(),
    'root',
  )
  assert.deepEqual(
    nested.map(row => [row.id, row.parentId, row.depth]),
    [
      ['finished', 'root', 0],
      ['grand', 'finished', 1],
      ['sibling', 'root', 0],
    ],
    'a completed child with a running grandchild sorts before an idle sibling, and the grandchild is listed directly under it',
  )

  /* Running work two levels down still floats its settled ancestors to the top. */
  const deep = parts.buildTree(
    {
      top: summary({ projectionValues: { subagentTiming: { lastTurnCompleted: true } } }),
      middle: summary({ projectionValues: { subagentTiming: { lastTurnCompleted: true } } }),
      bottom: summary({ running: true }),
      deepSibling: summary(),
    },
    {
      root: catalog([
        entry('deepSibling', 'one-shot', { createdAt: 2 }),
        entry('top', 'continuable', { createdAt: 1 }),
      ]),
      top: catalog([entry('middle', 'continuable', { createdAt: 3 })]),
      middle: catalog([entry('bottom', 'one-shot', { createdAt: 4 })]),
    },
    new Map(),
    'root',
  )
  assert.deepEqual(
    deep.map(row => [row.id, row.parentId, row.depth]),
    [
      ['top', 'root', 0],
      ['middle', 'top', 1],
      ['bottom', 'middle', 2],
      ['deepSibling', 'root', 0],
    ],
    'a completed child whose completed child has a running child sorts before an idle sibling',
  )

  /* Entries without a numeric createdAt keep catalog order at the end of their rank. */
  const untimed = parts.buildTree(
    {},
    {
      root: catalog([
        entry('no-a', 'one-shot', { createdAt: undefined }),
        entry('newest', 'one-shot', { createdAt: 5 }),
        entry('no-b', 'one-shot', { createdAt: undefined }),
        entry('older', 'one-shot', { createdAt: 3 }),
        entry('textual', 'one-shot', { createdAt: 'soon' }),
      ]),
    },
    new Map(),
    'root',
  )
  assert.deepEqual(
    untimed.map(row => row.id),
    ['newest', 'older', 'no-a', 'no-b', 'textual'],
    'untimed entries stay in catalog order at the end of their rank',
  )
})

test('every color token the tabs use exists in the app', () => {
  const appTokens = [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-specific-sidebar-fill',
  ]
  const part = (feature, name) => path.join(ROOT, 'features', feature, 'client', name)
  const tabParts = [
    path.join(ROOT, 'client', 'shared.js'),
    part('subagents', 'subagents.js'),
    part('jobs', 'jobs.js'),
    part('environment', 'environment-base.js'),
    part('environment', 'environment-context.js'),
    part('environment', 'environment-connectors.js'),
    part('environment', 'environment-settings.js'),
    part('environment', 'environment.js'),
    part('run', 'run.js'),
    part('git', 'git.js'),
    part('sizing', 'sizing.js'),
    part('browser', 'browser.js'),
  ]
  const used = new Set()
  for (const file of tabParts) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/var\((--dsw-[a-z0-9-]+)/gu)) used.add(match[1])
  }
  assert.ok(used.size > 0, 'the tabs use the app theme tokens')
  const unknown = [...used].filter(token => !appTokens.includes(token)).sort()
  assert.deepEqual(unknown, [], 'tokens outside the app theme: ' + unknown.join(', '))
})

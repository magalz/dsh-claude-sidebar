/**
 * Acceptance tests for the Jobs tab (features/jobs/client/jobs.js).
 *
 * The tab is driven through the real generated client.js: a fake
 * window.__ModuleLoader__, a minimal React stub that keeps hook state and runs
 * dependency-aware effects, and a fake ctx.jobs that records calls and stop
 * functions. The pure helpers are loaded from the source parts, so a missing
 * helper fails an assertion instead of crashing the file at load.
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
const JOBS_PART = path.join(ROOT, 'features', 'jobs', 'client', 'jobs.js')
const SLOT = 'sidebar.right.pane.tab'
const TAB_ID = 'dsh-claude-sidebar/jobs'
const KIND = 'claude-sidebar-jobs'

/**
 * The generated gate fetches the feature list in apply(). This fake settles synchronously
 * with every feature on, so the mounts this suite asserts happen in the same turn.
 */
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
 * when their dependency array changed (or always without one); a component
 * that disappears from the next tree is unmounted and its cleanups run first,
 * which is what the tab's stream and timer stops depend on.
 */
function makeRenderer() {
  const instances = new Map()
  const errors = []
  /** The fake pre node the output tail's ref points at: tests drive its scroll geometry. */
  const preNode = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 }
  let current = null

  function instanceOf(key) {
    let instance = instances.get(key)
    if (instance === undefined) {
      instance = {
        key,
        hooks: [],
        cursor: 0,
        effects: [],
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
      const ref = element.props.ref
      if (ref !== null && typeof ref === 'object' && 'current' in ref) {
        element.style = {}
        ref.current = element.type === 'pre' ? preNode : element
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
        if (instance.dead) return
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
    useMemo(fn) {
      return fn()
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
    preNode,
  }
}

/* ------------------------------------------------------------------ */
/* Loading the bundle and the source parts                             */
/* ------------------------------------------------------------------ */

/** Evaluate shared.js followed by jobs.js and return the names this suite calls; absent = null. */
function loadJobParts() {
  const source =
    readText(SHARED_PART) +
    '\n' +
    readText(JOBS_PART) +
    '\nreturn {' +
    "  sortJobs: typeof sortJobs === 'function' ? sortJobs : null," +
    "  statusInfo: typeof statusInfo === 'function' ? statusInfo : null," +
    "  formatDuration: typeof formatDuration === 'function' ? formatDuration : null," +
    "  cleanOutput: typeof cleanOutput === 'function' ? cleanOutput : null," +
    '}'
  const factory = new Function('require', source)
  const renderer = makeRenderer()
  return factory(name => {
    if (name === 'react') return renderer.React
    throw new Error('unexpected require: ' + name)
  })
}

/** Fake setTimeout/setInterval: tests see what the tab schedules, and fire or clear it. */
function makeTimers() {
  let nextId = 1
  const active = new Map()
  const timeouts = []
  const intervals = []
  const clears = []
  return {
    setTimeout(fn, delay) {
      const entry = { id: nextId++, delay, fn, kind: 'timeout' }
      active.set(entry.id, entry)
      timeouts.push(entry)
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
    timeouts,
    intervals,
  }
}

/**
 * Evaluate the generated client.js in a fresh context and return the plugin,
 * its fake ctx, the renderer the bundle's React comes from, and the fake timers
 * the bundle's setTimeout/setInterval resolve to.
 */
function mountBundle(jobs) {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const timers = makeTimers()
  let definition = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value
        },
      },
    },
    console: { info() {}, warn() {}, error() {}, log() {}, debug() {} },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    navigator: { language: 'en-US' },
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
  const ctx = makeCtx(jobs)
  plugin.apply(ctx)
  ctx.__flushSlots()
  return { plugin, ctx, renderer, timers }
}

/** The four host seats the bundle touches, recording what it registers and injects. */
function makeCtx(jobs) {
  const tabTypes = []
  const registrations = []
  const injections = []
  const disposers = []
  const ctx = {
    jobs,
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
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
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

/* ------------------------------------------------------------------ */
/* Fakes for ctx.jobs                                                  */
/* ------------------------------------------------------------------ */

/** A fake ctx.jobs: a subscribable snapshot source plus recording streams and kill. */
function makeJobsFake(options = {}) {
  let snapshot = { rows: {}, observed: {}, ...(options.snapshot || {}) }
  let killResult = options.killResult === undefined ? { ok: true } : options.killResult
  const listeners = new Set()
  const calls = { watch: [], watchStops: [], observe: [], observeStops: [], kill: [] }
  const openObservations = new Map()

  function changed() {
    for (const listener of Array.from(listeners)) listener()
  }

  return {
    state: {
      getSnapshot() {
        return snapshot
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    watchRows(sessionId) {
      calls.watch.push(sessionId)
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        calls.watchStops.push(sessionId)
      }
    },
    observe(sessionId, id) {
      const key = String(id)
      calls.observe.push([sessionId, id])
      openObservations.set(key, (openObservations.get(key) || 0) + 1)
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        calls.observeStops.push([sessionId, id])
        openObservations.delete(key)
      }
    },
    kill(sessionId, id) {
      calls.kill.push([sessionId, id])
      const answer = typeof killResult === 'function' ? killResult(sessionId, id) : killResult
      return Promise.resolve(answer)
    },
    setRows(rows) {
      snapshot = { rows, observed: snapshot.observed }
      changed()
    },
    setObserved(observed) {
      snapshot = { rows: snapshot.rows, observed }
      changed()
    },
    setKillResult(value) {
      killResult = value
    },
    calls,
    openObservations,
  }
}

/* ------------------------------------------------------------------ */
/* Applying a registration's inject() the way the app does             */
/* ------------------------------------------------------------------ */

/** Turn a getSnapshot/subscribe source into a selector hook, like the slot's use<Name> prop. */
function useStore(React, source, selector) {
  const [snapshot, setSnapshot] = React.useState(() => source.getSnapshot())
  React.useEffect(() => {
    const update = () => setSnapshot(source.getSnapshot())
    const stop = source.subscribe(update)
    update()
    return typeof stop === 'function' ? stop : undefined
  }, [source])
  return selector(snapshot)
}

/** Apply inject(): plain members become props, hooks.<name> becomes use<Name>(selector). */
function makeBodyProps(renderer, registration, options = {}) {
  const injection = typeof registration.spec.inject === 'function' ? registration.spec.inject() : {}
  const props = {
    sessionId: options.sessionId === undefined ? 's1' : options.sessionId,
    useTabInfo: () => ({ tab: { visible: options.visible !== false } }),
  }
  for (const [name, value] of Object.entries(injection)) {
    if (name === 'hooks') continue
    props[name] = value
  }
  for (const [name, source] of Object.entries(injection.hooks || {})) {
    const hookName = 'use' + name.charAt(0).toUpperCase() + name.slice(1)
    props[hookName] = selector => useStore(renderer.React, source, selector)
  }
  return props
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

/** The row header button whose text carries this command label. */
function rowButton(tree, label) {
  const buttons = collect(tree, node => node.type === 'button' && node.props['aria-expanded'] !== undefined)
  const found = buttons.find(button => textOf(button).includes(label))
  assert.ok(found, 'no row header button for ' + label)
  return found
}

/** A button whose whole text is exactly this label ("Stop", "Confirm stop"). */
function buttonWithText(tree, label) {
  return collect(tree, node => node.type === 'button' && textOf(node).trim() === label)
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

/** The row's status label span, whose whole text is exactly this label. */
function stateLabelOf(button, label) {
  const spans = collect(button, child => child.type === 'span' && textOf(child) === label)
  assert.equal(spans.length, 1, 'the row carries one "' + label + '" status label')
  return spans[0]
}

/** Render the body once with the props the app's inject() produces. */
function renderBody(renderer, registration, options = {}) {
  return renderer.render(registration.component, makeBodyProps(renderer, registration, options))
}

function jobsRegistration(ctx) {
  const found = ctx.__registrations.find(entry => entry.slot === SLOT && entry.spec.key === TAB_ID)
  assert.ok(found, 'no Jobs tab body registered in ' + SLOT + ' with key ' + TAB_ID)
  return found
}

/** One JobView with the fields a row and a duration read. */
function makeJob(overrides = {}) {
  return {
    id: 'job-1',
    kind: 'bash',
    label: 'npm run test',
    status: 'running',
    startedAt: 1_000,
    output: { total: 0, earliest: 0 },
    ...overrides,
  }
}

/* ------------------------------------------------------------------ */
/* Acceptance tests                                                    */
/* ------------------------------------------------------------------ */

test('the pure helpers sort, label, time and clean', () => {
  const parts = loadJobParts()
  for (const name of ['sortJobs', 'statusInfo', 'formatDuration', 'cleanOutput']) {
    assert.equal(typeof parts[name], 'function', 'features/jobs/client/jobs.js must define a pure ' + name + '()')
  }

  const sortCases = [
    {
      name: 'no rows gives an empty array',
      rows: undefined,
      expected: [],
    },
    {
      name: 'live jobs come first, newest first inside each group',
      rows: [
        makeJob({ id: 'a', status: 'running', startedAt: 1_000 }),
        makeJob({ id: 'b', status: 'running', startedAt: 3_000 }),
        makeJob({ id: 'c', status: 'completed', startedAt: 5_000, finishedAt: 6_000 }),
      ],
      expected: ['b', 'a', 'c'],
    },
    {
      name: 'stopping counts as live',
      rows: [
        makeJob({ id: 'r', status: 'running', startedAt: 1_000 }),
        makeJob({ id: 's', status: 'stopping', startedAt: 1_200 }),
      ],
      expected: ['s', 'r'],
    },
    {
      name: 'settled jobs are newest first',
      rows: [
        makeJob({ id: 'failed', status: 'failed', startedAt: 1_000 }),
        makeJob({ id: 'completed', status: 'completed', startedAt: 3_000 }),
        makeJob({ id: 'killed', status: 'killed', startedAt: 2_000 }),
      ],
      expected: ['completed', 'killed', 'failed'],
    },
  ]
  for (const item of sortCases) {
    assert.deepEqual(parts.sortJobs(item.rows).map(job => job.id), item.expected, item.name)
  }
  const input = [makeJob({ id: 'old', startedAt: 1 }), makeJob({ id: 'new', startedAt: 2 })]
  const sorted = parts.sortJobs(input)
  assert.notEqual(sorted, input, 'sortJobs returns a new array')
  assert.deepEqual(input.map(job => job.id), ['old', 'new'], 'sortJobs does not mutate its input')

  const statusCases = [
    { status: 'running', expected: { label: 'Running', tone: 'active', hollow: false } },
    { status: 'stopping', expected: { label: 'Stopping', tone: 'warn', hollow: false } },
    { status: 'completed', expected: { label: 'Completed', tone: 'success', hollow: false } },
    { status: 'killed', expected: { label: 'Stopped', tone: 'idle', hollow: true } },
    { status: 'failed', expected: { label: 'Failed', tone: 'error', hollow: false } },
    { status: 'weird', expected: { label: 'Unknown', tone: 'idle', hollow: true } },
  ]
  for (const item of statusCases) {
    assert.deepEqual(parts.statusInfo(makeJob({ status: item.status })), item.expected, item.status)
  }
  assert.deepEqual(
    parts.statusInfo(undefined),
    { label: 'Unknown', tone: 'idle', hollow: true },
    'a missing job is Unknown, idle and hollow',
  )

  const durationCases = [
    { ms: 0, expected: '0s' },
    { ms: 12_000, expected: '12s' },
    { ms: 59_999, expected: '59s' },
    { ms: 60_000, expected: '1m 00s' },
    { ms: 185_000, expected: '3m 05s' },
    { ms: 3_720_000, expected: '1h 02m' },
    { ms: -5, expected: '0s' },
    { ms: Number.NaN, expected: '0s' },
    { ms: Number.POSITIVE_INFINITY, expected: '0s' },
  ]
  for (const item of durationCases) {
    assert.equal(parts.formatDuration(item.ms), item.expected, String(item.ms))
  }

  const cleanCases = [
    { name: 'plain text passes through', text: 'plain', expected: 'plain' },
    { name: 'a colored line loses its CSI sequences', text: '\u001b[31mred\u001b[0m', expected: 'red' },
    { name: 'a clear-line CSI sequence is removed', text: 'one\u001b[2Ktwo', expected: 'onetwo' },
    { name: 'a carriage-return progress line keeps the last segment', text: '10%\r50%\r100%', expected: '100%' },
    { name: 'a colored progress line cleans both', text: '\u001b[32m50%\r\u001b[32m100%\u001b[0m', expected: '100%' },
    { name: 'CRLF becomes LF', text: 'a\r\nb', expected: 'a\nb' },
    { name: 'only lone carriage returns collapse per line', text: 'a\nb\rc\nd', expected: 'a\nc\nd' },
    { name: 'an OSC title ended by BEL is removed', text: '\u001b]0;title\u0007hello', expected: 'hello' },
    { name: 'an OSC title ended by ESC backslash is removed', text: '\u001b]2;t\u001b\\hello', expected: 'hello' },
    { name: 'a trailing carriage return keeps the line text', text: 'abc\r', expected: 'abc' },
    { name: 'a trailing carriage return on each line keeps both lines', text: 'abc\r\ndef\r', expected: 'abc\ndef' },
    { name: 'a trailing empty progress segment keeps the last text', text: '10%\r20%\r', expected: '20%' },
    { name: 'only empty carriage-return segments leave an empty line', text: '\r', expected: '' },
    { name: 'CSI parameter bytes include colon', text: '\u001b[38:2:255:0:0mred', expected: 'red' },
    { name: 'a character-set selection is removed', text: '\u001b(Bplain', expected: 'plain' },
    { name: 'another two-character escape is removed', text: '\u001bMplain', expected: 'plain' },
    { name: 'an unterminated CSI at the end is removed', text: 'ok\u001b[31', expected: 'ok' },
    { name: 'an unterminated OSC at the end is removed', text: 'ok\u001b]0;title', expected: 'ok' },
    {
      name: 'an OSC cut by another escape ends at that escape',
      text: '\u001b]0;t\u001b[31mx',
      expected: 'x',
    },
    { name: 'an OSC that never ends is removed to the end', text: 'ok\u001b]0;never ends', expected: 'ok' },
    {
      name: 'a character-set selection does not consume a newline',
      text: 'a\u001b(\nnext line',
      expected: 'a\nnext line',
    },
    {
      name: 'controls are removed before a carriage-return progress line',
      text: '50%\r\u0007',
      expected: '50%',
    },
    {
      name: 'remaining C0 controls are removed but tab and newline stay',
      text: '\u0000\u0007\u0008a\tb\nc\u001b',
      expected: 'a\tb\nc',
    },
    { name: 'DEL is removed', text: 'a\u007fb', expected: 'ab' },
    { name: 'non-string input is empty text', text: null, expected: '' },
    { name: 'a number is not output text', text: 42, expected: '' },
    { name: 'undefined is empty text', text: undefined, expected: '' },
  ]
  for (const item of cleanCases) {
    assert.equal(parts.cleanOutput(item.text), item.expected, item.name)
  }
})

test('apply registers the Jobs tab type and its body', () => {
  const jobs = makeJobsFake()
  const { plugin, ctx } = mountBundle(jobs)

  const tabType = ctx.__tabTypes.find(entry => entry.id === TAB_ID)
  assert.ok(tabType, 'no sidebar tab type registered with id ' + TAB_ID)
  assert.equal(tabType.kind, KIND, 'the Jobs tab type has its own kind')
  assert.equal(tabType.title(), 'Jobs', 'the tab title is Jobs')
  assert.equal(tabType.guide.length, 1, 'the tab type contributes exactly one guide entry')
  const guide = tabType.guide[0]
  assert.equal(guide.id, 'jobs')
  assert.equal(guide.order, 35)
  assert.equal(guide.title(), 'Jobs')
  assert.equal(guide.description(), 'Background jobs of this session and their live output')
  assert.equal(typeof guide.icon, 'function', 'the guide entry carries an icon component')

  const registration = jobsRegistration(ctx)
  assert.equal(registration.slot, SLOT)
  assert.equal(typeof registration.component, 'function', 'the tab body is a component')
  assert.equal(typeof registration.spec.inject, 'function', 'the body registration supplies its own props')

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
  assert.ok(plugin.inject.includes('jobs'), 'the merged plugin inject list contains jobs')
})

test('the tab lists the session\'s jobs, running first, and watches the roster while mounted', () => {
  const rows = [
    makeJob({ id: 'job-a', status: 'running', startedAt: 1_000, label: 'npm run test' }),
    makeJob({ id: 'job-b', status: 'completed', startedAt: 3_000, finishedAt: 4_000, label: 'npm run build' }),
    makeJob({ id: 'job-c', status: 'running', startedAt: 2_000, label: 'node scripts/watch.mjs' }),
  ]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    const props = () => makeBodyProps(renderer, registration)
    const tree = renderer.render(registration.component, props())
    assert.deepEqual(renderer.errors(), [], 'no render or effect may throw')

    const titles = collect(tree, node => node.type === 'span' && typeof node.props.title === 'string')
      .map(node => node.props.title)
    assert.deepEqual(
      titles,
      ['node scripts/watch.mjs', 'npm run test', 'npm run build'],
      'rows render in sortJobs order with each command label',
    )
    assert.deepEqual(jobs.calls.watch, ['s1'], 'watchRows was called once with the session id')

    jobs.setRows({})
    const empty = renderer.render(registration.component, props())
    assert.match(textOf(empty), /No background jobs in this session/, 'the empty session text renders')
  } finally {
    renderer.unmount()
  }
  assert.deepEqual(jobs.calls.watchStops, ['s1'], 'cleanup stopped the roster stream')
})

test('expanding a row streams its output and collapsing stops it', () => {
  const rows = [
    makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' }),
    makeJob({ id: 'job-2', status: 'completed', startedAt: 2_000, finishedAt: 3_000, label: 'npm run build' }),
  ]
  const observed = {
    'job-1': { jobId: 'job-1', text: '\u001b[32mhello\u001b[0m\n', gapBefore: false, streaming: true },
    'job-2': { jobId: 'job-2', text: 'built\n', gapBefore: false, streaming: false },
  }
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderer.render(registration.component, makeBodyProps(renderer, registration, { visible: true }))
    assert.deepEqual(jobs.calls.observe, [], 'a collapsed row opens no observation')

    rowButton(tree, 'npm run test').props.onClick()
    tree = renderer.render(registration.component, makeBodyProps(renderer, registration, { visible: true }))
    assert.deepEqual(jobs.calls.observe, [['s1', 'job-1']], 'expanding calls observe once with the session and job id')
    assert.match(textOf(tree), /hello/, 'the cleaned output text renders')
    assert.ok(!textOf(tree).includes('\u001b'), 'no escape sequence reaches the tree')

    rowButton(tree, 'npm run build').props.onClick()
    tree = renderer.render(registration.component, makeBodyProps(renderer, registration, { visible: true }))
    assert.deepEqual(
      jobs.calls.observe,
      [['s1', 'job-1'], ['s1', 'job-2']],
      'expanding a second row observes it too',
    )
    assert.deepEqual(jobs.calls.observeStops, [['s1', 'job-1']], 'expanding a second row stops the first stream')
    assert.deepEqual(Array.from(jobs.openObservations.keys()), ['job-2'], 'only the one expanded row is observed')
    assert.match(textOf(tree), /built/, 'the second row renders its own output')

    rowButton(tree, 'npm run build').props.onClick()
    tree = renderer.render(registration.component, makeBodyProps(renderer, registration, { visible: true }))
    assert.deepEqual(jobs.calls.observeStops.at(-1), ['s1', 'job-2'], 'collapsing calls the observation stop')
    assert.equal(jobs.openObservations.size, 0, 'a collapsed row leaves no stream open')

    rowButton(tree, 'npm run build').props.onClick()
    tree = renderer.render(registration.component, makeBodyProps(renderer, registration, { visible: true }))
    assert.equal(jobs.openObservations.size, 1, 're-expanding opens the stream again')

    tree = renderer.render(registration.component, makeBodyProps(renderer, registration, { visible: false }))
    assert.equal(jobs.openObservations.size, 0, 'a hidden tab closes the observation')
    assert.deepEqual(jobs.calls.observeStops.at(-1), ['s1', 'job-2'], 'hiding the tab calls the stop function')
    const openedWhileHidden = jobs.calls.observe.length
    tree = renderer.render(registration.component, makeBodyProps(renderer, registration, { visible: false }))
    assert.equal(jobs.calls.observe.length, openedWhileHidden, 'a hidden tab opens no observation')
    assert.equal(jobs.openObservations.size, 0, 'a hidden tab keeps no stream open')

    tree = renderer.render(registration.component, makeBodyProps(renderer, registration, { visible: true }))
    assert.equal(jobs.openObservations.size, 1, 'showing the tab reopens the expanded row stream')
    assert.ok(tree, 'the body renders while visible')
  } finally {
    renderer.unmount()
  }
  assert.equal(jobs.openObservations.size, 0, 'unmount leaves no observation open')
})

test('stopping a job takes two presses', async () => {
  const rows = [
    makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' }),
    makeJob({
      id: 'job-2',
      status: 'completed',
      startedAt: 2_000,
      finishedAt: 3_000,
      label: 'npm run build',
      detail: 'exit code: 0',
    }),
  ]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} }, killResult: { ok: true } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    const props = () => makeBodyProps(renderer, registration)
    let tree = renderer.render(registration.component, props())
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderer.render(registration.component, props())

    let stop = buttonWithText(tree, 'Stop')
    assert.equal(stop.length, 1, 'a running expanded row shows one stop control')
    await stop[0].props.onClick()
    tree = renderer.render(registration.component, props())
    assert.deepEqual(jobs.calls.kill, [], 'the first press only arms the control')
    assert.equal(buttonWithText(tree, 'Confirm stop').length, 1, 'the first press turns Stop into Confirm stop')

    await buttonWithText(tree, 'Confirm stop')[0].props.onClick()
    tree = renderer.render(registration.component, props())
    assert.deepEqual(jobs.calls.kill, [['s1', 'job-1']], 'the second press kills the job once with the session and job id')

    jobs.setKillResult({ ok: false })
    await buttonWithText(tree, 'Stop')[0].props.onClick()
    tree = renderer.render(registration.component, props())
    await buttonWithText(tree, 'Confirm stop')[0].props.onClick()
    tree = renderer.render(registration.component, props())
    assert.match(textOf(tree), /Could not stop the job/, 'a false kill result renders the error line')
    assert.deepEqual(jobs.calls.kill.at(-1), ['s1', 'job-1'], 'the refused kill still names the running job')

    rowButton(tree, 'npm run build').props.onClick()
    tree = renderer.render(registration.component, props())
    assert.equal(buttonWithText(tree, 'Stop').length, 0, 'a settled job has no stop control')
    assert.equal(buttonWithText(tree, 'Confirm stop').length, 0, 'a settled job never shows Confirm stop')
  } finally {
    renderer.unmount()
  }
})

test('the row header reflects the expanded row', () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration)
    assert.equal(rowButton(tree, 'npm run test').props['aria-expanded'], false, 'a collapsed header reports false')
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    assert.equal(rowButton(tree, 'npm run test').props['aria-expanded'], true, 'an expanded header reports true')
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    assert.equal(rowButton(tree, 'npm run test').props['aria-expanded'], false, 'a collapsed header reports false again')
  } finally {
    renderer.unmount()
  }
})

test('the row header names the status and command and controls the expanded region', () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration)
    let header = rowButton(tree, 'npm run test')
    assert.equal(
      header.props['aria-label'],
      'Running: npm run test',
      'the accessible name carries the status and the command, not the ticking duration',
    )
    assert.equal(header.props['aria-controls'], undefined, 'a collapsed header controls no region')

    header.props.onClick()
    tree = renderBody(renderer, registration)
    header = rowButton(tree, 'npm run test')
    const controls = header.props['aria-controls']
    assert.ok(typeof controls === 'string' && controls !== '', 'the expanded header points at its region')
    const regions = collect(tree, node => node.props && node.props.id === controls)
    assert.equal(regions.length, 1, 'exactly one expanded region carries the id the header names')
  } finally {
    renderer.unmount()
  }
})

test('each row shows its elapsed duration', () => {
  const rows = [
    makeJob({ id: 'job-1', status: 'completed', startedAt: 1_000, finishedAt: 13_000, label: 'npm run build' }),
  ]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    const tree = renderBody(renderer, registration)
    assert.match(textOf(rowButton(tree, 'npm run build')), /12s/, 'the settled row shows finishedAt minus startedAt')
  } finally {
    renderer.unmount()
  }
})

test('a settled row shows its terminal detail instead of progress', () => {
  const rows = [
    makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, progress: '3/10', label: 'npm run test' }),
    makeJob({
      id: 'job-2',
      status: 'completed',
      startedAt: 1_000,
      finishedAt: 2_000,
      progress: '9/10',
      detail: 'exit code: 0',
      label: 'npm run build',
    }),
  ]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    const tree = renderBody(renderer, registration)
    assert.match(textOf(rowButton(tree, 'npm run test')), /3\/10/, 'a live row shows its progress line')
    assert.match(textOf(rowButton(tree, 'npm run build')), /exit code: 0/, 'a settled row shows its terminal detail')
    assert.ok(
      !textOf(rowButton(tree, 'npm run build')).includes('9/10'),
      'a settled row does not keep showing progress',
    )
  } finally {
    renderer.unmount()
  }
})

test('a stopping job offers no stop control', () => {
  const rows = [makeJob({ id: 'job-1', status: 'stopping', startedAt: 1_000, label: 'npm run test' })]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration)
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    assert.equal(buttonWithText(tree, 'Stop').length, 0, 'a stopping job has no armed stop control')
    assert.equal(buttonWithText(tree, 'Confirm stop').length, 0, 'a stopping job has no confirming control')
  } finally {
    renderer.unmount()
  }
})

test('the confirm state reverts after three seconds', async () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer, timers } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration)
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    await buttonWithText(tree, 'Stop')[0].props.onClick()
    tree = renderBody(renderer, registration)
    const timer = timers.pending('timeout').find(entry => entry.delay === 3000)
    assert.ok(timer, 'the first press schedules the three-second revert')
    timers.fire(timer)
    tree = renderBody(renderer, registration)
    assert.equal(buttonWithText(tree, 'Stop').length, 1, 'the control is armed again after the revert')
    assert.equal(buttonWithText(tree, 'Confirm stop').length, 0, 'the confirming label is gone after the revert')
  } finally {
    renderer.unmount()
  }
})

test('collapsing or unmounting clears the pending confirm timer', async () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer, timers } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration)
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    await buttonWithText(tree, 'Stop')[0].props.onClick()
    tree = renderBody(renderer, registration)
    const collapsedTimer = timers.pending('timeout').find(entry => entry.delay === 3000)
    assert.ok(collapsedTimer, 'the first press schedules the revert timer')
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    assert.ok(
      timers.clearsFor('timeout').some(entry => entry.id === collapsedTimer.id),
      'collapsing the row clears the pending revert timer',
    )
    assert.equal(timers.pending('timeout').length, 0, 'no revert timer survives the collapse')

    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    await buttonWithText(tree, 'Stop')[0].props.onClick()
    tree = renderBody(renderer, registration)
    const unmountTimer = timers.pending('timeout').find(entry => entry.delay === 3000)
    assert.ok(unmountTimer, 'the re-armed control schedules its own revert timer')
    renderer.unmount()
    assert.ok(
      timers.clearsFor('timeout').some(entry => entry.id === unmountTimer.id),
      'unmounting the row clears the pending revert timer',
    )
    assert.equal(timers.pending('timeout').length, 0, 'no revert timer survives the unmount')
  } finally {
    renderer.unmount()
  }
})

test('a rejected kill shows the stop error', async () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const jobs = makeJobsFake({
    snapshot: { rows: { s1: rows }, observed: {} },
    killResult: () => Promise.reject(new Error('kill failed')),
  })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration)
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    await buttonWithText(tree, 'Stop')[0].props.onClick()
    tree = renderBody(renderer, registration)
    await buttonWithText(tree, 'Confirm stop')[0].props.onClick()
    tree = renderBody(renderer, registration)
    assert.match(textOf(tree), /Could not stop the job/, 'a rejected kill promise renders the error line')
  } finally {
    renderer.unmount()
  }
})

test('arming a retry clears an earlier stop error', async () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} }, killResult: { ok: false } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration)
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    await buttonWithText(tree, 'Stop')[0].props.onClick()
    tree = renderBody(renderer, registration)
    await buttonWithText(tree, 'Confirm stop')[0].props.onClick()
    tree = renderBody(renderer, registration)
    assert.match(textOf(tree), /Could not stop the job/, 'the refused stop leaves the error line')

    await buttonWithText(tree, 'Stop')[0].props.onClick()
    tree = renderBody(renderer, registration)
    assert.equal(buttonWithText(tree, 'Confirm stop').length, 1, 'the retry arms the control again')
    assert.ok(!textOf(tree).includes('Could not stop the job'), 'arming a retry clears the earlier stop error')
  } finally {
    renderer.unmount()
  }
})

test('the expanded row explains dropped output', () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const observed = { 'job-1': { jobId: 'job-1', text: 'tail\n', gapBefore: true, streaming: true } }
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration)
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    assert.match(textOf(tree), /Earlier output was dropped/, 'dropped output is named above the tail')
  } finally {
    renderer.unmount()
  }
})

test('the expanded row shows the observation error', () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const observed = {
    'job-1': { jobId: 'job-1', text: '', gapBefore: false, streaming: true, error: 'stream broke' },
  }
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration)
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    assert.match(textOf(tree), /stream broke/, 'the observation error is rendered')
  } finally {
    renderer.unmount()
  }
})

test('an expanded row with no output says so', () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration)
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    assert.match(textOf(tree), /No output yet/, 'an empty tail says so')
  } finally {
    renderer.unmount()
  }
})

test('the duration timer ticks once a second only while the tab is visible', () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer, timers } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration, { visible: true })
    assert.equal(timers.intervals.length, 1, 'a live visible tab schedules one duration interval')
    assert.equal(timers.intervals[0].delay, 1000, 'the duration interval ticks once a second')
    const interval = timers.pending('interval')[0]
    assert.ok(interval, 'the duration interval is pending')

    tree = renderBody(renderer, registration, { visible: false })
    assert.equal(timers.intervals.length, 1, 'a hidden tab schedules no new duration interval')
    assert.ok(
      timers.clearsFor('interval').some(entry => entry.id === interval.id),
      'hiding the tab clears the duration interval',
    )
    assert.equal(timers.pending('interval').length, 0, 'no duration interval runs while hidden')
    assert.ok(tree, 'the hidden body still renders')
  } finally {
    renderer.unmount()
  }
})

test('the duration timer is cleared on unmount', () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer, timers } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  renderBody(renderer, registration, { visible: true })
  const interval = timers.pending('interval')[0]
  assert.ok(interval, 'the live visible tab schedules the duration interval')
  renderer.unmount()
  assert.ok(
    timers.clearsFor('interval').some(entry => entry.id === interval.id),
    'unmounting clears the duration interval',
  )
  assert.equal(timers.pending('interval').length, 0, 'no duration interval survives the unmount')
})

test('the output view follows new output unless the user scrolled up', () => {
  const rows = [makeJob({ id: 'job-1', status: 'running', startedAt: 1_000, label: 'npm run test' })]
  const observed = { 'job-1': { jobId: 'job-1', text: 'first\n', gapBefore: false, streaming: true } }
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed } })
  const { ctx, renderer } = mountBundle(jobs)
  const preNode = renderer.preNode
  const registration = jobsRegistration(ctx)

  try {
    let tree = renderBody(renderer, registration)
    rowButton(tree, 'npm run test').props.onClick()
    tree = renderBody(renderer, registration)
    assert.ok(collect(tree, node => node.type === 'pre')[0], 'the expanded row renders the output pre')

    preNode.scrollHeight = 400
    preNode.clientHeight = 100
    preNode.scrollTop = 0
    jobs.setObserved({ 'job-1': { jobId: 'job-1', text: 'first\nsecond\n', gapBefore: false, streaming: true } })
    tree = renderBody(renderer, registration)
    assert.equal(preNode.scrollTop, 400, 'new output moves the tail to the end')

    preNode.scrollTop = 100
    collect(tree, node => node.type === 'pre')[0].props.onScroll({ currentTarget: preNode })
    jobs.setObserved({
      'job-1': { jobId: 'job-1', text: 'first\nsecond\nthird\n', gapBefore: false, streaming: true },
    })
    tree = renderBody(renderer, registration)
    assert.equal(preNode.scrollTop, 100, 'a scrolled-up reader keeps their position')
  } finally {
    renderer.unmount()
  }
})

test('the state marks of the Jobs tab differ by status', () => {
  const rows = [
    makeJob({ id: 'job-run', status: 'running', startedAt: 5_000, label: 'run the tests' }),
    makeJob({ id: 'job-stop-now', status: 'stopping', startedAt: 4_500, label: 'quitting sweep' }),
    makeJob({ id: 'job-done', status: 'completed', startedAt: 3_000, finishedAt: 4_000, label: 'completed build' }),
    makeJob({ id: 'job-stop', status: 'killed', startedAt: 2_000, finishedAt: 3_000, label: 'stopped watch' }),
    makeJob({ id: 'job-fail', status: 'failed', startedAt: 1_000, finishedAt: 2_000, label: 'failed server' }),
  ]
  const jobs = makeJobsFake({ snapshot: { rows: { s1: rows }, observed: {} } })
  const { ctx, renderer } = mountBundle(jobs)
  const registration = jobsRegistration(ctx)

  try {
    const tree = renderBody(renderer, registration)
    assert.deepEqual(renderer.errors(), [], 'no render or effect may throw')
    const names = ['running', 'stopping', 'completed', 'stopped', 'failed']
    const marks = ['run the tests', 'quitting sweep', 'completed build', 'stopped watch', 'failed server'].map(label =>
      markOf(rowButton(tree, label)),
    )
    for (let left = 0; left < marks.length; left += 1) {
      for (let right = left + 1; right < marks.length; right += 1) {
        assert.notDeepEqual(
          marks[left],
          marks[right],
          'the ' + names[left] + ' and ' + names[right] + ' marks differ',
        )
      }
    }
    assert.equal(marks[3].background, 'transparent', 'the stopped mark has a transparent background')
    assert.equal(marks[3].boxSizing, 'border-box', 'the hollow mark keeps its 8 px size inside its border')

    /* Only failed and stopping tint their label; the rest keep the ordinary text color. */
    assert.equal(
      stateLabelOf(rowButton(tree, 'run the tests'), 'Running').props.style.color,
      undefined,
      'the Running label keeps the ordinary text color',
    )
    assert.equal(
      stateLabelOf(rowButton(tree, 'completed build'), 'Completed').props.style.color,
      undefined,
      'the Completed label keeps the ordinary text color',
    )
    assert.equal(
      stateLabelOf(rowButton(tree, 'quitting sweep'), 'Stopping').props.style.color,
      marks[1].background,
      'the Stopping label carries its warn tone',
    )
    assert.equal(
      stateLabelOf(rowButton(tree, 'failed server'), 'Failed').props.style.color,
      marks[4].background,
      'the Failed label carries its error tone',
    )
  } finally {
    renderer.unmount()
  }
})

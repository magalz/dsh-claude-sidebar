/**
 * Acceptance tests for the Git tab (features/git/client/git.js) and the Environment
 * Changes rows that open it.
 *
 * The tab is driven through the real generated client.js: a fake
 * window.__ModuleLoader__, a minimal React stub that keeps hook state and runs
 * dependency-aware effects, fake useTabInfo / navigation / actions props, a fake
 * fetch for both Git routes (with deferred answers), fake setInterval/clearInterval
 * and a fake document. navigation is a plain value { address, params, revision }
 * delivered by useTabInfo(); navigating replaces it and re-renders the body.
 * tab.signal is one AbortSignal per open tab. Fakes only; no dsh process.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLIENT = path.join(ROOT, 'client.js')
const SLOT = 'sidebar.right.pane.tab'
const TAB_ID = 'dsh-claude-sidebar/git'
const KIND = 'claude-sidebar-git'
const ROUTE = '/dsh-claude-sidebar/git'
const DIFF_ROUTE = '/dsh-claude-sidebar/git/diff'
const REFRESH_MS = 12_000
const ENV_TAB_ID = 'dsh-claude-sidebar/environment'
const SUCCESS = 'var(--dsw-alias-state-success-primary, #2e9e5b)'
const WARN = 'var(--dsw-alias-state-warn-primary, #c98a00)'
const ERROR = 'var(--dsw-alias-state-error-primary, #d64545)'
const SECONDARY = 'var(--dsw-alias-label-secondary, inherit)'
const SUCCESS_TINT = 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #2da44e) 12%, transparent)'
const ERROR_TINT = 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 12%, transparent)'

/* ------------------------------------------------------------------ */
/* A small React stub with instance state and dependency-aware effects  */
/* ------------------------------------------------------------------ */

function makeRenderer(options = {}) {
  const instances = new Map()
  const errors = []
  const scrolls = []
  const rootWidth = options.rootWidth ?? 320
  let current = null
  let committing = false

  function instanceOf(key) {
    let instance = instances.get(key)
    if (instance === undefined) {
      instance = { key, hooks: [], cursor: 0, effects: [], memo: new Map(), stored: new Map(), dead: false }
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
        if (ref.current === null) {
          const node = {
            width: rootWidth,
            focused: false,
            getBoundingClientRect: () => ({ width: node.width, height: 0, top: 0, left: 0, right: node.width, bottom: 0 }),
            focus: () => { node.focused = true },
            contains: () => false,
            scrollIntoView: arg => { scrolls.push(arg) },
          }
          ref.current = node
        }
        element.__node = ref.current
      }
      return element
    },
    Component: class {
      constructor(props) { this.props = props; this.state = {} }
      setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
    },
    Fragment: 'Fragment',
    useState(initial) {
      const index = hookIndex()
      const instance = current
      if (!(index in instance.hooks)) {
        instance.hooks[index] = typeof initial === 'function' ? initial() : initial
      }
      const setter = next => {
        if (instance.dead) { errors.push(new Error('setState after unmount')); return }
        const value = typeof next === 'function' ? next(instance.hooks[index]) : next
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
    useEffect(fn, deps) { current.effects.push({ index: hookIndex(), fn, deps }) },
    useLayoutEffect(fn, deps) { current.effects.push({ index: hookIndex(), fn, deps }) },
    useMemo(fn, deps) {
      const index = hookIndex()
      const stored = current.memo.get(index)
      if (stored !== undefined && sameDeps(stored.deps, deps)) return stored.value
      const value = fn()
      current.memo.set(index, { deps, value })
      return value
    },
    useCallback(fn) { return fn },
  }

  function sameDeps(before, after) {
    if (before === undefined || after === undefined) return false
    if (!Array.isArray(before) || !Array.isArray(after)) return false
    if (before.length !== after.length) return false
    for (let i = 0; i < before.length; i += 1) if (!Object.is(before[i], after[i])) return false
    return true
  }

  function runCleanup(stored) {
    if (typeof stored.cleanup !== 'function') return
    try { stored.cleanup() } catch (error) { errors.push(error) }
  }

  function renderInstance(instance, type, props) {
    const previous = current
    current = instance
    instance.cursor = 0
    instance.effects = []
    let tree = null
    try { tree = type(props) } catch (error) { errors.push(error) } finally { current = previous }
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
        try { cleanup = effect.fn() } catch (error) { errors.push(error) }
        instance.stored.set(effect.index, { deps: effect.deps, cleanup })
      }
    } finally { committing = false }
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
    if (Array.isArray(node)) return node.map((child, index) => resolve(child, nodePath + '/' + index, live, order))
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
      for (const [key, instance] of Array.from(instances.entries())) if (!live.has(key)) unmount(instance)
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
    scrolls,
  }
}

/* ------------------------------------------------------------------ */
/* Timers, document, fetch and the navigation value fake                  */
/* ------------------------------------------------------------------ */

function makeTimers() {
  let nextId = 1
  const active = new Map()
  const intervals = []
  const clears = []
  return {
    setTimeout(fn, delay) { const e = { id: nextId++, delay, fn, kind: 'timeout' }; active.set(e.id, e); return e.id },
    clearTimeout(id) { clears.push({ kind: 'timeout', id }); active.delete(id) },
    setInterval(fn, delay) { const e = { id: nextId++, delay, fn, kind: 'interval' }; active.set(e.id, e); intervals.push(e); return e.id },
    clearInterval(id) { clears.push({ kind: 'interval', id }); active.delete(id) },
    pending(kind) { return Array.from(active.values()).filter(e => kind === undefined || e.kind === kind) },
    fire(entry) { if (entry.kind === 'timeout') active.delete(entry.id); entry.fn() },
    clearsFor(kind) { return clears.filter(e => e.kind === kind) },
    intervals,
  }
}

function makeDocument() {
  const listeners = new Map()
  return {
    visibilityState: 'visible',
    baseURI: 'http://127.0.0.1:55122/',
    activeElement: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
    dispatch(type) { for (const fn of Array.from(listeners.get(type) ?? [])) fn() },
    listenerCount(type) { return listeners.get(type)?.size ?? 0 },
  }
}

/** The plain navigation value the body hook delivers through useTabInfo(). */
function navValue(revision, path, address = KIND) {
  return { address, params: path === undefined ? {} : { path }, revision }
}

/** One AbortSignal per open tab; survives hiding/remount, dies only on close. */
function makeTabSignal() {
  return new AbortController().signal
}

/** The sidebarRight.openTabs store: same store contract, holds open-tab records. */
function makeOpenTabsStore(initial = []) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      snapshot = next
      for (const listener of Array.from(listeners)) listener()
    },
  }
}

function reply(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((next, fail) => { resolve = next; reject = fail })
  return { promise, resolve, reject }
}

/** A thenable that settles synchronously, for the gate's feature-list fetch in apply(). */
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

/** A recording fake fetch for both Git routes and the gate's feature list. */
function makeFetch(options = {}) {
  const calls = []
  const diffCalls = []
  const featureCalls = []
  const names = options.features ?? ['rail', 'jobs', 'subagents', 'environment', 'run', 'git', 'sizing', 'browser']
  let currentAnswer = options.answer ?? (() => reply(FULL_ANSWER))
  let currentDiff = options.diffAnswer ?? (() => reply(DIFF_ANSWER))
  const fetch = (url, init) => {
    if (String(url).endsWith('/dsh-claude-sidebar/features')) {
      featureCalls.push({ url, init })
      return syncChain({ ok: true, status: 200, json: () => syncChain({ features: names }) })
    }
    if (String(url).startsWith(DIFF_ROUTE + '?')) {
      diffCalls.push({ url, init })
      return Promise.resolve(currentDiff(url, init, diffCalls.length))
    }
    calls.push({ url, init })
    return Promise.resolve(currentAnswer(url, init, calls.length))
  }
  return {
    fetch,
    calls,
    diffCalls,
    featureCalls,
    setAnswer(next) { currentAnswer = next },
    setDiffAnswer(next) { currentDiff = next },
  }
}

/** Evaluate the generated client.js and apply the whole plugin against a recording ctx. */
function mountBundle(options = {}) {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const timers = makeTimers()
  const document = makeDocument()
  const network = makeFetch(options)
  const warnings = []
  let definition = null
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    console: { info() {}, warn(...args) { warnings.push(args) }, error() {}, log() {}, debug() {} },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    document,
    fetch: network.fetch,
    localStorage: { length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
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

  const renderer = makeRenderer()
  const plugin = definition.factory(name => {
    if (name === 'react') return renderer.React
    throw new Error('unexpected require: ' + name)
  })
  const openTabs = options.openTabs ?? makeOpenTabsStore()
  const ctx = makeCtx({ openTabs })
  plugin.apply(ctx)
  for (const { callback } of ctx.__injections) callback()
  return { ctx, plugin, renderer, timers, document, network, warnings, openTabs }
}

function makeCtx(options = {}) {
  const tabTypes = []
  const registrations = []
  const injections = []
  const effects = []
  return {
    get(name) { return name === 'sidebarRight' ? { openTabs: options.openTabs } : undefined },
    sidebarRight: { openTabs: options.openTabs },
    sidebarRightTabs: {
      register(definition) { tabTypes.push(definition); return () => {} },
    },
    slots: {
      inject(slot, callback) { injections.push({ slot, callback }); return () => {} },
      register(spec, component) { registrations.push({ slot: spec.name, spec, component }); return () => {} },
    },
    effect(callback) {
      const dispose = callback()
      if (dispose !== undefined && typeof dispose !== 'function') throw new Error('Invalid effect')
      effects.push(dispose)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    __tabTypes: tabTypes,
    __registrations: registrations,
    __injections: injections,
    __effects: effects,
  }
}

/* ------------------------------------------------------------------ */
/* Body props, rendering and tree helpers                               */
/* ------------------------------------------------------------------ */

function makeBodyProps(options = {}) {
  const openTab = options.openTab ?? (() => {})
  return {
    sessionId: options.sessionId === undefined ? 's1' : options.sessionId,
    useTabInfo: () => ({
      tab: {
        id: options.tabId ?? 'git-tab-1',
        signal: options.signal ?? makeTabSignal(),
        visible: options.visible !== false,
        navigation: options.navigation,
        actions: { openTab },
      },
      panel: { id: options.panelId ?? 'A', isFloating: false },
    }),
    useProjection: () => undefined,
  }
}

function gitRegistration(ctx) {
  const found = ctx.__registrations.find(entry => entry.slot === SLOT && entry.spec.key === TAB_ID)
  assert.ok(found, 'no Git tab body registered in ' + SLOT + ' with key ' + TAB_ID)
  return found
}

function environmentRegistration(ctx) {
  const found = ctx.__registrations.find(entry => entry.slot === SLOT && entry.spec.key === ENV_TAB_ID)
  assert.ok(found, 'no Environment tab body registered in ' + SLOT + ' with key ' + ENV_TAB_ID)
  return found
}

function renderBody(renderer, registration, options = {}) {
  const injected = typeof registration.spec.inject === 'function' ? registration.spec.inject() : undefined
  return renderer.render(registration.component, { ...makeBodyProps(options), ...(injected ?? {}) })
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve))
}

async function loadedBody(renderer, registration, options = {}) {
  renderBody(renderer, registration, options)
  await settle()
  return renderBody(renderer, registration, options)
}

function collect(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) { for (const child of node) collect(child, predicate, found); return found }
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

function hasTitle(tree, title) {
  return collect(tree, node => node.props !== undefined && node.props.title === title).length > 0
}

function refreshButton(tree) {
  const buttons = collect(tree, node => node.type === 'button' && textOf(node).trim() === 'Refresh')
  assert.equal(buttons.length, 1, 'the Git header renders one Refresh button')
  return buttons[0]
}

function sectionHeader(tree, id) {
  const headers = collect(tree, node => node.type === 'button' && node.props['data-section'] === id)
  assert.equal(headers.length, 1, 'the Git tab renders one ' + id + ' section header')
  return headers[0]
}

function sectionBody(tree, id) {
  const bodyId = sectionHeader(tree, id).props['aria-controls']
  const bodies = collect(tree, node => node.props !== undefined && node.props.id === bodyId)
  assert.equal(bodies.length, 1, 'the ' + id + ' header controls one existing body')
  return bodies[0]
}

function fileRow(tree, filePath) {
  const rows = collect(tree, node => node.props !== undefined && node.props['data-git-path'] === filePath)
  assert.equal(rows.length, 1, 'the Git tab renders one row for ' + filePath)
  return rows[0]
}

function diffPanel(tree, filePath) {
  const panels = collect(tree, node => node.props !== undefined && node.props['data-git-diff'] === filePath)
  assert.equal(panels.length, 1, 'the Git tab renders one diff panel for ' + filePath)
  return panels[0]
}

/* ------------------------------------------------------------------ */
/* Fixtures (the Host shapes from docs/specs/git-tab.md)                */
/* ------------------------------------------------------------------ */

const ago = ms => new Date(Date.now() - ms).toISOString()
const HOUR = 3_600_000
const DAY = 24 * HOUR

const FULL_ANSWER = {
  cwd: 'D:\\Repos\\project',
  git: true,
  repo: {
    root: 'D:/Repos/project',
    branch: 'main',
    detached: false,
    upstream: 'origin/main',
    ahead: 2,
    behind: 3,
    head: 'f20ca4b',
  },
  files: [
    { path: 'src/a.js', origPath: null, index: 'M', worktree: '.', kind: 'staged', added: 3, deleted: 1, binary: false },
    { path: 'src/b.js', origPath: 'src/old-b.js', index: 'R', worktree: '.', kind: 'staged', added: 2, deleted: 2, binary: false },
    { path: 'src/c.js', origPath: null, index: '.', worktree: 'M', kind: 'unstaged', added: 1, deleted: 4, binary: false },
    { path: 'img/logo.png', origPath: null, index: 'A', worktree: '.', kind: 'staged', added: null, deleted: null, binary: true },
    { path: 'new.txt', origPath: null, index: '?', worktree: '?', kind: 'untracked', added: null, deleted: null, binary: false },
    { path: 'dump/', origPath: null, index: '?', worktree: '?', kind: 'untracked', folder: true, added: null, deleted: null, binary: false },
    { path: 'conflict.js', origPath: null, index: 'U', worktree: 'U', kind: 'conflicted', added: 5, deleted: 0, binary: false },
  ],
  total: 9,
  truncated: true,
  commits: [
    { hash: 'f20ca4b', subject: 'Fix login flow', author: 'Name', date: ago(3 * HOUR) },
    { hash: 'a1b2c3d', subject: 'Add tests', author: 'Other', date: ago(2 * DAY) },
  ],
  errors: {},
}
const DIFF_ANSWER = {
  path: 'src/a.js',
  kind: 'staged',
  binary: false,
  truncated: false,
  hunks: [
    {
      header: '@@ -1,4 +1,6 @@',
      lines: [
        { type: 'context', text: 'a', old: 1, new: 1 },
        { type: 'del', text: 'b', old: 2, new: null },
        { type: 'add', text: 'c', old: null, new: 2 },
        { type: 'note', text: '\\ No newline at end of file', old: null, new: null },
      ],
    },
  ],
}

const ENV_ANSWER = {
  machine: { hostname: 'machine', platform: 'linux' },
  cwd: 'D:\\Repos\\project',
  task: { git: { root: 'D:/Repos/project', branch: 'main' } },
  changes: {
    total: 3,
    staged: 1,
    unstaged: 1,
    untracked: 1,
    files: [
      { path: 'src/a.js', index: 'M', worktree: '.', kind: 'staged' },
      { path: 'new.txt', index: '?', worktree: '?', kind: 'untracked' },
      { path: 'dump/', index: '?', worktree: '?', kind: 'untracked', folder: true },
    ],
  },
  errors: {},
}

/* ------------------------------------------------------------------ */
/* Tests                                                                */
/* ------------------------------------------------------------------ */

test('apply registers the Git tab type and its body', () => {
  const { ctx } = mountBundle()
  const tab = ctx.__tabTypes.find(definition => definition.id === TAB_ID)
  assert.ok(tab, 'no tab type registered with id ' + TAB_ID)
  assert.equal(tab.kind, KIND)
  assert.equal(tab.title(), 'Git')
  assert.equal(tab.guide.length, 1, 'the Git tab contributes exactly one guide entry')
  const guide = tab.guide[0]
  assert.equal(guide.id, 'git')
  assert.equal(typeof guide.order, 'number')
  assert.equal(guide.title(), 'Git')
  assert.equal(
    guide.description(),
    "Branch, changed files with their diffs, and recent commits of this session's folder",
  )
  assert.equal(typeof guide.icon, 'function', 'the guide entry draws a branch icon')
  gitRegistration(ctx)
  const ids = ctx.__tabTypes.map(definition => definition.id)
  for (const id of ['dsh-claude-sidebar/jobs', 'dsh-claude-sidebar/subagents', ENV_TAB_ID]) {
    assert.ok(ids.includes(id), 'the ' + id + ' tab is still registered')
  }
})

test('the tab renders the header, changes and commits of the current answer', async () => {
  const { ctx, renderer, network } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const tree = await loadedBody(renderer, gitRegistration(ctx))
  const text = textOf(tree)

  assert.equal(network.calls.length, 1)
  assert.equal(network.calls[0].url, ROUTE + '?sessionId=' + encodeURIComponent('s1'))
  assert.equal(network.calls[0].init.cache, 'no-store')
  assert.equal(network.calls[0].init.credentials, 'same-origin')
  assert.ok(network.calls[0].init.signal instanceof AbortSignal)

  assert.ok(text.includes('main'), 'the branch name is in the header')
  assert.ok(text.includes('↑2'), 'the ahead count uses the up arrow')
  assert.ok(text.includes('↓3'), 'the behind count uses the down arrow')
  refreshButton(tree)

  const changes = sectionBody(tree, 'changes')
  const rows = collect(changes, node => node.props !== undefined && node.props['data-git-path'])
  assert.deepEqual(
    rows.map(node => node.props['data-git-path']),
    ['src/a.js', 'src/b.js', 'src/c.js', 'img/logo.png', 'new.txt', 'dump/', 'conflict.js'],
  )
  assert.equal(fileRow(tree, 'src/a.js').type, 'button', 'a file row is a button')
  assert.equal(fileRow(tree, 'dump/').type, 'div', 'an untracked folder row is plain')
  assert.ok(text.includes('src/old-b.js → src/b.js'), 'a rename shows origPath → path')
  assert.ok(text.includes('+3 −1'), 'the counts use +N −M')
  assert.ok(text.includes('binary'), 'a binary file says binary')
  assert.ok(text.includes('new'), 'an untracked file says new')
  assert.ok(text.includes('and 2 more'), 'the total over the cap becomes one more row')
  const letters = collect(changes, node => node.type === 'span' && node.props.style?.width === 14)
  assert.deepEqual(
    letters.map(node => textOf(node)),
    ['M', 'R', 'M', 'A', '?', '?', '!'],
    'one status letter per row, in row order',
  )
  assert.deepEqual(
    letters.map(node => node.props.style.color),
    [SUCCESS, SUCCESS, WARN, SUCCESS, SECONDARY, SECONDARY, ERROR],
    'staged is success, unstaged warn, untracked secondary, conflicted error',
  )

  const commits = collect(sectionBody(tree, 'commits'), node => node.props !== undefined && node.props['data-git-commit'])
  assert.equal(commits.length, 2)
  assert.ok(text.includes('Fix login flow'), 'the subject renders')
  assert.ok(text.includes('f20ca4b'), 'the short hash renders')
  assert.ok(text.includes('3h'), 'a recent commit uses an hour-relative date')
  assert.ok(text.includes('2d'), 'an older commit uses a day-relative date')
  for (let i = 0; i < commits.length; i += 1) {
    assert.equal(commits[i].props.title, FULL_ANSWER.commits[i].date, 'the full date is in the title')
  }
})

test('detached, missing upstream, not-a-git folder and clean tree states', async () => {
  const detached = structuredClone(FULL_ANSWER)
  detached.repo.detached = true
  detached.repo.upstream = null
  detached.repo.ahead = 0
  detached.repo.behind = 0
  let host = mountBundle({ answer: () => reply(detached) })
  let tree = await loadedBody(host.renderer, gitRegistration(host.ctx))
  let text = textOf(tree)
  assert.ok(text.includes('detached at f20ca4b'), 'a detached head names its short hash')
  assert.equal(text.includes('↑'), false, 'no ahead arrow without an upstream')
  assert.equal(text.includes('↓'), false, 'no behind arrow without an upstream')

  const noGit = { cwd: 'D:\\Repos\\plain', git: false, repo: null, files: [], total: 0, truncated: false, commits: [], errors: {} }
  host = mountBundle({ answer: () => reply(noGit) })
  tree = await loadedBody(host.renderer, gitRegistration(host.ctx))
  assert.ok(textOf(tree).includes('Not a git folder'))

  const clean = { ...FULL_ANSWER, files: [], total: 0, truncated: false }
  host = mountBundle({ answer: () => reply(clean) })
  tree = await loadedBody(host.renderer, gitRegistration(host.ctx))
  assert.ok(textOf(sectionBody(tree, 'changes')).includes('No changes'))
})

test('sections collapse and Refresh sits in the header, not in a section', async () => {
  const { ctx, renderer, network } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  let tree = await loadedBody(renderer, gitRegistration(ctx))
  assert.equal(sectionHeader(tree, 'changes').props['aria-expanded'], 'true')
  assert.equal(sectionHeader(tree, 'commits').props['aria-expanded'], 'true')
  sectionHeader(tree, 'changes').props.onClick()
  tree = renderBody(renderer, gitRegistration(ctx))
  assert.equal(sectionHeader(tree, 'changes').props['aria-expanded'], 'false')
  assert.equal(collect(sectionBody(tree, 'changes'), node => node.props !== undefined && node.props['data-git-path']).length, 0)
  assert.equal(sectionHeader(tree, 'commits').props['aria-expanded'], 'true', 'only the clicked section collapses')
  sectionHeader(tree, 'changes').props.onClick()
  tree = renderBody(renderer, gitRegistration(ctx))
  assert.equal(sectionHeader(tree, 'changes').props['aria-expanded'], 'true')

  const refresh = refreshButton(tree)
  assert.equal(collect(refresh, node => node === undefined).length, 0)
  assert.equal(sectionHeader(tree, 'changes').children.includes(refresh), false, 'Refresh is not inside a section header')
  refresh.props.onClick()
  tree = renderBody(renderer, gitRegistration(ctx))
  await settle()
  tree = renderBody(renderer, gitRegistration(ctx))
  assert.equal(network.calls.length, 2, 'Refresh asks the route again')
})

test('the tab polls only while visible and unmount releases its listeners', async () => {
  const { ctx, renderer, timers, document, network } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = gitRegistration(ctx)
  const props = visible => ({ visible })

  let tree = renderBody(renderer, registration, props(false))
  await settle()
  assert.equal(network.calls.length, 0, 'a hidden tab does not fetch at mount')
  assert.equal(timers.pending('interval').length, 0)
  assert.equal(document.listenerCount('visibilitychange'), 0)

  tree = renderBody(renderer, registration, props(true))
  await settle()
  tree = renderBody(renderer, registration, props(true))
  assert.equal(network.calls.length, 1, 'becoming visible fetches once')
  const polls = timers.pending('interval')
  assert.equal(polls.length, 1)
  assert.equal(polls[0].delay, REFRESH_MS, 'the poll uses the Environment cadence')
  assert.equal(document.listenerCount('visibilitychange'), 1)

  timers.fire(polls[0])
  await settle()
  tree = renderBody(renderer, registration, props(true))
  assert.equal(network.calls.length, 2, 'a tick while visible fetches')

  document.visibilityState = 'hidden'
  timers.fire(timers.pending('interval')[0])
  await settle()
  assert.equal(network.calls.length, 2, 'a tick while the document is hidden fetches nothing')
  document.visibilityState = 'visible'
  document.dispatch('visibilitychange')
  await settle()
  assert.equal(network.calls.length, 3, 'the document becoming visible fetches')

  refreshButton(tree).props.onClick()
  await settle()
  tree = renderBody(renderer, registration, props(true))
  assert.equal(network.calls.length, 4, 'Refresh fetches at once')

  tree = renderBody(renderer, registration, props(false))
  assert.equal(timers.pending('interval').length, 0, 'hiding clears the poll')
  assert.equal(document.listenerCount('visibilitychange'), 0)
  renderer.unmount()
  assert.deepEqual(renderer.errors(), [], 'no state update lands after unmount')
})

test('only the current session answer renders and an empty session fetches nothing', async () => {
  const second = deferred()
  let calls = 0
  const { ctx, renderer, network } = mountBundle({
    answer: () => {
      calls += 1
      if (calls === 1) return reply(FULL_ANSWER)
      if (calls === 2) return second.promise
      return reply({ error: 'no session' }, 404)
    },
  })
  const registration = gitRegistration(ctx)
  let tree = await loadedBody(renderer, registration, { sessionId: 's1' })
  assert.ok(textOf(tree).includes('Fix login flow'))

  tree = renderBody(renderer, registration, { sessionId: 's2' })
  assert.equal(textOf(tree).includes('Fix login flow'), false, 'the old session answer is gone')
  assert.equal(tree.props['aria-busy'], 'true', 'the panel stays busy while the new session loads')

  second.resolve(reply({ ...FULL_ANSWER, repo: { ...FULL_ANSWER.repo, branch: 's2-branch' }, commits: [] }))
  await settle()
  tree = renderBody(renderer, registration, { sessionId: 's2' })
  assert.ok(textOf(tree).includes('s2-branch'))
  assert.equal(textOf(tree).includes('Fix login flow'), false)

  tree = renderBody(renderer, registration, { sessionId: '' })
  assert.ok(textOf(tree).includes('No session'))
  assert.equal(network.calls.length, 2, 'an empty session fetches nothing')
})

test('expanding a file fetches its diff once with encoded params and renders every line kind', async () => {
  const { ctx, renderer, network } = mountBundle({
    answer: () => reply(FULL_ANSWER),
    diffAnswer: (url, init, call) => {
      assert.ok(String(url).startsWith(DIFF_ROUTE + '?'))
      return reply(DIFF_ANSWER)
    },
  })
  const registration = gitRegistration(ctx)
  let tree = await loadedBody(renderer, registration, { sessionId: 's 1' })
  fileRow(tree, 'src/a.js').props.onClick()
  tree = renderBody(renderer, registration, { sessionId: 's 1' })
  assert.equal(network.diffCalls.length, 1, 'the first expand fetches once')
  const controlsId = fileRow(tree, 'src/a.js').props['aria-controls']
  assert.ok(typeof controlsId === 'string' && controlsId !== '', 'a file row names its diff container')
  const containers = collect(tree, node => node.props !== undefined && node.props.id === controlsId)
  assert.equal(containers.length, 1, 'the aria-controls id belongs to exactly one container')
  assert.equal(containers[0].props['data-git-diff'], 'src/a.js', 'that container holds this file diff')
  assert.equal(
    network.diffCalls[0].url,
    DIFF_ROUTE + '?sessionId=' + encodeURIComponent('s 1') + '&path=' + encodeURIComponent('src/a.js'),
    'both query parameters are encoded',
  )

  await settle()
  tree = renderBody(renderer, registration, { sessionId: 's 1' })
  const panel = diffPanel(tree, 'src/a.js')
  assert.ok(textOf(panel).includes('@@ -1,4 +1,6 @@'), 'the hunk header renders')
  const lines = collect(panel, node => node.props !== undefined && typeof node.props['data-git-line-type'] === 'string')
  assert.deepEqual(
    lines.map(node => node.props['data-git-line-type']),
    ['context', 'del', 'add', 'note'],
  )
  assert.deepEqual(
    lines.map(line => textOf(collect(line, node => node.props !== undefined && node.props['data-git-line-text'] !== undefined)[0])),
    ['a', 'b', 'c', '\\ No newline at end of file'],
  )
  assert.equal(lines[1].props.style.color, ERROR, 'a del line uses the error color')
  assert.equal(lines[1].props.style.background, ERROR_TINT, 'a del line uses the faint error tint')
  assert.equal(lines[2].props.style.color, SUCCESS, 'an add line uses the success color')
  assert.equal(lines[2].props.style.background, SUCCESS_TINT, 'an add line uses the faint success tint')
  const numbers = collect(lines[0], node => node.type === 'span' && node.props.style?.fontFamily)
  assert.ok(numbers.length >= 2, 'each line has old and new number columns')
  assert.ok(textOf(numbers[0]) === '1' && textOf(numbers[1]) === '1', 'the context line shows both line numbers')
  assert.equal(network.diffCalls.length, 1, 're-rendering does not refetch')

  fileRow(tree, 'src/a.js').props.onClick()
  tree = renderBody(renderer, registration, { sessionId: 's 1' })
  assert.equal(fileRow(tree, 'src/a.js').props['aria-expanded'], 'false', 'the row collapses')
  fileRow(tree, 'src/a.js').props.onClick()
  tree = renderBody(renderer, registration, { sessionId: 's 1' })
  assert.equal(network.diffCalls.length, 1, 'collapsing and expanding again reuses the loaded diff')
  assert.ok(textOf(diffPanel(tree, 'src/a.js')).includes('@@ -1,4 +1,6 @@'), 'the loaded diff returns on re-expand')
})

test('Refresh refetches the diff of an expanded row', async () => {
  const { ctx, renderer, network } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = gitRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  fileRow(tree, 'src/a.js').props.onClick()
  tree = renderBody(renderer, registration)
  await settle()
  assert.equal(network.diffCalls.length, 1)

  refreshButton(tree).props.onClick()
  tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  assert.equal(network.calls.length, 2, 'Refresh refetches the main route')
  assert.equal(network.diffCalls.length, 2, 'Refresh refetches the expanded diff')
  assert.equal(network.diffCalls[1].url, network.diffCalls[0].url)
})

test('binary, too-large, truncated and failed diff reads each have their own state', async () => {
  const answers = {
    'img/logo.png': { path: 'img/logo.png', binary: true, truncated: false, hunks: [] },
    'src/b.js': { path: 'src/b.js', binary: false, tooLarge: true, truncated: true, hunks: [] },
    'src/c.js': { path: 'src/c.js', binary: false, truncated: true, hunks: [] },
    'conflict.js': null,
  }
  const { ctx, renderer, network } = mountBundle({
    answer: () => reply(FULL_ANSWER),
    diffAnswer: (url, init) => {
      const filePath = new URL(url, 'http://localhost/').searchParams.get('path')
      if (filePath === 'conflict.js') return Promise.reject(new Error('diff read failed'))
      return reply(answers[filePath] ?? DIFF_ANSWER)
    },
  })
  const registration = gitRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  for (const filePath of Object.keys(answers)) {
    fileRow(tree, filePath).props.onClick()
    tree = renderBody(renderer, registration)
  }
  await settle()
  tree = renderBody(renderer, registration)
  assert.ok(textOf(diffPanel(tree, 'img/logo.png')).includes('Binary file'))
  assert.ok(textOf(diffPanel(tree, 'src/b.js')).includes('Diff too large to show'))
  assert.equal(textOf(diffPanel(tree, 'src/b.js')).includes('Diff truncated'), false, 'tooLarge owns the message')
  assert.ok(textOf(diffPanel(tree, 'src/c.js')).includes('Diff truncated'))
  assert.ok(textOf(diffPanel(tree, 'conflict.js')).includes('diff read failed'))
  const statuses = collect(diffPanel(tree, 'conflict.js'), node => node.type === 'p' && node.props.role === 'status')
  assert.equal(statuses.length, 1, 'a diff error is a status message')
  assert.equal(network.diffCalls.length, 4, 'each expanded row fetched once')
})

test('Refresh keeps the current diff visible until the new answer arrives', async () => {
  const refreshed = deferred()
  let call = 0
  const { ctx, renderer, network } = mountBundle({
    answer: () => reply(FULL_ANSWER),
    diffAnswer: () => {
      call += 1
      return call === 1 ? reply(DIFF_ANSWER) : refreshed.promise
    },
  })
  const registration = gitRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  fileRow(tree, 'src/a.js').props.onClick()
  tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  assert.ok(textOf(diffPanel(tree, 'src/a.js')).includes('@@ -1,4 +1,6 @@'), 'the first diff is shown')

  refreshButton(tree).props.onClick()
  tree = renderBody(renderer, registration)
  const during = textOf(diffPanel(tree, 'src/a.js'))
  assert.ok(during.includes('@@ -1,4 +1,6 @@'), 'the old diff stays while Refresh is in flight')
  assert.equal(during.includes('Loading diff…'), false, 'Refresh does not flash Loading over a shown diff')

  refreshed.resolve(reply({
    ...DIFF_ANSWER,
    hunks: [{ header: '@@ -9,9 +9,9 @@', lines: [{ type: 'add', text: 'fresh line', old: null, new: 9 }] }],
  }))
  await settle()
  tree = renderBody(renderer, registration)
  assert.ok(textOf(diffPanel(tree, 'src/a.js')).includes('@@ -9,9 +9,9 @@'), 'the new answer replaces the old diff')
  assert.equal(network.diffCalls.length, 2)
})

test('a navigation revision is remembered across remounts of the tab', async () => {
  const signal = makeTabSignal()
  let navigation = navValue(0)
  const { ctx, renderer, network } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = gitRegistration(ctx)
  let tree = await loadedBody(renderer, registration, { navigation, signal })
  navigation = navValue(7, 'src/c.js')
  tree = renderBody(renderer, registration, { navigation, signal })
  await settle()
  tree = renderBody(renderer, registration, { navigation, signal })
  assert.equal(fileRow(tree, 'src/c.js').props['aria-expanded'], 'true')
  assert.equal(renderer.scrolls.length, 1)
  const diffCalls = network.diffCalls.length

  renderer.unmount()
  tree = await loadedBody(renderer, registration, { navigation, signal })
  assert.equal(fileRow(tree, 'src/c.js').props['aria-expanded'], 'false', 'the old path is not re-expanded on remount')
  assert.equal(renderer.scrolls.length, 1, 'the old path does not scroll again on remount')
  assert.equal(network.diffCalls.length, diffCalls, 'the old path does not refetch on remount')

  navigation = navValue(8, 'src/a.js')
  tree = renderBody(renderer, registration, { navigation, signal })
  await settle()
  tree = renderBody(renderer, registration, { navigation, signal })
  assert.equal(fileRow(tree, 'src/a.js').props['aria-expanded'], 'true', 'a newer revision still acts')
  assert.equal(renderer.scrolls.length, 2, 'the newer revision scrolls once')
})

test('diffs are keyed by session so a late answer cannot overwrite a newer session', async () => {
  const oldDiff = deferred()
  const newDiff = deferred()
  let call = 0
  const { ctx, renderer } = mountBundle({
    answer: () => reply(FULL_ANSWER),
    diffAnswer: () => {
      call += 1
      return call === 1 ? oldDiff.promise : newDiff.promise
    },
  })
  const registration = gitRegistration(ctx)
  let tree = await loadedBody(renderer, registration, { sessionId: 's1' })
  fileRow(tree, 'src/a.js').props.onClick()
  tree = renderBody(renderer, registration, { sessionId: 's1' })

  tree = await loadedBody(renderer, registration, { sessionId: 's2' })
  fileRow(tree, 'src/a.js').props.onClick()
  tree = renderBody(renderer, registration, { sessionId: 's2' })

  oldDiff.resolve(reply({
    ...DIFF_ANSWER,
    hunks: [{ header: '@@ -1,1 +1,1 @@', lines: [{ type: 'add', text: 'OLD SESSION', old: null, new: 1 }] }],
  }))
  newDiff.resolve(reply({
    ...DIFF_ANSWER,
    hunks: [{ header: '@@ -2,2 +2,2 @@', lines: [{ type: 'add', text: 'NEW SESSION', old: null, new: 2 }] }],
  }))
  await settle()
  tree = renderBody(renderer, registration, { sessionId: 's2' })
  assert.ok(textOf(tree).includes('NEW SESSION'), 'the current session answer shows')
  assert.equal(textOf(tree).includes('OLD SESSION'), false, 'the late old-session answer is ignored')
  tree = await loadedBody(renderer, registration, { sessionId: 's1' })
  fileRow(tree, 'src/a.js').props.onClick()
  tree = renderBody(renderer, registration, { sessionId: 's1' })
  assert.ok(textOf(tree).includes('OLD SESSION'), 'the old session keeps its own diff')
})

test('close and reopen starts a new navigation store at revision 1', async () => {
  const firstSignal = makeTabSignal()
  let first = navValue(0)
  const { ctx, renderer } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = gitRegistration(ctx)
  let tree = await loadedBody(renderer, registration, { navigation: first, signal: firstSignal, tabId: 'git-1', panelId: 'B' })
  first = navValue(1, 'src/a.js')
  tree = renderBody(renderer, registration, { navigation: first, signal: firstSignal, tabId: 'git-1', panelId: 'B' })
  await settle()
  tree = renderBody(renderer, registration, { navigation: first, signal: firstSignal, tabId: 'git-1', panelId: 'B' })
  assert.equal(fileRow(tree, 'src/a.js').props['aria-expanded'], 'true')

  renderer.unmount()
  const second = navValue(1, 'src/c.js')
  tree = await loadedBody(renderer, registration, { navigation: second, signal: makeTabSignal(), tabId: 'git-2', panelId: 'C' })
  assert.equal(fileRow(tree, 'src/c.js').props['aria-expanded'], 'true', 'a new tab at revision 1 still expands')
})

test('two Git tabs keep independent navigation revisions', async () => {
  const { ctx, renderer } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = gitRegistration(ctx)
  const firstNav = navValue(1, 'src/a.js')
  const secondNav = navValue(1, 'src/c.js')
  const firstSignal = makeTabSignal()
  const secondSignal = makeTabSignal()
  const React = renderer.React
  const twoTabs = () => React.createElement('div', null,
    React.createElement(registration.component, { ...makeBodyProps({ navigation: firstNav, signal: firstSignal, tabId: 'git-a', panelId: 'B' }), key: 'tab-a' }),
    React.createElement(registration.component, { ...makeBodyProps({ navigation: secondNav, signal: secondSignal, tabId: 'git-b', panelId: 'C' }), key: 'tab-b' }),
  )
  let tree = renderer.render(twoTabs, {})
  await settle()
  tree = renderer.render(twoTabs, {})
  const panels = collect(tree, node => node.props !== undefined && Object.hasOwn(node.props, 'aria-busy'))
  assert.equal(panels.length, 2, 'two Git bodies are mounted')
  const buttonIn = (panel, filePath) => collect(panel, node => node.type === 'button' && node.props['data-git-path'] === filePath)[0]
  assert.equal(buttonIn(panels[0], 'src/a.js').props['aria-expanded'], 'true')
  assert.equal(buttonIn(panels[1], 'src/c.js').props['aria-expanded'], 'true', 'the second tab at revision 1 expands too')
  assert.notEqual(
    buttonIn(panels[0], 'src/a.js').props['aria-controls'],
    buttonIn(panels[1], 'src/c.js').props['aria-controls'],
    'each mounted tab owns a distinct diff container id',
  )
})

test('a collapsed row still exposes its hidden diff container', async () => {
  const { ctx, renderer } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const tree = await loadedBody(renderer, gitRegistration(ctx))
  const row = fileRow(tree, 'src/a.js')
  assert.equal(row.props['aria-expanded'], 'false')
  const containers = collect(tree, node => node.props !== undefined && node.props.id === row.props['aria-controls'])
  assert.equal(containers.length, 1, 'aria-controls resolves while the row is collapsed')
  assert.equal(containers[0].props.hidden, true, 'the container is hidden, not absent')
})

test('a failed diff is retried when the row is re-expanded', async () => {
  let fail = true
  const { ctx, renderer, network } = mountBundle({
    answer: () => reply(FULL_ANSWER),
    diffAnswer: () => (fail ? Promise.reject(new Error('boom')) : reply(DIFF_ANSWER)),
  })
  const registration = gitRegistration(ctx)
  let tree = await loadedBody(renderer, registration)
  fileRow(tree, 'src/a.js').props.onClick()
  tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  assert.ok(textOf(diffPanel(tree, 'src/a.js')).includes('boom'), 'the first read failed')

  fail = false
  fileRow(tree, 'src/a.js').props.onClick()
  tree = renderBody(renderer, registration)
  fileRow(tree, 'src/a.js').props.onClick()
  tree = renderBody(renderer, registration)
  await settle()
  tree = renderBody(renderer, registration)
  assert.equal(network.diffCalls.length, 2, 'a failed diff is fetched again on re-expand')
  assert.ok(textOf(diffPanel(tree, 'src/a.js')).includes('@@ -1,4 +1,6 @@'))
})

test('Environment reveals an existing Git tab in its pane and otherwise opens a new pane', async () => {
  const opened = []
  const openTab = (...args) => { opened.push(args) }
  const openTabs = makeOpenTabsStore([{ sessionId: 's1', tabId: 'git-1', kind: KIND, contentId: 'c1' }])
  const { ctx, renderer } = mountBundle({ answer: () => reply(ENV_ANSWER), openTabs })
  const gitReg = gitRegistration(ctx)
  const envReg = environmentRegistration(ctx)
  await loadedBody(renderer, gitReg, { tabId: 'git-1', panelId: 'B' })
  renderer.unmount() // a hidden tab body unmounts, but its pane registry entry stays

  let tree = await loadedBody(renderer, envReg, { openTab })
  let body = collect(tree, node => node.props !== undefined && node.props['data-column-section'] === 'changes')[0]
  assert.deepEqual(renderer.errors(), [], 'render errors: ' + renderer.errors().join('; '))
  assert.ok(body, 'the Environment Changes section is rendered')
  collect(body, node => node.type === 'button' && textOf(node).includes('uncommitted'))[0].props.onClick()
  tree = renderBody(renderer, envReg, { openTab })
  body = collect(tree, node => node.props !== undefined && node.props['data-column-section'] === 'changes')[0]
  assert.ok(body, 'the Environment Changes section is still rendered')
  const file = collect(body, node => node.props !== undefined && node.props['data-git-path'] === 'src/a.js')[0]
  file.props.onClick()
  const reused = opened.pop()
  assert.equal(reused[0], KIND)
  assert.equal(reused[1].paneId, 'B', 'the existing Git tab in pane B is reused')
  assert.equal(reused[1].preferNewPane, undefined)
  assert.equal(reused[1].params.path, 'src/a.js', 'the new path still travels with the reveal')

  openTabs.set([])
  file.props.onClick()
  const fallback = opened.pop()
  assert.equal(fallback[1].preferNewPane, true, 'a closed Git tab falls back to a new pane')
  assert.equal(fallback[1].paneId, undefined)
})

test('a new navigation revision expands and scrolls to the row; repeats and unknown paths are ignored', async () => {
  const signal = makeTabSignal()
  let navigation = navValue(0)
  const { ctx, renderer, network } = mountBundle({ answer: () => reply(FULL_ANSWER) })
  const registration = gitRegistration(ctx)
  let tree = await loadedBody(renderer, registration, { navigation, signal })
  assert.equal(refCount(tree, 'src/c.js'), 0, 'no row owns the scroll ref before navigation')

  navigation = navValue(1, 'src/c.js')
  tree = renderBody(renderer, registration, { navigation, signal })
  await settle()
  tree = renderBody(renderer, registration, { navigation, signal })
  assert.equal(fileRow(tree, 'src/c.js').props['aria-expanded'], 'true', 'the navigated row expands')
  assert.equal(refCount(tree, 'src/c.js'), 1, 'the scroll ref moves to that row')
  assert.deepEqual(renderer.scrolls.map(call => call.block), ['nearest'], 'the row scrolls into view once')
  assert.equal(network.diffCalls.length, 1, 'the navigated row loads its diff')

  navigation = navValue(1, 'src/c.js')
  tree = renderBody(renderer, registration, { navigation, signal })
  await settle()
  tree = renderBody(renderer, registration, { navigation, signal })
  assert.deepEqual(renderer.scrolls.map(call => call.block), ['nearest'], 'a repeated revision does nothing')
  assert.equal(network.diffCalls.length, 1)

  navigation = navValue(2, 'does/not/exist.js')
  tree = renderBody(renderer, registration, { navigation, signal })
  await settle()
  tree = renderBody(renderer, registration, { navigation, signal })
  assert.deepEqual(renderer.scrolls.map(call => call.block), ['nearest'], 'an unknown path is ignored')
  assert.equal(network.diffCalls.length, 1)

  navigation = navValue(3, 'src/c.js')
  tree = renderBody(renderer, registration, { navigation, signal })
  await settle()
  tree = renderBody(renderer, registration, { navigation, signal })
  assert.equal(renderer.scrolls.length, 2, 'a later revision of the same path scrolls again')

  renderer.unmount()
  assert.deepEqual(renderer.errors(), [], 'no state update lands after unmount')
})

function refCount(tree, filePath) {
  return collect(tree, node => node.props !== undefined && node.props['data-git-scroll'] === filePath).length
}

test('Environment Changes rows open the Git tab; the summary toggle only expands', async () => {
  const opened = []
  const openTab = (...args) => { opened.push(args) }
  const { ctx, renderer } = mountBundle({ answer: () => reply(ENV_ANSWER) })
  const registration = environmentRegistration(ctx)
  let tree = await loadedBody(renderer, registration, { openTab })
  let body = collect(tree, node => node.props !== undefined && node.props['data-column-section'] === 'changes')[0]
  const before = collect(body, node => node.type === 'button' && textOf(node).includes('uncommitted'))[0]
  assert.equal(before.props['aria-expanded'], 'false', 'the working-tree list starts collapsed')
  before.props.onClick()
  tree = renderBody(renderer, registration, { openTab })
  body = collect(tree, node => node.props !== undefined && node.props['data-column-section'] === 'changes')[0]
  const toggle = collect(body, node => node.type === 'button' && textOf(node).includes('uncommitted'))[0]
  assert.equal(toggle.props['aria-expanded'], 'true', 'the summary row expands')
  assert.deepEqual(opened, [], 'the summary toggle does not open the Git tab')

  const openButton = collect(body, node => node.type === 'button' && node.props['aria-label'] === 'Open in the Git tab')[0]
  assert.ok(openButton, 'the summary row has a separate Git action')
  assert.equal(textOf(openButton).trim(), 'Open in Git')
  assert.equal(openButton.props.type, 'button')
  assert.equal(openButton.props.style.fontSize, 11.5, 'the action uses the Refresh button look')
  assert.equal(collect(toggle, node => node === openButton).length, 0, 'the action is not nested in the toggle')
  const shared = collect(body, node => node.type === 'div' && node.children.includes(toggle) && node.children.includes(openButton))
  assert.equal(shared.length, 1, 'the action is a sibling of the toggle in the summary row')
  openButton.props.onClick()
  const summaryCall = opened.pop()
  assert.equal(summaryCall[0], KIND)
  assert.equal(summaryCall.length, 2)
  assert.equal(summaryCall[1].preferNewPane, true, 'the summary asks for a second pane')
  assert.equal(summaryCall[1].params, undefined, 'the summary opens the Git tab without a path')

  const file = collect(body, node => node.props !== undefined && node.props['data-git-path'] === 'src/a.js')[0]
  assert.ok(file, 'the Environment file row carries its path')
  assert.equal(file.type, 'button', 'the Environment file row is a button')
  file.props.onClick()
  const fileCall = opened.pop()
  assert.equal(fileCall[0], KIND)
  assert.equal(fileCall[1].params.path, 'src/a.js', 'the clicked path is passed as a param')
  assert.equal(fileCall[1].preferNewPane, true, 'a file also asks for a second pane')

  const folder = collect(body, node => node.props !== undefined && node.props['data-git-path'] === 'dump/')[0]
  assert.equal(folder.type, 'div', 'the untracked folder row stays plain')
  assert.equal(typeof folder.props.onClick, 'undefined')
  assert.deepEqual(opened, [], 'no other click opened a tab')
})

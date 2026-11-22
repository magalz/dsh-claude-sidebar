/**
 * Acceptance tests for the Run button on chat code blocks (features/run/client/run.js).
 *
 * The pure helpers and the layer factory are loaded from the source part the same way
 * environment-tab.test.mjs loads its parts: shared.js and run.js are concatenated inside
 * one Function with the React stub as `require('react')`, and the names under test are
 * returned. A part that does not exist yet reads as empty, so a missing helper is an
 * assertion failure here, not a syntax error.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SHARED_PART = path.join(ROOT, 'client', 'shared.js')
const RUN_PART = path.join(ROOT, 'features', 'run', 'client', 'run.js')
const SLOT = 'conversation.chat.markdown.fence'
const LAYER_ID = 'dsh-claude-sidebar/fence/run'
const LIMIT_MESSAGE = 'This session already has the maximum number of terminals; close one and try again.'
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const WSL_SYSTEM_BASH = 'C:\\Windows\\System32\\bash.exe'
const WSL_APPS_BASH = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe'
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WIN_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'

/** Read a part as UTF-8; a part that does not exist yet reads as empty (the red test). */
function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* A small React stub with hook state, effects and unmount              */
/* ------------------------------------------------------------------ */

function makeRenderer() {
  const instances = new Map()
  const errors = []
  let current = null
  let dirty = false

  function instanceOf(key) {
    let instance = instances.get(key)
    if (instance === undefined) {
      instance = { key, hooks: [], cursor: 0, effects: [], stored: new Map(), dead: false }
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
    Fragment: 'Fragment',
    useState(initial) {
      const index = hookIndex()
      const instance = current
      if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
      const setter = next => {
        if (instance.dead) {
          errors.push(new Error('setState after unmount'))
          return
        }
        const value = typeof next === 'function' ? next(instance.hooks[index]) : next
        if (!Object.is(value, instance.hooks[index])) {
          instance.hooks[index] = value
          dirty = true
        }
      }
      return [instance.hooks[index], setter]
    },
    useRef(initial) {
      const index = hookIndex()
      if (!(index in current.hooks)) current.hooks[index] = { current: initial }
      return current.hooks[index]
    },
    useEffect(fn, deps) {
      const index = hookIndex()
      current.effects.push({ index, fn, deps })
    },
  }

  function sameDeps(before, after) {
    if (!Array.isArray(before) || !Array.isArray(before) || !Array.isArray(after)) return false
    if (before.length !== after.length) return false
    return before.every((value, index) => Object.is(value, after[index]))
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

  function render(type, props) {
    for (let pass = 0; pass < 10; pass += 1) {
      dirty = false
      const instance = instanceOf('root')
      const tree = renderInstance(instance, type, props)
      commit(instance)
      if (!dirty) return tree
    }
    throw new Error('render did not settle')
  }

  function unmount() {
    for (const instance of instances.values()) {
      instance.dead = true
      for (const stored of instance.stored.values()) runCleanup(stored)
      instance.stored.clear()
    }
    instances.clear()
  }

  return { React, render, unmount, errors: () => errors.map(error => error.message) }
}

/** Load shared.js + run.js and return the names under test, absent = null. */
function loadRunParts(renderer) {
  const source =
    readText(SHARED_PART) +
    '\n' +
    readText(RUN_PART) +
    '\nreturn {' +
    "  runFamily: typeof runFamily === 'function' ? runFamily : null," +
    "  pickShell: typeof pickShell === 'function' ? pickShell : null," +
    "  commandText: typeof commandText === 'function' ? commandText : null," +
    "  runInTerminal: typeof runInTerminal === 'function' ? runInTerminal : null," +
    "  createRunFenceLayer: typeof createRunFenceLayer === 'function' ? createRunFenceLayer : null," +
    "  mount: typeof mount === 'function' ? mount : null," +
    "  FEATURES: typeof FEATURES === 'object' ? FEATURES : null," +
    "  RUN_LANGS: typeof RUN_LANGS === 'object' ? RUN_LANGS : null," +
    '}'
  const factory = new Function('require', source)
  return factory(name => {
    if (name === 'react') return renderer.React
    throw new Error('unexpected require: ' + name)
  })
}

/** Every suite starts from a fresh module evaluation and asserts the helpers exist. */
function api() {
  const renderer = makeRenderer()
  const parts = loadRunParts(renderer)
  for (const name of ['runFamily', 'pickShell', 'commandText', 'runInTerminal', 'createRunFenceLayer', 'mount']) {
    assert.ok(parts[name], 'features/run/client/run.js does not define ' + name)
  }
  return { ...parts, renderer }
}

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

function makeTimers() {
  let nextId = 1
  const pending = new Map()
  return {
    setTimeout(fn, ms) {
      const id = nextId++
      pending.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    fire(ms) {
      const due = [...pending.entries()].filter(([, entry]) => entry.ms === ms)
      for (const [id, entry] of due) {
        pending.delete(id)
        entry.fn()
      }
      return due.length
    },
    count(ms) {
      return [...pending.values()].filter(entry => entry.ms === ms).length
    },
  }
}

function makeSidebar(initial = []) {
  let tabs = [...initial]
  const calls = []
  return {
    calls,
    tabsIn(sessionId) {
      calls.push(['tabsIn', sessionId])
      return tabs
    },
    openTabIn(sessionId, type, options) {
      calls.push(['openTabIn', sessionId, type, options])
      const tab = { id: 'tab-' + (tabs.length + 1), contentId: 'addr-' + (tabs.length + 1) }
      tabs = [...tabs, tab]
      return tab
    },
  }
}

/** The real TerminalView.state: a SnapshotStore whose listener gets no arguments. */
function makeView(initialState) {
  let snapshot = initialState
  const listeners = new Set()
  const writes = []
  const view = {
    writes,
    state: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set(next) {
        snapshot = next
        for (const listener of Array.from(listeners)) listener()
      },
    },
    write(text, typed) {
      writes.push({ text, typed })
    },
    // The tab body owns the shared view's DOM lifetime; the Run button must never mount it.
    mount() {
      throw new Error('the Run button must not call view.mount()')
    },
  }
  view.set = next => view.state.set(next)
  return view
}

function makeTerminals(options = {}) {
  const calls = []
  return {
    calls,
    launchShells(sessionId, signal) {
      calls.push(['launchShells', sessionId, signal])
      if (options.onLaunch) options.onLaunch()
      if (options.launchError) return Promise.reject(new Error('shell lookup failed'))
      return Promise.resolve({ shells: options.shells ?? [], selectedShell: options.selectedShell })
    },
    view(...args) {
      calls.push(['view', ...args])
      return options.view
    },
  }
}

function makeCtx(options = {}) {
  const registrations = []
  const effects = []
  const scopes = []
  const ctx = {
    sidebarRight: options.sidebarRight ?? {},
    slots: {
      inject(slot, callback) {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    effect(callback, label) {
      effects.push({ callback, label })
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  if (options.noInject !== true) {
    ctx.inject = (deps, callback) => {
      scopes.push({ deps, callback })
      const inner = { webTerminals: options.webTerminals ?? null }
      const dispose = callback(inner)
      return { dispose: typeof dispose === 'function' ? dispose : () => {} }
    }
  }
  return { ctx, registrations, effects, scopes }
}

function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

const buttonOf = tree => {
  const found = findAll(tree, node => node.type === 'button')
  assert.equal(found.length, 1, 'expected exactly one Run button')
  return found[0]
}
const textOf = node => (node.children ?? []).map(child => (typeof child === 'string' ? child : '')).join('')
const flush = () => new Promise(resolve => setImmediate(resolve))
/** Bound an awaited run: a broken implementation must fail an assertion, not hang the suite. */
const settled = promise => Promise.race([
  promise,
  new Promise(resolve => setTimeout(() => resolve({ ok: false, error: new Error('runInTerminal did not settle') }), 400)),
])

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

test('runFamily maps every runnable fence key to its shell family', () => {
  const { runFamily } = api()
  for (const key of ['bash', 'sh', 'shell', 'zsh', 'console']) assert.equal(runFamily(key), 'posix', key)
  for (const key of ['powershell', 'pwsh', 'ps1']) assert.equal(runFamily(key), 'powershell', key)
  for (const key of ['cmd', 'bat']) assert.equal(runFamily(key), 'cmd', key)
  for (const key of ['js', 'diff', 'math', '']) assert.equal(runFamily(key), null, key)
})

test('pickShell keeps a fitting selection and prefers Git Bash over the WSL launchers', () => {
  const { pickShell } = api()
  const shells = [{ path: WSL_SYSTEM_BASH }, { path: WSL_APPS_BASH }, { path: GIT_BASH }]
  assert.equal(pickShell('posix', shells, PWSH), GIT_BASH)
  assert.equal(pickShell('posix', shells, GIT_BASH), GIT_BASH, 'a selected Git Bash stays selected')
  assert.equal(pickShell('posix', shells.slice(0, 2), PWSH), PWSH, 'no usable POSIX shell falls back to the selection')
  assert.equal(pickShell('posix', [], undefined), undefined, 'nothing to pick and nothing selected')
})

test('pickShell prefers pwsh, then powershell, then the selection for cmd', () => {
  const { pickShell } = api()
  const shells = [{ path: WIN_POWERSHELL }, { path: PWSH }, { path: CMD }]
  assert.equal(pickShell('powershell', shells, CMD), PWSH, 'pwsh wins over an earlier powershell')
  assert.equal(pickShell('powershell', [{ path: WIN_POWERSHELL }], PWSH), PWSH, 'a fitting selection is kept')
  assert.equal(pickShell('powershell', [{ path: CMD }], undefined), undefined)
  assert.equal(pickShell('cmd', shells, PWSH), CMD)
  assert.equal(pickShell('cmd', [], PWSH), PWSH, 'cmd falls back to the selection')
})

test('commandText trims trailing whitespace, normalizes breaks and appends one return', () => {
  const { commandText } = api()
  assert.equal(commandText('bash', 'a\nb\n'), 'a\rb\r')
  assert.equal(commandText('bash', 'a\r\nb\r\n'), 'a\rb\r', 'CRLF input')
  assert.equal(commandText('bash', 'a\n\n\n  '), 'a\r', 'trailing blank lines and spaces')
  assert.equal(commandText('bash', '   '), '', 'blank code')
})

test('commandText keeps only the prompt lines of a console fence', () => {
  const { commandText } = api()
  const transcript = '$ echo hi\nhi\n> pwd\n/current\n'
  assert.equal(commandText('console', transcript), 'echo hi\rpwd\r')
  assert.equal(commandText('console', 'just output\nmore output\n'), '', 'no prompt line means nothing runs')
})

/* ------------------------------------------------------------------ */
/* runInTerminal                                                      */
/* ------------------------------------------------------------------ */

/** Drive one run with fakes; the view is the real SnapshotStore shape. */
async function startRun(options = {}) {
  const { runInTerminal } = api()
  const timers = makeTimers()
  const view = makeView(options.initialState ?? { phase: 'connected', writable: true })
  const sidebar = makeSidebar()
  const terminals = makeTerminals({
    shells: options.shells ?? [{ path: WSL_SYSTEM_BASH }, { path: GIT_BASH }],
    selectedShell: options.selectedShell ?? PWSH,
    launchError: options.launchError,
    onLaunch: options.onLaunch,
    view,
  })
  const deps = {
    sidebarRight: sidebar,
    webTerminals: terminals,
    now: options.now || (() => 0),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  }
  const promise = runInTerminal(deps, { sessionId: 's1', lang: options.lang ?? 'bash', code: options.code ?? 'a\nb\n' })
  await flush()
  await flush()
  return { promise, timers, view, sidebar, terminals }
}

test('runInTerminal opens one tab and writes once through the matching view', async () => {
  const { promise, timers, view, sidebar, terminals } = await startRun()
  const opened = sidebar.calls.filter(call => call[0] === 'openTabIn')
  assert.equal(opened.length, 1, 'one new terminal tab')
  assert.equal(opened[0][1], 's1')
  assert.equal(opened[0][2], 'terminal')
  assert.equal(opened[0][3].params.shellPath, GIT_BASH)
  const viewCall = terminals.calls.find(call => call[0] === 'view')
  assert.ok(viewCall, 'the terminal model is requested')
  assert.deepEqual(viewCall.slice(1), ['s1', 'tab-1', 'addr-1', undefined, GIT_BASH], 'same shellPath as the tab params')
  assert.equal(view.writes.length, 0, 'no write before the prompt')

  view.set({ phase: 'connected', writable: true, render: { frame: { type: 'output' } } })
  assert.deepEqual(await settled(promise), { ok: true })
  assert.deepEqual(view.writes, [{ text: 'a\rb\r', typed: true }], 'exactly one typed write')
  assert.equal(timers.count(1500), 0, 'the fallback timer is cleared after a prompt')
})

test('runInTerminal writes at once when the first snapshot already shows the prompt', async () => {
  const { promise, timers, view } = await startRun({
    initialState: { phase: 'connected', writable: true, render: { frame: { type: 'output' } } },
  })
  assert.deepEqual(await settled(promise), { ok: true })
  assert.deepEqual(view.writes, [{ text: 'a\rb\r', typed: true }])
  assert.equal(timers.count(1500), 0, 'no fallback timer remains')
})

test('runInTerminal writes after 1.5 s when no output frame arrives', async () => {
  const { promise, timers, view } = await startRun()
  assert.equal(timers.count(1500), 1, 'a 1.5 s fallback is armed once writable')
  timers.fire(1500)
  assert.deepEqual(await settled(promise), { ok: true })
  assert.deepEqual(view.writes, [{ text: 'a\rb\r', typed: true }])
})

test('runInTerminal writes once across a connected to disconnected to connected flip', async () => {
  const { promise, timers, view } = await startRun()
  view.set({ phase: 'disconnected', writable: false })
  view.set({ phase: 'connected', writable: true, render: { frame: { type: 'output' } } })
  view.set({ phase: 'connected', writable: true, render: { frame: { type: 'output' } } })
  timers.fire(1500)
  await flush()
  assert.deepEqual(await settled(promise), { ok: true })
  assert.equal(view.writes.length, 1, 'still one write')
})

test('runInTerminal uses the view error text when the terminal fails', async () => {
  const { promise, view } = await startRun()
  view.set({ phase: 'failed', error: 'session full' })
  const result = await settled(promise)
  assert.equal(result.ok, false)
  assert.equal(String(result.error?.message ?? result.error), 'session full')
  assert.equal(view.writes.length, 0)
})

test('runInTerminal reports the terminalLimit issue with a helpful message', async () => {
  const { promise, view } = await startRun()
  view.set({ phase: 'failed', issue: 'terminalLimit', error: 'limit reached' })
  const result = await settled(promise)
  assert.equal(result.ok, false)
  assert.equal(String(result.error?.message ?? result.error), LIMIT_MESSAGE)
  assert.equal(view.writes.length, 0)
})

test('runInTerminal fails without writing when the view closes', async () => {
  const { promise, view } = await startRun()
  view.set({ phase: 'closed', writable: false })
  const result = await settled(promise)
  assert.equal(result.ok, false)
  assert.equal(view.writes.length, 0)
})

test('runInTerminal fails without writing at the 15 s deadline', async () => {
  const { promise, timers, view } = await startRun({ initialState: { phase: 'connecting', writable: false } })
  timers.fire(15000)
  const result = await settled(promise)
  assert.equal(result.ok, false)
  assert.match(String(result.error?.message ?? result.error), /timed out/)
  assert.equal(view.writes.length, 0)
})

test('runInTerminal arms the remaining deadline and never writes after it', async () => {
  let clock = 5000
  const { promise, timers, view } = await startRun({
    now: () => clock,
    onLaunch: () => { clock = 7000 },
    initialState: { phase: 'connected', writable: true },
  })
  assert.equal(timers.count(13000), 1, 'the 15 s deadline is armed for the time left since the click')
  clock = 20000
  timers.fire(1500)
  const result = await settled(promise)
  assert.equal(result.ok, false)
  assert.match(String(result.error?.message ?? result.error), /timed out/)
  assert.equal(view.writes.length, 0, 'the 1.5 s fallback never writes past the deadline')
})

test('runInTerminal does not write a command longer than the view input limit', async () => {
  const { promise, view } = await startRun({
    initialState: { phase: 'connected', writable: true, environment: { maxInputBytes: 3 } },
  })
  view.set({ phase: 'connected', writable: true, environment: { maxInputBytes: 3 }, render: { frame: { type: 'output' } } })
  const result = await settled(promise)
  assert.equal(result.ok, false)
  assert.match(String(result.error?.message ?? result.error), /too long/)
  assert.equal(view.writes.length, 0)
})

test('runInTerminal opens a tab with no shellPath when launchShells fails', async () => {
  const { promise, sidebar, terminals, view } = await startRun({ launchError: true })
  const opened = sidebar.calls.filter(call => call[0] === 'openTabIn')
  assert.equal(opened.length, 1)
  assert.equal(opened[0][3].params.shellPath, undefined, 'no shellPath in the params')
  const viewCall = terminals.calls.find(call => call[0] === 'view')
  assert.equal(viewCall[5], undefined, 'undefined passed to view')
  view.set({ phase: 'connected', writable: true, render: { frame: { type: 'output' } } })
  assert.deepEqual(await settled(promise), { ok: true })
})

/* ------------------------------------------------------------------ */
/* The fence layer                                                    */
/* ------------------------------------------------------------------ */

function layerProps(overrides = {}) {
  return {
    lang: 'bash',
    code: 'echo hi\n',
    streaming: false,
    meta: {},
    sessionId: 's1',
    children: { type: 'pre', props: {}, children: ['echo hi'] },
    ...overrides,
  }
}

test('the fence layer renders children once and shows Run only when it can run', () => {
  const { createRunFenceLayer, renderer } = api()
  const Layer = createRunFenceLayer({ run: () => Promise.resolve({ ok: true }) })
  const props = layerProps()
  const tree = renderer.render(Layer, props)
  assert.equal(findAll(tree, node => node.type === 'pre').length, 1, 'children rendered exactly once, unchanged')
  assert.equal(textOf(buttonOf(tree)), 'Run')

  for (const override of [
    { streaming: true },
    { lang: 'diff' },
    { code: '   ' },
    { sessionId: '' },
    { sessionId: undefined },
  ]) {
    const hidden = renderer.render(Layer, layerProps(override))
    assert.equal(findAll(hidden, node => node.type === 'button').length, 0, 'no button with ' + JSON.stringify(override))
    assert.equal(findAll(hidden, node => node.type === 'pre').length, 1, 'children still shown')
  }
})

test('the fence layer click goes Opening… to Sent to Run and ignores a second click', async () => {
  const { createRunFenceLayer, renderer } = api()
  const timers = makeTimers()
  let resolveRun
  let runs = 0
  const Layer = createRunFenceLayer({
    run: () => {
      runs += 1
      return new Promise(resolve => { resolveRun = resolve })
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })
  const props = layerProps()
  const first = buttonOf(renderer.render(Layer, props))
  first.props.onClick()
  const opening = buttonOf(renderer.render(Layer, props))
  assert.equal(textOf(opening), 'Opening…')
  assert.equal(opening.props['aria-disabled'], 'true')
  assert.equal(opening.props['aria-label'], 'Run in a new terminal')
  assert.equal(opening.props.title, 'Run in a new terminal')

  opening.props.onClick()
  assert.equal(runs, 1, 'a click while Opening… starts no second run')
  resolveRun({ ok: true })
  await flush()
  assert.equal(textOf(buttonOf(renderer.render(Layer, props))), 'Sent')
  timers.fire(2000)
  assert.equal(textOf(buttonOf(renderer.render(Layer, props))), 'Run')
})

test('the fence layer shows an error in a status region', async () => {
  const { createRunFenceLayer, renderer } = api()
  const Layer = createRunFenceLayer({ run: () => Promise.resolve({ ok: false, error: new Error('session full') }) })
  const props = layerProps()
  buttonOf(renderer.render(Layer, props)).props.onClick()
  await flush()
  const tree = renderer.render(Layer, props)
  const status = findAll(tree, node => node.props.role === 'status')
  assert.equal(status.length, 1, 'one status region')
  assert.match(textOf(status[0]), /session full/)
  assert.equal(textOf(buttonOf(tree)), 'Run')
})

test('the fence layer stops updating after unmount but the run still completes', async () => {
  const { createRunFenceLayer, renderer } = api()
  let resolveRun
  let runs = 0
  const Layer = createRunFenceLayer({ run: () => {
    runs += 1
    return new Promise(resolve => { resolveRun = resolve })
  } })
  const props = layerProps()
  buttonOf(renderer.render(Layer, props)).props.onClick()
  assert.equal(textOf(buttonOf(renderer.render(Layer, props))), 'Opening…')
  renderer.unmount()
  resolveRun({ ok: true })
  await flush()
  assert.equal(runs, 1, 'the run itself still completes after the message unmounts')
  assert.deepEqual(renderer.errors(), [], 'no button state update after unmount')
})

test('the fence layer clears its Sent timer on unmount', async () => {
  const { createRunFenceLayer, renderer } = api()
  const timers = makeTimers()
  const Layer = createRunFenceLayer({
    run: () => Promise.resolve({ ok: true }),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })
  const props = layerProps()
  buttonOf(renderer.render(Layer, props)).props.onClick()
  await flush()
  renderer.render(Layer, props)
  assert.equal(timers.count(2000), 1, 'the Sent timer is armed')
  renderer.unmount()
  assert.equal(timers.count(2000), 0, 'the Sent timer is cleared on unmount')
})

/* ------------------------------------------------------------------ */
/* Registration                                                       */
/* ------------------------------------------------------------------ */

test('mount registers one run layer per runnable language id', () => {
  const { mount, FEATURES, RUN_LANGS } = api()
  const webTerminals = { view() {}, launchShells() {} }
  const { ctx, registrations, effects, scopes } = makeCtx({ webTerminals })
  mount(ctx)

  assert.ok(FEATURES.find(feature => feature.name === 'run'), 'the feature is registered in the bundle')
  assert.deepEqual(FEATURES.find(feature => feature.name === 'run').inject, ['slots', 'sidebarRight'])
  assert.equal(scopes.length, 1)
  assert.deepEqual(scopes[0].deps, ['webTerminals'])
  assert.equal(effects.length, Object.keys(RUN_LANGS).length, 'one effect per runnable key')
  assert.equal(registrations.length, Object.keys(RUN_LANGS).length)
  for (const registration of registrations) {
    assert.equal(registration.spec.name, SLOT)
    assert.equal(registration.spec.id, LAYER_ID)
    assert.ok(registration.spec.key, 'a layer always has a key')
    assert.equal(typeof registration.component, 'function')
  }
  assert.deepEqual(
    registrations.map(entry => entry.spec.key).sort(),
    Object.keys(RUN_LANGS).sort(),
    'exactly the runnable keys',
  )
})

test('mount stays off without webTerminals or scoped injection', () => {
  const { mount } = api()
  const absent = makeCtx({ webTerminals: null })
  assert.doesNotThrow(() => mount(absent.ctx))
  assert.equal(absent.registrations.length, 0, 'no layer without the terminal service')
  const noInject = makeCtx({ noInject: true })
  assert.doesNotThrow(() => mount(noInject.ctx))
  assert.equal(noInject.registrations.length, 0, 'no layer without scoped injection')
  assert.equal(noInject.scopes.length, 0)
})

test('the generated slot name and layer id are the ones the app and spec fix', () => {
  assert.equal(SLOT, 'conversation.chat.markdown.fence')
  assert.equal(LAYER_ID, 'dsh-claude-sidebar/fence/run')
})

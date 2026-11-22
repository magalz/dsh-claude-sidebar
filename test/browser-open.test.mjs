/**
 * Acceptance tests for the browser-open tool view (features/browser/client/browser.js).
 *
 * The view is driven through the real generated client.js: a fake
 * window.__ModuleLoader__, a minimal React stub that keeps hook state and runs
 * dependency-aware effects, fake tool-call blocks in the shapes the chat emits,
 * a fake sidebarRight/sidebarRightTabs/document, and a fake localStorage.
 * Fakes only; no dsh process and no network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLIENT = path.join(ROOT, 'client.js')
const SLOT = 'tool.call.toolview'
const KEY = 'open_in_browser'
const MCP_KEY = 'mcp__dsh__open_in_browser'
const STORAGE_KEY = 'dsh-claude-sidebar.browser-opened.v1'
const URL_RAW = 'example.com/page?a=1'
const URL_CANONICAL = 'https://example.com/page?a=1'
const HOST = 'example.com'
const APP_ORIGIN = 'http://127.0.0.1:55122'
const OTHER_KEY = 'call-2'

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

/* ------------------------------------------------------------------ */
/* A small React stub with instance state and dependency-aware effects  */
/* ------------------------------------------------------------------ */

function sameDeps(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false
  for (let i = 0; i < before.length; i += 1) {
    if (!Object.is(before[i], after[i])) return false
  }
  return true
}

/** One view instance is enough: the tool row renders no custom child components. */
function makeRenderer() {
  const errors = []
  let current = null
  let committing = false
  const instance = { hooks: [], memo: new Map(), effects: [], stored: [], dirty: false }

  const React = {
    Component: class {
      constructor(props) {
        this.props = props
        this.state = {}
      }
      setState(next) {
        this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
      }
    },
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
      }
    },
    useState(initial) {
      const index = current.cursor++
      const hooks = current.hooks
      const owner = current
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      const setter = next => {
        const value = typeof next === 'function' ? next(hooks[index]) : next
        if (Object.is(value, hooks[index])) return
        hooks[index] = value
        if (committing) owner.dirty = true
      }
      return [hooks[index], setter]
    },
    useRef(initial) {
      const index = current.cursor++
      if (!(index in current.hooks)) current.hooks[index] = { current: initial }
      return current.hooks[index]
    },
    useEffect(fn, deps) {
      current.effects.push({ fn, deps })
    },
    useLayoutEffect(fn, deps) {
      current.effects.push({ fn, deps })
    },
    useMemo(fn, deps) {
      const index = current.cursor++
      const previous = current.memo.get(index)
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
      const value = fn()
      current.memo.set(index, { deps, value })
      return value
    },
    useCallback(fn) {
      return fn
    },
  }

  function render(component, props) {
    let tree = null
    for (let pass = 0; pass < 10; pass += 1) {
      current = instance
      instance.cursor = 0
      instance.effects = []
      instance.dirty = false
      try {
        tree = component(props)
      } catch (error) {
        errors.push(error)
      } finally {
        current = null
      }
      committing = true
      try {
        for (let i = 0; i < instance.effects.length; i += 1) {
          const effect = instance.effects[i]
          const previous = instance.stored[i]
          if (previous !== undefined && sameDeps(previous.deps, effect.deps)) continue
          if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
          let cleanup = null
          try {
            cleanup = effect.fn()
          } catch (error) {
            errors.push(error)
          }
          instance.stored[i] = { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
        }
        instance.stored.length = instance.effects.length
      } finally {
        committing = false
      }
      if (!instance.dirty) return tree
    }
    errors.push(new Error('render did not settle after 10 passes'))
    return tree
  }

  function unmount() {
    for (const stored of instance.stored) {
      if (stored !== undefined && typeof stored.cleanup === 'function') stored.cleanup()
    }
    instance.stored = []
    instance.hooks = []
    instance.memo.clear()
  }

  return { React, render, unmount, errors: () => errors.map(error => (error && error.message ? error.message : String(error))) }
}

/* ------------------------------------------------------------------ */
/* Bundle, storage, sidebar and tree helpers                           */
/* ------------------------------------------------------------------ */

/** A fake localStorage: a key/value map, or one whose methods throw when storage is disabled. */
function makeStorage(options = {}) {
  const values = new Map(Object.entries(options.data ?? {}))
  return {
    getItem(key) {
      if (options.throwGet === true) throw new Error('storage is disabled')
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      if (options.throwSet === true) throw new Error('storage is disabled')
      values.set(key, String(value))
    },
    stored(key) {
      return values.get(key)
    },
  }
}
function storedIds(storage) {
  const raw = storage.stored(STORAGE_KEY)
  return raw === undefined ? [] : JSON.parse(raw)
}

/** sidebarRight: `mounted.getSnapshot()` is the session currently on screen. */
function makeSidebarRight(opens, options = {}) {
  const service = {
    mounted: { getSnapshot: () => options.onScreen ?? 'sess-1' },
  }
  if (options.dropOpenTabIn !== true) {
    service.openTabIn = (sessionId, kind, callOptions) => {
      opens.push({
        method: 'openTabIn',
        sessionId,
        kind,
        options: { params: { url: callOptions?.params?.url } },
      })
      if (options.throwOnOpen === true) throw new Error('sidebar refused the tab')
    }
  }
  service.openTab = (kind, callOptions) => {
    opens.push({ method: 'openTab', kind, options: { params: { url: callOptions?.params?.url } } })
    if (options.throwOnOpen === true) throw new Error('sidebar refused the tab')
  }
  return service
}

/** sidebarRightTabs: the chat opens a Browser tab only when that tab type exists. */
function makeSidebarRightTabs(options = {}) {
  return {
    get(kind) {
      return options.browserTabs === false || kind !== 'browser' ? undefined : { id: 'browser' }
    },
  }
}

/** Evaluate the generated client.js in a fresh context and apply the whole plugin. */
function mountBundle(options = {}) {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const warnings = []
  const opens = []
  const injections = []
  const registrations = []
  const storage = options.storage ?? makeStorage(options.storageData)
  const sidebarRight = options.sidebarRight ?? makeSidebarRight(opens, options)
  const sidebarRightTabs = options.sidebarRightTabs ?? makeSidebarRightTabs(options)
  const services = { sidebarRight, sidebarRightTabs }
  let definition = null
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    console: {
      info() {}, warn(...args) { warnings.push(args) }, error() {}, log() {}, debug() {},
    },
    localStorage: storage,
    document: { baseURI: 'http://127.0.0.1:55122/', location: { origin: options.origin ?? APP_ORIGIN } },
    URL,
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
  const ctx = {
    get(name) {
      return services[name]
    },
    sidebarRight,
    sidebarRightTabs,
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
      if (dispose !== undefined && typeof dispose !== 'function') throw new Error('Invalid effect')
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  plugin.apply(ctx)
  for (const { callback } of injections) callback()
  return { renderer, ctx, plugin, opens, storage, sidebarRight, sidebarRightTabs, warnings, registrations, injections }
}

/** The tool view component registered for one wire name. */
function viewFor(mounted, key) {
  const found = mounted.registrations.find(entry => entry.slot === SLOT && entry.spec.key === key)
  assert.ok(found, 'no tool view registered in ' + SLOT + ' with key ' + key)
  return found.component
}

function renderView(mounted, key, props) {
  return mounted.renderer.render(viewFor(mounted, key), props)
}

/** Real blocks: preparing has a lazy `args` and no `argsRaw`; start and result carry `argsRaw`. */
function preparingBlock() {
  const partial = '{"url":"' + URL_RAW + '"'
  return {
    phase: 'preparing',
    callId: 'call-1',
    name: KEY,
    args: { toString: () => partial, refresh: () => false, isSealed: false },
  }
}
function startedBlock(argsRaw) {
  return { phase: 'start', callId: 'call-1', name: KEY, argsRaw: argsRaw ?? JSON.stringify({ url: URL_RAW }) }
}
function settledBlock(argsRaw, options = {}) {
  const block = {
    kind: options.kind ?? 'result',
    call: { argsRaw: argsRaw ?? JSON.stringify({ url: URL_RAW }) },
    content: [{ type: 'text', text: options.text ?? 'ok' }],
  }
  if (options.isError === true) block.isError = true
  if (options.error !== undefined) block.error = options.error
  return block
}

function callProps(overrides = {}) {
  return {
    callId: 'call-1',
    toolName: KEY,
    phase: 'result',
    block: settledBlock(),
    sessionId: 'sess-1',
    useSession: selector => selector({ running: true }),
    ...overrides,
  }
}

/** Walk the h() tree; collect every visible string and every node with a title. */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node !== null && typeof node === 'object') {
    visit(node)
    for (const child of node.children ?? []) walk(child, visit)
  }
}
function textOf(tree) {
  const parts = []
  walk(tree, node => {
    for (const child of node.children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') parts.push(String(child))
    }
  })
  return parts.join(' ')
}
function nodesWithTitle(tree, title) {
  const found = []
  walk(tree, node => {
    if (node.props?.title === title) found.push(node)
  })
  return found
}
function openButton(tree) {
  const found = []
  walk(tree, node => {
    if (node.type === 'button' && textOf(node).includes('Open')) found.push(node)
  })
  return found[0]
}
function dataState(tree) {
  return tree?.props?.['data-state']
}

/* ------------------------------------------------------------------ */
/* Acceptance tests                                                    */
/* ------------------------------------------------------------------ */

test('registers one tool view in tool.call.toolview for each wire name', () => {
  const mounted = mountBundle()
  const seats = mounted.registrations.filter(entry => entry.slot === SLOT)
  assert.equal(seats.length, 2, 'two tool-view seats are registered')
  assert.deepEqual(
    seats.map(entry => entry.spec.key).sort(),
    [KEY, MCP_KEY].sort(),
    'both the plain and the MCP-prefixed tool names are registered',
  )
  for (const seat of seats) {
    assert.equal(seat.spec.name, SLOT)
    assert.equal(typeof seat.component, 'function')
  }
  assert.equal(viewFor(mounted, KEY).name, viewFor(mounted, MCP_KEY).name, 'both keys share one component')
})

test('the row shows no host while preparing, and host plus full title when settled', () => {
  const mounted = mountBundle()
  const preparing = renderView(mounted, KEY, callProps({ phase: 'preparing', block: preparingBlock() }))
  assert.ok(textOf(preparing).includes('Opening…'), 'preparing row: ' + textOf(preparing))
  assert.equal('argsRaw' in preparingBlock(), false, 'a preparing block has only a lazy args view')
  assert.equal(nodesWithTitle(preparing, URL_CANONICAL).length, 0, 'no host while arguments are partial')
  assert.equal(textOf(preparing).includes(HOST), false, 'the partial URL is not shown as a host')

  const settled = renderView(mounted, KEY, callProps())
  const text = textOf(settled)
  assert.ok(text.includes('Opened in Browser'), 'settled row: ' + text)
  assert.ok(text.includes(HOST), 'the row shows the host: ' + text)
  const titled = nodesWithTitle(settled, URL_CANONICAL)
  assert.equal(titled.length, 1, 'the host carries the canonical URL in its title')
  assert.equal(textOf(titled[0]), HOST, 'the titled node is the host')
})

test('data-state is preparing / opening / opened / failed, and an interrupted call says Could not open', () => {
  const mounted = mountBundle()
  assert.equal(dataState(renderView(mounted, KEY, callProps({ phase: 'preparing', block: preparingBlock() }))), 'preparing')
  assert.equal(dataState(renderView(mounted, KEY, callProps({ phase: 'start', block: startedBlock() }))), 'opening')
  assert.equal(dataState(renderView(mounted, KEY, callProps())), 'opened')
  assert.equal(dataState(renderView(mounted, KEY, callProps({ block: settledBlock(undefined, { isError: true }) }))), 'failed')
  const interrupted = renderView(mounted, KEY, callProps({
    block: settledBlock(undefined, { error: { name: 'ToolError', code: 'interrupted' } }),
  }))
  assert.equal(dataState(interrupted), 'failed')
  assert.ok(textOf(interrupted).includes('Could not open'), 'an interrupted call says Could not open')
})

test('the row says Could not open for a failed settled call; the Open button is disabled only for an unsafe URL', () => {
  const mounted = mountBundle()
  for (const block of [settledBlock(undefined, { isError: true }), settledBlock(undefined, { error: { code: 'bad' } })]) {
    const tree = renderView(mounted, KEY, callProps({ block }))
    assert.ok(textOf(tree).includes('Could not open'), 'failed row: ' + textOf(tree))
  }
  const unsafe = renderView(mounted, KEY, callProps({ block: settledBlock('{"url":"javascript:alert(1)"}') }))
  assert.equal(openButton(unsafe).props.disabled, true)
  assert.equal(openButton(unsafe).props['aria-disabled'], 'true')
})

test('a live call seen at start then result opens exactly once with the canonical URL', () => {
  const mounted = mountBundle()
  renderView(mounted, KEY, callProps({ phase: 'start', block: startedBlock() }))
  assert.equal(mounted.opens.length, 0, 'an unfinished call opens nothing')
  renderView(mounted, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(mounted.opens.length, 1, 'the settled call opens once')
  assert.deepEqual(mounted.opens[0], {
    method: 'openTabIn',
    sessionId: 'sess-1',
    kind: 'browser',
    options: { params: { url: URL_CANONICAL } },
  }, 'the open is session-scoped and carries the canonical URL')
  renderView(mounted, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(mounted.opens.length, 1, 'a re-render of the same call does not open again')
})

test('a call first seen at start while idle still opens when it settles while idle', () => {
  const mounted = mountBundle()
  const idle = selector => selector({ running: false })
  renderView(mounted, KEY, callProps({ phase: 'start', block: startedBlock(), useSession: idle }))
  renderView(mounted, KEY, callProps({ phase: 'result', block: settledBlock(), useSession: idle }))
  assert.equal(mounted.opens.length, 1, 'the first sight, not the running value at settle time, decides liveness')
})

test('a call first seen settled while idle never opens after the session starts running', () => {
  const mounted = mountBundle()
  renderView(mounted, KEY, callProps({ useSession: selector => selector({ running: false }) }))
  assert.equal(mounted.opens.length, 0)
  renderView(mounted, KEY, callProps({ useSession: selector => selector({ running: true }) }))
  assert.equal(mounted.opens.length, 0, 'a later running value cannot turn history into a live call')
})

test('a history call stays closed after a remount while the session is running', () => {
  const storage = makeStorage()
  const first = mountBundle({ storage })
  renderView(first, KEY, callProps({ useSession: selector => selector({ running: false }) }))
  assert.equal(first.opens.length, 0)
  assert.equal(storedIds(storage).includes('call-1'), true, 'history ids are persisted at first sight')

  const second = mountBundle({ storage })
  renderView(second, KEY, callProps({ useSession: selector => selector({ running: true }) }))
  assert.equal(second.opens.length, 0, 'a history call can never auto-open later')
})

test('the MCP-prefixed key renders and opens the same way', () => {
  const mounted = mountBundle()
  renderView(mounted, MCP_KEY, callProps({ phase: 'start', block: startedBlock() }))
  renderView(mounted, MCP_KEY, callProps({ toolName: MCP_KEY, phase: 'result', block: settledBlock() }))
  assert.equal(mounted.opens.length, 1)
  assert.equal(mounted.opens[0].options.params.url, URL_CANONICAL)
})

test('a call already opened in this window does not reopen after a remount', () => {
  const storage = makeStorage()
  const first = mountBundle({ storage })
  renderView(first, KEY, callProps({ phase: 'start', block: startedBlock() }))
  renderView(first, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(first.opens.length, 1)

  const second = mountBundle({ storage })
  renderView(second, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(second.opens.length, 0, 'history never reopens a tab')

  const broken = mountBundle({ storage: makeStorage({ throwGet: true, throwSet: true }) })
  renderView(broken, KEY, callProps({ phase: 'result', block: settledBlock() }))
  broken.renderer.unmount()
  renderView(broken, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(broken.opens.length, 1, 'the in-memory Set still guards a remount')
})

test('a call whose session is not on screen is left unmarked and opens when it comes on screen', () => {
  const storage = makeStorage()
  const off = mountBundle({ storage, onScreen: 'child-session' })
  renderView(off, KEY, callProps({ phase: 'start', block: startedBlock() }))
  renderView(off, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(off.opens.length, 0, 'a child session whose sidebar store is not adopted opens nothing')
  assert.equal(storedIds(storage).includes('call-1'), false, 'an unadopted session call is not marked')

  const on = mountBundle({ storage })
  renderView(on, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(on.opens.length, 1, 'the same call opens once its session is on screen')
})

test('an absent Browser tab type shows Could not open and does not mark the call', () => {
  const storage = makeStorage()
  const mounted = mountBundle({ storage, browserTabs: false })
  const tree = renderView(mounted, KEY, callProps())
  assert.ok(textOf(tree).includes('Could not open'), 'the row reports the missing tab type')
  assert.equal(mounted.opens.length, 0)
  assert.equal(storedIds(storage).includes('call-1'), false, 'nothing is marked when no Browser type exists')
})

test('an id is marked only after the sidebar accepts the open', () => {
  const storage = makeStorage()
  const refused = mountBundle({ storage, throwOnOpen: true })
  renderView(refused, KEY, callProps({ phase: 'start', block: startedBlock() }))
  renderView(refused, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(refused.opens.length, 1, 'the open was attempted')
  assert.equal(storedIds(storage).includes('call-1'), false, 'a rejected open is not marked')

  const retry = mountBundle({ storage })
  renderView(retry, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(retry.opens.length, 1, 'a rejected call can be auto-opened later')
})

test('a settled call first seen while the session is running opens once', () => {
  const mounted = mountBundle()
  renderView(mounted, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(mounted.opens.length, 1, 'a live settled call opens on first sight')
  const button = openButton(mounted.renderer.render(viewFor(mounted, KEY), callProps()))
  button.props.onClick()
  assert.equal(mounted.opens.length, 2, 'the button opens again on demand')
})

test('a history call still offers a working Open button', () => {
  const mounted = mountBundle()
  const tree = renderView(mounted, KEY, callProps({ useSession: selector => selector({ running: false }) }))
  assert.equal(mounted.opens.length, 0)
  const button = openButton(tree)
  assert.equal(button.props.disabled, false, 'history has a valid URL, so the button is enabled')
  button.props.onClick()
  assert.equal(mounted.opens.length, 1, 'the button opens on demand')
})

test('a failed call or an unsafe URL never opens automatically', () => {
  const mounted = mountBundle()
  renderView(mounted, KEY, callProps({ block: settledBlock(undefined, { isError: true }) }))
  renderView(mounted, KEY, callProps({ callId: OTHER_KEY, block: settledBlock('{"url":"javascript:alert(1)"}') }))
  renderView(mounted, KEY, callProps({ callId: OTHER_KEY + 'b', block: settledBlock('{"url":"https://user:pass@example.com/"}') }))
  renderView(mounted, KEY, callProps({ callId: OTHER_KEY + 'c', block: settledBlock('{"url":"file:///etc/passwd"}') }))
  assert.equal(mounted.opens.length, 0, 'no error, script, credential or non-HTTP URL opens a tab')
})

test('an address at the application origin is refused', () => {
  const mounted = mountBundle({ origin: 'https://example.com' })
  const tree = renderView(mounted, KEY, callProps())
  assert.ok(textOf(tree).includes('Could not open'), 'the app origin is refused in the row')
  assert.equal(mounted.opens.length, 0, 'the app origin never opens a tab')
  assert.equal(openButton(tree).props.disabled, true)
})

test('openTab is used when the sidebar has no openTabIn', () => {
  const mounted = mountBundle({ dropOpenTabIn: true })
  renderView(mounted, KEY, callProps({ phase: 'start', block: startedBlock() }))
  renderView(mounted, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(mounted.opens.length, 1)
  assert.deepEqual(mounted.opens[0], {
    method: 'openTab',
    kind: 'browser',
    options: { params: { url: URL_CANONICAL } },
  })
})

test('localStorage failures are tolerated and the persisted id list is capped at 200', () => {
  const broken = mountBundle({ storage: makeStorage({ throwGet: true, throwSet: true }) })
  renderView(broken, KEY, callProps({ phase: 'start', block: startedBlock() }))
  renderView(broken, KEY, callProps({ phase: 'result', block: settledBlock() }))
  assert.equal(broken.opens.length, 1, 'storage failures do not stop the open')
  assert.deepEqual(broken.renderer.errors(), [], 'the view renders without hook or effect errors')

  const ids = Array.from({ length: 200 }, (unused, index) => 'old-' + index)
  const storage = makeStorage({ data: { [STORAGE_KEY]: JSON.stringify(ids) } })
  const capped = mountBundle({ storage })
  renderView(capped, KEY, callProps({ phase: 'result', block: settledBlock() }))
  const stored = storedIds(storage)
  assert.equal(stored.length, 200, 'the list never exceeds 200 ids')
  assert.equal(stored.includes('call-1'), true, 'the new id is recorded')
  assert.equal(stored.includes('old-0'), false, 'the oldest id is dropped')
})

test('hydration remembers exactly the last 200 persisted ids', () => {
  const ids = Array.from({ length: 250 }, (unused, index) => 'id-' + index)
  const storage = makeStorage({ data: { [STORAGE_KEY]: JSON.stringify(ids) } })
  const outside = mountBundle({ storage, onScreen: 'id-0' })
  renderView(outside, KEY, callProps({ callId: 'id-0', sessionId: 'id-0', block: settledBlock() }))
  assert.equal(outside.opens.length, 1, 'an id outside the hydrated window is not remembered')

  const inside = mountBundle({ storage, onScreen: 'id-249' })
  renderView(inside, KEY, callProps({ callId: 'id-249', sessionId: 'id-249', block: settledBlock() }))
  assert.equal(inside.opens.length, 0, 'an id inside the hydrated window is remembered')
})

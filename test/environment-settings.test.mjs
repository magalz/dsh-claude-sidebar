/**
 * Acceptance tests for the Environment row's Configure page.
 *
 * Two things are under test, both through the real sources:
 *  - the browser half registers plugins.row.config while the Environment feature is
 *    mounted, and disposing it removes the registration (the generated client.js is
 *    evaluated with a fake ctx that models slot disposal);
 *  - the View the registration supplies renders the form and saves through form.mutate
 *    (the Environment source parts are evaluated with a small React stub).
 *
 * A source that does not exist yet reads as empty, and a missing symbol reads as null,
 * so on the tests-only commit every assertion below fails on the missing behavior
 * instead of failing to load.
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
const ENVIRONMENT_PARTS = [
  'environment-base.js',
  'environment-context.js',
  'environment-connectors.js',
  'environment-settings.js',
  'environment.js',
].map(name => path.join(ROOT, 'features', 'environment', 'client', name))

const CONFIG_SLOT = 'plugins.row.config'
const CONFIG_KEY = 'dsh-claude-sidebar#claude-sidebar-environment'
const NOTE = 'Turn the Environment tab row on to change these settings.'
const LOADING = 'Loading…'
const REFUSED = 'Could not save: the settings changed elsewhere. Reload the page and try again.'

/** Read a file as UTF-8; a part that does not exist yet reads as empty (the red test). */
function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* A React stub just big enough for one stateful component             */
/* ------------------------------------------------------------------ */

/** A dependency array comparison, matching React's Object.is elementwise. */
function sameDeps(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false
  for (let i = 0; i < before.length; i += 1) {
    if (!Object.is(before[i], after[i])) return false
  }
  return true
}

/**
 * A React stub with useState/useEffect/useRef/useMemo. Effects commit after a render;
 * an update from an effect (or from a handler the test calls) sets dirty, so the next
 * render() call shows the settled tree. The settings View is one component, so a single
 * hook slot per index is enough.
 */
function makeRenderer() {
  let hooks = {}
  let cursor = 0
  let effects = []
  let dirty = false
  const stored = new Map()

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
      }
    },
    Fragment: 'Fragment',
    Component: class {
      constructor(props) {
        this.props = props
        this.state = {}
      }
      setState(next) {
        this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
      }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      const setter = next => {
        const value = typeof next === 'function' ? next(hooks[index]) : next
        if (Object.is(value, hooks[index])) return
        hooks[index] = value
        dirty = true
      }
      return [hooks[index], setter]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useMemo(fn, deps) {
      const index = cursor++
      if (!(index in hooks) || !sameDeps(hooks[index].deps, deps)) hooks[index] = { deps, value: fn() }
      return hooks[index].value
    },
    useEffect(fn, deps) {
      effects.push({ fn, deps })
    },
  }

  function commit() {
    const present = new Set(effects.map((effect, index) => index))
    for (const [index, entry] of Array.from(stored.entries())) {
      if (present.has(index)) continue
      if (typeof entry.cleanup === 'function') entry.cleanup()
      stored.delete(index)
    }
    for (const [index, effect] of effects.entries()) {
      const previous = stored.get(index)
      if (previous !== undefined && sameDeps(previous.deps, effect.deps)) continue
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
      const cleanup = effect.fn()
      stored.set(index, { deps: effect.deps, cleanup })
    }
  }

  function render(View, props) {
    for (let pass = 0; pass < 20; pass += 1) {
      cursor = 0
      effects = []
      dirty = false
      const tree = View(props)
      commit()
      if (!dirty) return tree
    }
    throw new Error('render did not settle after 20 passes')
  }

  return { React, render }
}

/* ------------------------------------------------------------------ */
/* Source View and bundle mounting                                     */
/* ------------------------------------------------------------------ */

/** Evaluate shared.js and every Environment part; return the View, or null when absent. */
function loadSettings() {
  const renderer = makeRenderer()
  const source =
    readText(SHARED_PART) +
    '\n' +
    ENVIRONMENT_PARTS.map(readText).join('\n') +
    '\nreturn { View: typeof EnvironmentSettingsView === "function" ? EnvironmentSettingsView : null }'
  const factory = new Function('require', source)
  const { View } = factory(name => {
    if (name === 'react') return renderer.React
    throw new Error('unexpected require: ' + name)
  })
  return { renderer, View }
}

/** A thenable that settles synchronously, so apply() mounts inside the test's turn. */
function settled(failed, value) {
  const chain = {
    then(onOk, onFail) { return failed ? run(onFail) : run(onOk) },
    catch(onFail) { return run(onFail) },
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

/**
 * A ctx that models Cordis slot disposal: slots.register returns a disposer that removes
 * the entry, slots.inject calls its callback and hands back that disposer, and effect
 * keeps the returned disposer so __dispose() can run the whole chain.
 */
function makeCtx() {
  const registrations = []
  const injections = []
  const effects = []
  const ctx = {
    get() { return undefined },
    sidebarRightTabs: { register() { return () => {} } },
    slots: {
      inject(slot, callback) {
        const registrationDispose = callback()
        const entry = { slot, dispose: registrationDispose }
        injections.push(entry)
        return () => {
          if (typeof registrationDispose === 'function') registrationDispose()
        }
      },
      register(spec, component) {
        const entry = { slot: spec.name, spec, component, disposed: false }
        registrations.push(entry)
        return () => {
          entry.disposed = true
          const at = registrations.indexOf(entry)
          if (at >= 0) registrations.splice(at, 1)
        }
      },
    },
    effect(callback, label) {
      const result = callback()
      const dispose = typeof result === 'function' ? result : () => {}
      effects.push({ label, result, dispose })
      return () => dispose()
    },
    inject(deps, callback) {
      try {
        callback({ remote: {} })
      } catch {
        /* an absent optional service, as on a bare client context */
      }
      return { dispose() {} }
    },
    __registrations: registrations,
    __injections: injections,
    __effects: effects,
    __dispose() {
      for (const entry of effects) entry.dispose()
    },
  }
  return ctx
}

/** Evaluate the generated client.js and apply it with the fake ctx; mount is synchronous. */
function mountBundle() {
  const source = fs.readFileSync(CLIENT, 'utf8')
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          sandbox.__definition = value
        },
      },
    },
    console: { info() {}, warn() {}, error() {}, log() {}, debug() {} },
    setTimeout() { return 1 },
    clearTimeout() {},
    setInterval() { return 1 },
    clearInterval() {},
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    fetch() {
      return resolved({ ok: true, status: 200, json: () => resolved({ features: ['environment'] }) })
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: CLIENT })
  assert.ok(sandbox.__definition, 'the bundle did not call window.__ModuleLoader__.load()')
  const renderer = makeRenderer()
  const plugin = sandbox.__definition.factory(name => {
    if (name === 'react') return renderer.React
    throw new Error('unexpected require: ' + name)
  })
  const ctx = makeCtx()
  plugin.apply(ctx)
  return { ctx }
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

function treeHasText(node, needle) {
  if (typeof node === 'string') return node.includes(needle)
  if (typeof node === 'number') return String(node).includes(needle)
  if (node === null || node === undefined || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(child => treeHasText(child, needle))
  if (textOf(node).includes(needle)) return true
  for (const [key, value] of Object.entries(node.props || {})) {
    if (key === 'children') continue
    if (typeof value === 'string' && value.includes(needle)) return true
  }
  return (node.children || []).some(child => treeHasText(child, needle))
}

function saveButton(tree) {
  const buttons = collect(tree, node => node.type === 'button' && textOf(node).trim() === 'Save')
  assert.equal(buttons.length, 1, 'the page renders exactly one Save button')
  return buttons[0]
}

function noSaveButton(tree) {
  assert.equal(
    collect(tree, node => node.type === 'button' && textOf(node).trim() === 'Save').length,
    0,
    'the page renders no Save button',
  )
}

function checkboxOf(tree) {
  const inputs = collect(tree, node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(inputs.length, 1, 'the page renders one checkbox')
  return inputs[0]
}

/** Find a text input through its associated label's htmlFor and the input's id. */
function textInputFor(tree, labelText) {
  const label = collect(tree, node => node.type === 'label' && textOf(node).includes(labelText))[0]
  assert.ok(label, 'the page labels "' + labelText + '"')
  assert.ok(label.props.htmlFor, 'the label for "' + labelText + '" is associated with an input')
  const inputs = collect(tree, node => node.type === 'input' && node.props.id === label.props.htmlFor)
  assert.equal(inputs.length, 1, 'the label for "' + labelText + '" names one input')
  return inputs[0]
}

function pageProps(state, mutate) {
  return { view: 'page', form: { state, mutate } }
}

function readyState(overrides = {}) {
  return {
    status: 'ready',
    value: { taskFacts: false, trackerUrl: '', registryPath: '' },
    base: {},
    user: {},
    revision: 7,
    writable: true,
    ...overrides,
  }
}

/** Let the mutate promise chain settle before the next render shows its answer. */
async function settle() {
  await new Promise(resolve => setImmediate(resolve))
}

/* ------------------------------------------------------------------ */
/* Acceptance tests                                                    */
/* ------------------------------------------------------------------ */

test('mounting the Environment feature registers the row config slot and disposing removes it', () => {
  const { ctx } = mountBundle()
  const found = ctx.__registrations.find(entry => entry.slot === CONFIG_SLOT && entry.spec.key === CONFIG_KEY)
  assert.ok(found, 'Environment mount registers ' + CONFIG_SLOT + ' under ' + CONFIG_KEY)
  assert.equal(typeof found.component, 'function', 'the registration supplies a View component')
  assert.equal(found.component.name, 'EnvironmentSettingsView', 'the registration supplies the settings View')
  ctx.__dispose()
  assert.equal(ctx.__registrations.includes(found), false, 'disposing the effect removes the registration')
})

test("view: 'summary' returns a short task-facts string", () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const off = renderer.render(View, { view: 'summary', form: { state: readyState() } })
  assert.equal(off, 'Task facts: off', 'summary reports task facts off')
  const on = renderer.render(View, {
    view: 'summary',
    form: { state: readyState({ value: { taskFacts: true, trackerUrl: '', registryPath: '' } }) },
  })
  assert.equal(on, 'Task facts: on', 'summary reports task facts on')
})

test('no form or an unavailable state shows the note and no Save control', () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const absent = renderer.render(View, { view: 'page' })
  assert.ok(treeHasText(absent, NOTE), 'a row without a form shows the note')
  noSaveButton(absent)
  const unavailable = renderer.render(View, {
    view: 'page',
    form: { state: { status: 'unavailable', value: undefined, revision: undefined, writable: false } },
  })
  assert.ok(treeHasText(unavailable, NOTE), 'an unavailable form shows the note')
  noSaveButton(unavailable)
})

test("a loading state shows 'Loading…' and no Save control", () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const tree = renderer.render(View, pageProps({ status: 'loading', value: undefined, revision: undefined, writable: false }))
  assert.ok(treeHasText(tree, LOADING), 'a loading form says Loading…')
  noSaveButton(tree)
})

test('the ready page renders three bound controls and keeps Save disabled until a change', () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const state = readyState({
    value: { taskFacts: true, trackerUrl: 'https://tracker.example.com', registryPath: '/tmp/links.json' },
  })
  const tree = renderer.render(View, pageProps(state, () => Promise.resolve(true)))

  assert.equal(checkboxOf(tree).props.checked, true, 'the checkbox carries taskFacts')
  const tracker = textInputFor(tree, 'Tracker web address')
  assert.equal(tracker.props.value, 'https://tracker.example.com', 'the tracker input carries trackerUrl')
  assert.equal(tracker.props.placeholder, 'https://tracker.example.com', 'the tracker input has its placeholder')
  const registry = textInputFor(tree, 'Registry path')
  assert.equal(registry.props.value, '/tmp/links.json', 'the registry input carries registryPath')
  assert.equal(registry.props.placeholder, '~/.claude/itsaplan/links.json', 'the registry input has its placeholder')

  assert.ok(treeHasText(tree, 'Show the tracker card named by the branch'), 'the checkbox has its help text')
  assert.ok(treeHasText(tree, 'Used to link cards; leave empty for cards without links.'), 'the tracker has its help text')
  assert.ok(treeHasText(tree, 'Path of the itsaplan link registry; leave empty for the default.'), 'the registry has its help text')
  assert.equal(saveButton(tree).props.disabled, true, 'Save is disabled while nothing changed')
})

test('Save sends one mutate with trimmed set/unset ops and the accepted revision, then shows Saved', async () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const state = readyState({ value: { taskFacts: false, trackerUrl: '', registryPath: 'custom' } })
  const calls = []
  const form = {
    state,
    mutate(ops, revision) {
      calls.push({ ops, revision })
      return Promise.resolve(true)
    },
  }
  let tree = renderer.render(View, pageProps(state, form.mutate))
  checkboxOf(tree).props.onChange({ target: { checked: true } })
  tree = renderer.render(View, pageProps(state, form.mutate))
  textInputFor(tree, 'Tracker web address').props.onChange({ target: { value: '  https://tracker.example.com/x  ' } })
  tree = renderer.render(View, pageProps(state, form.mutate))
  textInputFor(tree, 'Registry path').props.onChange({ target: { value: '' } })
  tree = renderer.render(View, pageProps(state, form.mutate))

  const save = saveButton(tree)
  assert.equal(save.props.disabled, false, 'Save is enabled after an edit')
  save.props.onClick()
  await settle()
  tree = renderer.render(View, pageProps(state, form.mutate))

  assert.equal(calls.length, 1, 'Save calls mutate exactly once')
  assert.equal(calls[0].revision, 7, 'mutate receives form.state.revision')
  assert.deepEqual(calls[0].ops, [
    { op: 'set', path: ['taskFacts'], value: true },
    { op: 'set', path: ['trackerUrl'], value: 'https://tracker.example.com/x' },
    { op: 'unset', path: ['registryPath'] },
  ], 'changed non-defaults are set, defaults are unset, strings are trimmed')
  assert.ok(treeHasText(tree, 'Saved'), 'an accepted save shows Saved')
  assert.equal(saveButton(tree).props.disabled, true, 'Save is disabled again after the accepted save')
})

test('a refused save shows the concurrency note and a rejection shows its message', async () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')

  const refusedState = readyState()
  let tree = renderer.render(View, pageProps(refusedState, () => Promise.resolve(false)))
  textInputFor(tree, 'Tracker web address').props.onChange({ target: { value: 'https://tracker.example.com' } })
  tree = renderer.render(View, pageProps(refusedState, () => Promise.resolve(false)))
  saveButton(tree).props.onClick()
  await settle()
  tree = renderer.render(View, pageProps(refusedState, () => Promise.resolve(false)))
  assert.ok(treeHasText(tree, REFUSED), 'a false result shows the changed-elsewhere note')

  const failingState = readyState()
  const fail = () => Promise.reject(new Error('network is down'))
  tree = renderer.render(View, pageProps(failingState, fail))
  textInputFor(tree, 'Registry path').props.onChange({ target: { value: '/tmp/links.json' } })
  tree = renderer.render(View, pageProps(failingState, fail))
  saveButton(tree).props.onClick()
  await settle()
  tree = renderer.render(View, pageProps(failingState, fail))
  assert.ok(treeHasText(tree, 'Could not save: network is down'), 'a rejection shows its message')
})

test('a read-only form keeps Save disabled even after an edit', () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const state = readyState({ writable: false })
  let tree = renderer.render(View, pageProps(state, () => Promise.resolve(true)))
  assert.equal(saveButton(tree).props.disabled, true, 'Save is disabled on a read-only form')
  textInputFor(tree, 'Tracker web address').props.onChange({ target: { value: 'https://tracker.example.com' } })
  tree = renderer.render(View, pageProps(state, () => Promise.resolve(true)))
  assert.equal(saveButton(tree).props.disabled, true, 'an edit cannot enable Save on a read-only form')
})

test('a new accepted revision updates an untouched draft but not one with unsaved edits', () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const first = readyState({ value: { taskFacts: false, trackerUrl: 'first', registryPath: '' }, revision: 1 })
  const second = readyState({ value: { taskFacts: false, trackerUrl: 'second', registryPath: '' }, revision: 2 })
  const mutate = () => Promise.resolve(true)
  let tree = renderer.render(View, pageProps(first, mutate))
  tree = renderer.render(View, pageProps(second, mutate))
  assert.equal(textInputFor(tree, 'Tracker web address').props.value, 'second', 'an untouched draft follows the new revision')

  const dirty = renderer.render(View, {
    view: 'page',
    form: { state: first, mutate },
  })
  textInputFor(dirty, 'Tracker web address').props.onChange({ target: { value: 'mine' } })
  renderer.render(View, pageProps(first, mutate))
  const kept = renderer.render(View, pageProps(second, mutate))
  assert.equal(textInputFor(kept, 'Tracker web address').props.value, 'mine', 'a draft with edits survives a new revision')
})

test('saving sends only the fields the user changed, not fields changed elsewhere', async () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const first = readyState({ value: { taskFacts: false, trackerUrl: '', registryPath: '' }, revision: 1 })
  const calls = []
  const mutate = (ops, revision) => {
    calls.push({ ops, revision })
    return Promise.resolve(true)
  }
  let tree = renderer.render(View, pageProps(first, mutate))
  checkboxOf(tree).props.onChange({ target: { checked: true } })
  tree = renderer.render(View, pageProps(first, mutate))

  /* Another writer sets trackerUrl and bumps the revision; the unsaved draft keeps its own
     values, so the tracker input stays empty and the user's tick is the only local change. */
  const second = readyState({ value: { taskFacts: false, trackerUrl: 'https://a', registryPath: '' }, revision: 2 })
  tree = renderer.render(View, pageProps(second, mutate))
  assert.equal(textInputFor(tree, 'Tracker web address').props.value, '', 'the unsaved draft keeps its old value')
  saveButton(tree).props.onClick()
  await settle()

  assert.equal(calls.length, 1, 'Save calls mutate once')
  assert.equal(calls[0].revision, 2, 'mutate uses the accepted revision')
  assert.deepEqual(
    calls[0].ops,
    [{ op: 'set', path: ['taskFacts'], value: true }],
    'only the field the user edited is sent; a field changed elsewhere is left alone',
  )
})

test('a whitespace-only text edit leaves Save disabled and never calls mutate', async () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const state = readyState()
  let calls = 0
  const mutate = () => {
    calls += 1
    return Promise.resolve(true)
  }
  let tree = renderer.render(View, pageProps(state, mutate))
  textInputFor(tree, 'Registry path').props.onChange({ target: { value: '   ' } })
  tree = renderer.render(View, pageProps(state, mutate))
  assert.equal(saveButton(tree).props.disabled, true, 'whitespace alone is not a change')
  saveButton(tree).props.onClick()
  await settle()
  assert.equal(calls, 0, 'an empty op set is never sent')
})

test('after an accepted save the draft adopts the snapshot the page owner supplies', async () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const base = { trackerUrl: 'https://old' }
  const first = readyState({ value: base, base, revision: 1 })
  let accept = null
  const mutate = () => new Promise(resolve => { accept = resolve })
  let tree = renderer.render(View, pageProps(first, mutate))
  textInputFor(tree, 'Tracker web address').props.onChange({ target: { value: '' } })
  tree = renderer.render(View, pageProps(first, mutate))
  saveButton(tree).props.onClick()
  await settle()

  /* The page owner accepts the unset and supplies a fresh snapshot: the effective value
     falls back to the non-default base, so the input must show it, not the typed ''. */
  const second = readyState({ value: base, base, revision: 2 })
  tree = renderer.render(View, pageProps(second, mutate))
  accept(true)
  await settle()
  tree = renderer.render(View, pageProps(second, mutate))
  assert.equal(
    textInputFor(tree, 'Tracker web address').props.value,
    'https://old',
    'the input shows the accepted stored value after the save',
  )
})

test('a save that settles before the new snapshot keeps showing the saved values', async () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const first = readyState({ value: { taskFacts: false, trackerUrl: 'https://old', registryPath: '' }, revision: 1 })
  const mutate = () => Promise.resolve(true)
  let tree = renderer.render(View, pageProps(first, mutate))
  textInputFor(tree, 'Tracker web address').props.onChange({ target: { value: 'https://new' } })
  tree = renderer.render(View, pageProps(first, mutate))
  saveButton(tree).props.onClick()
  await settle()

  /* The page owner has not refreshed yet: the snapshot is still revision 1. */
  tree = renderer.render(View, pageProps(first, mutate))
  tree = renderer.render(View, pageProps(first, mutate))
  assert.equal(textInputFor(tree, 'Tracker web address').props.value, 'https://new', 'the saved value is not reverted to the old snapshot')
  assert.ok(treeHasText(tree, 'Saved'), 'the page still says Saved')

  const second = readyState({ value: { taskFacts: false, trackerUrl: 'https://new', registryPath: '' }, revision: 2 })
  tree = renderer.render(View, pageProps(second, mutate))
  tree = renderer.render(View, pageProps(second, mutate))
  assert.equal(textInputFor(tree, 'Tracker web address').props.value, 'https://new', 'the refreshed snapshot agrees')
  assert.equal(saveButton(tree).props.disabled, true, 'nothing is left unsaved')
})

test('a whitespace-only edit does not stop the draft from following a new revision', () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const first = readyState({ value: { taskFacts: false, trackerUrl: '', registryPath: '' }, revision: 1 })
  const mutate = () => Promise.resolve(true)
  let tree = renderer.render(View, pageProps(first, mutate))
  textInputFor(tree, 'Registry path').props.onChange({ target: { value: ' ' } })
  tree = renderer.render(View, pageProps(first, mutate))
  const second = readyState({ value: { taskFacts: false, trackerUrl: 'https://a', registryPath: '' }, revision: 2 })
  tree = renderer.render(View, pageProps(second, mutate))
  tree = renderer.render(View, pageProps(second, mutate))
  assert.equal(textInputFor(tree, 'Tracker web address').props.value, 'https://a', 'whitespace alone does not hold back a newer value')
})

test('two synchronous Save clicks send only one mutate', async () => {
  const { renderer, View } = loadSettings()
  assert.equal(typeof View, 'function', 'environment-settings.js must define EnvironmentSettingsView')
  const state = readyState()
  let calls = 0
  const mutate = () => {
    calls += 1
    return Promise.resolve(true)
  }
  let tree = renderer.render(View, pageProps(state, mutate))
  textInputFor(tree, 'Tracker web address').props.onChange({ target: { value: 'https://a' } })
  tree = renderer.render(View, pageProps(state, mutate))
  const save = saveButton(tree)
  save.props.onClick()
  save.props.onClick()
  await settle()
  assert.equal(calls, 1, 'a second click while a save is in flight sends nothing')
})

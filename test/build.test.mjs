import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, Script } from 'node:vm'
import * as build from '../scripts/build-client.mjs'
const { buildClient, PARTS } = build

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT = join(ROOT, 'client.js')
const PACKAGE = join(ROOT, 'package.json')
const PATCH = join(ROOT, 'cordis.patch.yml')

/** The committed browser half, as text. */
function committedClient() {
  return readFileSync(CLIENT, 'utf8')
}

/**
 * A thenable that settles synchronously. The gate chains .then/.catch, so a fake fetch
 * built from these makes apply() mount inside the same turn the test calls it.
 */
function settled(failed, value) {
  const chain = {
    then(onOk, onFail) {
      return failed ? (typeof onFail === 'function' ? run(onFail) : chain) : run(onOk)
    },
    catch(onFail) {
      return failed ? run(onFail) : chain
    },
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

/** The default features answer: every feature is switched on. */
function featureAnswer(names = ALL_FEATURES) {
  return resolved({ ok: true, status: 200, json: () => resolved({ features: names }) })
}

/** A ctx whose effect disposers can be fired by hand, like Cordis disposing the plugin. */
function gateCtx() {
  const cleanups = []
  return {
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
}

/** Fake timers for the gate's abort timeout. */
function makeTimers() {
  const timers = []
  let seq = 0
  return {
    setTimeout(fn, ms) {
      timers.push({ id: ++seq, ms, fn })
      return seq
    },
    clearTimeout(id) {
      const at = timers.findIndex(entry => entry.id === id)
      if (at >= 0) timers.splice(at, 1)
    },
    pending() { return timers.slice() },
    fireAll() { for (const entry of timers.splice(0)) entry.fn() },
  }
}

/** Let a promises chain (including the gate's .catch) settle after a timer or deferred answer. */
async function settle() {
  await new Promise(resolve => setImmediate(resolve))
}

/** The shared part the gate tests need: registry, active set and the api() helper. */
const GATE_SHARED = [
  'const FEATURES = []',
  'const ACTIVE_FEATURES = new Set()',
  'function registerFeature(feature) { FEATURES.push({ name: feature.name, inject: feature.inject, mount: feature.mount }) }',
  'function api(path) { return String(path) }',
].join('\n')

/** Evaluate one generated bundle in a fresh context; returns what it passed to the loader. */
function evaluate(text, globals = {}) {
  const loaded = []
  const context = {
    window: { __ModuleLoader__: { load(entry) { loaded.push(entry) } } },
    console: { warn() {} },
    fetch: globals.fetch ?? (() => featureAnswer()),
    AbortController,
    setTimeout,
    clearTimeout,
    ...globals,
  }
  createContext(context)
  new Script(text).runInContext(context)
  return loaded
}

/* ------------------------------------------------------------------ */
/* The generated bundle                                                */
/* ------------------------------------------------------------------ */

test('client.js is exactly what build-client produces from the feature sources', () => {
  assert.equal(buildClient(), committedClient(), 'run `node scripts/build-client.mjs` and commit its output')
})

test('client.js is a classic script without jsxDEV, import or export', () => {
  const text = buildClient()
  assert.equal(text.includes('jsxDEV'), false, 'the bundle must not contain jsxDEV')
  const moduleLines = text.split('\n').filter(line => /^(?:import|export)\s/u.test(line))
  assert.deepEqual(moduleLines, [], 'the bundle must not contain top-level import or export lines')
  assert.equal((text.match(/__ModuleLoader__\.load\(/gu) ?? []).length, 1, 'the bundle must call __ModuleLoader__.load exactly once')
  assert.doesNotThrow(() => new Script(text), 'the bundle must parse as a classic script')
})

test('a feature whose mount throws does not stop the others', () => {
  const mounts = []
  const warnings = []
  const parts = {
    'shared.js': [
      '/* the fake shared part: only what the footer reads */',
      'const FEATURES = []',
      'const ACTIVE_FEATURES = new Set()',
      'function api(path) { return String(path) }',
      '',
      '/** Register one feature. */',
      'function registerFeature(feature) {',
      '  FEATURES.push({ name: feature.name, inject: feature.inject, mount: feature.mount })',
      '}',
    ].join('\n'),
    'first.js': [
      "registerFeature({ name: 'first', inject: ['alpha', 'beta'], mount() { throw new Error('boom') } })",
      '',
      "registerFeature({ name: 'second', inject: ['beta', 'gamma'], mount(ctx) { mounts.push(ctx) } })",
    ].join('\n'),
  }
  const output = buildClient(name => parts[name], ['shared.js', 'first.js'])
  const loaded = evaluate(output, {
    mounts,
    fetch: () => featureAnswer(['first', 'second']),
    console: { warn(...args) { warnings.push(args) } },
  })
  assert.equal(loaded.length, 1)

  const plugin = loaded[0].factory(() => ({}))
  assert.deepEqual([...plugin.inject], ['alpha', 'beta', 'gamma'], 'inject is the de-duplicated union in first-seen order')

  const ctx = { id: 'ctx', effect() { return () => {} } }
  plugin.apply(ctx)
  assert.equal(warnings.length, 1, 'the failed feature is reported once')
  assert.equal(warnings[0][0], 'dsh-claude-sidebar: feature "first" failed to mount')
  assert.equal(warnings[0][1].message, 'boom')
  assert.equal(mounts.length, 1, 'the feature after the throwing one still mounts')
  assert.equal(mounts[0], ctx)
})

test('two parts that declare the same names each keep their own', () => {
  const parts = {
    'shared.js': [
      '/* the fake shared part: only what the footer reads */',
      'const FEATURES = []',
      'const ACTIVE_FEATURES = new Set()',
      'function api(path) { return String(path) }',
      '',
      '/** Register one feature. */',
      'function registerFeature(feature) {',
      '  FEATURES.push({ name: feature.name, inject: feature.inject, mount: feature.mount })',
      '}',
    ].join('\n'),
    'first.js': [
      "const S = 'first'",
      "function mount(ctx) { ctx.mounted.push('first') }",
      "registerFeature({ name: 'first', inject: ['one'], mount })",
    ].join('\n'),
    'second.js': [
      "const S = 'second'",
      "function mount(ctx) { ctx.mounted.push('second') }",
      "registerFeature({ name: 'second', inject: ['two'], mount })",
    ].join('\n'),
  }
  const output = buildClient(name => parts[name], ['shared.js', 'first.js', 'second.js'])
  let loaded
  assert.doesNotThrow(
    () => { loaded = evaluate(output, { fetch: () => featureAnswer(['first', 'second']) }) },
    'each feature part is its own block, so duplicate names do not collide',
  )
  assert.equal(loaded.length, 1)
  const plugin = loaded[0].factory(() => ({}))
  assert.deepEqual([...plugin.inject], ['one', 'two'])
  const ctx = { mounted: [], effect() { return () => {} } }
  plugin.apply(ctx)
  assert.deepEqual(ctx.mounted, ['first', 'second'], 'each feature runs its own mount')
})

test('a group entry shares its declarations across its files in one block', () => {
  const parts = {
    'shared.js': [
      '/* the fake shared part: only what the footer reads */',
      'const FEATURES = []',
      'const ACTIVE_FEATURES = new Set()',
      'function api(path) { return String(path) }',
      '',
      '/** Register one feature. */',
      'function registerFeature(feature) {',
      '  FEATURES.push({ name: feature.name, inject: feature.inject, mount: feature.mount })',
      '}',
    ].join('\n'),
    'group-a.js': "const COLOR = 'red'",
    'group-b.js': [
      'function paint() { return COLOR }',
      "registerFeature({ name: 'grouped', inject: ['paint'], mount(ctx) { ctx.painted = paint() } })",
    ].join('\n'),
  }
  // group-b.js reads COLOR, declared in group-a.js: the files must share one scope.
  // Unknown names read as '' so the current build still evaluates and fails on assertions.
  const output = buildClient(name => parts[name] ?? '', ['shared.js', ['group-a.js', 'group-b.js']])
  const loaded = evaluate(output, { fetch: () => featureAnswer(['grouped']) })
  assert.equal(loaded.length, 1)
  const plugin = loaded[0].factory(() => ({}))
  assert.deepEqual([...plugin.inject], ['paint'], 'the group registers its feature')
  const ctx = { effect() { return () => {} } }
  plugin.apply(ctx)
  assert.equal(ctx.painted, 'red', 'a later file in the group sees an earlier file\'s const')
})

test('a plain entry keeps its own block, byte for byte', () => {
  const parts = { 'shared.js': '/* shared */', 'solo.js': 'const X = 1' }
  const output = buildClient(name => parts[name], ['shared.js', 'solo.js'])
  assert.match(output, /\n    \/\/ src\/client\/solo\.js\n    \{\nconst X = 1\n    \}\n/u, 'comment, brace, text, brace keep the original layout')
  assert.equal((output.match(/^    \{$/gmu) ?? []).length, 1, 'one block for one plain part')
})

test('--check exits 1 for a stale client.js and 0 for a current one', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-build-check-'))
  try {
    mkdirSync(join(tmp, 'scripts'), { recursive: true })
    const script = join(tmp, 'scripts', 'build-client.mjs')
    copyFileSync(join(ROOT, 'scripts', 'build-client.mjs'), script)
    for (const source of build.SOURCES) {
      const partPath = join(tmp, source)
      mkdirSync(dirname(partPath), { recursive: true })
      writeFileSync(partPath, source === 'client/shared.js' ? 'const FEATURES = []\n' : '/* part */\n')
    }

    writeFileSync(join(tmp, 'client.js'), '// stale\n')
    const stale = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
    assert.equal(stale.status, 1, '--check reports a stale client.js')
    assert.match(stale.stderr, /client\.js is stale/u)

    assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 0, 'build writes client.js')
    assert.equal(spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' }).status, 0, '--check passes when current')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* The manifest, the patch and the Host half                           */
/* ------------------------------------------------------------------ */

test('the bundle names dsh-claude-sidebar in every place the app reads', async () => {
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8'))
  assert.equal(pkg.name, 'dsh-claude-sidebar')

  const clientInject = pkg.dsh?.client?.inject
  assert.ok(Array.isArray(clientInject), 'dsh.client.inject is a list')
  for (const service of ['@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-ui-slots']) {
    assert.ok(clientInject.includes(service), 'dsh.client.inject names ' + service)
  }

  const patch = readFileSync(PATCH, 'utf8')
  const rowId = /^\s*-\s*id:\s*(\S+)\s*$/mu.exec(patch)?.[1]
  const rowName = /^\s*name:\s*'([^']+)'\s*$/mu.exec(patch)?.[1]
  assert.equal(rowId, 'claude-sidebar')
  assert.equal(rowName, 'dsh-claude-sidebar')

  const client = committedClient()
  const loaderId = /__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'([^']+)'/u.exec(client)?.[1]
  assert.equal(loaderId, 'dsh-claude-sidebar')

  const root = await import('../index.js')
  const environment = await import('../features/environment/route.js')
  assert.equal(root.name, rowId, 'the Host name matches the patch row id')
  assert.ok(environment.ENV_ROUTE.startsWith('/dsh-claude-sidebar/'), 'the Host route starts with /dsh-claude-sidebar/')
  assert.ok(client.includes(environment.ENV_ROUTE), 'the client fetches the Host route ' + environment.ENV_ROUTE)
})

test('the manifest lists schemastery as a peer so the row Config resolves in dsh', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8'))
  assert.equal(
    pkg.peerDependencies?.['@deepseek-ai/schemastery'],
    '>=3.18.3 <4',
    '.volatile() first exists in schemastery 3.18.3, which dsh needs for the row Settings',
  )
})

test('the sources live under client/ and features/<feature>/client in the fixed order', () => {
  assert.deepEqual(build.SOURCES, [
    'client/shared.js',
    'features/rail/client/rail.js',
    'features/jobs/client/jobs.js',
    'features/subagents/client/subagents.js',
    'features/environment/client/environment-base.js',
    'features/environment/client/environment-context.js',
    'features/environment/client/environment-connectors.js',
    'features/environment/client/environment-settings.js',
    'features/environment/client/environment.js',
    'features/run/client/run.js',
    'features/git/client/git.js',
    'features/sizing/client/sizing.js',
    'features/browser/client/browser.js',
  ], 'the build reads the shared prelude, then each feature in the spec order')
  assert.deepEqual(build.FEATURES.map(feature => feature.name), [
    'rail', 'jobs', 'subagents', 'environment', 'run', 'git', 'sizing', 'browser',
  ], 'the client feature names equal the row names')
})

test('the bundle uses the fixed feature order and no longer carries the Task tab', () => {
  assert.deepEqual(PARTS, [
    'shared.js',
    'rail.js',
    'jobs.js',
    'subagents.js',
    ['environment-base.js', 'environment-context.js', 'environment-connectors.js', 'environment-settings.js', 'environment.js'],
    'run.js',
    'git.js',
    'sizing.js',
    'browser.js',
  ], 'PARTS is the shared prelude followed by the features in the spec order; environment keeps one block')
  const client = committedClient()
  // The generated bundle must not carry the removed tab id.
  assert.equal(client.includes('dsh-claude-sidebar/task'), false, 'client.js must not carry the removed tab id')
})

/* ------------------------------------------------------------------ */
/* The feature gate in the generated footer                            */
/* ------------------------------------------------------------------ */

/** Three recorded features, each with one service to prove inject stays a union. */
function gateParts(mounts) {
  return {
    'shared.js': GATE_SHARED,
    'a.js': "registerFeature({ name: 'a', inject: ['one'], mount() { mounts.push('a') } })",
    'b.js': "registerFeature({ name: 'b', inject: ['two'], mount() { mounts.push('b') } })",
    'c.js': "registerFeature({ name: 'c', inject: ['three'], mount() { mounts.push('c') } })",
  }
}

test('the gate fetches the feature list once and mounts only the listed features, in order', () => {
  const mounts = []
  const parts = gateParts(mounts)
  const calls = []
  const output = buildClient(name => parts[name], ['shared.js', 'a.js', 'b.js', 'c.js'])
  const loaded = evaluate(output, {
    mounts,
    fetch(url, init) {
      calls.push({ url, init })
      return featureAnswer(['c', 'a'])
    },
  })
  const plugin = loaded[0].factory(() => ({}))
  assert.deepEqual([...plugin.inject], ['one', 'two', 'three'], 'inject is still the union of every feature')

  const returned = plugin.apply(gateCtx())
  assert.equal(returned, undefined, 'apply stays synchronous: no promise for Cordis to wait on')
  assert.deepEqual(calls.length, 1, 'the feature list is fetched exactly once')
  assert.equal(calls[0].url, '/dsh-claude-sidebar/features')
  assert.equal(calls[0].init.cache, 'no-store')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.ok(calls[0].init.signal, 'the request carries a signal the gate can abort')
  assert.deepEqual(mounts, ['a', 'c'], 'only listed features mount, in feature order')
})

test('an unavailable feature list mounts nothing and warns once', () => {
  const cases = [
    ['a rejected fetch', () => rejected(new Error('offline'))],
    ['a non-200 answer', () => resolved({ ok: false, status: 404, json: () => resolved({ features: ALL_FEATURES }) })],
    ['a rejecting json()', () => resolved({ ok: true, status: 200, json: () => rejected(new Error('bad json')) })],
    ['a null body', () => resolved({ ok: true, status: 200, json: () => resolved(null) })],
    ['an array body', () => resolved({ ok: true, status: 200, json: () => resolved(ALL_FEATURES) })],
    ['a body without an array', () => resolved({ ok: true, status: 200, json: () => resolved({ nope: true }) })],
    ['a features value that is not an array', () => resolved({ ok: true, status: 200, json: () => resolved({ features: 'a' }) })],
  ]
  for (const [label, answer] of cases) {
    const mounts = []
    const warnings = []
    const parts = gateParts(mounts)
    const output = buildClient(name => parts[name], ['shared.js', 'a.js', 'b.js', 'c.js'])
    const loaded = evaluate(output, {
      mounts,
      fetch: () => answer(),
      console: { warn(...args) { warnings.push(args) } },
    })
    loaded[0].factory(() => ({})).apply(gateCtx())
    assert.deepEqual(mounts, [], label + ': nothing mounts')
    assert.equal(warnings.length, 1, label + ': warns exactly once')
    assert.equal(warnings[0][0], 'dsh-claude-sidebar: feature list unavailable; no feature mounted')
  }
})

test('a feature-list request that never answers is aborted after ten seconds', async () => {
  const mounts = []
  const warnings = []
  const timers = makeTimers()
  const parts = gateParts(mounts)
  const output = buildClient(name => parts[name], ['shared.js', 'a.js', 'b.js', 'c.js'])
  let signal = null
  const loaded = evaluate(output, {
    mounts,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console: { warn(...args) { warnings.push(args) } },
    fetch(url, init) {
      signal = init.signal
      return new Promise((resolve, reject) => {
        if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  })
  const returned = loaded[0].factory(() => ({})).apply(gateCtx())
  assert.equal(returned, undefined, 'apply does not return the pending request')
  assert.equal(timers.pending().length, 1, 'one abort timeout is armed')
  assert.equal(timers.pending()[0].ms, 10_000, 'the timeout is ten seconds')
  timers.fireAll()
  await settle()
  assert.equal(signal.aborted, true, 'the request is aborted')
  assert.deepEqual(mounts, [], 'nothing mounts')
  assert.equal(warnings.length, 1, 'the failure is reported once')
})

test('disposing before the answer arrives mounts nothing and stays quiet', async () => {
  const mounts = []
  const warnings = []
  const parts = gateParts(mounts)
  const output = buildClient(name => parts[name], ['shared.js', 'a.js', 'b.js', 'c.js'])
  let signal = null
  let answer
  const loaded = evaluate(output, {
    mounts,
    console: { warn(...args) { warnings.push(args) } },
    fetch(url, init) {
      signal = init.signal
      return new Promise(resolve => { answer = resolve })
    },
  })
  const ctx = gateCtx()
  loaded[0].factory(() => ({})).apply(ctx)
  ctx.dispose()
  assert.equal(signal.aborted, true, 'disposal aborts the request')
  // Name the features this test bundle really has, so a missing dispose guard would mount them.
  answer({ ok: true, status: 200, json: () => resolved({ features: ['a', 'b', 'c'] }) })
  await settle()
  assert.deepEqual(mounts, [], 'a late answer cannot mount into a disposed plugin')
  assert.equal(warnings.length, 0, 'a disposal is not a failure')
})

test('a disposal that aborts the request (as browsers reject it) stays quiet', async () => {
  const mounts = []
  const warnings = []
  const parts = gateParts(mounts)
  const output = buildClient(name => parts[name], ['shared.js', 'a.js', 'b.js', 'c.js'])
  const loaded = evaluate(output, {
    mounts,
    console: { warn(...args) { warnings.push(args) } },
    fetch(url, init) {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  })
  const ctx = gateCtx()
  loaded[0].factory(() => ({})).apply(ctx)
  ctx.dispose()
  await settle()
  assert.deepEqual(mounts, [], 'nothing mounts')
  assert.equal(warnings.length, 0, 'the aborted request is not reported after a disposal')
})

test('a settled feature-list request leaves no abort timer behind', async () => {
  const mounts = []
  const timers = makeTimers()
  const parts = gateParts(mounts)
  const output = buildClient(name => parts[name], ['shared.js', 'a.js', 'b.js', 'c.js'])
  const loaded = evaluate(output, {
    mounts,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: () => resolved({ ok: true, status: 200, json: () => resolved({ features: ['a', 'c'] }) }),
  })
  loaded[0].factory(() => ({})).apply(gateCtx())
  await settle()
  assert.deepEqual(mounts, ['a', 'c'], 'the listed features mount')
  assert.equal(timers.pending().length, 0, 'the abort timer is cleared once the request settles')
})

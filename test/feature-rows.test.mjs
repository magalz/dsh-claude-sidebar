import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enableFeature, features, getFeatures } from '../host/features.js'
import { FEATURES_ROUTE, apply as applyRoot, inject as rootInject, name as rootName } from '../index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = relative => readFileSync(join(ROOT, relative), 'utf8')

/** The nine rows of the spec table, in order, with their exact id and specifier. */
const ROWS = [
  { feature: null, id: 'claude-sidebar', spec: 'dsh-claude-sidebar', title: 'Claude sidebar' },
  { feature: 'rail', id: 'claude-sidebar-rail', spec: 'dsh-claude-sidebar/rail', title: 'Claude sidebar: icon rail' },
  { feature: 'jobs', id: 'claude-sidebar-jobs', spec: 'dsh-claude-sidebar/jobs', title: 'Claude sidebar: Jobs tab' },
  { feature: 'subagents', id: 'claude-sidebar-subagents', spec: 'dsh-claude-sidebar/subagents', title: 'Claude sidebar: Subagents tab' },
  { feature: 'environment', id: 'claude-sidebar-environment', spec: 'dsh-claude-sidebar/environment', title: 'Claude sidebar: Environment tab' },
  { feature: 'run', id: 'claude-sidebar-run', spec: 'dsh-claude-sidebar/run', title: 'Claude sidebar: Run button' },
  { feature: 'git', id: 'claude-sidebar-git', spec: 'dsh-claude-sidebar/git', title: 'Claude sidebar: Git tab' },
  { feature: 'sizing', id: 'claude-sidebar-sizing', spec: 'dsh-claude-sidebar/sizing', title: 'Claude sidebar: pane sizes' },
  { feature: 'browser', id: 'claude-sidebar-browser', spec: 'dsh-claude-sidebar/browser', title: 'Claude sidebar: open in Browser' },
]

/** A Host ctx that runs effects now, records route registrations and keeps dispose callbacks. */
function fakeCtx() {
  const disposes = []
  const registered = []
  return {
    disposes,
    registered,
    effect(effect) {
      const dispose = effect()
      if (typeof dispose === 'function') disposes.push(dispose)
      return dispose
    },
    get() { return undefined },
    webServer: { register(route) { registered.push(route); return () => {} } },
  }
}

/** Call a registered route once and read its answer. */
async function call(route, { url = FEATURES_ROUTE, method = 'GET', headers = { host: '127.0.0.1:50277' } } = {}) {
  const req = { method, url, headers }
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, fields) { this.statusCode = status; this.headers = fields },
    end(payload) { this.body = payload ?? '' },
  }
  await route.handler(req, res)
  return { status: res.statusCode, headers: res.headers, body: res.body === '' ? null : JSON.parse(res.body) }
}

/* ------------------------------------------------------------------ */
/* The root row and its features route                                  */
/* ------------------------------------------------------------------ */

test('the root row registers a guarded, method-checked, no-store features route', async () => {
  assert.equal(rootName, 'claude-sidebar')
  assert.deepEqual(rootInject, ['webServer'])

  const enabled = fakeCtx()
  enableFeature(enabled, 'zeta')
  enableFeature(enabled, 'alpha')
  try {
    assert.ok(features.has('zeta') && features.has('alpha'), 'the names are registered')

    const ctx = fakeCtx()
    applyRoot(ctx)
    const route = ctx.registered.find(item => item.path === FEATURES_ROUTE)
    assert.ok(route, 'the features route is registered')
    assert.equal(route.kind, 'exact')
    assert.equal(FEATURES_ROUTE, '/dsh-claude-sidebar/features')

    const answer = await call(route)
    assert.equal(answer.status, 200)
    assert.equal(answer.headers['Cache-Control'], 'no-store')
    assert.equal(answer.headers['Content-Type'], 'application/json; charset=utf-8')
    assert.deepEqual(Object.keys(answer.body), ['features'])
    assert.deepEqual(answer.body.features, ['alpha', 'zeta'], 'the list is sorted')

    const refused = await call(route, { headers: { host: '127.0.0.1:50277', origin: 'https://example.com' } })
    assert.equal(refused.status, 403)
    assert.deepEqual(refused.body, { error: 'origin-not-trusted' })
    assert.equal(refused.headers['Cache-Control'], 'no-store')

    const wrongHost = await call(route, { headers: { host: 'evil.example' } })
    assert.equal(wrongHost.status, 403)
    assert.deepEqual(wrongHost.body, { error: 'host-not-trusted' })

    const wrongMethod = await call(route, { method: 'POST' })
    assert.equal(wrongMethod.status, 405)
    assert.deepEqual(wrongMethod.body, { error: 'method not allowed' })
    assert.equal(wrongMethod.headers['Cache-Control'], 'no-store')
  } finally {
    enabled.disposes.forEach(dispose => dispose())
  }
})

test('enableFeature adds a name and removes it when the row stops', () => {
  const ctx = fakeCtx()
  assert.equal(features.has('disposable-probe'), false)
  enableFeature(ctx, 'disposable-probe')
  assert.equal(features.has('disposable-probe'), true, 'apply adds the name')
  assert.ok(getFeatures().includes('disposable-probe'), 'the getter lists it')
  assert.equal(ctx.disposes.length, 1, 'the row gets one dispose callback')
  ctx.disposes[0]()
  assert.equal(features.has('disposable-probe'), false, 'dispose removes the name')
  assert.equal(getFeatures().includes('disposable-probe'), false)
})

/* ------------------------------------------------------------------ */
/* The patch, the manifest, the locale and the icons                    */
/* ------------------------------------------------------------------ */

test('cordis.patch.yml lists the nine spec rows in order with their exact specifiers', () => {
  const patch = read('cordis.patch.yml')
  const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gmu)].map(match => match[1])
  assert.deepEqual(ids, ROWS.map(row => row.id))
  const names = [...patch.matchAll(/^\s*name:\s*'([^']+)'\s*$/gmu)].map(match => match[1])
  assert.deepEqual(names, ROWS.map(row => row.spec))
  assert.equal(patch.includes('claude-sidebar-browser-tool'), false, 'the old browser-tool row is gone')
})

test('every patch row has a package export, locale title and description, and an icon', () => {
  const pkg = JSON.parse(read('package.json'))
  for (const row of ROWS) {
    const feature = row.feature
    const key = feature === null ? '.' : './' + feature
    const expected = feature === null ? './index.js' : './features/' + feature + '/host.js'
    assert.equal(pkg.exports[key], expected, row.id + ' has its Host export')

    const localePath = feature === null ? 'locale/en.json' : 'features/' + feature + '/locale/en.json'
    assert.ok(existsSync(join(ROOT, localePath)), row.id + ' has a locale file')
    const meta = JSON.parse(read(localePath)).meta
    assert.equal(meta.title, row.title, row.id + ' has the spec title in sentence case')
    assert.equal(typeof meta.description, 'string', row.id + ' has a description')
    assert.ok(meta.description.length >= 40, row.id + ' describes the feature')
    assert.match(meta.description, /nothing outside (?:dsh|DeepSeek Harness)/iu, row.id + ' says it sends nothing outside dsh')

    const iconPath = feature === null ? 'icon.svg' : 'features/' + feature + '/icon.svg'
    assert.ok(existsSync(join(ROOT, iconPath)), row.id + ' has an icon')
    const icon = read(iconPath)
    assert.match(icon, /^<svg\b/u, row.id + ' icon is an SVG')
    assert.ok(Buffer.byteLength(icon) < 2048, row.id + ' icon is under 2 KiB')
    if (feature !== null) {
      assert.match(icon, /viewBox="0 0 24 24"/u, row.id + ' icon uses the 24x24 viewBox')
      assert.match(icon, /stroke="currentColor"/u, row.id + ' icon is monochrome')
    }
  }
})

test('package.json points main and the Host files at the new layout', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.main, './index.js')
  assert.equal(pkg.exports['.'], './index.js')
  for (const key of ['./client', './locale/*.json', './icon', './cordis.patch.yml', './package.json']) {
    assert.ok(key in pkg.exports, key + ' export is kept')
  }
  for (const feature of ROWS.slice(1).map(row => row.feature)) {
    assert.equal(pkg.exports['./' + feature + '/locale/*.json'], './features/' + feature + '/locale/*.json')
    assert.equal(pkg.exports['./' + feature + '/icon'], './features/' + feature + '/icon.svg')
  }
  for (const file of ['index.js', 'host/', 'features/', 'cordis.patch.yml']) {
    assert.ok(pkg.files.includes(file), file + ' is shipped')
  }
  assert.equal(typeof pkg.peerDependencies?.['@deepseek-ai/dsh-tools'], 'string', 'the tools peer stays for the browser row')
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-terminal-controller',
  ], 'dsh.client is unchanged')
  for (const file of ['index.js', 'host/features.js', 'host/http.js', 'host/session.js', 'host/git.js', 'host/redact.js']) {
    assert.match(pkg.scripts.check, new RegExp('node --check ' + file.replace(/[/.]/gu, '\\$&') + '(?=\\s|$)', 'u'), 'check covers ' + file)
  }
})

/* ------------------------------------------------------------------ */
/* One Loader row per feature                                           */
/* ------------------------------------------------------------------ */

test('every feature host module exports a unique name, its inject list and apply', async () => {
  const seen = new Set()
  for (const row of ROWS.slice(1)) {
    const feature = row.feature
    const path = 'features/' + feature + '/host.js'
    assert.ok(existsSync(join(ROOT, path)), row.id + ' has a Host module')
    const expectedInject = feature === 'browser' ? ['tools'] : ['environment', 'git'].includes(feature) ? ['webServer'] : []
    // The browser and environment rows import optional @deepseek-ai peers, which are not
    // installed in this checkout; check their exports in source like the tool test does.
    if (feature === 'browser' || feature === 'environment') {
      const text = read(path)
      assert.match(text, new RegExp("export const name = '" + row.id + "'", 'u'))
      assert.match(text, new RegExp("export const inject = \\['" + expectedInject[0] + "'\\]", 'u'))
      assert.match(text, /export function apply\(/u)
      if (feature === 'environment') {
        assert.match(text, /export const Config = z\.object\(\{/u, 'the Environment row declares its Settings')
        for (const field of ['taskFacts', 'trackerUrl', 'registryPath']) {
          const line = text.split('\n').find(item => item.trim().startsWith(field + ':'))
          assert.match(line ?? '', /\.volatile\(\)/u, field + ' is writable in Settings on dsh 0.2')
        }
      }
    } else {
      const mod = await import('../' + path)
      assert.equal(mod.name, row.id, row.id + ' exports its unique name')
      assert.equal(seen.has(mod.name), false, 'names are unique')
      assert.ok(Array.isArray(mod.inject), row.id + ' exports an inject list')
      assert.equal(typeof mod.apply, 'function', row.id + ' exports apply')
      assert.deepEqual(mod.inject, expectedInject, row.id + ' injects only what it needs')
    }
    seen.add(row.id)
  }
})

test('every row apply enables its feature; switch-only rows install nothing', async () => {
  for (const feature of ['rail', 'jobs', 'subagents', 'run', 'sizing', 'git']) {
    const mod = await import('../features/' + feature + '/host.js')
    const ctx = fakeCtx()
    mod.apply(ctx)
    assert.equal(features.has(feature), true, feature + ' is enabled by apply')
    if (['rail', 'jobs', 'subagents', 'run', 'sizing'].includes(feature)) {
      assert.deepEqual(ctx.registered, [], feature + ' installs no route')
    } else {
      assert.ok(ctx.registered.length > 0, feature + ' still installs its routes')
    }
    ctx.disposes.forEach(dispose => dispose())
    assert.equal(features.has(feature), false, feature + ' is removed on dispose')
  }

  // The browser and environment rows import optional peers absent from this checkout; check their source.
  const browser = read('features/browser/host.js')
  assert.match(
    browser,
    /export function apply\(ctx\) \{[\s\S]*?enableFeature\(ctx, 'browser'\)[\s\S]*?\}/u,
    'the browser row enables its feature in apply',
  )
  const environment = read('features/environment/host.js')
  assert.match(
    environment,
    /export function apply\(ctx, config\) \{[\s\S]*?enableFeature\(ctx, 'environment'\)[\s\S]*?installEnvironment\(ctx, config\)/u,
    'the environment row enables its feature and installs its route with the config',
  )
  assert.match(environment, /export const Config = z\.object\(\{/u, 'the environment row declares its Settings')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openInBrowserTool, parseOpenUrl } from '../features/browser/core.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const DESCRIPTION = "Open a web page for the person in a Browser tab of the right sidebar in their dsh window, in this session. Use it to show them a page (documentation, a local dev server, a pull request). It does not return the page's content; use web_fetch to read a page."
const PARAM_DESCRIPTION = 'http or https address; localhost allowed; an address without a scheme gets https://'

/* ------------------------------------------------------------------ */
/* parseOpenUrl: the Browser tab's allowlist, mirrored                 */
/* ------------------------------------------------------------------ */

test('parseOpenUrl accepts http(s) addresses and keeps their canonical href', () => {
  assert.deepEqual(parseOpenUrl('https://example.com/a?b#c'), { ok: true, url: 'https://example.com/a?b#c' })
  assert.deepEqual(parseOpenUrl('http://localhost:5173/'), { ok: true, url: 'http://localhost:5173/' })
})

test('parseOpenUrl gives a scheme-less address https:// and normalizes it', () => {
  assert.deepEqual(parseOpenUrl('example.com'), { ok: true, url: 'https://example.com/' })
})

test('parseOpenUrl treats host:port without a scheme as an address, not a scheme', () => {
  assert.deepEqual(parseOpenUrl('127.0.0.1:3000/x'), { ok: true, url: 'https://127.0.0.1:3000/x' })
  assert.deepEqual(parseOpenUrl('example.com:3000/x'), { ok: true, url: 'https://example.com:3000/x' })
})

test('parseOpenUrl refuses empty and whitespace-only addresses', () => {
  for (const input of ['', '   ', '\t\n']) {
    assert.deepEqual(parseOpenUrl(input), { ok: false, reason: 'empty' }, JSON.stringify(input))
  }
})

test('parseOpenUrl refuses addresses over 16 KiB but accepts the exact limit', () => {
  const prefix = 'https://example.com/'
  const over = prefix + 'a'.repeat(16 * 1024)
  assert.deepEqual(parseOpenUrl(over), { ok: false, reason: 'invalid' })
  const atLimit = prefix + 'a'.repeat(16 * 1024 - prefix.length)
  assert.equal(atLimit.length, 16 * 1024)
  assert.deepEqual(parseOpenUrl(atLimit), { ok: true, url: atLimit })
})

test('parseOpenUrl refuses protocols outside http(s)', () => {
  for (const input of ['javascript:alert(1)', 'file:///C:/x', 'data:text/html,x', 'ftp://x']) {
    assert.deepEqual(parseOpenUrl(input), { ok: false, reason: 'protocol' }, input)
  }
})

test('parseOpenUrl refuses embedded credentials', () => {
  assert.deepEqual(parseOpenUrl('https://user:pass@host/'), { ok: false, reason: 'credentials' })
})

test('parseOpenUrl refuses addresses the URL parser rejects', () => {
  assert.deepEqual(parseOpenUrl('https://['), { ok: false, reason: 'invalid' })
})

/* ------------------------------------------------------------------ */
/* The definition options                                              */
/* ------------------------------------------------------------------ */

test('the definition has the tool name, description, parameter and output schema from the spec', () => {
  const definition = openInBrowserTool({ argsError: message => new Error(message) })
  assert.equal(definition.name, 'open_in_browser')
  assert.equal(definition.description, DESCRIPTION)
  assert.deepEqual(definition.parameters, {
    url: { type: 'string', required: true, description: PARAM_DESCRIPTION },
  })
  assert.deepEqual(definition.output.schema, {
    type: 'object',
    additionalProperties: false,
    properties: { url: { type: 'string', required: true } },
  })
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(typeof definition.execute, 'function')
})

test('execute returns the canonical href', async () => {
  const definition = openInBrowserTool({ argsError: message => new Error(message) })
  assert.deepEqual(await definition.execute({ url: 'example.com' }), { url: 'https://example.com/' })
})

test('execute throws the argsError result with the refusal reason', async () => {
  const sentinel = new Error('refused')
  let reason
  const definition = openInBrowserTool({
    argsError(message) {
      reason = message
      return sentinel
    },
  })
  await assert.rejects(() => definition.execute({ url: 'javascript:alert(1)' }), error => error === sentinel)
  assert.equal(reason, 'url must use http or https')
  await assert.rejects(() => definition.execute({ url: 'https://user:pw@example.com/' }))
  assert.equal(reason, 'url must not contain a user name or password')
})

test('openInBrowserTool() without an argsError builder falls back to a plain Error', async () => {
  const definition = openInBrowserTool()
  await assert.rejects(() => definition.execute({ url: '' }), /empty/u)
})

test('output.render says the person\'s window was asked to open the URL', () => {
  const definition = openInBrowserTool()
  assert.deepEqual(definition.output.render({ url: 'example.com' }, { url: 'https://example.com/' }), [{
    type: 'text',
    text: "Asked the person's dsh window to open https://example.com/ in a Browser tab. It opens when this session is on screen.",
  }])
})

/* ------------------------------------------------------------------ */
/* The manifest, the patch and the thin Host row                       */
/* ------------------------------------------------------------------ */

test('package.json exports and ships the browser feature modules', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./browser'], './features/browser/host.js')
  assert.ok(pkg.files.includes('features/'), 'files ships the features folder')
  // A linked plugin's bare import of a shipped package is routed to the dsh installation only when the
  // plugin's manifest lists it as a peer (dsh-app-boot src/profile-resolution/resolver.ts:636-653).
  assert.equal(typeof pkg.peerDependencies?.['@deepseek-ai/dsh-tools'], 'string', 'dsh-tools is a peer dependency')
})

test('cordis.patch.yml inserts the browser row with the new id and specifier', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const rows = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gmu)].map(match => match[1])
  assert.deepEqual(rows, [
    'claude-sidebar', 'claude-sidebar-rail', 'claude-sidebar-jobs', 'claude-sidebar-subagents',
    'claude-sidebar-environment', 'claude-sidebar-run', 'claude-sidebar-git',
    'claude-sidebar-sizing', 'claude-sidebar-browser',
  ])
  assert.equal(patch.includes('claude-sidebar-browser-tool'), false, 'the old browser-tool row is gone')
  assert.match(patch, /^\s*name:\s*'dsh-claude-sidebar\/browser'\s*$/mu)
})

test('features/browser/host.js is a thin row that registers the tool exactly once', () => {
  const text = readFileSync(join(ROOT, 'features/browser/host.js'), 'utf8')
  assert.match(text, /from '@deepseek-ai\/dsh-tools'/u, 'imports from the tools package')
  assert.match(text, /\bdefineTool\b/u)
  assert.match(text, /\bToolArgsError\b/u)
  assert.match(text, /from '\.\/core\.js'/u, 'imports the core')
  assert.match(text, /\bopenInBrowserTool\b/u)
  assert.match(text, /export const name = 'claude-sidebar-browser'/u)
  assert.match(text, /export const inject = \['tools'\]/u)
  assert.equal((text.match(/ctx\.tools\.register\(/gu) ?? []).length, 1, 'one registration')
})

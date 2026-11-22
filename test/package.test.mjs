/**
 * Publication metadata: what a registry, a Git install and dsh's version check read from
 * package.json.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const REPO = 'https://github.com/magalz/dsh-claude-sidebar'

test('package.json names the license, repository, homepage and issue tracker', () => {
  assert.equal(pkg.license, 'MIT')
  assert.deepEqual(pkg.repository, { type: 'git', url: 'git+' + REPO + '.git' })
  assert.equal(pkg.homepage, REPO + '#readme')
  assert.deepEqual(pkg.bugs, { url: REPO + '/issues' })
  for (const keyword of ['dsh', 'dsh-plugin', 'deepseek-harness']) {
    assert.ok(pkg.keywords.includes(keyword), 'keyword ' + keyword)
  }
})

test('engines.dsh matches the dsh-tools peer range, and Node 22 is the floor', () => {
  assert.equal(pkg.engines.dsh, pkg.peerDependencies['@deepseek-ai/dsh-tools'])
  assert.equal(pkg.engines.node, '>=22')
})

test('files covers every exported path and the license', () => {
  const covered = target => {
    const path = target.replace(/^\.\//u, '')
    if (path === 'package.json') return true
    return pkg.files.some(entry => {
      if (entry.endsWith('/')) return path.startsWith(entry)
      if (entry.includes('*')) {
        const pattern = new RegExp('^' + entry.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]+') + '$', 'u')
        return pattern.test(path)
      }
      return entry === path
    })
  }
  for (const [key, target] of Object.entries(pkg.exports)) {
    assert.ok(covered(target), 'export ' + key + ' (' + target + ') is in files')
  }
  assert.ok(pkg.files.includes('LICENSE'), 'the license ships')
})

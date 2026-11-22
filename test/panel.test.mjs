import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cardOf,
  capProgress,
  followsConvention,
  linkOf,
  parseRegistry,
  parseRepoSlug,
  progressPath,
} from '../features/environment/facts.js'

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const LINKS = {
  'example-org/example-app': { status: 'linked', teamId: 1, projectId: 5, projectRef: 'example-team.ACL' },
  'example-org/tracker': { status: 'declined', declinedAt: '2026-01-01T00:00:00.0000000Z' },
}
const LINKED = { state: 'linked', projectRef: 'example-team.ACL' }
const UNLINKED = { state: 'unlinked' }
/** A neutral tracker address; no private origin is built into the plugin. */
const TRACKER = 'https://tracker.example.com'

/* ------------------------------------------------------------------ */
/* Repository slug                                                     */
/* ------------------------------------------------------------------ */

test('a github.com remote yields a lowercased owner/repo slug with ".git" stripped, in https, ssh:// and git@ form', () => {
  assert.equal(parseRepoSlug('https://github.com/Example-Org/Example-App.git'), 'example-org/example-app')
  assert.equal(parseRepoSlug('ssh://git@github.com/Example-Org/Example-App.git'), 'example-org/example-app')
  assert.equal(parseRepoSlug('git@github.com:Example-Org/Example-App.git'), 'example-org/example-app')
  assert.equal(parseRepoSlug('https://github.com/example-org/tracker'), 'example-org/tracker')
})

test('a remote that is not on github.com yields no slug', () => {
  assert.equal(parseRepoSlug('https://gitlab.com/example-org/tracker.git'), null)
  assert.equal(parseRepoSlug('git@example.com:example-org/tracker.git'), null)
  assert.equal(parseRepoSlug(undefined), null)
})

/* ------------------------------------------------------------------ */
/* Card and branch convention                                          */
/* ------------------------------------------------------------------ */

test('a conforming branch names the card and follows the convention', () => {
  assert.deepEqual(cardOf('feat/ACL-12-login', LINKED, TRACKER), {
    key: 'ACL-12',
    url: TRACKER + '/example-team/issue/ACL-12',
  })
  assert.equal(followsConvention('feat/ACL-12-login', LINKED, false), true)
  assert.equal(cardOf('feat/acl-7-two-words', LINKED, TRACKER).key, 'ACL-7', 'the key is matched case-insensitively and reported in upper case')
})

test('a branch that names the card but breaks the pattern reports the card and does not follow', () => {
  for (const branch of ['ACL-12-login', 'Feat/ACL-12-login', 'feat/ACL-12']) {
    assert.deepEqual(cardOf(branch, LINKED, TRACKER), { key: 'ACL-12', url: TRACKER + '/example-team/issue/ACL-12' }, branch)
    assert.equal(followsConvention(branch, LINKED, false), false, branch)
  }
})

test('card URLs encode the team slug and key as path segments', () => {
  const spaced = { state: 'linked', projectRef: 'My Team.ACL' }
  assert.deepEqual(cardOf('feat/ACL-12-login', spaced, TRACKER), {
    key: 'ACL-12',
    url: TRACKER + '/My%20Team/issue/ACL-12',
  })
  const fragmented = { state: 'linked', projectRef: 'team#x.ACL' }
  assert.deepEqual(cardOf('feat/ACL-12-login', fragmented, TRACKER), {
    key: 'ACL-12',
    url: TRACKER + '/team%23x/issue/ACL-12',
  })
})

test('a linked branch with no card number reports no card and does not follow', () => {
  assert.equal(cardOf('feat/login-flow', LINKED), null)
  assert.equal(followsConvention('feat/login-flow', LINKED, false), false)
})

test('a detached head reports no card and a null convention', () => {
  assert.equal(cardOf(null, LINKED), null)
  assert.equal(followsConvention(null, LINKED, true), null)
})

test('a repository that is not linked reports no card and a null convention', () => {
  for (const link of [UNLINKED, { state: 'declined' }, { state: 'n/a' }]) {
    assert.equal(cardOf('feat/ACL-12-login', link), null)
    assert.equal(followsConvention('feat/ACL-12-login', link, false), null)
  }
})

/* ------------------------------------------------------------------ */
/* Link lookup                                                         */
/* ------------------------------------------------------------------ */

test('a linked registry entry reports linked with its projectRef', () => {
  assert.deepEqual(linkOf(parseRegistry(JSON.stringify(LINKS)), 'example-org/example-app'), LINKED)
})

test('a declined registry entry reports declined without a projectRef', () => {
  assert.deepEqual(linkOf(parseRegistry(JSON.stringify(LINKS)), 'example-org/tracker'), { state: 'declined' })
})

test('a repository with no registry entry is unlinked', () => {
  assert.deepEqual(linkOf(parseRegistry(JSON.stringify(LINKS)), 'example-org/unknown'), { state: 'unlinked' })
})

test('an absent or unreadable registry reads as empty, so the repository is unlinked', () => {
  for (const text of [undefined, '', 'not json', '[]']) {
    assert.deepEqual(parseRegistry(text), {})
    assert.deepEqual(linkOf(parseRegistry(text), 'example-org/example-app'), { state: 'unlinked' })
  }
})

/* ------------------------------------------------------------------ */
/* Progress file                                                       */
/* ------------------------------------------------------------------ */

test('the progress file is a sibling of the work tree root, named after it plus ".progress.md"', () => {
  assert.equal(progressPath('D:/Repos/example-repo/.worktrees/ACL-12'), 'D:/Repos/example-repo/.worktrees/ACL-12.progress.md')
  assert.equal(progressPath('D:/Repos/example-repo/'), 'D:/Repos/example-repo.progress.md')
})

test('progress text is cut at 6000 characters and reported as truncated', () => {
  assert.deepEqual(capProgress('short'), { text: 'short', truncated: false })
  assert.deepEqual(capProgress('x'.repeat(6000)), { text: 'x'.repeat(6000), truncated: false })
  assert.deepEqual(capProgress('x'.repeat(9000)), { text: 'x'.repeat(6000), truncated: true })
  assert.deepEqual(capProgress('x'.repeat(10), 4), { text: 'xxxx', truncated: true })
})

/* ------------------------------------------------------------------ */
/* The client bundle                                                   */
/* ------------------------------------------------------------------ */

test('the client registers the Environment, Jobs and Subagents tab types and their body seats, and no Task tab', async () => {
  const loaded = []
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  globalThis.window = { __ModuleLoader__: { load(entry) { loaded.push(entry) } } }
  /* The gated apply() asks for the feature list; answer with all rows, settled synchronously
     so the tab types are registered by the time the assertions below run. */
  const chain = value => ({
    then(fn) { const out = fn(value); return out && typeof out.then === 'function' ? out : chain(out) },
    catch() { return chain(value) },
  })
  globalThis.fetch = () => chain({
    ok: true,
    status: 200,
    json: () => chain({ features: ['rail', 'jobs', 'subagents', 'environment', 'run', 'git', 'sizing', 'browser'] }),
  })
  try {
    await import('../client.js?client-half')
    assert.equal(loaded.length, 1, 'the factory script registers exactly one bundle')
    assert.equal(loaded[0].id, 'dsh-claude-sidebar')

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
      createElement(type, props, ...children) { return { type, props: { ...props, children } } },
      useState() { throw new Error('the mount test does not render') },
      useEffect() { throw new Error('the mount test does not render') },
    }
    const plugin = loaded[0].factory(name => {
      assert.equal(name, 'react')
      return React
    })
    assert.deepEqual(plugin.inject, ['slots', 'sidebarRightTabs', 'sidebarRight', 'jobs', 'sessions', 'uiWorkspace'])

    const tabs = []
    const seats = []
    const effects = []
    const ctx = {
      effect(effect) { effects.push(effect); return effect() },
      sidebarRightTabs: { register(definition) { tabs.push(definition); return () => {} } },
      slots: {
        inject(name, mount) {
          assert.ok(
            name === 'sidebar.right.pane.tab' ||
              name === 'tool.call.toolview' ||
              name === 'plugins.row.config',
            'unexpected slot ' + name,
          )
          mount()
        },
        register(spec, component) { seats.push({ spec, component }); return () => {} },
      },
    }
    plugin.apply(ctx)

    assert.equal(effects.length, 8, 'the four tab types, sizing, the two browser tool views and the gate live inside ctx.effect')
    assert.equal(tabs.length, 4)
    assert.deepEqual(
      tabs.map(tab => tab.id).sort(),
      [
        'dsh-claude-sidebar/environment',
        'dsh-claude-sidebar/git',
        'dsh-claude-sidebar/jobs',
        'dsh-claude-sidebar/subagents',
      ],
      'the bundle registers the three remaining tab types, the Git tab and no Task tab',
    )
    const environment = tabs.find(tab => tab.id === 'dsh-claude-sidebar/environment')
    assert.equal(environment.kind, 'claude-sidebar-environment')
    assert.equal(environment.title(), 'Environment')
    assert.equal(environment.guide[0].title(), 'Environment')
    assert.ok(
      tabs.some(tab => tab.id === 'dsh-claude-sidebar/jobs' && tab.kind === 'claude-sidebar-jobs'),
      'the Jobs tab type is registered too',
    )
    assert.ok(
      tabs.some(tab => tab.id === 'dsh-claude-sidebar/subagents' && tab.kind === 'claude-sidebar-subagents'),
      'the Subagents tab type is registered too',
    )
    assert.equal(seats.length, 7, 'four tab bodies, two browser tool views and the Environment row config page')
    const configSeat = seats.find(seat => seat.spec.key === 'dsh-claude-sidebar#claude-sidebar-environment')
    assert.ok(configSeat, 'the Environment row config page is registered')
    assert.equal(configSeat.spec.name, 'plugins.row.config')
    assert.equal(typeof configSeat.component, 'function')
    const environmentSeat = seats.find(seat => seat.spec.key === 'dsh-claude-sidebar/environment')
    assert.ok(environmentSeat, 'the Environment tab body seat is registered')
    assert.equal(environmentSeat.spec.name, 'sidebar.right.pane.tab')
    assert.equal(environmentSeat.spec.key, 'dsh-claude-sidebar/environment')
    assert.equal(typeof environmentSeat.spec.inject, 'function', 'the Environment body gets its Reconnect handle')
    assert.equal(typeof environmentSeat.component, 'function')
    assert.ok(
      seats.some(seat => seat.spec.key === 'dsh-claude-sidebar/jobs'),
      'the Jobs tab body seat is registered too',
    )
    assert.ok(
      seats.some(seat => seat.spec.key === 'dsh-claude-sidebar/subagents'),
      'the Subagents tab body seat is registered too',
    )
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})

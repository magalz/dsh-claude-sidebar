import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as facts from '../features/environment/facts.js'
import {
  connectorView,
  pinnedConnectors,
  pullRequestView,
  summarizeChanges,
} from '../features/environment/facts.js'
import { parseStatusV2 } from '../host/git.js'
import { redactUrls } from '../host/redact.js'
import * as routeModule from '../features/environment/route.js'
import { ENV_ROUTE, installEnvironment } from '../features/environment/route.js'
import { FEATURES_ROUTE, apply as applyRoot } from '../index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** The neutral tracker address tests configure; the old private origin must not appear anywhere. */
const TRACKER = 'https://tracker.example.com'
/** The well-known key a dsh Loader puts on a `.volatile()` config reference. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Stand in for the live reference the Loader hands a volatile config field. */
function volatileRef(value) {
  return { get: () => value, [VOLATILE_WRITE]: () => {} }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const WORKTREE = 'D:/Repos/example-repo/.worktrees/ACL-12'
const PULL = 'https://github.com/Example-Org/Example-App/pull/'

const LINKS = {
  'example-org/example-app': { status: 'linked', teamId: 1, projectId: 5, projectRef: 'example-team.ACL' },
}

/** Status output: a branch with its upstream, one staged ordinary change and one untracked file. */
const STATUS = [
  '# branch.oid 1111111111111111111111111111111111111111',
  '# branch.head feat/ACL-12-login',
  '# branch.upstream origin/feat/ACL-12-login',
  '# branch.ab +1 -0',
  '1 M. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 src/staged.js',
  '? notes.md',
].join('\0') + '\0'

/** Every git answer the faked handler may ask for, keyed by the argument list after the executable. */
const GIT_ANSWERS = {
  'rev-parse --show-toplevel': WORKTREE,
  'rev-parse --abbrev-ref HEAD': 'feat/ACL-12-login',
  'rev-parse --absolute-git-dir': 'D:/Repos/example-repo/.git/worktrees/ACL-12',
  'rev-parse --git-common-dir': 'D:/Repos/example-repo/.git',
  'config --get remote.origin.url': 'git@github.com:Example-Org/Example-App.git',
  'worktree list --porcelain': 'worktree D:/Repos/example-repo\nHEAD 1111111\nbranch refs/heads/main\n\nworktree D:/Repos/example-repo/.worktrees/ACL-12\nHEAD 2222222\nbranch refs/heads/feat/ACL-12-login\n',
}

/** Files the faked handler may read, keyed by absolute path. */
const FILES = {
  'C:/Users/test/.claude/itsaplan/links.json': JSON.stringify(LINKS),
  'D:/Repos/example-repo/.worktrees/ACL-12.progress.md': '# Progress\n\nCard ACL-12 in review.\n',
}

/** A stand-in for the dsh services the Host route uses; the returned route is the real handler.
 *  Its Connection service allows requests unless a test overrides it. */
function fakeHost({
  rows = [{ sessionId: 's1', cwd: WORKTREE }],
  services = {},
  deps = fakeDeps(),
  config = { taskFacts: true, trackerUrl: TRACKER, registryPath: '' },
} = {}) {
  const registered = []
  const reads = []
  const controller = services.sessionController ?? {
    list: async () => ({ items: rows }),
  }
  const mounted = { connection: { requestRejection: () => undefined }, ...services }
  const ctx = {
    effect(effect) { return effect() },
    get(name) {
      reads.push(name)
      return name === 'sessionController' ? controller : mounted[name]
    },
    webServer: { register(route) { registered.push(route); return () => {} } },
    logger: { warn() {} },
  }
  installEnvironment(ctx, config, deps)
  return {
    ctx,
    registered,
    reads,
    route: registered.find(route => route.path === ENV_ROUTE),
  }
}

/** The faked file system: a known path answers its text, anything else raises ENOENT. */
function fakeFiles(files = FILES) {
  return async filePath => {
    if (Object.hasOwn(files, filePath)) return files[filePath]
    const error = new Error("ENOENT: no such file or directory, open '" + filePath + "'")
    error.code = 'ENOENT'
    throw error
  }
}

/** The deps the handler tests hand the Host half: faked git, files, env and machine. */
function fakeDeps(overrides = {}) {
  return {
    env: { ITSAPLAN_LINKS_PATH: 'C:/Users/test/.claude/itsaplan/links.json' },
    home: 'C:/Users/test',
    readText: fakeFiles(),
    git: async args => (args.includes('status') ? STATUS : GIT_ANSWERS[args.join(' ')]),
    hostname: 'example-repo-machine',
    platform: 'win32',
    ...overrides,
  }
}

/** A subprocess service that answers git commands from the fixtures; status output can be lossy. */
function fakeSubprocess({ lossyStatus = false, statusAnswer = STATUS } = {}) {
  const spawns = []
  return {
    spawns,
    service: {
      async resolveExecutable(name) { assert.equal(name, 'git'); return 'C:/git/git.exe' },
      spawn(spec) {
        spawns.push(spec)
        const args = spec.argv.slice(1).join(' ')
        const isStatus = spec.argv.includes('status')
        const text = isStatus ? statusAnswer : GIT_ANSWERS[args] ?? ''
        const lossy = isStatus && lossyStatus
        const reader = () => ({ readFrom: () => ({ text, nextOffset: 0, lossy }) })
        return {
          collected: { stdout: reader(), stderr: reader() },
          done: Promise.resolve({ exitCode: 0, signal: null }),
        }
      },
    },
  }
}

/** Call a registered route once and read its answer. */
async function call(route, { url = ENV_ROUTE + '?sessionId=s1', method = 'GET', headers = { host: '127.0.0.1:50277' } } = {}) {
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

/** The header pair every `git status --porcelain=v2 --branch` answer starts with. */
function header(upstream, ahead, behind) {
  const head = '# branch.oid 1111111111111111111111111111111111111111\0# branch.head feat/ACL-12-login\0'
  if (upstream === null) return head
  return head + '# branch.upstream ' + upstream + '\0# branch.ab +' + ahead + ' -' + behind + '\0'
}

/** One ordinary `1` record; the path is last so it may contain spaces. */
function ordinary(xy, path) {
  return '1 ' + xy + ' N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 ' + path + '\0'
}

/* ------------------------------------------------------------------ */
/* Acceptance 1: the porcelain v2 parser and the changes summary        */
/* ------------------------------------------------------------------ */

test('parseStatusV2 and summarizeChanges read the porcelain v2 format', () => {
  const cases = [
    {
      name: 'branch header with an upstream and ahead/behind',
      text: header('origin/feat/ACL-12-login', 2, 1),
      expected: { upstream: 'origin/feat/ACL-12-login', ahead: 2, behind: 1, files: [] },
    },
    {
      name: 'no upstream or ahead/behind header',
      text: header(null),
      expected: { upstream: null, ahead: null, behind: null, files: [] },
    },
    {
      name: 'an ordinary staged change',
      text: ordinary('A.', 'src/staged.js'),
      expected: {
        upstream: null, ahead: null, behind: null,
        files: [{ path: 'src/staged.js', index: 'A', worktree: '.', kind: 'staged' }],
      },
    },
    {
      name: 'an ordinary unstaged change',
      text: ordinary('.M', 'src/unstaged.js'),
      expected: {
        upstream: null, ahead: null, behind: null,
        files: [{ path: 'src/unstaged.js', index: '.', worktree: 'M', kind: 'unstaged' }],
      },
    },
    {
      name: 'a change on both sides',
      text: ordinary('MM', 'src/both.js'),
      expected: {
        upstream: null, ahead: null, behind: null,
        files: [{ path: 'src/both.js', index: 'M', worktree: 'M', kind: 'both' }],
      },
    },
    {
      name: 'a rename carries its original path in the following record',
      text: '2 R. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R100 src/renamed.js\0src/original.js\0',
      expected: {
        upstream: null, ahead: null, behind: null,
        files: [{ path: 'src/renamed.js', origPath: 'src/original.js', index: 'R', worktree: '.', kind: 'staged' }],
      },
    },
    {
      name: 'an original path starting with "? " is consumed, not read as an untracked file',
      text: '2 R. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R100 src/renamed.js\0? original name.txt\0? real untracked.txt\0',
      expected: {
        upstream: null, ahead: null, behind: null,
        files: [
          { path: 'src/renamed.js', origPath: '? original name.txt', index: 'R', worktree: '.', kind: 'staged' },
          { path: 'real untracked.txt', index: '?', worktree: '?', kind: 'untracked' },
        ],
      },
    },
    {
      name: 'an unmerged record',
      text: 'u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 src/conflict.js\0',
      expected: {
        upstream: null, ahead: null, behind: null,
        files: [{ path: 'src/conflict.js', index: 'U', worktree: 'U', kind: 'conflicted' }],
      },
    },
    {
      name: 'an untracked path containing spaces',
      text: '? docs/new notes.md\0',
      expected: {
        upstream: null, ahead: null, behind: null,
        files: [{ path: 'docs/new notes.md', index: '?', worktree: '?', kind: 'untracked' }],
      },
    },
    {
      name: 'ignored and malformed records are skipped',
      text: '! node_modules/\0garbage\0' + ordinary('A.', 'src/kept.js') + '? kept notes.txt\0',
      expected: {
        upstream: null, ahead: null, behind: null,
        files: [
          { path: 'src/kept.js', index: 'A', worktree: '.', kind: 'staged' },
          { path: 'kept notes.txt', index: '?', worktree: '?', kind: 'untracked' },
        ],
      },
    },
  ]
  for (const { name, text, expected } of cases) {
    assert.deepEqual(parseStatusV2(text), expected, name)
  }
  assert.deepEqual(parseStatusV2(undefined), { upstream: null, ahead: null, behind: null, files: [] }, 'non-string input')
  assert.deepEqual(parseStatusV2(''), { upstream: null, ahead: null, behind: null, files: [] }, 'empty output')

  const parsed = parseStatusV2([
    header('origin/main', 3, 0),
    ordinary('M.', 'src/staged.js'),
    ordinary('.M', 'src/unstaged.js'),
    ordinary('MM', 'src/both.js'),
    '2 R. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R100 src/renamed.js\0src/original.js\0',
    'u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 src/conflict.js\0',
    '? docs/new notes.md\0',
    '! ignored/\0',
  ].join(''))
  assert.equal(parsed.files.length, 6)
  const summary = summarizeChanges(parsed, 2)
  assert.deepEqual(summary, {
    upstream: 'origin/main',
    ahead: 3,
    behind: 0,
    staged: 3,
    unstaged: 2,
    untracked: 1,
    conflicted: 1,
    total: 6,
    files: parsed.files.slice(0, 2),
  })
  assert.equal(
    Object.hasOwn(summary, 'truncated'),
    false,
    'the changes summary carries no truncated flag; the tab counts the rest from total',
  )
  assert.equal(Object.hasOwn(summarizeChanges(parseStatusV2(''), 2), 'truncated'), false)
})

/* ------------------------------------------------------------------ */
/* Acceptance 2: machine, directory, task facts and changes             */
/* ------------------------------------------------------------------ */

test('the environment route answers machine, directory, task facts and changes', async () => {
  const host = fakeHost()
  assert.ok(host.route, 'the environment route is registered')
  const answer = await call(host.route)
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['Cache-Control'], 'no-store')
  assert.deepEqual(answer.body.machine, { hostname: 'example-repo-machine', platform: 'win32' })
  assert.equal(answer.body.cwd, WORKTREE)

  assert.deepEqual(answer.body.task, {
    git: {
      root: WORKTREE,
      branch: 'feat/ACL-12-login',
      detached: false,
      linkedWorktree: true,
      mainRoot: 'D:/Repos/example-repo',
    },
    repo: 'example-org/example-app',
    link: { state: 'linked', projectRef: 'example-team.ACL' },
    card: { key: 'ACL-12', url: TRACKER + '/example-team/issue/ACL-12' },
    branchFollowsConvention: true,
    progress: {
      path: WORKTREE + '.progress.md',
      text: '# Progress\n\nCard ACL-12 in review.\n',
      truncated: false,
    },
  })
  assert.deepEqual(answer.body.changes, {
    upstream: 'origin/feat/ACL-12-login',
    ahead: 1,
    behind: 0,
    staged: 1,
    unstaged: 0,
    untracked: 1,
    conflicted: 0,
    total: 2,
    files: [
      { path: 'src/staged.js', index: 'M', worktree: '.', kind: 'staged' },
      { path: 'notes.md', index: '?', worktree: '?', kind: 'untracked' },
    ],
  })
  assert.deepEqual(answer.body.connectors, null)
  assert.deepEqual(answer.body.pullRequests, [])
  assert.deepEqual(answer.body.errors, {})

  const outside = fakeHost({ deps: fakeDeps({ git: async () => undefined }) })
  assert.ok(outside.route)
  const outsideAnswer = await call(outside.route)
  assert.equal(outsideAnswer.status, 200)
  assert.equal(outsideAnswer.body.task.git, null)
  assert.equal(outsideAnswer.body.changes, null)
})

/* ------------------------------------------------------------------ */
/* Changes hardening: failure, bounds and the fsmonitor guard           */
/* ------------------------------------------------------------------ */

test('a status command that does not answer fails its section instead of showing a clean tree', async () => {
  const noStatus = async args => (args.includes('status') ? undefined : GIT_ANSWERS[args.join(' ')])
  const host = fakeHost({ deps: fakeDeps({ git: noStatus }) })
  assert.ok(host.route)
  const answer = await call(host.route)
  assert.equal(answer.status, 200)
  assert.equal(answer.body.changes, null)
  assert.equal(answer.body.errors.changes, 'git status did not answer')
  assert.ok(answer.body.task.git, 'the task facts still answer')
})

test('the status call asks for the 1 MiB bound while the other calls keep the 64 KiB default', async () => {
  const subprocess = fakeSubprocess()
  const host = fakeHost({ services: { subprocess: subprocess.service }, deps: fakeDeps({ git: undefined }) })
  assert.ok(host.route)
  await call(host.route)
  const status = subprocess.spawns.find(spec => spec.argv.includes('status'))
  assert.ok(status, 'the status command ran')
  assert.equal(status.stdio.stdout.maxBytes, 1024 * 1024)
  for (const spec of subprocess.spawns.filter(item => !item.argv.includes('status'))) {
    assert.equal(spec.stdio.stdout.maxBytes, 64 * 1024, spec.argv.slice(1).join(' '))
  }
})

test('the status command disables a repository core.fsmonitor', async () => {
  const subprocess = fakeSubprocess()
  const host = fakeHost({ services: { subprocess: subprocess.service }, deps: fakeDeps({ git: undefined }) })
  assert.ok(host.route)
  await call(host.route)
  const status = subprocess.spawns.find(spec => spec.argv.includes('status'))
  assert.ok(status, 'the status command ran')
  assert.deepEqual(status.argv.slice(1, 3), ['-c', 'core.fsmonitor=false'])
})

test('a lossy status output becomes a changes failure instead of a partial answer', async () => {
  const tail = '1 M. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 src/cut.js\0'
  const subprocess = fakeSubprocess({ lossyStatus: true, statusAnswer: tail })
  const host = fakeHost({ services: { subprocess: subprocess.service }, deps: fakeDeps({ git: undefined }) })
  assert.ok(host.route)
  const answer = await call(host.route)
  assert.equal(answer.status, 200)
  assert.equal(answer.body.changes, null)
  assert.equal(answer.body.errors.changes, 'git status output was too large')
  assert.ok(answer.body.task.git, 'the task facts still answer')
})

/* ------------------------------------------------------------------ */
/* Acceptance 3: connectors and their failure isolation                 */
/* ------------------------------------------------------------------ */

test('connectors come from the MCP manager and their failure stays in its section', async () => {
  const manager = {
    list: () => [
      { name: 'github', configured: true, status: { state: 'connected', toolCount: 7, connectedAt: 1 } },
      {
        name: 'linear',
        configured: true,
        status: {
          state: 'reconnecting',
          attempt: 2,
          maxAttempts: 5,
          nextRetryAtMs: 1,
          lastError: 'x'.repeat(250),
        },
      },
      { name: 'legacy', configured: false, status: { state: 'disabled' } },
    ],
  }
  const host = fakeHost({ services: { mcpManager: manager } })
  assert.ok(host.route, 'the environment route is registered')
  const answer = await call(host.route)
  assert.deepEqual(answer.body.connectors, [
    { name: 'github', configured: true, state: 'connected', toolCount: 7 },
    { name: 'linear', configured: true, state: 'reconnecting', attempt: 2, error: 'x'.repeat(200) },
    { name: 'legacy', configured: false, state: 'disabled' },
  ])
  assert.deepEqual(
    connectorView({ name: 'quiet', configured: true, status: { state: 'closed', result: { closeConfirmed: true } } }),
    { name: 'quiet', configured: true, state: 'closed' },
    'a status without a lastError adds no error',
  )
  assert.deepEqual(
    connectorView({ name: 'gave-up', configured: true, status: { state: 'failed', reason: 'gave-up' } }),
    { name: 'gave-up', configured: true, state: 'failed', reason: 'gave-up' },
    'a failed status without a lastError carries its reason',
  )
  assert.deepEqual(
    connectorView({
      name: 'failed-with-error',
      configured: true,
      status: { state: 'failed', reason: 'reconnect-disabled', lastError: 'sse handshake failed' },
    }),
    {
      name: 'failed-with-error',
      configured: true,
      state: 'failed',
      reason: 'reconnect-disabled',
      error: 'sse handshake failed',
    },
    'a failed status carries both its reason and its lastError',
  )
  assert.deepEqual(
    connectorView({ name: 'plain-failed', configured: true, status: { state: 'failed', reason: 42 } }),
    { name: 'plain-failed', configured: true, state: 'failed' },
    'a non-string reason is not part of the view',
  )
  assert.deepEqual(
    connectorView({
      name: 'connected-reason',
      configured: true,
      status: { state: 'connected', toolCount: 2, reason: 'gave-up' },
    }),
    { name: 'connected-reason', configured: true, state: 'connected', toolCount: 2 },
    'only a failed status carries a reason',
  )
  assert.deepEqual(answer.body.errors, {})

  const absent = fakeHost()
  assert.ok(absent.route)
  assert.equal((await call(absent.route)).body.connectors, null)

  const failing = fakeHost({ services: { mcpManager: { list() { throw new Error('the MCP manager did not answer') } } } })
  assert.ok(failing.route)
  const failed = await call(failing.route)
  assert.equal(failed.status, 200)
  assert.equal(failed.body.connectors, null)
  assert.equal(failed.body.errors.connectors, 'the MCP manager did not answer')
  assert.notEqual(failed.body.changes, null, 'the other sections still answer')
  assert.deepEqual(failed.body.pullRequests, [])

  const longError = fakeHost({ services: { mcpManager: { list() { throw new Error('z'.repeat(250)) } } } })
  assert.ok(longError.route)
  assert.equal((await call(longError.route)).body.errors.connectors, 'z'.repeat(200), 'a section error is cut to 200 characters')

  const leaking = fakeHost({
    services: {
      mcpManager: {
        list() { throw new Error('fetch https://u:tok@x.example/sse?api_key=SECRET failed') },
      },
    },
  })
  assert.ok(leaking.route)
  assert.equal((await call(leaking.route)).body.errors.connectors, 'fetch https://x.example/sse failed')
})

test('credentialRefs returns the template names and nothing else', () => {
  assert.equal(typeof facts.credentialRefs, 'function', 'facts.js exports credentialRefs')
  const entry = {
    command: 'linear-mcp',
    env: { OUTER: '${credential:API_KEY}', NESTED: [{ DEEP: 'prefix ${credential:ACCOUNT_ID} suffix' }] },
    headers: { Authorization: 'Bearer ${credential:API_KEY}', Literal: 'sk-literal-not-a-template' },
    url: 'https://example.com/${credential:REGION}/sse',
    args: ['--token', '${credential:API_KEY}', '--bad', '${credential:bad-name}', '--no', '${credential:9NOPE}'],
    enabled: true,
    retries: 3,
  }
  assert.deepEqual(
    facts.credentialRefs(entry),
    ['API_KEY', 'ACCOUNT_ID', 'REGION'],
    'unique names in first-seen order, from strings at every depth',
  )
  assert.deepEqual(facts.credentialRefs(entry, 1), ['API_KEY'], 'the limit keeps the first names only')
  assert.deepEqual(facts.credentialRefs(null), [], 'a missing entry has no credential names')
})

test('credentialRefs reads values only, skips long names and survives cycles', () => {
  const cyclic = { env: { OK: '${credential:OK}' } }
  cyclic.self = cyclic
  const entry = {
    '${credential:FROM_KEY}': 'plain value',
    env: { LONG: '${credential:' + 'X'.repeat(129) + '}' },
    nested: cyclic,
  }
  assert.deepEqual(
    facts.credentialRefs(entry),
    ['OK'],
    'a template used as an object key is not a value, a 129-char name is too long, and a cycle does not recurse',
  )
})

test('a prototype-named server never reads inherited config', async () => {
  const config = Object.create({
    constructor: { headers: { Authorization: '${credential:FROM_PROTOTYPE}' } },
  })
  config.linear = { headers: { Authorization: '${credential:LINEAR_TOKEN}' } }
  const manager = {
    list: () => [
      { name: 'constructor', configured: true, status: { state: 'waiting-credentials' } },
      { name: 'linear', configured: true, status: { state: 'waiting-credentials' } },
    ],
    config: { servers: { get: () => config } },
  }
  const host = fakeHost({ services: { mcpManager: manager } })
  const answer = await call(host.route)
  assert.deepEqual(answer.body.connectors, [
    { name: 'constructor', configured: true, state: 'waiting-credentials' },
    { name: 'linear', configured: true, state: 'waiting-credentials', credentials: ['LINEAR_TOKEN'] },
  ])
  assert.equal(JSON.stringify(answer.body).includes('FROM_PROTOTYPE'), false, 'no inherited config crosses the boundary')
})

test('the route lists the credential names of a waiting server', async () => {
  const waiting = { name: 'linear', configured: true, status: { state: 'waiting-credentials' } }
  const connected = { name: 'github', configured: true, status: { state: 'connected', toolCount: 3 } }
  const manager = {
    list: () => [waiting, connected],
    config: {
      servers: {
        get: () => ({
          linear: {
            env: { TOKEN: '${credential:LINEAR_TOKEN}' },
            headers: { Authorization: '${credential:LINEAR_TOKEN}', Other: 'Bearer abc' },
          },
          github: { headers: { Authorization: '${credential:GH_TOKEN}' } },
        }),
      },
    },
  }
  const host = fakeHost({ services: { mcpManager: manager } })
  assert.ok(host.route)
  const answer = await call(host.route)
  assert.deepEqual(answer.body.connectors, [
    { name: 'linear', configured: true, state: 'waiting-credentials', credentials: ['LINEAR_TOKEN'] },
    { name: 'github', configured: true, state: 'connected', toolCount: 3 },
  ])
  const json = JSON.stringify(answer.body)
  assert.equal(json.includes('Bearer abc'), false, 'the literal header value never leaves the host')
  assert.equal(json.includes('Authorization'), false, 'no header name leaves the host')
  assert.equal(json.includes('GH_TOKEN'), false, 'a connected server carries no credential names')

  const broken = fakeHost({
    services: {
      mcpManager: {
        list: () => [waiting],
        config: {
          servers: {
            get() {
              throw new Error('no config')
            },
          },
        },
      },
    },
  })
  const failed = await call(broken.route)
  assert.deepEqual(failed.body.connectors, [{ name: 'linear', configured: true, state: 'waiting-credentials' }])
  assert.equal(failed.body.errors.connectors, undefined, 'a config read failure does not fail the section')
  assert.deepEqual(failed.body.pullRequests, [], 'the other sections still answer')
})

test('pinnedConnectors groups mcp tools by server and skips managed servers', () => {
  const names = ['bash', 'mcp__firecrawl__scrape', 'mcp__firecrawl__search', 'mcp__my_server__t', 'mcp__a__x', 42, 'mcp__bad']
  const expected = [
    { name: 'firecrawl', configured: true, state: 'pinned', toolCount: 2 },
    { name: 'my_server', configured: true, state: 'pinned', toolCount: 1 },
  ]
  assert.deepEqual(pinnedConnectors(names, ['a']), expected)
  assert.deepEqual(pinnedConnectors(names, ['a'], 1), expected.slice(0, 1), 'the limit keeps the first sorted server')
})

test('pinnedConnectors skips every tool a managed server claims, whatever its name', () => {
  assert.deepEqual(
    pinnedConnectors(['mcp__gh___search', 'mcp__gh___issue'], ['gh_']),
    [],
    'a managed name ending in _ claims its tools by prefix, not by the lazy server split',
  )
  assert.deepEqual(
    pinnedConnectors(['mcp__a__b__tool'], ['a__b']),
    [],
    'a managed name containing __ claims its tools too',
  )
  assert.deepEqual(
    pinnedConnectors(['mcp__srv__a__b'], []),
    [{ name: 'srv', configured: true, state: 'pinned', toolCount: 1 }],
    'a pinned name is still split at its first __, with no authoritative name to consult',
  )
  assert.deepEqual(
    pinnedConnectors([42, 'mcp__srv__t'], []),
    [{ name: 'srv', configured: true, state: 'pinned', toolCount: 1 }],
    'a non-string tool name is ignored',
  )
})

test("the connectors section merges the manager and the profile's plain servers", async () => {
  const names = ['bash', 'mcp__firecrawl__scrape', 'mcp__firecrawl__search', 'mcp__my_server__t', 'mcp__a__x', 42, 'mcp__bad']
  const manager = {
    list: () => [{ name: 'a', configured: true, status: { state: 'connected', toolCount: 4 } }],
  }
  const calls = []
  const tools = {
    definitions(...args) {
      calls.push(args)
      if (args.length > 0) throw new Error('definitions must be called with no scope and no tool set')
      return names.map(name => ({ name }))
    },
  }
  const managedView = { name: 'a', configured: true, state: 'connected', toolCount: 4 }
  const pinnedViews = [
    { name: 'firecrawl', configured: true, state: 'pinned', toolCount: 2 },
    { name: 'my_server', configured: true, state: 'pinned', toolCount: 1 },
  ]

  const both = fakeHost({ services: { mcpManager: manager, tools } })
  assert.ok(both.route)
  assert.deepEqual((await call(both.route)).body.connectors, [managedView, ...pinnedViews])
  assert.deepEqual(calls, [[]], 'definitions is called exactly once, with no arguments')

  const pinnedOnly = fakeHost({ services: { tools } })
  assert.deepEqual((await call(pinnedOnly.route)).body.connectors, [
    { name: 'a', configured: true, state: 'pinned', toolCount: 1 },
    ...pinnedViews,
  ])

  const noDefinitions = fakeHost({ services: { mcpManager: manager, tools: {} } })
  assert.deepEqual((await call(noDefinitions.route)).body.connectors, [managedView], 'tools without definitions adds nothing')

  const toolsOnly = fakeHost({ services: { tools: {} } })
  assert.deepEqual((await call(toolsOnly.route)).body.connectors, [], 'a mounted tool service without definitions is not absent')

  assert.equal((await call(fakeHost().route)).body.connectors, null, 'both services absent is null')

  const failing = fakeHost({
    services: {
      tools: {
        definitions() {
          throw new Error('the tool registry did not answer')
        },
      },
    },
  })
  const failed = await call(failing.route)
  assert.equal(failed.status, 200)
  assert.equal(failed.body.connectors, null)
  assert.equal(failed.body.errors.connectors, 'the tool registry did not answer')
  assert.notEqual(failed.body.changes, null, 'the other sections still answer')
})

/* ------------------------------------------------------------------ */
/* Acceptance 4: pull requests from the session's bindings, no polling  */
/* ------------------------------------------------------------------ */

test("pull requests come from the session's forge bindings without starting a poll", async () => {
  const bindings = [
    { url: PULL + '12', origin: 'created', dismissed: false },
    { url: PULL + '13', origin: 'referenced', dismissed: false },
    { url: PULL + '14', origin: 'discovered', dismissed: true },
    { url: 'https://example.com/not-a-pull-request', origin: 'referenced', dismissed: false },
  ]
  const rows = [{
    sessionId: 's1',
    cwd: WORKTREE,
    projections: { kind: 'sequenced', asOfSeq: 9, values: { forgeChangeRequests: bindings } },
  }]
  const calls = []
  const core = {
    changeRequestFromUrl(url) {
      calls.push('changeRequestFromUrl')
      if (!url.startsWith(PULL)) return undefined
      return {
        repository: { forge: 'github', host: 'github.com', owner: 'Example-Org', name: 'Example-App' },
        number: Number(url.slice(PULL.length)),
      }
    },
    latest(ref) {
      calls.push('latest')
      if (ref.number !== 12) return undefined
      return { snapshot: { title: 'Add login', state: 'open', draft: false, checksRollup: 'success', reviewDecision: 'approved' } }
    },
  }
  // Any other forge method throws when the route calls it: the route must not watch, fetch or merge.
  const forge = new Proxy(core, {
    get(target, property) {
      if (property in target) return target[property]
      return () => { throw new Error('the route called forge.' + String(property)) }
    },
  })
  const host = fakeHost({ rows, services: { forge } })
  assert.ok(host.route, 'the environment route is registered')
  const answer = await call(host.route)
  assert.deepEqual(answer.body.pullRequests, [
    {
      url: PULL + '12',
      number: 12,
      origin: 'created',
      title: 'Add login',
      state: 'open',
      draft: false,
      checks: 'success',
      review: 'approved',
    },
    { url: PULL + '13', number: 13, origin: 'referenced' },
  ])
  assert.deepEqual(
    pullRequestView(
      { url: PULL + '99', origin: 'tracked' },
      { number: 99 },
      { key: 'key', fetchedAt: 1, failure: { code: 'unavailable', message: 'the host is down' } },
    ),
    { url: PULL + '99', number: 99, origin: 'tracked' },
    'a failed poll result adds no snapshot fields',
  )
  assert.deepEqual([...new Set(calls)].sort(), ['changeRequestFromUrl', 'latest'])
  assert.deepEqual(answer.body.errors, {})

  const absent = fakeHost({ rows })
  assert.ok(absent.route)
  assert.deepEqual((await call(absent.route)).body.pullRequests, [])
})

test('the pull-request section keeps at most five bindings', async () => {
  const bindings = [20, 21, 22, 23, 24, 25, 26].map(number => ({ url: PULL + number, origin: 'referenced', dismissed: false }))
  const rows = [{
    sessionId: 's1',
    cwd: WORKTREE,
    projections: { kind: 'sequenced', asOfSeq: 9, values: { forgeChangeRequests: bindings } },
  }]
  const forge = {
    changeRequestFromUrl(url) {
      return url.startsWith(PULL) ? { repository: {}, number: Number(url.slice(PULL.length)) } : undefined
    },
    latest() { return undefined },
  }
  const host = fakeHost({ rows, services: { forge } })
  assert.ok(host.route)
  const answer = await call(host.route)
  assert.deepEqual(answer.body.pullRequests.map(pull => pull.number), [20, 21, 22, 23, 24])
})

test('one failing changeRequestFromUrl skips only its binding', async () => {
  const BAD = 'https://github.com/Example-Org/Example-App/pull/broken'
  const bindings = [
    { url: PULL + '30', origin: 'created', dismissed: false },
    { url: BAD, origin: 'referenced', dismissed: false },
    { url: PULL + '32', origin: 'discovered', dismissed: false },
  ]
  const rows = [{
    sessionId: 's1',
    cwd: WORKTREE,
    projections: { kind: 'sequenced', asOfSeq: 9, values: { forgeChangeRequests: bindings } },
  }]
  const forge = {
    changeRequestFromUrl(url) {
      if (url === BAD) throw new Error('malformed pull request URL')
      return url.startsWith(PULL) ? { repository: {}, number: Number(url.slice(PULL.length)) } : undefined
    },
    latest() { return undefined },
  }
  const host = fakeHost({ rows, services: { forge } })
  assert.ok(host.route)
  const answer = await call(host.route)
  assert.deepEqual(answer.body.pullRequests, [
    { url: PULL + '30', number: 30, origin: 'created' },
    { url: PULL + '32', number: 32, origin: 'discovered' },
  ])
  assert.equal('pullRequests' in answer.body.errors, false, 'one bad binding does not fail the section')
})

test('one failing latest skips only its binding', async () => {
  const bindings = [40, 41, 42].map(number => ({ url: PULL + number, origin: 'referenced', dismissed: false }))
  const rows = [{
    sessionId: 's1',
    cwd: WORKTREE,
    projections: { kind: 'sequenced', asOfSeq: 9, values: { forgeChangeRequests: bindings } },
  }]
  const forge = {
    changeRequestFromUrl(url) {
      return url.startsWith(PULL) ? { repository: {}, number: Number(url.slice(PULL.length)) } : undefined
    },
    latest(ref) {
      if (ref.number === 41) throw new Error('the forge did not answer')
      return undefined
    },
  }
  const host = fakeHost({ rows, services: { forge } })
  assert.ok(host.route)
  const answer = await call(host.route)
  assert.deepEqual(answer.body.pullRequests.map(pull => pull.number), [40, 42])
  assert.equal('pullRequests' in answer.body.errors, false, 'one failed poll read does not fail the section')
})

/* ------------------------------------------------------------------ */
/* Acceptance 5: the route's guards                                     */
/* ------------------------------------------------------------------ */

test('the environment route is guarded', async () => {
  const host = fakeHost()
  assert.ok(host.route, 'the environment route is registered')
  const refused = await call(host.route, { headers: { host: '127.0.0.1:50277', origin: 'https://example.com' } })
  assert.equal(refused.status, 403)
  assert.deepEqual(refused.body, { error: 'origin-not-trusted' })
  assert.deepEqual(host.reads, [], 'no service is read before the guard answers')

  const wrongMethod = await call(host.route, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  assert.deepEqual(wrongMethod.body, { error: 'method not allowed' })

  const unknown = fakeHost({ rows: [{ sessionId: 'other', cwd: WORKTREE }] })
  assert.ok(unknown.route)
  const missing = await call(unknown.route, { url: ENV_ROUTE + '?sessionId=missing' })
  assert.equal(missing.status, 404)
  assert.equal(typeof missing.body.error, 'string')
  assert.deepEqual(Object.keys(missing.body), ['error'], 'a 404 carries the error and no facts')
})

test('the environment route fails closed when the connection service is missing', async () => {
  for (const connection of [null, {}]) {
    const host = fakeHost({ services: { connection } })
    const answer = await call(host.route)
    assert.equal(answer.status, 503)
    assert.deepEqual(answer.body, { error: 'connection service is not mounted' })
    assert.equal(answer.headers['Cache-Control'], 'no-store')
  }
})

test('the environment route honors a Connection gate rejection', async () => {
  const seen = []
  const host = fakeHost({ services: { connection: { requestRejection(req) { seen.push(req); return 401 } } } })
  const answer = await call(host.route)
  assert.equal(answer.status, 401)
  assert.deepEqual(answer.body, { error: 'request rejected' })
  assert.equal(seen.length, 1, 'the gate sees the incoming request')
})

/* ------------------------------------------------------------------ */
/* Acceptance 1: one route                                             */
/* ------------------------------------------------------------------ */

test('the root row registers the features route and the Environment row registers its route', async () => {
  const registered = []
  const ctx = {
    effect(effect) { return effect() },
    get() { return undefined },
    webServer: { register(route) { registered.push(route); return () => {} } },
  }
  applyRoot(ctx)
  installEnvironment(ctx, { taskFacts: true })
  assert.deepEqual(
    registered.map(route => route.path).sort(),
    [FEATURES_ROUTE, ENV_ROUTE].sort(),
    'the root mounts the features route and the Environment row mounts its route',
  )
  assert.ok(registered.every(route => route.kind === 'exact'))

  for (const removed of ['ROUTE', 'install', 'createHandler', 'createEnvironmentHandler']) {
    assert.equal(removed in routeModule, false, 'the Environment route module no longer exports ' + removed)
  }

  // The row imports the optional schemastery peer, not installed here; check its wiring in source.
  const row = readFileSync(join(ROOT, 'features/environment/host.js'), 'utf8')
  assert.match(row, /export const name = 'claude-sidebar-environment'/u)
  assert.match(row, /export const inject = \['webServer'\]/u)
  assert.match(row, /import \{ installEnvironment \} from '\.\/route\.js'/u)
  assert.match(row, /export function apply\(ctx, config\) \{[\s\S]*?enableFeature\(ctx, 'environment'\)[\s\S]*?installEnvironment\(ctx, config\)/u)
})

/* ------------------------------------------------------------------ */
/* Acceptance 2: every git command is hardened                         */
/* ------------------------------------------------------------------ */

test('every git command runs with the hardened environment and bounds', async () => {
  const subprocess = fakeSubprocess()
  const host = fakeHost({ services: { subprocess: subprocess.service }, deps: fakeDeps({ git: undefined }) })
  assert.ok(host.route)
  await call(host.route)

  // The fixture is a linked worktree, so readGitState also asks git for the worktree list.
  assert.deepEqual(
    subprocess.spawns.map(spec => spec.argv.slice(1).join(' ')).sort(),
    [
      'rev-parse --show-toplevel',
      'rev-parse --abbrev-ref HEAD',
      'rev-parse --absolute-git-dir',
      'rev-parse --git-common-dir',
      'config --get remote.origin.url',
      'worktree list --porcelain',
      '-c core.fsmonitor=false status --porcelain=v2 --branch -z --untracked-files=normal',
    ].sort(),
    'the route runs exactly these git commands',
  )

  const expectedEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_COUNT: '0',
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
  }
  assert.ok(subprocess.spawns.length > 0, 'the route ran git')
  for (const spec of subprocess.spawns) {
    const name = spec.argv.slice(1).join(' ')
    // deepEqual is deepStrictEqual here: a present undefined key differs from an absent one.
    assert.deepEqual(spec.env, expectedEnv, name + ' carries the hardened git environment')
    assert.deepEqual(
      Object.keys(spec.env).sort(),
      Object.keys(expectedEnv).sort(),
      name + ' names every hardened git variable explicitly',
    )
    assert.equal(spec.stdio.stdin, 'ignore', name + ' ignores stdin')
    assert.equal(typeof spec.stdio.stdout.maxBytes, 'number', name + ' bounds stdout')
    assert.ok(spec.stdio.stdout.maxBytes >= 1024, name + ' gives stdout a usable bound')
    assert.equal(typeof spec.stdio.stderr.maxBytes, 'number', name + ' bounds stderr')
    assert.ok(spec.stdio.stderr.maxBytes >= 1024, name + ' gives stderr a usable bound')
    assert.equal(typeof spec.graceMs, 'number', name + ' carries a numeric grace')
    assert.ok(spec.signal instanceof AbortSignal, name + ' carries an abort signal')
  }
  const first = subprocess.spawns[0]
  assert.deepEqual(first.argv, ['C:/git/git.exe', 'rev-parse', '--show-toplevel'])
  assert.equal(first.cwd, WORKTREE)
})

/* ------------------------------------------------------------------ */
/* Acceptance 3: the live working directory                            */
/* ------------------------------------------------------------------ */

/** Call the route for one session-list row; returns the answer and every git spawn it made. */
async function answerForRow(row) {
  const subprocess = fakeSubprocess()
  const host = fakeHost({ rows: [row], services: { subprocess: subprocess.service }, deps: fakeDeps({ git: undefined }) })
  assert.ok(host.route)
  return { answer: await call(host.route), spawns: subprocess.spawns }
}

test('the route answers for the live working directory', async () => {
  // The route only follows an absolute folder, and what is absolute depends on the platform.
  const MOVED = process.platform === 'win32' ? 'D:/Repos/live/ACL-12' : '/repos/live/ACL-12'

  // cwd is where the session was created; the workingDirectory projection is where it works now.
  const moved = await answerForRow({
    sessionId: 's1',
    cwd: WORKTREE,
    projections: { kind: 'summary', values: { workingDirectory: MOVED } },
  })
  assert.equal(moved.answer.status, 200)
  assert.equal(moved.answer.body.cwd, MOVED, 'the answer names the live folder')
  assert.ok(moved.spawns.length > 0, 'the route ran git')
  for (const spec of moved.spawns) {
    assert.equal(spec.cwd, MOVED, spec.argv.slice(1).join(' ') + ' runs in the live folder')
  }

  // A relative, empty or non-string projection cannot name a folder: the creation cwd stands.
  for (const workingDirectory of ['relative/folder', '', 42, null]) {
    const kept = await answerForRow({
      sessionId: 's1',
      cwd: WORKTREE,
      projections: { kind: 'summary', values: { workingDirectory } },
    })
    assert.equal(kept.answer.status, 200, String(workingDirectory))
    assert.equal(kept.answer.body.cwd, WORKTREE, String(workingDirectory))
    for (const spec of kept.spawns) {
      assert.equal(spec.cwd, WORKTREE, spec.argv.slice(1).join(' ') + ' falls back to the creation folder')
    }
  }

  // With no creation cwd the absolute projection is the only folder the row carries.
  const projectedOnly = await answerForRow({
    sessionId: 's1',
    projections: { kind: 'summary', values: { workingDirectory: MOVED } },
  })
  assert.equal(projectedOnly.answer.status, 200)
  assert.equal(projectedOnly.answer.body.cwd, MOVED)
  for (const spec of projectedOnly.spawns) {
    assert.equal(spec.cwd, MOVED)
  }

  // Neither source: the same 404 the route answered before.
  const none = await answerForRow({ sessionId: 's1' })
  assert.equal(none.answer.status, 404)
  assert.equal(typeof none.answer.body.error, 'string')
  assert.deepEqual(none.spawns, [], 'no folder means no git command runs')
})

/* ------------------------------------------------------------------ */
/* Migrated from the Task route: git missing and a 500                 */
/* ------------------------------------------------------------------ */

test('git missing answers null task facts and an n-a link on the environment route', async () => {
  const host = fakeHost({ rows: [{ sessionId: 's1', cwd: 'D:/Repos/main' }], deps: fakeDeps({ git: async () => undefined }) })
  assert.ok(host.route)
  const answer = await call(host.route)
  assert.equal(answer.status, 200)
  assert.equal(answer.body.cwd, 'D:/Repos/main')
  assert.equal(answer.body.task.git, null)
  assert.equal(answer.body.task.repo, null)
  assert.deepEqual(answer.body.task.link, { state: 'n/a' })
  assert.equal(answer.body.task.card, null)
  assert.equal(answer.body.task.branchFollowsConvention, null)
  assert.equal(answer.body.task.progress, null)
  assert.equal(answer.body.changes, null)
})

test('an unexpected failure answers 500 with the error and no stack', async () => {
  const host = fakeHost({
    services: { sessionController: { list: async () => { throw new Error('boom') } } },
    deps: fakeDeps(),
  })
  assert.ok(host.route)
  const answer = await call(host.route)
  assert.equal(answer.status, 500)
  assert.deepEqual(answer.body, { error: 'boom' })
})

/* ------------------------------------------------------------------ */
/* URL redaction                                                       */
/* ------------------------------------------------------------------ */

test('redactUrls removes url credentials, queries and fragments and leaves other text alone', () => {
  assert.equal(redactUrls('https://u:tok@x.example/sse?api_key=SECRET'), 'https://x.example/sse')
  assert.equal(redactUrls('fetch https://x.example/sse?api_key=SECRET failed'), 'fetch https://x.example/sse failed')
  assert.equal(redactUrls('https://u:p@x.example/a#frag'), 'https://x.example/a')
  assert.equal(
    redactUrls('https://u:p@a.example/x?t=1 and https://b.example/y#f'),
    'https://a.example/x and https://b.example/y',
  )
  assert.equal(redactUrls('no url here'), 'no url here')
  assert.equal(redactUrls(''), '')
  assert.equal(redactUrls('https://[bad url'), 'https://[bad url', 'a malformed URL is left alone, not thrown on')
  assert.equal(redactUrls('https://u:p@[::1]:8080/x?q'), 'https://[::1]:8080/x')
  assert.deepEqual(
    connectorView({
      name: 'leaky',
      configured: true,
      status: { state: 'waiting-credentials', lastError: 'sign in at https://u:tok@x.example/sse?key=SECRET' },
    }),
    { name: 'leaky', configured: true, state: 'waiting-credentials', error: 'sign in at https://x.example/sse' },
    'a connector error redacts URLs before it is bounded',
  )
})

/* ------------------------------------------------------------------ */
/* Task facts are an opt-in row setting                                  */
/* ------------------------------------------------------------------ */

test('the default config sends no task facts and reads neither the registry nor the progress file', async () => {
  const fileReads = []
  const readText = async file => {
    fileReads.push(file)
    return fakeFiles()(file)
  }
  const host = fakeHost({ config: {}, deps: fakeDeps({ readText }) })
  assert.ok(host.route)
  const answer = await call(host.route)
  assert.equal(answer.status, 200)
  assert.deepEqual(Object.keys(answer.body.task), ['git', 'repo'], 'off sends only git and repo')
  for (const key of ['link', 'card', 'branchFollowsConvention', 'progress']) {
    assert.equal(key in answer.body.task, false, 'off does not send ' + key)
  }
  assert.deepEqual(fileReads, [], 'off does not read the registry or the progress file')
})

test('with task facts on but no tracker address the card shows its key without a link', async () => {
  const host = fakeHost({ config: { taskFacts: true, trackerUrl: '', registryPath: '' } })
  const answer = await call(host.route)
  assert.deepEqual(answer.body.task.card, { key: 'ACL-12' }, 'no URL means no link')
  assert.deepEqual(answer.body.task.link, { state: 'linked', projectRef: 'example-team.ACL' })
  assert.equal(answer.body.task.branchFollowsConvention, true)
  assert.ok(answer.body.task.progress, 'the progress file is still read when facts are on')
})

test('with task facts on the card URL comes from the configured tracker address', async () => {
  const expected = TRACKER + '/example-team/issue/ACL-12'
  for (const tracker of [TRACKER, TRACKER + '///', '  ' + TRACKER + '/  ']) {
    const host = fakeHost({ config: { taskFacts: true, trackerUrl: tracker } })
    const answer = await call(host.route)
    assert.deepEqual(answer.body.task.card, { key: 'ACL-12', url: expected }, tracker)
  }
})

test('a non-http tracker address is ignored, leaving a card without a link', async () => {
  for (const tracker of ['ftp://tracker.example.com', 'javascript:alert(1)', 'tracker.example.com', 'mailto:a@example.com']) {
    const host = fakeHost({ config: { taskFacts: true, trackerUrl: tracker } })
    const answer = await call(host.route)
    assert.deepEqual(answer.body.task.card, { key: 'ACL-12' }, tracker)
  }
})

test('a configured registry path wins over the legacy environment variable', async () => {
  const files = {
    'D:/config/links.json': JSON.stringify({ 'example-org/example-app': { status: 'declined' } }),
    'C:/Users/test/.claude/itsaplan/links.json': JSON.stringify(LINKS),
  }
  const host = fakeHost({
    config: { taskFacts: true, registryPath: 'D:/config/links.json' },
    deps: fakeDeps({ readText: fakeFiles(files) }),
  })
  const answer = await call(host.route)
  assert.deepEqual(answer.body.task.link, { state: 'declined' })
})

test('the Environment row declares the opt-in Config defaults shown in Settings', () => {
  const text = readFileSync(join(ROOT, 'features/environment/host.js'), 'utf8')
  assert.match(text, /from '@deepseek-ai\/schemastery'/u, 'the row imports the schema library')
  assert.match(text, /export const Config = z\.object\(\{/u, 'the row exports a Config object')
  assert.match(text, /taskFacts: z\.boolean\(\)\.default\(false\)/u, 'task facts are off by default')
  assert.match(text, /trackerUrl: z\.string\(\)\.default\(''\)/u, 'the tracker address is empty by default')
  assert.match(text, /registryPath: z\.string\(\)\.default\(''\)/u, 'the registry path is empty by default')
  assert.match(text, /Show task facts/u, 'taskFacts has a description')
  assert.match(text, /Tracker web address/u, 'trackerUrl has a description')
  assert.match(text, /Path of the itsaplan link registry/u, 'registryPath has a description')
  assert.match(text, /export function apply\(ctx, config\)/u, 'apply receives the validated config')
  assert.match(text, /enableFeature\(ctx, 'environment'\)/u, 'apply still enables the feature')
  assert.match(text, /installEnvironment\(ctx, config\)/u, 'apply installs the route with the config')
  for (const field of ['taskFacts', 'trackerUrl', 'registryPath']) {
    const line = text.split('\n').find(item => item.trim().startsWith(field + ':'))
    assert.ok(line, field + ' is declared')
    assert.match(line, /\.volatile\(\),\s*$/u, field + ' is volatile so Settings shows and writes it')
    assert.ok(line.indexOf('.volatile()') > line.indexOf('.default('), field + ' marks volatile after default')
    assert.ok(line.indexOf('.volatile()') > line.indexOf('.description('), field + ' marks volatile after description')
  }
})

/* ------------------------------------------------------------------ */
/* Settings writes live volatile config references                       */
/* ------------------------------------------------------------------ */

test('volatile config references are unwrapped: off stays off and on shows the facts', async () => {
  const fileReads = []
  const readText = async file => {
    fileReads.push(file)
    return fakeFiles()(file)
  }
  const off = fakeHost({
    config: {
      taskFacts: volatileRef(false),
      trackerUrl: volatileRef(''),
      registryPath: volatileRef(''),
    },
    deps: fakeDeps({ readText }),
  })
  const offAnswer = await call(off.route)
  assert.equal(offAnswer.status, 200)
  assert.deepEqual(Object.keys(offAnswer.body.task), ['git', 'repo'], 'a volatile false still means no facts')
  assert.deepEqual(fileReads, [], 'a volatile false reads neither the registry nor the progress file')

  const on = fakeHost({
    config: {
      taskFacts: volatileRef(true),
      trackerUrl: volatileRef(TRACKER),
      registryPath: volatileRef(''),
    },
  })
  const onAnswer = await call(on.route)
  assert.equal(onAnswer.status, 200)
  assert.deepEqual(onAnswer.body.task.link, { state: 'linked', projectRef: 'example-team.ACL' })
  assert.deepEqual(onAnswer.body.task.card, { key: 'ACL-12', url: TRACKER + '/example-team/issue/ACL-12' })
  assert.ok(onAnswer.body.task.progress, 'a volatile true reads the progress file')
})

test('a Settings write to a volatile reference changes the next route answer without a restart', async () => {
  let enabled = false
  let address = ''
  const config = {
    taskFacts: { get: () => enabled, [VOLATILE_WRITE]: () => {} },
    trackerUrl: { get: () => address, [VOLATILE_WRITE]: () => {} },
    registryPath: volatileRef(''),
  }
  const host = fakeHost({ config })
  const first = await call(host.route)
  assert.deepEqual(Object.keys(first.body.task), ['git', 'repo'], 'the first answer has no task facts')

  enabled = true
  address = TRACKER
  const second = await call(host.route)
  assert.deepEqual(second.body.task.card, { key: 'ACL-12', url: TRACKER + '/example-team/issue/ACL-12' }, 'the same handler reads the new value')
  assert.ok(second.body.task.progress, 'the second answer reads the progress file')
})

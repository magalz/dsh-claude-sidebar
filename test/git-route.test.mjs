import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  parseBranchHeader,
  parseGitLog,
  parseNumstat,
  parseUnifiedDiff,
  untrackedDiff,
} from '../features/git/facts.js'
import {
  GIT_DIFF_ROUTE,
  GIT_ROUTE,
  apply as applyGit,
  installGit,
} from '../features/git/host.js'
import { FEATURES_ROUTE, apply as applyRoot } from '../index.js'

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const ROOT = 'D:/Repos/project'
const SESSION_CWD = ROOT + '/src'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const SHOW_TOPLEVEL = ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel']
const STATUS_ARGS = ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']
const SHORT_HEAD = ['-c', 'core.fsmonitor=false', 'rev-parse', '--short', 'HEAD']
const numstatArgs = base => ['-c', 'core.fsmonitor=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--numstat', '-z', base]
const LOG_ARGS = ['-c', 'core.fsmonitor=false', 'log', '-n', '20', '--no-color', '--no-show-signature', '--format=%h%x1f%s%x1f%an%x1f%cI%x1e']
const diffArgs = (base, path) => ['-c', 'core.fsmonitor=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', base, '--', path]
const conflictArgs = path => ['-c', 'core.fsmonitor=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', path]

const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)
const H3 = '3'.repeat(40)

function header(upstream = 'origin/main', ahead = 1, behind = 0, oid = H1) {
  let text = '# branch.oid ' + oid + '\0# branch.head main\0'
  if (upstream !== null) text += '# branch.upstream ' + upstream + '\0# branch.ab +' + ahead + ' -' + behind + '\0'
  return text
}
function ordinary(xy, path) {
  return '1 ' + xy + ' N... 100644 100644 100644 ' + H1 + ' ' + H2 + ' ' + path + '\0'
}
function rename(xy, path, orig) {
  return '2 ' + xy + ' N... 100644 100644 100644 ' + H1 + ' ' + H2 + ' R100 ' + path + '\0' + orig + '\0'
}
function conflicted(path) {
  return 'u UU N... 100644 100644 100644 100644 ' + H1 + ' ' + H2 + ' ' + H3 + ' ' + path + '\0'
}
function untracked(path) {
  return '? ' + path + '\0'
}

const STATUS = header() +
  ordinary('M.', 'src/staged.js') +
  ordinary('.M', 'src/unstaged.js') +
  ordinary('MM', 'src/both.js') +
  rename('R.', 'src/renamed.js', 'src/original.js') +
  ordinary('A.', 'src/image.png') +
  conflicted('src/conflict.js') +
  untracked('notes.md') +
  untracked('folder/')

const NUMSTAT = [
  '3\t1\tsrc/staged.js',
  '2\t0\tsrc/unstaged.js',
  '5\t2\tsrc/both.js',
  '1\t1\t',
  'src/original.js',
  'src/renamed.js',
  '-\t-\tsrc/image.png',
].join('\0') + '\0'

const LOG = [
  'f20ca4b\x1fMerge branch feature\x1fAlice\x1f2026-11-21T18:30:00-03:00\x1e',
  'abc1234\x1fFix stuff\x1fBob\x1f2026-11-20T10:00:00-03:00\x1e',
].join('\n')

/** A git fake answering by argument list; a lossy key sets options.lossy and returns undefined. */
function gitFake(answers = {}, lossy = {}) {
  const calls = []
  const git = async (args, cwd, options = {}) => {
    calls.push({ args, cwd })
    const key = args.join(' ')
    if (Object.hasOwn(lossy, key)) {
      options.lossy = true
      return undefined
    }
    return Object.hasOwn(answers, key) ? answers[key] : undefined
  }
  return { git, calls }
}

function defaultAnswers(overrides = {}) {
  return {
    [SHOW_TOPLEVEL.join(' ')]: ROOT,
    [STATUS_ARGS.join(' ')]: STATUS,
    [SHORT_HEAD.join(' ')]: 'f20ca4b',
    [numstatArgs('HEAD').join(' ')]: NUMSTAT,
    [LOG_ARGS.join(' ')]: LOG,
    ...overrides,
  }
}

function fakeHost({ rows = [{ sessionId: 's1', cwd: SESSION_CWD }], services = {}, deps = {} } = {}) {
  const registered = []
  const controller = services.sessionController ?? { list: async () => ({ items: rows }) }
  const ctx = {
    effect(effect) { return effect() },
    get(name) { return name === 'sessionController' ? controller : services[name] },
    webServer: { register(route) { registered.push(route); return () => {} } },
    logger: { warn() {} },
  }
  installGit(ctx, {
    readBytes: async () => Buffer.from(''),
    lstat: async () => ({ isFile: () => true }),
    realpath: async path => path,
    ...deps,
  })
  return {
    registered,
    route: registered.find(route => route.path === GIT_ROUTE),
    diffRoute: registered.find(route => route.path === GIT_DIFF_ROUTE),
  }
}

async function call(route, { url, method = 'GET', headers = { host: '127.0.0.1:50277' } } = {}) {
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

const OVERVIEW_URL = GIT_ROUTE + '?sessionId=s1'
const diffUrl = path => GIT_DIFF_ROUTE + '?sessionId=s1&path=' + encodeURIComponent(path)

/* ------------------------------------------------------------------ */
/* Pure parsers                                                        */
/* ------------------------------------------------------------------ */

test('parseBranchHeader reads the branch and flags a detached head', () => {
  assert.deepEqual(parseBranchHeader(STATUS), { branch: 'main', detached: false })
  assert.deepEqual(parseBranchHeader('# branch.head (detached)\0# branch.ab +0 -0\0'), { branch: null, detached: true })
  assert.deepEqual(parseBranchHeader(undefined), { branch: null, detached: true })
})

test('parseNumstat reads counts, renames by new path and binary marks', () => {
  const counts = parseNumstat(NUMSTAT)
  assert.deepEqual(counts.get('src/staged.js'), { added: 3, deleted: 1, binary: false })
  assert.deepEqual(counts.get('src/unstaged.js'), { added: 2, deleted: 0, binary: false })
  assert.deepEqual(counts.get('src/both.js'), { added: 5, deleted: 2, binary: false })
  assert.deepEqual(counts.get('src/renamed.js'), { added: 1, deleted: 1, binary: false }, 'a rename is keyed by the new path')
  assert.equal(counts.has('src/original.js'), false)
  assert.deepEqual(counts.get('src/image.png'), { added: null, deleted: null, binary: true })
  assert.equal(parseNumstat(undefined).size, 0)
  assert.equal(parseNumstat('').size, 0)
})

test('parseGitLog reads records and cuts subjects at 200 characters', () => {
  assert.deepEqual(parseGitLog(LOG), [
    { hash: 'f20ca4b', subject: 'Merge branch feature', author: 'Alice', date: '2026-11-21T18:30:00-03:00' },
    { hash: 'abc1234', subject: 'Fix stuff', author: 'Bob', date: '2026-11-20T10:00:00-03:00' },
  ])
  const long = 'abc1234\x1f' + 'x'.repeat(250) + '\x1fA\x1fd\x1e'
  assert.equal(parseGitLog(long)[0].subject.length, 200)
  assert.deepEqual(parseGitLog(undefined), [])
  assert.deepEqual(parseGitLog(''), [])
})

test('parseUnifiedDiff reads hunks, notes, binary diffs and the 2000-line cap', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js',
    '@@ -1,4 +1,6 @@', ' context', '-old', '+new', '+more', '\\ No newline at end of file',
  ].join('\n')
  const parsed = parseUnifiedDiff(diff)
  assert.deepEqual(parsed, {
    binary: false,
    truncated: false,
    hunks: [{
      header: '@@ -1,4 +1,6 @@',
      lines: [
        { type: 'context', text: 'context', old: 1, new: 1 },
        { type: 'del', text: 'old', old: 2, new: null },
        { type: 'add', text: 'new', old: null, new: 2 },
        { type: 'add', text: 'more', old: null, new: 3 },
        { type: 'note', text: '\\ No newline at end of file', old: null, new: null },
      ],
    }],
  })
  assert.deepEqual(parseUnifiedDiff('Binary files a/src/image.png and b/src/image.png differ\n'), {
    binary: true, hunks: [], truncated: false,
  })
  const capped = parseUnifiedDiff('@@ -0,0 +1,2005 @@\n' + '+x\n'.repeat(2005))
  assert.equal(capped.truncated, true)
  assert.equal(capped.hunks[0].lines.length, 2000)
  assert.deepEqual(parseUnifiedDiff(undefined), { binary: false, hunks: [], truncated: false })
})

test('untrackedDiff builds one add hunk with 1..N line numbers', () => {
  assert.deepEqual(untrackedDiff('one\ntwo\nthree\n'), {
    binary: false,
    truncated: false,
    hunks: [{
      header: '@@ -0,0 +1,3 @@',
      lines: [
        { type: 'add', text: 'one', old: null, new: 1 },
        { type: 'add', text: 'two', old: null, new: 2 },
        { type: 'add', text: 'three', old: null, new: 3 },
      ],
    }],
  })
})

/* ------------------------------------------------------------------ */
/* Route registration                                                  */
/* ------------------------------------------------------------------ */

test('the root row registers the features route and the Git row registers both Git routes', () => {
  const registered = []
  const ctx = {
    effect(effect) { return effect() },
    get() { return undefined },
    webServer: { register(route) { registered.push(route); return () => {} } },
  }
  applyRoot(ctx)
  applyGit(ctx)
  assert.deepEqual(registered.map(route => route.path).sort(), [FEATURES_ROUTE, GIT_ROUTE, GIT_DIFF_ROUTE].sort())
  assert.ok(registered.every(route => route.kind === 'exact'))
})

/* ------------------------------------------------------------------ */
/* Overview route                                                      */
/* ------------------------------------------------------------------ */

test('a folder outside a work tree answers git false with empty sections', async () => {
  const { git, calls } = gitFake(defaultAnswers({ [SHOW_TOPLEVEL.join(' ')]: undefined }))
  const answer = await call(fakeHost({ deps: { git } }).route, { url: OVERVIEW_URL })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, {
    cwd: SESSION_CWD, git: false, repo: null, files: [], total: 0, truncated: false, commits: [], errors: {},
  })
  assert.equal(calls.length, 1, 'only the root probe ran')
})

test('the overview reports branch, upstream, ahead, behind, head and detached', async () => {
  const { git } = gitFake(defaultAnswers())
  const answer = await call(fakeHost({ deps: { git } }).route, { url: OVERVIEW_URL })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.git, true)
  assert.deepEqual(answer.body.repo, {
    root: ROOT, branch: 'main', detached: false, upstream: 'origin/main', ahead: 1, behind: 0, head: 'f20ca4b',
  })
  assert.deepEqual(answer.body.errors, {})

  const detachedStatus = header(null, 0, 0, H1).replace('# branch.head main', '# branch.head (detached)') + untracked('x.txt')
  const detached = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: detachedStatus }))
  const dAnswer = await call(fakeHost({ deps: { git: detached.git } }).route, { url: OVERVIEW_URL })
  assert.deepEqual(dAnswer.body.repo, {
    root: ROOT, branch: null, detached: true, upstream: null, ahead: null, behind: null, head: 'f20ca4b',
  })
})

test('file rows carry kinds, sort order, numstat counts and a rename', async () => {
  const { git } = gitFake(defaultAnswers())
  const answer = await call(fakeHost({ deps: { git } }).route, { url: OVERVIEW_URL })
  assert.equal(answer.body.total, 8)
  assert.equal(answer.body.truncated, false)
  assert.deepEqual(answer.body.files, [
    { path: 'src/conflict.js', origPath: null, index: 'U', worktree: 'U', kind: 'conflicted', added: null, deleted: null, binary: false },
    { path: 'src/both.js', origPath: null, index: 'M', worktree: 'M', kind: 'staged', added: 5, deleted: 2, binary: false },
    { path: 'src/image.png', origPath: null, index: 'A', worktree: '.', kind: 'staged', added: null, deleted: null, binary: true },
    { path: 'src/renamed.js', origPath: 'src/original.js', index: 'R', worktree: '.', kind: 'staged', added: 1, deleted: 1, binary: false },
    { path: 'src/staged.js', origPath: null, index: 'M', worktree: '.', kind: 'staged', added: 3, deleted: 1, binary: false },
    { path: 'src/unstaged.js', origPath: null, index: '.', worktree: 'M', kind: 'unstaged', added: 2, deleted: 0, binary: false },
    { path: 'folder/', origPath: null, index: '?', worktree: '?', kind: 'untracked', added: null, deleted: null, binary: false, folder: true },
    { path: 'notes.md', origPath: null, index: '?', worktree: '?', kind: 'untracked', added: null, deleted: null, binary: false },
  ])
})

test('an untracked file and an untracked folder are reported without counts', async () => {
  const status = header() + untracked('notes.md') + untracked('dir/')
  const numstat = '9\t9\tnotes.md\0'
  const { git } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status, [numstatArgs('HEAD').join(' ')]: numstat }))
  const answer = await call(fakeHost({ deps: { git } }).route, { url: OVERVIEW_URL })
  assert.deepEqual(answer.body.files, [
    { path: 'dir/', origPath: null, index: '?', worktree: '?', kind: 'untracked', added: null, deleted: null, binary: false, folder: true },
    { path: 'notes.md', origPath: null, index: '?', worktree: '?', kind: 'untracked', added: null, deleted: null, binary: false },
  ])
})

test('the 200-row cap reports total and truncated', async () => {
  const status = header() + Array.from({ length: 205 }, (_, i) => untracked('f' + String(i).padStart(3, '0') + '.txt')).join('')
  const { git } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status, [numstatArgs('HEAD').join(' ')]: '' }))
  const answer = await call(fakeHost({ deps: { git } }).route, { url: OVERVIEW_URL })
  assert.equal(answer.body.total, 205)
  assert.equal(answer.body.files.length, 200)
  assert.equal(answer.body.truncated, true)
})

test('an oversize status fails files but leaves commits', async () => {
  const { git } = gitFake(defaultAnswers(), { [STATUS_ARGS.join(' ')]: true })
  const answer = await call(fakeHost({ deps: { git } }).route, { url: OVERVIEW_URL })
  assert.deepEqual(answer.body.files, [])
  assert.equal(answer.body.total, 0)
  assert.equal(answer.body.truncated, false)
  assert.equal(answer.body.errors.files, 'git status output was too large')
  assert.equal(answer.body.commits.length, 2, 'commits still answer')

  const absent = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: undefined }))
  const failed = await call(fakeHost({ deps: { git: absent.git } }).route, { url: OVERVIEW_URL })
  assert.equal(failed.body.errors.files, 'git status did not answer')
})

test('an oversize numstat leaves null counts and an errors.counts message', async () => {
  const { git } = gitFake(defaultAnswers(), { [numstatArgs('HEAD').join(' ')]: true })
  const answer = await call(fakeHost({ deps: { git } }).route, { url: OVERVIEW_URL })
  assert.equal(answer.body.errors.counts, 'git diff --numstat output was too large')
  assert.equal(answer.body.files.length, 8)
  for (const row of answer.body.files.filter(item => item.kind !== 'untracked')) {
    assert.equal(row.added, null)
    assert.equal(row.deleted, null)
  }
})

test('commits parse from git log and a failing log leaves the files section', async () => {
  const log = 'abc1234\x1f' + 'S'.repeat(250) + '\x1fA\x1fd\x1e'
  const { git } = gitFake(defaultAnswers({ [LOG_ARGS.join(' ')]: log }))
  const answer = await call(fakeHost({ deps: { git } }).route, { url: OVERVIEW_URL })
  assert.equal(answer.body.commits.length, 1)
  assert.equal(answer.body.commits[0].subject.length, 200)
  assert.equal(answer.body.files.length, 8)

  const noLog = gitFake(defaultAnswers({ [LOG_ARGS.join(' ')]: undefined }))
  const failed = await call(fakeHost({ deps: { git: noLog.git } }).route, { url: OVERVIEW_URL })
  assert.deepEqual(failed.body.commits, [])
  assert.equal(failed.body.errors.commits, 'git log did not answer')
  assert.equal(failed.body.files.length, 8, 'files still answer')
})

test('a repository without commits uses the empty tree and answers no head or commits', async () => {
  const status = header('origin/main', 0, 0, '(initial)') + untracked('notes.md') + ordinary('A.', 'src/new.js')
  const emptyKey = numstatArgs(EMPTY_TREE).join(' ')
  const answers = defaultAnswers({
    [STATUS_ARGS.join(' ')]: status,
    [SHORT_HEAD.join(' ')]: undefined,
    [numstatArgs('HEAD').join(' ')]: undefined,
    [emptyKey]: '7\t0\tsrc/new.js\0',
    [LOG_ARGS.join(' ')]: '',
  })
  const { git, calls } = gitFake(answers)
  const answer = await call(fakeHost({ deps: { git } }).route, { url: OVERVIEW_URL })
  assert.equal(answer.body.repo.head, null)
  assert.deepEqual(answer.body.commits, [])
  assert.deepEqual(answer.body.errors, {})
  assert.ok(calls.some(item => item.args.join(' ') === emptyKey), 'numstat ran against the empty tree')
  assert.equal(answer.body.files.find(item => item.path === 'src/new.js').added, 7)
})

/* ------------------------------------------------------------------ */
/* Diff route                                                          */
/* ------------------------------------------------------------------ */

test('a diff for a tracked file parses hunks with old and new line numbers', async () => {
  const status = header() + ordinary('M.', 'src/a.js')
  const diffText = [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js',
    '@@ -1,4 +1,6 @@', ' context', '-old', '+new', '+more',
  ].join('\n')
  const key = diffArgs('HEAD', 'src/a.js').join(' ')
  const { git, calls } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status, [key]: diffText }))
  const answer = await call(fakeHost({ deps: { git } }).diffRoute, { url: diffUrl('src/a.js') })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, {
    path: 'src/a.js', kind: 'staged', binary: false, truncated: false,
    hunks: [{
      header: '@@ -1,4 +1,6 @@',
      lines: [
        { type: 'context', text: 'context', old: 1, new: 1 },
        { type: 'del', text: 'old', old: 2, new: null },
        { type: 'add', text: 'new', old: null, new: 2 },
        { type: 'add', text: 'more', old: null, new: 3 },
      ],
    }],
  })
  assert.ok(calls.some(item => item.args.join(' ') === key))
})

test('a tracked diff in a repository without commits uses the empty tree', async () => {
  const status = header('origin/main', 0, 0, '(initial)') + ordinary('A.', 'src/new.js')
  const key = diffArgs(EMPTY_TREE, 'src/new.js').join(' ')
  const answers = defaultAnswers({
    [STATUS_ARGS.join(' ')]: status,
    [diffArgs('HEAD', 'src/new.js').join(' ')]: undefined,
    [key]: '@@ -0,0 +1,1 @@\n+new\n',
  })
  const { git, calls } = gitFake(answers)
  const answer = await call(fakeHost({ deps: { git } }).diffRoute, { url: diffUrl('src/new.js') })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body.hunks, [{ header: '@@ -0,0 +1,1 @@', lines: [{ type: 'add', text: 'new', old: null, new: 1 }] }])
  assert.ok(calls.some(item => item.args.join(' ') === key), 'the diff bases on the empty tree')
  assert.equal(calls.some(item => item.args.includes('--short')), false, 'no HEAD probe is needed')
})

test('a conflicted file runs git diff without HEAD', async () => {
  const status = header() + conflicted('src/conflict.js')
  const key = conflictArgs('src/conflict.js').join(' ')
  const { git, calls } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status, [key]: '@@ -1 +1 @@\n-old\n+new\n' }))
  const answer = await call(fakeHost({ deps: { git } }).diffRoute, { url: diffUrl('src/conflict.js') })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.kind, 'conflicted')
  const diffCall = calls.find(item => item.args.includes('--'))
  assert.ok(diffCall && diffCall.args.join(' ') === key)
  assert.equal(diffCall.args.includes('HEAD'), false, 'the conflict diff has no HEAD argument')
})

test('an untracked file is read on the host into one add hunk', async () => {
  const status = header() + untracked('notes.md')
  const { git } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status }))
  const reads = []
  const readBytes = async (file, limit) => { reads.push({ file, limit }); return Buffer.from('one\ntwo\nthree\n') }
  const answer = await call(fakeHost({ deps: { git, readBytes } }).diffRoute, { url: diffUrl('notes.md') })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.path, 'notes.md')
  assert.equal(answer.body.kind, 'untracked')
  assert.equal(answer.body.binary, false)
  assert.equal(answer.body.truncated, false)
  assert.deepEqual(answer.body.hunks, [{
    header: '@@ -0,0 +1,3 @@',
    lines: [
      { type: 'add', text: 'one', old: null, new: 1 },
      { type: 'add', text: 'two', old: null, new: 2 },
      { type: 'add', text: 'three', old: null, new: 3 },
    ],
  }])
  assert.equal(reads.length, 1)
  assert.equal(reads[0].file, resolve(ROOT, 'notes.md'))
  assert.ok(reads[0].limit >= 512 * 1024)
})

test('an untracked binary file is detected by a NUL in the first 8 KiB', async () => {
  const status = header() + untracked('blob.bin')
  const { git } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status }))
  const binaryBytes = Buffer.concat([Buffer.from('abc'), Buffer.from([0]), Buffer.from('def')])
  const binary = await call(fakeHost({ deps: { git, readBytes: async () => binaryBytes } }).diffRoute, { url: diffUrl('blob.bin') })
  assert.equal(binary.body.binary, true)
  assert.deepEqual(binary.body.hunks, [])

  const lateNul = Buffer.concat([Buffer.from('a'.repeat(9000)), Buffer.from([0])])
  const text = await call(fakeHost({ deps: { git, readBytes: async () => lateNul } }).diffRoute, { url: diffUrl('blob.bin') })
  assert.equal(text.body.binary, false, 'a NUL after the first 8 KiB is not a binary marker')
})

test('an untracked folder answers folder true with no hunks', async () => {
  const status = header() + untracked('dir/')
  const { git, calls } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status }))
  let reads = 0
  const readBytes = async () => { reads += 1; return Buffer.from('') }
  const answer = await call(fakeHost({ deps: { git, readBytes } }).diffRoute, { url: diffUrl('dir/') })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.folder, true)
  assert.deepEqual(answer.body.hunks, [])
  assert.equal(reads, 0, 'no host read for a folder')
  assert.equal(calls.some(item => item.args.includes('diff')), false, 'no git diff for a folder')
})

test('an oversize diff answers tooLarge with empty hunks', async () => {
  const status = header() + ordinary('M.', 'src/a.js')
  const key = diffArgs('HEAD', 'src/a.js').join(' ')
  const { git } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status }), { [key]: true })
  const answer = await call(fakeHost({ deps: { git } }).diffRoute, { url: diffUrl('src/a.js') })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.truncated, true)
  assert.equal(answer.body.tooLarge, true)
  assert.deepEqual(answer.body.hunks, [])
})

test('a diff stops at 2000 lines with truncated true', async () => {
  const status = header() + ordinary('M.', 'src/a.js')
  const diffText = '@@ -0,0 +1,2005 @@\n' + '+x\n'.repeat(2005)
  const key = diffArgs('HEAD', 'src/a.js').join(' ')
  const { git } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status, [key]: diffText }))
  const answer = await call(fakeHost({ deps: { git } }).diffRoute, { url: diffUrl('src/a.js') })
  assert.equal(answer.body.truncated, true)
  assert.notEqual(answer.body.tooLarge, true)
  assert.equal(answer.body.hunks[0].lines.length, 2000)
})

test('a no-newline marker becomes a note and a binary diff reports binary', async () => {
  const status = header() + ordinary('M.', 'src/a.js') + ordinary('A.', 'src/image.png')
  const answers = defaultAnswers({
    [STATUS_ARGS.join(' ')]: status,
    [diffArgs('HEAD', 'src/a.js').join(' ')]: '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n',
    [diffArgs('HEAD', 'src/image.png').join(' ')]: 'Binary files a/src/image.png and b/src/image.png differ\n',
  })
  const { git } = gitFake(answers)
  const host = fakeHost({ deps: { git } })
  const note = await call(host.diffRoute, { url: diffUrl('src/a.js') })
  assert.deepEqual(note.body.hunks[0].lines.map(line => line.type), ['del', 'note', 'add'])
  const binary = await call(host.diffRoute, { url: diffUrl('src/image.png') })
  assert.equal(binary.body.binary, true)
  assert.deepEqual(binary.body.hunks, [])
})

test('a path not in status answers 404 not a changed file', async () => {
  const status = header() + untracked('notes.md')
  const { git, calls } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status }))
  const answer = await call(fakeHost({ deps: { git } }).diffRoute, { url: diffUrl('secret.txt') })
  assert.equal(answer.status, 404)
  assert.deepEqual(answer.body, { error: 'not a changed file' })
  assert.equal(calls.some(item => item.args.includes('diff')), false)
})

test('a path resolving outside the root is refused', async () => {
  const status = header() + untracked('../outside.txt')
  const { git } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status }))
  let reads = 0
  const readBytes = async () => { reads += 1; return Buffer.from('x') }
  const answer = await call(fakeHost({ deps: { git, readBytes } }).diffRoute, { url: diffUrl('../outside.txt') })
  assert.equal(answer.status, 403)
  assert.equal(typeof answer.body.error, 'string')
  assert.equal(reads, 0, 'no bytes read outside the root')
})

test('every diff and numstat call runs in the root with the hardened flags', async () => {
  const status = header() + ordinary('M.', 'src/a.js') + conflicted('src/conflict.js')
  const { git, calls } = gitFake(defaultAnswers({ [STATUS_ARGS.join(' ')]: status }))
  const host = fakeHost({ deps: { git } })
  await call(host.route, { url: OVERVIEW_URL })
  await call(host.diffRoute, { url: diffUrl('src/a.js') })
  await call(host.diffRoute, { url: diffUrl('src/conflict.js') })
  const readCalls = calls.filter(item => item.args.includes('diff') || item.args.includes('numstat') || item.args.includes('log'))
  assert.ok(readCalls.length >= 4)
  for (const item of readCalls) {
    assert.equal(item.cwd, ROOT, item.args.join(' ') + ' runs in the repo root')
  }
  for (const item of calls.filter(item => item.args.includes('diff'))) {
    for (const flag of ['--no-color', '--no-ext-diff', '--no-textconv']) {
      assert.ok(item.args.includes(flag), item.args.join(' ') + ' has ' + flag)
    }
  }
  for (const item of calls.filter(item => item.args.includes('--'))) {
    const index = item.args.indexOf('--')
    assert.ok(index > 0 && index < item.args.length - 1, item.args.join(' ') + ' has a path after --')
  }
  assert.ok(calls.every(item => item.args[0] === '-c' && item.args[1] === 'core.fsmonitor=false'))
})

/* ------------------------------------------------------------------ */
/* Guards and failures                                                 */
/* ------------------------------------------------------------------ */

test('the git routes are guarded, method-checked and answer 404 for an unknown session', async () => {
  const { git } = gitFake(defaultAnswers())
  const host = fakeHost({ deps: { git } })
  assert.ok(host.route && host.diffRoute, 'both routes are registered')

  const refused = await call(host.route, { url: OVERVIEW_URL, headers: { host: '127.0.0.1:50277', origin: 'https://example.com' } })
  assert.equal(refused.status, 403)
  assert.deepEqual(refused.body, { error: 'origin-not-trusted' })
  const refusedDiff = await call(host.diffRoute, { url: diffUrl('notes.md'), headers: { host: 'evil.example' } })
  assert.equal(refusedDiff.status, 403)
  assert.deepEqual(refusedDiff.body, { error: 'host-not-trusted' })

  const wrongMethod = await call(host.route, { url: OVERVIEW_URL, method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  assert.deepEqual(wrongMethod.body, { error: 'method not allowed' })
  const wrongDiffMethod = await call(host.diffRoute, { url: diffUrl('notes.md'), method: 'POST' })
  assert.equal(wrongDiffMethod.status, 405)

  const unknown = fakeHost({ rows: [{ sessionId: 'other', cwd: SESSION_CWD }], deps: { git } })
  for (const [route, url] of [
    [unknown.route, GIT_ROUTE + '?sessionId=missing'],
    [unknown.diffRoute, GIT_DIFF_ROUTE + '?sessionId=missing&path=notes.md'],
  ]) {
    const answer = await call(route, { url })
    assert.equal(answer.status, 404)
    assert.deepEqual(Object.keys(answer.body), ['error'])
  }

  const noCwd = fakeHost({ rows: [{ sessionId: 's1' }], deps: { git } })
  const missingCwd = await call(noCwd.route, { url: OVERVIEW_URL })
  assert.equal(missingCwd.status, 404)
})

test('an unexpected failure answers 500 with the message only', async () => {
  const host = fakeHost({ services: { sessionController: { list: async () => { throw new Error('boom') } } } })
  const answer = await call(host.route, { url: OVERVIEW_URL })
  assert.equal(answer.status, 500)
  assert.deepEqual(answer.body, { error: 'boom' })
})

/* ------------------------------------------------------------------ */
/* Exact stdout captured from real git repositories                     */
/* ------------------------------------------------------------------ */

const REAL = {
  // git -c core.fsmonitor=false status --porcelain=v2 --branch -z --untracked-files=normal  (main)
  mainStatus: '# branch.oid 756df3eb353d0fb3e1e37eadda2d8197e2cf5bef\x00# branch.head main\x00' +
    '1 .M N... 100644 100644 100644 67be67e5f12beb9fe8971a08acff8e712217aeee 67be67e5f12beb9fe8971a08acff8e712217aeee bin.dat\x00' +
    '1 .M N... 100644 100644 100644 79a6188d221b76ee517260d15c1adeea3bf49b34 79a6188d221b76ee517260d15c1adeea3bf49b34 blank.txt\x00' +
    '1 .M N... 100644 100644 100644 814f4a422927b82f5f8a43f8fab6d3839e3983f2 814f4a422927b82f5f8a43f8fab6d3839e3983f2 crlf.txt\x00' +
    '1 MM N... 100644 100644 100644 de980441c3ab03a8c07dda1ad27b8a11f39deb1e a7bc997ebe8cf84988b83d2e83f1d193124fe593 mod.txt\x00' +
    '2 R. N... 100644 100644 100644 e573969ae80190f0545f4884c62ece9bf88d7d85 e573969ae80190f0545f4884c62ece9bf88d7d85 R100 new.txt\x00old.txt\x00' +
    '1 .M N... 100644 100644 100644 1b322989b6eea65102d4f5921ccb7df5dc613fe7 1b322989b6eea65102d4f5921ccb7df5dc613fe7 nonl.txt\x00' +
    '? junc/\x00? newdir/\x00? ubin.dat\x00? untracked.txt\x00',
  // git diff --no-color --no-ext-diff --no-textconv --numstat -z HEAD  (main)
  mainNumstat: '-\t-\tbin.dat\x001\t0\tblank.txt\x001\t1\tcrlf.txt\x003\t1\tmod.txt\x000\t0\t\x00old.txt\x00new.txt\x001\t1\tnonl.txt\x00',
  // git log -n 20 --no-color --no-show-signature --format=%h%x1f%s%x1f%an%x1f%cI%x1e  (main)
  mainLog: '756df3e\x1fsecond ' + 'S'.repeat(250) + '\x1fRev\x1f2026-11-21T19:31:16-03:00\x1e\n' +
    'b76ab0e\x1finit: first commit with a subject\x1fRev\x1f2026-11-21T19:31:16-03:00\x1e\n',
  // git diff --no-color --no-ext-diff --no-textconv HEAD -- blank.txt  (main) — last line is a blank context line
  blankDiff: 'diff --git a/blank.txt b/blank.txt\nindex 79a6188..834c4c4 100644\n--- a/blank.txt\n+++ b/blank.txt\n' +
    '@@ -1,2 +1,3 @@\n keep\n+add\n \n',
  nonlDiff: 'diff --git a/nonl.txt b/nonl.txt\nindex 1b32298..6e94b48 100644\n--- a/nonl.txt\n+++ b/nonl.txt\n' +
    '@@ -1,2 +1,2 @@\n x\n-y\n\\ No newline at end of file\n+z\n\\ No newline at end of file\n',
  // git diff --no-color --no-ext-diff --no-textconv HEAD -- mod.txt  (main)
  modDiff: 'diff --git a/mod.txt b/mod.txt\nindex de98044..6fe8acc 100644\n--- a/mod.txt\n+++ b/mod.txt\n' +
    '@@ -1,3 +1,5 @@\n a\n-b\n+B\n c\n+d\n+e\n',
  binaryDiff: 'diff --git a/bin.dat b/bin.dat\nindex 67be67e..83a9a62 100644\nBinary files a/bin.dat and b/bin.dat differ\n',
  // git diff --no-color --no-ext-diff --no-textconv -- c.txt  (conflict) — combined format
  conflictStatus: '# branch.oid b5f101fdd78f4a85cec537a590a354b13095995f\0# branch.head main\0' +
    'u UU N... 100644 100644 100644 100644 f0f23074642919bb50ab5b6e4ec489706127f061 ' +
    'db133015c8114a4e922d89ade395a7fa4f2cfff3 7cab740f24e895eed99ad5027eb20da69769cf35 c.txt\0',
  conflictDiff: 'diff --cc c.txt\nindex db13301,7cab740..0000000\n--- a/c.txt\n+++ b/c.txt\n' +
    '@@@ -1,3 -1,3 +1,7 @@@\n  l1\n++<<<<<<< HEAD\n +MAIN\n++=======\n+ OTHER\n++>>>>>>> other\n  l3\n',
  // unborn repository
  unbornStatus: '# branch.oid (initial)\0# branch.head main\0' +
    '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 ' +
    '2fe4df4058e9498fd54d7881330292ca2a755ee5 staged.txt\0? un.txt\0',
  unbornNumstat: '2\t0\tstaged.txt\0',
  unbornStagedDiff: 'diff --git a/staged.txt b/staged.txt\nnew file mode 100644\nindex 0000000..2fe4df4\n' +
    '--- /dev/null\n+++ b/staged.txt\n@@ -0,0 +1,2 @@\n+n1\n+n2\n',
  untrackedText: 'u1\nu2',   // bytes of main/untracked.txt
  untrackedBinary: 'hello\0world', // bytes of main/ubin.dat
}

/** A stand-in for dsh-subprocess's contract, so the runner's `raw` read can be exercised. */
function fakeSubprocess(answers, lossy = {}) {
  const spawns = []
  return {
    spawns,
    service: {
      async resolveExecutable(name) { assert.equal(name, 'git'); return 'git' },
      spawn(spec) {
        spawns.push(spec)
        const key = spec.argv.slice(1).join(' ')
        const text = Object.hasOwn(answers, key) ? answers[key] : ''
        const isLossy = Object.hasOwn(lossy, key)
        const reader = () => ({ readFrom: () => ({ text, lossy: isLossy }) })
        return {
          collected: { stdout: reader(), stderr: reader() },
          done: Promise.resolve({ exitCode: 0, signal: null }),
        }
      },
    },
  }
}

const realAnswers = overrides => defaultAnswers({
  [SHOW_TOPLEVEL.join(' ')]: ROOT,
  [STATUS_ARGS.join(' ')]: REAL.mainStatus,
  [SHORT_HEAD.join(' ')]: '756df3e',
  [numstatArgs('HEAD').join(' ')]: REAL.mainNumstat,
  [LOG_ARGS.join(' ')]: REAL.mainLog,
  ...overrides,
})

test('a real combined conflict diff parses its two-column prefixes into add and context lines', async () => {
  const key = conflictArgs('c.txt').join(' ')
  const { git } = gitFake(defaultAnswers({
    [STATUS_ARGS.join(' ')]: REAL.conflictStatus,
    [key]: REAL.conflictDiff,
  }))
  const answer = await call(fakeHost({ deps: { git } }).diffRoute, { url: diffUrl('c.txt') })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, {
    path: 'c.txt', kind: 'conflicted', binary: false, truncated: false,
    hunks: [{
      header: '@@@ -1,3 -1,3 +1,7 @@@',
      lines: [
        { type: 'context', text: 'l1', old: null, new: 1 },
        { type: 'add', text: '<<<<<<< HEAD', old: null, new: 2 },
        { type: 'add', text: 'MAIN', old: null, new: 3 },
        { type: 'add', text: '=======', old: null, new: 4 },
        { type: 'add', text: 'OTHER', old: null, new: 5 },
        { type: 'add', text: '>>>>>>> other', old: null, new: 6 },
        { type: 'context', text: 'l3', old: null, new: 7 },
      ],
    }],
  })
})

test('a real untracked binary file diff carries every field including truncated', async () => {
  const { git } = gitFake(realAnswers())
  const readBytes = async () => Buffer.from(REAL.untrackedBinary, 'binary')
  const answer = await call(fakeHost({ deps: { git, readBytes } }).diffRoute, { url: diffUrl('ubin.dat') })
  assert.equal(answer.status, 200)
  assert.deepEqual(Object.keys(answer.body).sort(), ['binary', 'hunks', 'kind', 'path', 'truncated'])
  assert.deepEqual(answer.body, { path: 'ubin.dat', kind: 'untracked', binary: true, truncated: false, hunks: [] })
})

test('a real unborn repository skips git log and reports no commits error', async () => {
  const answers = defaultAnswers({
    [STATUS_ARGS.join(' ')]: REAL.unbornStatus,
    [SHORT_HEAD.join(' ')]: undefined,
    [numstatArgs(EMPTY_TREE).join(' ')]: REAL.unbornNumstat,
    [LOG_ARGS.join(' ')]: undefined,
  })
  const { git, calls } = gitFake(answers)
  const answer = await call(fakeHost({ deps: { git } }).route, { url: OVERVIEW_URL })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.repo.head, null)
  assert.deepEqual(answer.body.commits, [])
  assert.deepEqual(answer.body.errors, {})
  assert.equal(calls.some(item => item.args.includes('log')), false, 'no log runs in a repository without commits')
  assert.equal(answer.body.files[0].added, 2)
})

test('a real diff ending in a blank context line keeps it through the runner raw read', async () => {
  const diffKey = diffArgs('HEAD', 'blank.txt').join(' ')
  const subprocess = fakeSubprocess({
    [SHOW_TOPLEVEL.join(' ')]: ROOT,
    [STATUS_ARGS.join(' ')]: REAL.mainStatus,
    [SHORT_HEAD.join(' ')]: '756df3e',
    [numstatArgs('HEAD').join(' ')]: REAL.mainNumstat,
    [LOG_ARGS.join(' ')]: REAL.mainLog,
    [diffKey]: REAL.blankDiff,
  })
  const host = fakeHost({ deps: { git: undefined, readBytes: async () => Buffer.from('') }, services: { subprocess: subprocess.service } })
  const answer = await call(host.diffRoute, { url: diffUrl('blank.txt') })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body.hunks[0].lines, [
    { type: 'context', text: 'keep', old: 1, new: 1 },
    { type: 'add', text: 'add', old: null, new: 2 },
    { type: 'context', text: '', old: 2, new: 3 },
  ])
  assert.ok(subprocess.spawns.some(item => item.argv.slice(1).join(' ') === diffKey))
})

test('a real blank context line is not lost by the parser itself', () => {
  assert.deepEqual(parseUnifiedDiff(REAL.blankDiff).hunks[0].lines.at(-1), { type: 'context', text: '', old: 2, new: 3 })
  assert.deepEqual(parseUnifiedDiff(REAL.nonlDiff).hunks[0].lines.map(line => line.type), ['context', 'del', 'note', 'add', 'note'])
  assert.equal(parseUnifiedDiff(REAL.binaryDiff).binary, true)
})

test('the real numstat rename is matched by its new path and binary marks survive', () => {
  const counts = parseNumstat(REAL.mainNumstat)
  assert.deepEqual(counts.get('new.txt'), { added: 0, deleted: 0, binary: false })
  assert.equal(counts.has('old.txt'), false)
  assert.deepEqual(counts.get('bin.dat'), { added: null, deleted: null, binary: true })
  const parsed = parseGitLog(REAL.mainLog)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].subject.length, 200)
  assert.equal(parsed[0].author, 'Rev')
})

test('exactly 2000 parsed lines does not set truncated, 2001 does', () => {
  const base = '@@ -0,0 +1,2000 @@\n'
  assert.equal(parseUnifiedDiff(base + '+x\n'.repeat(2000)).truncated, false)
  assert.equal(parseUnifiedDiff(base + '+x\n'.repeat(2001)).truncated, true)
})

test('a failed git diff is a 502, not a tooLarge answer', async () => {
  const key = diffArgs('HEAD', 'mod.txt').join(' ')
  const { git } = gitFake(realAnswers({ [STATUS_ARGS.join(' ')]: REAL.mainStatus, [key]: undefined }))
  const answer = await call(fakeHost({ deps: { git } }).diffRoute, { url: diffUrl('mod.txt') })
  assert.equal(answer.status, 502)
  assert.deepEqual(answer.body, { error: 'git diff did not answer' })
})

test('a lossy status in the diff route answers 503 instead of 404', async () => {
  const { git } = gitFake(realAnswers(), { [STATUS_ARGS.join(' ')]: true })
  const answer = await call(fakeHost({ deps: { git } }).diffRoute, { url: diffUrl('untracked.txt') })
  assert.equal(answer.status, 503)
  assert.deepEqual(answer.body, { error: 'status too large to check the path' })
})

test('an untracked symlink is refused before any bytes are read', async () => {
  const { git } = gitFake(realAnswers())
  let reads = 0
  const readBytes = async () => { reads += 1; return Buffer.from(REAL.untrackedText) }
  const lstat = async () => ({ isFile: () => false }) // symlink, directory or device
  const answer = await call(fakeHost({ deps: { git, readBytes, lstat, realpath: async path => path } }).diffRoute,
    { url: diffUrl('untracked.txt') })
  assert.equal(answer.status, 404)
  assert.deepEqual(answer.body, { error: 'not a changed file' })
  assert.equal(reads, 0, 'no bytes are read through a non-regular path')
})

test('a realpath that leaves the root is refused before any bytes are read', async () => {
  const { git } = gitFake(realAnswers())
  let reads = 0
  const readBytes = async () => { reads += 1; return Buffer.from(REAL.untrackedText) }
  const lstat = async () => ({ isFile: () => true })
  const realpath = async path => (path === resolve(ROOT, 'untracked.txt') ? 'D:/elsewhere/secret.txt' : path)
  const answer = await call(fakeHost({ deps: { git, readBytes, lstat, realpath } }).diffRoute,
    { url: diffUrl('untracked.txt') })
  assert.equal(answer.status, 404)
  assert.deepEqual(answer.body, { error: 'not a changed file' })
  assert.equal(reads, 0)
})

test('a vanished untracked file answers 404, not a local path in a 500', async () => {
  const { git } = gitFake(realAnswers())
  const gone = new Error('ENOENT')
  gone.code = 'ENOENT'
  const lstat = async () => { throw gone }
  const answer = await call(fakeHost({ deps: { git, lstat, realpath: async path => path } }).diffRoute,
    { url: diffUrl('untracked.txt') })
  assert.equal(answer.status, 404)
  assert.deepEqual(answer.body, { error: 'not a changed file' })
})

test('every success answer carries the fields the client contract lists', async () => {
  const main = gitFake(realAnswers({ [diffArgs('HEAD', 'mod.txt').join(' ')]: REAL.modDiff }))
  const host = fakeHost({ deps: { git: main.git, readBytes: async () => Buffer.from(REAL.untrackedText) } })
  const overview = await call(host.route, { url: OVERVIEW_URL })
  assert.deepEqual(Object.keys(overview.body).sort(), ['commits', 'cwd', 'errors', 'files', 'git', 'repo', 'total', 'truncated'])
  for (const file of overview.body.files) {
    assert.deepEqual(Object.keys(file).sort(), [
      'added', 'binary', 'deleted', 'index', 'kind', 'origPath', 'path', 'worktree',
      ...(file.folder ? ['folder'] : []),
    ].sort(), file.path)
  }
  for (const commit of overview.body.commits) {
    assert.deepEqual(Object.keys(commit).sort(), ['author', 'date', 'hash', 'subject'])
  }
  const diffFields = ['binary', 'hunks', 'kind', 'path', 'truncated']
  for (const [path, extra] of [['mod.txt', []], ['untracked.txt', []], ['newdir/', ['folder']]]) {
    const answer = await call(host.diffRoute, { url: diffUrl(path) })
    assert.equal(answer.status, 200, path)
    assert.deepEqual(Object.keys(answer.body).sort(), [...diffFields, ...extra].sort(), path)
  }
  const conflict = gitFake(defaultAnswers({
    [STATUS_ARGS.join(' ')]: REAL.conflictStatus,
    [conflictArgs('c.txt').join(' ')]: REAL.conflictDiff,
  }))
  const conflictHost = fakeHost({ deps: { git: conflict.git } })
  const conflictAnswer = await call(conflictHost.diffRoute, { url: diffUrl('c.txt') })
  assert.equal(conflictAnswer.status, 200)
  assert.deepEqual(Object.keys(conflictAnswer.body).sort(), diffFields)
})

test('a regular untracked file still reads after the lstat and realpath checks', async () => {
  const { git } = gitFake(realAnswers())
  const readBytes = async () => Buffer.from(REAL.untrackedText)
  const checked = []
  const lstat = async file => { checked.push(['lstat', file]); return { isFile: () => true } }
  const realpath = async path => { checked.push(['realpath', path]); return path }
  const answer = await call(fakeHost({ deps: { git, readBytes, lstat, realpath } }).diffRoute,
    { url: diffUrl('untracked.txt') })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body.hunks, [{ header: '@@ -0,0 +1,2 @@', lines: [
    { type: 'add', text: 'u1', old: null, new: 1 },
    { type: 'add', text: 'u2', old: null, new: 2 },
  ] }])
  assert.ok(checked.some(item => item[0] === 'lstat' && item[1] === resolve(ROOT, 'untracked.txt')))
  assert.ok(checked.some(item => item[0] === 'realpath' && item[1] === resolve(ROOT, 'untracked.txt')))
  assert.ok(checked.some(item => item[0] === 'realpath' && item[1] === ROOT))
})

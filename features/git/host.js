/**
 * Host half of the Git tab: two read-only HTTP routes that report a session's branch, files
 * and commits, and the diff of one changed file. Every git command goes through the hardened
 * runner shared with the Environment row; a diff path must still be in the current status and
 * resolve to a regular file inside the real repository root before any bytes are read.
 */
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative as relativePath, resolve, sep } from 'node:path'
import { enableFeature } from '../../host/features.js'
import {
  BINARY_PROBE_BYTES,
  EMPTY_TREE,
  GIT_FILE_BYTES,
  GIT_FILE_LIMIT,
  GIT_SHORT_HEAD_ARGS,
  GIT_STATUS_ARGS,
  GIT_STATUS_OUTPUT_BYTES,
  GIT_TOPLEVEL_ARGS,
  gitConflictArgs,
  gitDiffArgs,
  gitLogArgs,
  gitNumstatArgs,
  gitRunner,
  parseStatusV2,
  trimPath,
} from '../../host/git.js'
import { guard, reply } from '../../host/http.js'
import { isolated, messageOf } from '../../host/redact.js'
import { cwdOf, sessionRow } from '../../host/session.js'
import {
  parseBranchHeader,
  parseGitLog,
  parseNumstat,
  parseUnifiedDiff,
  untrackedDiff,
} from './facts.js'

export const name = 'claude-sidebar-git'
export const inject = ['webServer']

/** The two read-only Git routes, installed beside the Environment route. */
export const GIT_ROUTE = '/dsh-claude-sidebar/git'
export const GIT_DIFF_ROUTE = '/dsh-claude-sidebar/git/diff'

export function apply(ctx) {
  enableFeature(ctx, 'git')
  installGit(ctx)
}

/**
 * Mount the two read-only Git routes. The deps exist so tests can answer for git and for the
 * bytes of an untracked file without a dsh process or a real repository.
 * @param {object} ctx - the Host plugin context.
 * @param {{ git?: (args: string[], cwd: string, options?: { outputBytes?: number, lossy?: boolean, raw?: boolean }) => Promise<string | undefined>, readBytes?: (file: string, limit: number) => Promise<Uint8Array>, lstat?: (file: string) => Promise<{ isFile: () => boolean }>, realpath?: (path: string) => Promise<string> }} [deps]
 */
export function installGit(ctx, deps = {}) {
  const overview = createGitHandler(ctx, deps)
  const diff = createGitDiffHandler(ctx, deps)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: GIT_ROUTE, handler: overview }), 'git panel: overview route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: GIT_DIFF_ROUTE, handler: diff }), 'git panel: diff route')
}

/** Build the Git overview handler: branch, files and commits, each section isolated. */
function createGitHandler(ctx, deps = {}) {
  const git = deps.git ?? gitRunner(ctx)
  return async function handler(req, res) {
    if (!guard(ctx, req, res)) return
    if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' })
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const row = await sessionRow(ctx, sessionId)
      const cwd = cwdOf(row)
      if (cwd === null) return reply(res, 404, { error: 'no session with a working directory: ' + sessionId })
      reply(res, 200, { cwd, ...await gitFacts({ cwd, git }) })
    } catch (error) {
      reply(res, 500, { error: messageOf(error) })
    }
  }
}

/**
 * The overview's facts. Only the root probe uses the session folder; every other git read runs
 * in the root, because a diff pathspec is relative to the current directory but status paths
 * are relative to the repository root.
 */
async function gitFacts({ cwd, git }) {
  const root = await git(GIT_TOPLEVEL_ARGS, cwd)
  if (typeof root !== 'string' || root === '') {
    return { git: false, repo: null, files: [], total: 0, truncated: false, commits: [], errors: {} }
  }
  const repoRoot = trimPath(root)
  const statusOptions = { outputBytes: GIT_STATUS_OUTPUT_BYTES }
  const [status, head] = await Promise.all([
    git(GIT_STATUS_ARGS, repoRoot, statusOptions),
    git(GIT_SHORT_HEAD_ARGS, repoRoot),
  ])
  const { branch, detached } = parseBranchHeader(status)
  const parsed = parseStatusV2(status)
  const repo = {
    root: repoRoot,
    branch,
    detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    head: typeof head === 'string' && head !== '' ? head : null,
  }
  const errors = {}
  const files = await isolated(
    errors, 'files', { files: [], total: 0, truncated: false, countsError: null },
    () => fileFacts(git, repoRoot, status, statusOptions, repo.head, parsed),
  )
  if (typeof files.countsError === 'string') errors.counts = files.countsError
  const { countsError, ...fileSection } = files
  // An unborn branch has no log to read; git log would exit 128 and fail the section.
  const commits = repo.head === null ? [] : await isolated(errors, 'commits', [], async () => {
    const log = await git(gitLogArgs(), repoRoot)
    if (typeof log !== 'string') throw new Error('git log did not answer')
    return parseGitLog(log)
  })
  return { git: true, repo, ...fileSection, commits, errors }
}

/** The changed-file rows. An oversize numstat drops every count but keeps the rows. */
async function fileFacts(git, root, status, statusOptions, head, parsed) {
  if (typeof status !== 'string') {
    throw new Error(statusOptions.lossy === true ? 'git status output was too large' : 'git status did not answer')
  }
  const options = { outputBytes: GIT_STATUS_OUTPUT_BYTES }
  const numstat = await git(gitNumstatArgs(head === null ? EMPTY_TREE : 'HEAD'), root, options)
  let counts = null
  let countsError = null
  if (typeof numstat === 'string' && options.lossy !== true) {
    counts = parseNumstat(numstat)
  } else {
    countsError = options.lossy === true
      ? 'git diff --numstat output was too large'
      : 'git diff --numstat did not answer'
  }
  const rows = fileRows(parsed.files, counts)
  return {
    files: rows.slice(0, GIT_FILE_LIMIT),
    total: rows.length,
    truncated: rows.length > GIT_FILE_LIMIT,
    countsError,
  }
}

/** One row per status entry, sorted conflicted → staged → unstaged → untracked, then by path. */
function fileRows(files, counts) {
  const rank = { conflicted: 0, staged: 1, unstaged: 2, untracked: 3 }
  return files.map(file => {
    const kind = file.kind === 'both' ? 'staged' : file.kind
    const row = {
      path: file.path,
      origPath: typeof file.origPath === 'string' ? file.origPath : null,
      index: file.index,
      worktree: file.worktree,
      kind,
      added: null,
      deleted: null,
      binary: false,
    }
    if (kind === 'untracked') {
      if (file.path.endsWith('/')) row.folder = true
    } else if (counts !== null) {
      const count = counts.get(file.path)
      if (count !== undefined) {
        row.added = count.added
        row.deleted = count.deleted
        row.binary = count.binary
      }
    }
    return row
  }).sort((left, right) => rank[left.kind] - rank[right.kind] || compareText(left.path, right.path))
}

/** Build the diff handler: it re-reads status so only a path in it can be fetched. */
function createGitDiffHandler(ctx, deps = {}) {
  const git = deps.git ?? gitRunner(ctx)
  const readBytes = deps.readBytes ?? readBoundedBytes
  const lstatOf = deps.lstat ?? lstat
  const realpathOf = deps.realpath ?? realpath
  return async function handler(req, res) {
    if (!guard(ctx, req, res)) return
    if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' })
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const path = url.searchParams.get('path') ?? ''
      const row = await sessionRow(ctx, sessionId)
      const cwd = cwdOf(row)
      if (cwd === null) return reply(res, 404, { error: 'no session with a working directory: ' + sessionId })
      const result = await diffFacts({ cwd, path, git, readBytes, lstat: lstatOf, realpath: realpathOf })
      if (result.status !== 200) return reply(res, result.status, { error: result.error })
      reply(res, 200, result.body)
    } catch (error) {
      reply(res, 500, { error: messageOf(error) })
    }
  }
}

/** The diff of one changed file; a path that is not a regular file inside the root is refused. */
async function diffFacts({ cwd, path, git, readBytes, lstat, realpath }) {
  const root = await git(GIT_TOPLEVEL_ARGS, cwd)
  if (typeof root !== 'string' || root === '') return { status: 404, error: 'not a changed file' }
  const repoRoot = trimPath(root)
  const options = { outputBytes: GIT_STATUS_OUTPUT_BYTES }
  const status = await git(GIT_STATUS_ARGS, repoRoot, options)
  if (options.lossy === true) return { status: 503, error: 'status too large to check the path' }
  const entry = parseStatusV2(status).files.find(item => item.path === path)
  if (entry === undefined) return { status: 404, error: 'not a changed file' }
  const file = resolveWithin(repoRoot, path)
  if (file === null) return { status: 403, error: 'path outside repository root' }
  const kind = entry.kind === 'both' ? 'staged' : entry.kind
  if (kind === 'untracked' && path.endsWith('/')) {
    return { status: 200, body: { path, kind, binary: false, truncated: false, folder: true, hunks: [] } }
  }
  if (kind === 'untracked') {
    if (await safeUntrackedPath(file, repoRoot, lstat, realpath) === null) {
      return { status: 404, error: 'not a changed file' }
    }
    let buffer
    try {
      buffer = await readBytes(file, GIT_FILE_BYTES + 1)
    } catch (error) {
      if (isNotFound(error)) return { status: 404, error: 'not a changed file' }
      throw error
    }
    const bytes = buffer.subarray(0, GIT_FILE_BYTES)
    const binary = bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)
    const diff = binary
      ? { binary: true, truncated: false, hunks: [] }
      : untrackedDiff(bytes.toString('utf8'))
    return {
      status: 200,
      body: {
        path, kind, binary: diff.binary,
        truncated: buffer.length > GIT_FILE_BYTES || diff.truncated,
        hunks: diff.hunks,
      },
    }
  }
  // An unborn branch has no HEAD to diff against; status names it in the oid header.
  const noCommits = typeof status === 'string' && status.split('\0').includes('# branch.oid (initial)')
  const args = kind === 'conflicted'
    ? gitConflictArgs(path)
    : gitDiffArgs(noCommits ? EMPTY_TREE : 'HEAD', path)
  const diffOptions = { outputBytes: GIT_FILE_BYTES, raw: true }
  const diff = await git(args, repoRoot, diffOptions)
  if (diffOptions.lossy === true) {
    return { status: 200, body: { path, kind, binary: false, truncated: true, tooLarge: true, hunks: [] } }
  }
  if (typeof diff !== 'string') return { status: 502, error: 'git diff did not answer' }
  const parsed = parseUnifiedDiff(diff)
  return {
    status: 200,
    body: { path, kind, binary: parsed.binary, truncated: parsed.truncated, hunks: parsed.hunks },
  }
}

/**
 * Only a regular file whose real path stays in the real root may be read on the Host: a status
 * path can name a symlink whose target lives outside the repository. A file that vanished after
 * status answered has the same 404 as a path that was never changed.
 */
async function safeUntrackedPath(file, root, lstat, realpath) {
  let stat
  try {
    stat = await lstat(file)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
  if (stat === null || typeof stat.isFile !== 'function' || !stat.isFile()) return null
  let realFile
  let realRoot
  try {
    [realFile, realRoot] = await Promise.all([realpath(file), realpath(root)])
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
  return isWithin(realRoot, realFile) ? file : null
}

function isNotFound(error) {
  return error !== null && typeof error === 'object' && error.code === 'ENOENT'
}

/** Whether `file` sits inside `root` after both have been resolved. */
function isWithin(root, file) {
  const within = relativePath(root, file)
  return within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within)
}

/** The absolute path for a status path, or null when it would leave the repository root. */
function resolveWithin(root, path) {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) return null
  const absolute = resolve(root, path)
  return isWithin(root, absolute) ? absolute : null
}

/** A bounded read of an untracked file's bytes; the caller decides how much of it to show. */
async function readBoundedBytes(file, limit) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

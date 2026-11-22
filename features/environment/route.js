/**
 * Host route behind the Environment tab: a read-only HTTP route that reports where a session
 * works, what is dirty there, its git branch, the app's connectors and the session's pull requests.
 *
 * The route reads the session's live working directory from the session-list row and asks git a
 * handful of read-only questions through the subprocess service. The maintainer-specific facts —
 * the itsaplan link registry, the tracker card and branch-name convention, and the work tree's
 * progress file — are read only when the row's `taskFacts` setting is on; off, the answer carries
 * only `git` and `repo` in its `task` object. With the setting on, a card link is built only when
 * the row has a valid http(s) `trackerUrl`. The route adds one `git status`, the MCP manager's
 * in-memory views, the profile's plain dsh-mcp-client servers (derived from the tool names they
 * register) and the forge bundle's bindings and latest polling results; for a server waiting on
 * a credential it adds only the `${credential:NAME}` names from that server's configured entry.
 * It writes nothing, starts no polling, and holds no secrets.
 *
 * No app imports here, so tests can load this module without dsh installed.
 */
import { readFile } from 'node:fs/promises'
import { homedir, hostname as osHostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  GIT_STATUS_ARGS,
  GIT_STATUS_OUTPUT_BYTES,
  gitRunner,
  parseStatusV2,
  samePath,
  trimPath,
} from '../../host/git.js'
import { guard, reply } from '../../host/http.js'
import { isolated, messageOf } from '../../host/redact.js'
import { cwdOf, serviceOf, sessionRow } from '../../host/session.js'
import {
  capProgress,
  cardOf,
  connectorView,
  credentialRefs,
  followsConvention,
  linkOf,
  parseRepoSlug,
  parseRegistry,
  pinnedConnectors,
  progressPath,
  pullRequestView,
  summarizeChanges,
} from './facts.js'

/** The Environment route: the session's live folder, machine, changes, connectors and pull requests. */
export const ENV_ROUTE = '/dsh-claude-sidebar/environment'

/** The most pull-request rows one answer carries. */
const PULL_REQUEST_LIMIT = 5

/** The well-known key a volatile config reference carries its writer under; no cosmokit import. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Snapshot the row's config as plain values. A `.volatile()` field arrives in `apply` as a live
 * reference the Loader mutates in place when Settings writes, so unwrapping on every request
 * makes a change live on the next tab refresh. Plain values (tests, older hosts) pass through,
 * and a missing config is simply off.
 * @param {object} [config] - the row's resolved Config.
 * @returns {Record<string, unknown>} the current plain values.
 */
function readLiveConfig(config) {
  const section = {}
  for (const key of Object.keys(config ?? {})) {
    const value = config[key]
    section[key] = typeof value === 'object' && value !== null && VOLATILE_WRITE in value ? value.get() : value
  }
  return section
}

/**
 * Mount the Environment route. The deps exist so tests can answer for git, the file system,
 * the environment and the machine without a dsh process.
 * @param {object} ctx - the Host plugin context.
 * @param {object} [config] - the row's resolved Config; volatile fields are read live.
 * @param {{ readText?: (file: string) => Promise<string>, env?: Record<string, string | undefined>, home?: string, git?: (args: string[], cwd: string, options?: { outputBytes?: number, lossy?: boolean }) => Promise<string | undefined>, hostname?: string, platform?: string }} [deps]
 */
export function installEnvironment(ctx, config = {}, deps = {}) {
  const handler = createEnvironmentHandler(ctx, config, deps)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ENV_ROUTE, handler }), 'environment panel: facts route')
}

/**
 * Build the Environment route handler. Every section is computed on its own, so one missing
 * service or one failing read leaves the rest of the answer usable.
 * @param {object} ctx - the Host plugin context.
 * @param {object} [config] - the row's resolved Config, unwrapped on each request.
 * @param {object} [deps] - the same overrides installEnvironment takes.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
function createEnvironmentHandler(ctx, config = {}, deps = {}) {
  const readText = deps.readText ?? (file => readFile(file, 'utf8'))
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const git = deps.git ?? gitRunner(ctx)
  const machine = { hostname: deps.hostname ?? osHostname(), platform: deps.platform ?? process.platform }
  return async function handler(req, res) {
    if (!guard(req, res)) return
    if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' })
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const row = await sessionRow(ctx, sessionId)
      const cwd = cwdOf(row)
      if (cwd === null) return reply(res, 404, { error: 'no session with a working directory: ' + sessionId })
      const facts = await taskFacts({ cwd, git, readText, env, home, config: readLiveConfig(config) })
      // The task facts, minus the cwd it answers as its own top-level field.
      const { cwd: taskCwd, ...task } = facts
      const errors = {}
      const changes = await isolated(errors, 'changes', null, () => changeFacts(cwd, git, facts.git !== null))
      const connectors = await isolated(errors, 'connectors', null, () => connectorFacts(ctx))
      const pullRequests = await isolated(errors, 'pullRequests', [], () => pullRequestFacts(ctx, row))
      reply(res, 200, { machine, cwd: taskCwd, task, changes, connectors, pullRequests, errors })
    } catch (error) {
      // A route must answer, never propagate: the tab shows the message, not a stack.
      reply(res, 500, { error: messageOf(error) })
    }
  }
}

/** Everything the tab renders about one directory. */
async function taskFacts({ cwd, git, readText, env, home, config }) {
  const state = await readGitState(cwd, git)
  const repo = state === null ? null : parseRepoSlug(state.origin)
  const task = {
    cwd,
    git: state === null ? null : {
      root: state.root,
      branch: state.branch,
      detached: state.detached,
      linkedWorktree: state.linkedWorktree,
      mainRoot: state.mainRoot,
    },
    repo,
  }
  // The private facts are opt-in. Off, neither the registry nor the progress file is read and
  // the four extra keys are absent, so the client renders no card or progress rows.
  if (config?.taskFacts !== true) return task
  const link = repo === null ? { state: 'n/a' } : linkOf(await readRegistry(readText, env, home, config.registryPath), repo)
  return {
    ...task,
    link,
    card: cardOf(state === null ? null : state.branch, link, config.trackerUrl),
    branchFollowsConvention: followsConvention(state === null ? null : state.branch, link, state !== null && state.detached),
    progress: state === null ? null : await readProgress(readText, state.root),
  }
}

/** The working tree's current changes; null outside a work tree. */
async function changeFacts(cwd, git, inWorkTree) {
  if (!inWorkTree) return null
  const options = { outputBytes: GIT_STATUS_OUTPUT_BYTES }
  const status = await git(GIT_STATUS_ARGS, cwd, options)
  // A truncated status has no headers and loses entries: fail the section rather than report
  // wrong counts as if the tree were clean.
  if (typeof status !== 'string') {
    throw new Error(options.lossy === true ? 'git status output was too large' : 'git status did not answer')
  }
  return summarizeChanges(parseStatusV2(status))
}

/**
 * The app's MCP servers: the manager's with their live state (and, for a waiting server, the
 * credential names its configured entry asks for), plus the servers the profile mounts as plain
 * dsh-mcp-client rows, with their tool count. Null only when neither the MCP manager nor the
 * tool registry is mounted.
 */
function connectorFacts(ctx) {
  const manager = serviceOf(ctx, 'mcpManager')
  const tools = serviceOf(ctx, 'tools')
  const hasManager = manager !== undefined && manager !== null
  const hasTools = tools !== undefined && tools !== null
  if (!hasManager && !hasTools) return null
  const configured = hasManager ? configuredServers(manager) : null
  const managed = hasManager
    ? manager.list().map(view => {
        const connector = connectorView(view)
        if (
          configured !== null &&
          connector.state === 'waiting-credentials' &&
          Object.hasOwn(configured, connector.name)
        ) {
          const credentials = credentialRefs(configured[connector.name])
          if (credentials.length > 0) connector.credentials = credentials
        }
        return connector
      })
    : []
  const registered = hasTools && typeof tools.definitions === 'function' ? tools.definitions() : []
  const names = registered.map(definition => definition?.name)
  return [...managed, ...pinnedConnectors(names, managed.map(connector => connector.name))]
}

/**
 * The manager's configured server entries, or null when the manager has no readable config.
 * A config read is best-effort: it adds credential names to waiting rows, never a section error.
 */
function configuredServers(manager) {
  try {
    const servers = manager.config?.servers
    if (servers === null || servers === undefined || typeof servers.get !== 'function') return null
    const entries = servers.get()
    return entries !== null && typeof entries === 'object' && !Array.isArray(entries) ? entries : null
  } catch {
    return null
  }
}

/** The session's visible forge bindings, mapped; this reads, it never watches or fetches. */
function pullRequestFacts(ctx, row) {
  const forge = serviceOf(ctx, 'forge')
  if (forge === undefined || forge === null) return []
  const pullRequests = []
  for (const binding of forgeBindingsOf(row)) {
    if (pullRequests.length >= PULL_REQUEST_LIMIT) break
    if (binding === null || typeof binding !== 'object' || binding.dismissed === true) continue
    try {
      const ref = forge.changeRequestFromUrl(binding.url)
      if (ref === undefined) continue
      pullRequests.push(pullRequestView(binding, ref, forge.latest(ref)))
    } catch {
      // One binding the forge cannot resolve or read is skipped; the rest of the section answers.
    }
  }
  return pullRequests
}

/**
 * The session's `forgeChangeRequests` summary projection value. The Host session-list row carries
 * it at `projections.values` (dsh-api-session-controller src/types.ts:48-63,166); the forge-session
 * package maps that key to `{ url, origin, dismissed }[]` and keeps it out of the summary-excluded
 * keys (dsh-experimental-forge-session src/projection.ts:71-78, src/types.ts:106).
 */
function forgeBindingsOf(row) {
  const values = row?.projections?.values
  if (values === null || typeof values !== 'object') return []
  return Array.isArray(values.forgeChangeRequests) ? values.forgeChangeRequests : []
}

/** The work tree facts, or null when the directory is outside a work tree or git is missing. */
async function readGitState(cwd, git) {
  const root = await git(['rev-parse', '--show-toplevel'], cwd)
  if (typeof root !== 'string' || root === '') return null
  const [head, gitDirText, commonDirText, origin] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    git(['rev-parse', '--absolute-git-dir'], cwd),
    git(['rev-parse', '--git-common-dir'], cwd),
    git(['config', '--get', 'remote.origin.url'], cwd),
  ])
  // "HEAD" is what --abbrev-ref prints on a detached head.
  const detached = typeof head !== 'string' || head === '' || head === 'HEAD'
  const gitDir = typeof gitDirText === 'string' && gitDirText !== '' ? resolve(cwd, gitDirText) : null
  const commonDir = typeof commonDirText === 'string' && commonDirText !== '' ? resolve(cwd, commonDirText) : null
  const linkedWorktree = gitDir !== null && commonDir !== null && !samePath(gitDir, commonDir)
  return {
    root: trimPath(root),
    branch: detached ? null : head,
    detached,
    linkedWorktree,
    mainRoot: linkedWorktree ? await mainRootOf(cwd, git, commonDir) : trimPath(root),
    origin: typeof origin === 'string' ? origin : null,
  }
}

/** The main work tree's root: the first "worktree" row git lists, else the common dir's parent. */
async function mainRootOf(cwd, git, commonDir) {
  const listed = await git(['worktree', 'list', '--porcelain'], cwd)
  const first = typeof listed === 'string' ? /^worktree (.+)$/mu.exec(listed) : null
  if (first !== null) return trimPath(first[1].trim())
  return commonDir === null ? null : trimPath(dirname(commonDir))
}

/**
 * The itsaplan link registry; a missing or unreadable file is an empty registry. The row's
 * configured path wins; the legacy ITSAPLAN_LINKS_PATH environment variable is still honored;
 * empty means ~/.claude/itsaplan/links.json.
 */
async function readRegistry(readText, env, home, registryPath) {
  const configured = typeof registryPath === 'string' ? registryPath.trim() : ''
  const fromEnv = typeof env?.ITSAPLAN_LINKS_PATH === 'string' ? env.ITSAPLAN_LINKS_PATH.trim() : ''
  const file = configured !== '' ? configured : fromEnv !== '' ? fromEnv : join(home, '.claude', 'itsaplan', 'links.json')
  try {
    return parseRegistry(await readText(file))
  } catch {
    return {}
  }
}

/** The work tree's progress file, bounded; null when it does not exist. */
async function readProgress(readText, root) {
  const file = progressPath(root)
  if (file === null) return null
  try {
    const text = await readText(file)
    return { path: file, ...capProgress(text) }
  } catch {
    return null
  }
}

/**
 * Pure facts behind the Environment tab: the GitHub repository a remote names, what the itsaplan
 * link registry says about it, the tracker card and branch-name convention a branch carries, the
 * progress file and its bound, the change summary, the connector and pull-request views the route
 * serves, and the credential-template names a waiting connector's
 * configured entry asks for.
 *
 * Nothing here touches dsh, the file system or the network: every function takes what
 * the Host routes already read. That keeps the parsing and the naming rules testable on their
 * own, which is where the tracker conventions live.
 */
import { MESSAGE_LIMIT, redactUrls } from '../../host/redact.js'

/** The most progress text the route serves; anything longer is cut and flagged. */
export const PROGRESS_LIMIT = 6000

/**
 * The owner/repo slug a GitHub remote names, lowercased and without ".git".
 * Accepts the https, ssh:// and git@github.com: forms of a GitHub remote.
 * @param {unknown} url - the remote.origin.url text, if any.
 * @returns {string | null} owner/repo, or null for anything that is not a GitHub remote.
 */
export function parseRepoSlug(url) {
  if (typeof url !== 'string') return null
  const text = url.trim()
  let path
  let match = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::[0-9]+)?\/(.+)$/iu.exec(text)
  if (match !== null) path = match[1]
  else {
    // The scp-like form: git@github.com:owner/repo.git
    match = /^(?:[^@/\s]+@)?github\.com:(?!\/)(.+)$/iu.exec(text)
    if (match === null) return null
    path = match[1]
  }
  const cleaned = path.replace(/\/+$/u, '').replace(/\.git$/iu, '')
  const parts = cleaned.split('/')
  if (parts.length !== 2) return null
  const [owner, repo] = parts
  if (owner === '' || repo === '') return null
  return (owner + '/' + repo).toLowerCase()
}

/**
 * Parse the link registry text. A missing, empty or unreadable file is an empty
 * registry, never an error: an absent entry means "not in the local registry", which
 * this read-only tab reports as unlinked.
 * @param {unknown} text - the file contents, when the file could be read.
 * @returns {Record<string, unknown>} the registry, keyed by lowercased owner/repo.
 */
export function parseRegistry(text) {
  if (typeof text !== 'string' || text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed
}

/**
 * What the registry says about one repository.
 * @param {Record<string, unknown>} registry - see parseRegistry.
 * @param {string | null} repo - the lowercased owner/repo slug.
 * @returns {{ state: 'linked' | 'declined' | 'unlinked' | 'n/a', projectRef?: string }}
 */
export function linkOf(registry, repo) {
  if (typeof repo !== 'string' || repo === '') return { state: 'n/a' }
  const record = entryOf(registry, repo)
  if (record === null) return { state: 'unlinked' }
  if (record.status === 'declined') return { state: 'declined' }
  if (record.status === 'linked' && typeof record.projectRef === 'string' && record.projectRef !== '') {
    return { state: 'linked', projectRef: record.projectRef }
  }
  // "hook-found" (the authoritative GitHub fallback) needs gh admin access, which this
  // read-only tab does not use; every other record fails closed to "not linked here".
  return { state: 'unlinked' }
}

/**
 * The tracker card a branch names. The card key is the text after the last dot of
 * projectRef, matched case-insensitively and reported in upper case. The URL is built only
 * from the row's configured tracker address:
 * empty or non-http(s) means the card carries just its key, so the tab shows no link. The team
 * slug and the key are encoded as path segments, so a space or a "#" cannot break the URL.
 * @param {string | null} branch - the abbreviated branch name; null when detached.
 * @param {{ state: string, projectRef?: string } | null} link - see linkOf.
 * @param {string} [trackerUrl] - the row's tracker web address; empty by default.
 * @returns {{ key: string, url?: string } | null}
 */
export function cardOf(branch, link, trackerUrl = '') {
  if (typeof branch !== 'string' || branch === '') return null
  if (link === null || typeof link !== 'object' || link.state !== 'linked') return null
  const parts = projectRefParts(link.projectRef)
  if (parts === null) return null
  const number = cardNumberOf(branch, parts.key)
  if (number === null) return null
  const key = parts.key.toUpperCase() + '-' + number
  const tracker = trackerOrigin(trackerUrl)
  if (tracker === null) return { key }
  return { key, url: tracker + '/' + encodeURIComponent(parts.teamSlug) + '/issue/' + encodeURIComponent(key) }
}

/**
 * The configured tracker origin: trimmed, trailing slashes removed, http(s) only. Building it
 * from `origin + pathname` also drops userinfo, a query and a fragment, so none of them end up
 * in a card link. Anything unparsable or with another scheme is ignored.
 * @param {unknown} value - the configured tracker address.
 * @returns {string | null}
 */
function trackerOrigin(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin + url.pathname.replace(/\/+$/u, '')
}

/**
 * Whether the branch matches type/KEY-N-slug (AGENTS.md, and the convention no hook
 * enforces). The type and the slug are lowercase; the key is matched case-insensitively.
 * @param {string | null} branch - the abbreviated branch name.
 * @param {{ state: string, projectRef?: string } | null} link - see linkOf.
 * @param {boolean} detached - whether HEAD is detached.
 * @returns {boolean | null} null when the question does not apply (not linked, detached,
 * or a projectRef this tab cannot split into team and key).
 */
export function followsConvention(branch, link, detached) {
  if (link === null || typeof link !== 'object' || link.state !== 'linked') return null
  if (detached === true) return null
  if (typeof branch !== 'string' || branch === '') return null
  const parts = projectRefParts(link.projectRef)
  if (parts === null) return null
  return new RegExp('^[a-z][a-z0-9]*/' + keyPattern(parts.key) + '-[0-9]+-[a-z0-9][a-z0-9-]*$', 'u').test(branch)
}

/**
 * The progress file of a work tree: a sibling of the work tree folder with
 * ".progress.md" appended to its name.
 * @param {string | null} root - the work tree root.
 * @returns {string | null}
 */
export function progressPath(root) {
  if (typeof root !== 'string' || root === '') return null
  return root.replace(/[\\/]+$/u, '') + '.progress.md'
}

/**
 * Bound the progress text the route serves.
 * @param {unknown} text - the file contents.
 * @param {number} [limit] - the most characters to keep; default PROGRESS_LIMIT.
 * @returns {{ text: string, truncated: boolean }} the kept text and whether it was cut.
 */
export function capProgress(text, limit = PROGRESS_LIMIT) {
  const value = typeof text === 'string' ? text : ''
  const kept = value.slice(0, limit)
  return { text: kept, truncated: kept.length < value.length }
}

/**
 * One MCP manager view as the Environment tab shows it: identity, state, and only the detail the
 * status actually carries. A failed server also names its reason ('gave-up',
 * 'reconnect-disabled', 'unclosed-generation'), which the tab labels when no lastError arrived.
 * The list is the app-wide fleet, not one session's servers.
 * @param {{ name: string, configured: boolean, status: { state: string, reason?: unknown } & Record<string, unknown> }} view - an McpManagedServerView.
 * @returns {{ name: string, configured: boolean, state: string, toolCount?: number, attempt?: number, error?: string, reason?: string }}
 */
export function connectorView(view) {
  const status = view.status
  const connector = { name: view.name, configured: view.configured, state: status.state }
  if (status.state === 'connected') connector.toolCount = status.toolCount
  if (status.state === 'connecting' || status.state === 'reconnecting') connector.attempt = status.attempt
  if (typeof status.lastError === 'string') connector.error = redactUrls(status.lastError).slice(0, MESSAGE_LIMIT)
  if (status.state === 'failed' && typeof status.reason === 'string') connector.reason = status.reason
  return connector
}

/** The longest credential name this tab will surface; a longer template name is ignored. */
const CREDENTIAL_NAME_MAX = 128

/**
 * The unique `${credential:NAME}` names a configured MCP server entry refers to, in first-seen
 * order. Names follow dsh-mcp-client's template syntax (src/templates.ts:12-13,70-79): a name
 * starts with a letter or underscore and continues with letters, digits or underscores. Only
 * the names are returned — never the surrounding template, a literal value, a header name or
 * any other part of the entry. Strings are looked for at every depth of objects and arrays
 * (env, headers, url, args), which is where dsh-mcp-client resolves templates.
 * @param {unknown} entry - one server entry from `mcpManager.config.servers.get()`.
 * @param {number} [limit] - the most names to keep; default 10.
 * @returns {string[]}
 */
export function credentialRefs(entry, limit = 10) {
  const names = []
  const seen = new Set()
  const visited = new Set()
  const pattern = /\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}/gu
  const walk = value => {
    if (names.length >= limit) return
    if (typeof value === 'string') {
      pattern.lastIndex = 0
      let match = pattern.exec(value)
      while (match !== null) {
        if (match[1].length <= CREDENTIAL_NAME_MAX && !seen.has(match[1])) {
          seen.add(match[1])
          names.push(match[1])
          if (names.length >= limit) break
        }
        match = pattern.exec(value)
      }
      return
    }
    if (value === null || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    // Values only: a template used as an object key is not a reference the MCP client resolves.
    const children = Array.isArray(value) ? value : Object.values(value)
    for (const child of children) {
      walk(child)
      if (names.length >= limit) break
    }
  }
  walk(entry)
  return names
}

/** How a mounted dsh-mcp-client names each tool it registers: `mcp__<serverName>__<rawName>`. */
const PINNED_TOOL_PATTERN = /^mcp__(.+?)__.+$/u

/**
 * The MCP servers the profile mounts as plain dsh-mcp-client rows, derived from the tool names
 * their connected instances register. The MCP manager lists only its own configured and
 * registered servers, so a profile row never appears there, while its tools do appear in the
 * global registry (dsh-mcp-client src/tools.ts:92,177). A tool whose name starts with a managed
 * server's `mcp__<name>__` prefix is skipped, so the two lists never repeat a server whatever
 * its name looks like. A pinned row has no authoritative name: a server whose name ends in `_`
 * or contains `__` is split at its first `__` (a known limit).
 * @param {unknown[]} toolNames - every registered tool's name; non-string entries are ignored.
 * @param {Iterable<string>} managedNames - the servers the MCP manager already reports.
 * @param {number} [limit] - the most server rows to keep; default 50.
 * @returns {Array<{ name: string, configured: true, state: 'pinned', toolCount: number }>}
 */
export function pinnedConnectors(toolNames, managedNames, limit = 50) {
  const claimed = Array.from(managedNames, name => 'mcp__' + name + '__')
  const counts = new Map()
  for (const name of toolNames) {
    if (typeof name !== 'string') continue
    if (claimed.some(prefix => name.startsWith(prefix))) continue
    const match = PINNED_TOOL_PATTERN.exec(name)
    if (match === null) continue
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
  }
  return Array.from(counts, ([name, toolCount]) => ({ name, configured: true, state: 'pinned', toolCount }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .slice(0, limit)
}

/**
 * One bound change request as the Environment tab shows it. The snapshot fields are present only
 * when the forge already polled the request for some watcher; this route never asks for a read.
 * @param {{ url: string, origin: string }} binding - one `forgeChangeRequests` entry.
 * @param {{ number: number }} ref - the provider's reference for the binding's URL.
 * @param {{ snapshot?: object } | null | undefined} update - the forge's latest polling result, if any.
 * @returns {{ url: string, number: number, origin: string, title?: string, state?: string, draft?: boolean, checks?: string, review?: string }}
 */
export function pullRequestView(binding, ref, update) {
  const view = { url: binding.url, number: ref.number, origin: binding.origin }
  const snapshot = update?.snapshot
  if (snapshot !== undefined) {
    view.title = snapshot.title
    view.state = snapshot.state
    view.draft = snapshot.draft
    view.checks = snapshot.checksRollup
    view.review = snapshot.reviewDecision
  }
  return view
}

/**
 * The Environment route's `changes` object from a parsed status. Staged and unstaged count tracked
 * files by their two status letters, so a file changed on both sides counts once in each; an
 * untracked or unmerged file has its own tally and no staged/unstaged change.
 * @param {ReturnType<typeof import('../../host/git.js').parseStatusV2>} parsed - see parseStatusV2.
 * @param {number} [limit] - the most file rows to keep; default 200.
 * @returns {{ upstream: string | null, ahead: number | null, behind: number | null, staged: number, unstaged: number, untracked: number, conflicted: number, total: number, files: object[] }}
 */
export function summarizeChanges(parsed, limit = 200) {
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0
  for (const file of parsed.files) {
    if (file.kind === 'untracked') untracked += 1
    else if (file.kind === 'conflicted') conflicted += 1
    else {
      if (file.index !== '.') staged += 1
      if (file.worktree !== '.') unstaged += 1
    }
  }
  return {
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    staged,
    unstaged,
    untracked,
    conflicted,
    total: parsed.files.length,
    files: parsed.files.slice(0, limit),
  }
}

/** The registry record for a repository, tolerant of hand-edited key case. */
function entryOf(registry, repo) {
  if (registry === null || typeof registry !== 'object') return null
  if (Object.hasOwn(registry, repo)) return recordOf(registry[repo])
  const lowered = repo.toLowerCase()
  for (const [key, value] of Object.entries(registry)) {
    if (key.toLowerCase() === lowered) return recordOf(value)
  }
  return null
}

function recordOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** Split <team-slug>.<KEY> at the last dot; null when either side is empty. */
function projectRefParts(projectRef) {
  if (typeof projectRef !== 'string') return null
  const dot = projectRef.lastIndexOf('.')
  if (dot <= 0 || dot === projectRef.length - 1) return null
  return { teamSlug: projectRef.slice(0, dot), key: projectRef.slice(dot + 1) }
}

/** The KEY-<number> card number a branch carries, with itsaplan's word boundaries. */
function cardNumberOf(branch, key) {
  const pattern = new RegExp('(?<![A-Za-z0-9])' + keyPattern(key) + '-([0-9]+)(?![0-9])', 'iu')
  const match = pattern.exec(branch)
  return match === null ? null : match[1]
}

/** One key as a case-insensitive regular-expression fragment. */
function keyPattern(key) {
  let pattern = ''
  for (const char of key) {
    if (/[a-z]/iu.test(char)) pattern += '[' + char.toLowerCase() + char.toUpperCase() + ']'
    else if (/[0-9]/u.test(char)) pattern += char
    else pattern += char.replace(/[.*+?^$\{\}()|[\]\\]/gu, '\\$&')
  }
  return pattern
}

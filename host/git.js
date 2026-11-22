/**
 * The hardened, read-only git runner and the arguments and parsing both git-reading routes
 * share. A command is never a shell string; it runs through the Host subprocess service with a
 * deadline, bounded output and an environment that keeps it silent and pointed at one folder.
 */
import { serviceOf } from './session.js'

/** How long one git command may run, and the grace its provider gets to stop it. */
const GIT_TIMEOUT_MS = 10_000
const GIT_GRACE_MS = 1_000
const GIT_OUTPUT_BYTES = 64 * 1024
const GIT_STDERR_BYTES = 8 * 1024

/**
 * A dirty tree can be large: the Environment route's one status read gets a 1 MiB bound.
 * `core.fsmonitor=false` keeps status from running a repository's fsmonitor command when it
 * refreshes the index; clean filters such as git-lfs can still run, as they can for the app's own recorder.
 */
export const GIT_STATUS_OUTPUT_BYTES = 1024 * 1024
export const GIT_STATUS_ARGS = ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']

/** The Git routes: a root probe, a short HEAD, and read-only diff/log commands. */
export const GIT_TOPLEVEL_ARGS = ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel']
export const GIT_SHORT_HEAD_ARGS = ['-c', 'core.fsmonitor=false', 'rev-parse', '--short', 'HEAD']
const GIT_DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv']
export const gitNumstatArgs = base => ['-c', 'core.fsmonitor=false', 'diff', ...GIT_DIFF_FLAGS, '--numstat', '-z', base]
export const gitLogArgs = () => ['-c', 'core.fsmonitor=false', 'log', '-n', '20', '--no-color', '--no-show-signature', '--format=%h%x1f%s%x1f%an%x1f%cI%x1e']
export const gitDiffArgs = (base, path) => ['-c', 'core.fsmonitor=false', 'diff', ...GIT_DIFF_FLAGS, base, '--', path]
export const gitConflictArgs = path => ['-c', 'core.fsmonitor=false', 'diff', ...GIT_DIFF_FLAGS, '--', path]

/** The comparison base for a repository without commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** The row page the Git overview serves, and the Host-side untracked-file bounds. */
export const GIT_FILE_LIMIT = 200
export const GIT_FILE_BYTES = 512 * 1024
export const BINARY_PROBE_BYTES = 8 * 1024

/**
 * Run one read-only git command through the Host subprocess service: never a shell string,
 * with a 10 s deadline, and an environment that keeps the command silent, read-only and
 * pointed at `cwd`: no terminal prompt, no optional lock, no inherited
 * `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pairs (`GIT_CONFIG_COUNT=0` makes git ignore them)
 * and no inherited repository location (`GIT_DIR`, `GIT_WORK_TREE`, ...). `options.outputBytes`
 * raises the stdout bound for a command whose answer is expected to be large; a bounded stdout
 * that overflowed answers `undefined` and sets `options.lossy`, so the caller can name the cause.
 * `options.raw` opts out of the trailing-whitespace trim: the diff route needs a trailing blank
 * context line and any trailing spaces intact; every other reader keeps the default trim.
 */
export function gitRunner(ctx) {
  return async function git(args, cwd, options = {}) {
    const subprocess = serviceOf(ctx, 'subprocess')
    if (subprocess === undefined || subprocess === null) return undefined
    let executable
    try {
      executable = await subprocess.resolveExecutable('git')
    } catch {
      return undefined
    }
    const signal = AbortSignal.timeout(GIT_TIMEOUT_MS)
    let handle
    try {
      handle = subprocess.spawn({
        argv: [executable, ...args],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: options.outputBytes ?? GIT_OUTPUT_BYTES },
          stderr: { maxBytes: GIT_STDERR_BYTES },
        },
        graceMs: GIT_GRACE_MS,
        signal,
        env: {
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_CONFIG_COUNT: '0',
          // dsh-subprocess merges this object over the scrubbed parent environment and an
          // explicit undefined removes an inherited entry (README.md:80; src/index.ts:83), so
          // a parent git location cannot point every read at another repository.
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_COMMON_DIR: undefined,
          GIT_CONFIG_PARAMETERS: undefined,
        },
      })
    } catch {
      return undefined
    }
    try {
      const { exitCode } = await handle.done
      if (signal.aborted || exitCode !== 0) return undefined
      const output = handle.collected?.stdout?.readFrom(0)
      if (output === undefined) return ''
      // Bounded output that overflowed keeps only its tail: answer "no result" instead of
      // returning a partial answer that looks complete.
      if (output.lossy === true) {
        options.lossy = true
        return undefined
      }
      return options.raw === true ? output.text : output.text.trim()
    } catch {
      return undefined
    }
  }
}

export function trimPath(value) {
  return value.replace(/[\\/]+$/u, '')
}

export function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 *
 * With `-z` every record ends with NUL, header records start with "# ", and a rename or copy
 * record's original path is the next record. The path is the last fixed-field record field and
 * may contain spaces. A record this parser does not recognize is skipped: the status is evidence
 * for a read-only panel, never a reason to fail the whole answer.
 * @param {unknown} text - the command's stdout, or anything else when it failed.
 * @returns {{ upstream: string | null, ahead: number | null, behind: number | null, files: Array<{ path: string, origPath?: string, index: string, worktree: string, kind: 'staged' | 'unstaged' | 'both' | 'untracked' | 'conflicted' }> }}
 */
export function parseStatusV2(text) {
  if (typeof text !== 'string' || text === '') return { upstream: null, ahead: null, behind: null, files: [] }
  const parsed = { upstream: null, ahead: null, behind: null, files: [] }
  const records = text.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === '') continue
    if (record.startsWith('# ')) {
      const aheadBehind = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record)
      if (aheadBehind !== null) {
        parsed.ahead = Number(aheadBehind[1])
        parsed.behind = Number(aheadBehind[2])
      } else if (record.startsWith('# branch.upstream ')) {
        parsed.upstream = record.slice('# branch.upstream '.length)
      }
      continue
    }
    const type = record[0]
    if (type === '?') {
      const path = record.slice(2)
      if (path !== '') parsed.files.push({ path, index: '?', worktree: '?', kind: 'untracked' })
      continue
    }
    // "!" ignored records and anything unrecognized carry no change the panel shows.
    if (type !== '1' && type !== '2' && type !== 'u') continue
    const fields = record.split(' ')
    // "1" has 8 fixed fields before the path, "2" 9 (its rename score), "u" 10.
    const fixed = type === '1' ? 8 : type === '2' ? 9 : 10
    if (fields.length < fixed + 1) continue
    const xy = fields[1]
    if (typeof xy !== 'string' || xy.length !== 2) continue
    const path = fields.slice(fixed).join(' ')
    if (path === '') continue
    const file = { path, index: xy[0], worktree: xy[1], kind: changeKind(type, xy) }
    if (type === '2') {
      const origPath = records[index + 1]
      if (typeof origPath !== 'string' || origPath === '') continue
      file.origPath = origPath
      index += 1
    }
    parsed.files.push(file)
  }
  return parsed
}

/** The status letters a "1" or "2" record carries, or the unmerged kind a "u" record names. */
function changeKind(type, xy) {
  if (type === 'u') return 'conflicted'
  const staged = xy[0] !== '.'
  const unstaged = xy[1] !== '.'
  if (staged && unstaged) return 'both'
  return staged ? 'staged' : 'unstaged'
}

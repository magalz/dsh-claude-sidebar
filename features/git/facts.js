/**
 * Pure parsers for the Git tab: commit subjects, numstat counts, log records, unified and
 * combined diffs and the Host-side diff of an untracked file. Nothing here touches dsh, the
 * file system or the network: every function takes text the Host routes already read.
 */

/** The Git tab's bounds: a commit subject, the lines parsed from one diff, one file row page. */
export const COMMIT_SUBJECT_LIMIT = 200
export const DIFF_LINE_LIMIT = 2000
const LOG_FIELD_SEP = '\x1f'
const LOG_RECORD_SEP = '\x1e'

/**
 * The branch header of `git status --porcelain=v2 --branch -z`: the short branch name, or
 * null with detached true for a detached HEAD. A status that did not answer is detached.
 * @param {unknown} text - the NUL-separated status output.
 * @returns {{ branch: string | null, detached: boolean }}
 */
export function parseBranchHeader(text) {
  if (typeof text !== 'string') return { branch: null, detached: true }
  const record = text.split('\0').find(item => item.startsWith('# branch.head '))
  if (record === undefined) return { branch: null, detached: true }
  const branch = record.slice('# branch.head '.length)
  return branch === '(detached)' ? { branch: null, detached: true } : { branch, detached: false }
}

/**
 * Parse `git diff --numstat -z HEAD` into counts keyed by the path the status also names.
 * A normal row is `added\tdeleted\tpath\0`; a rename is `added\tdeleted\t\0old\0new\0`,
 * so the new path — the one status reports — is the key. A binary `-` carries null counts.
 * @param {unknown} text - the NUL-separated numstat output.
 * @returns {Map<string, { added: number | null, deleted: number | null, binary: boolean }>}
 */
export function parseNumstat(text) {
  const counts = new Map()
  if (typeof text !== 'string' || text === '') return counts
  const fields = text.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === '') continue
    const parts = field.split('\t')
    if (parts.length < 3) continue
    const [added, deleted, path] = parts
    let key = path
    if (path === '') {
      // Rename or copy: the following two records are the old and the new path.
      const oldPath = fields[index + 1]
      const newPath = fields[index + 2]
      if (typeof oldPath !== 'string' || oldPath === '' || typeof newPath !== 'string' || newPath === '') continue
      key = newPath
      index += 2
    }
    if (key === '') continue
    const binary = added === '-' || deleted === '-'
    if (!binary && (!/^\d+$/u.test(added) || !/^\d+$/u.test(deleted))) continue
    counts.set(key, {
      added: binary ? null : Number(added),
      deleted: binary ? null : Number(deleted),
      binary,
    })
  }
  return counts
}

/**
 * Parse `git log -n 20 --format=%h%x1f%s%x1f%an%x1f%cI%x1e` into the rows the Git tab shows.
 * Subjects past 200 characters are cut: a panel shows a cause, not a wall of text.
 * @param {unknown} text - the log output.
 * @returns {Array<{ hash: string, subject: string, author: string, date: string }>}
 */
export function parseGitLog(text, subjectLimit = COMMIT_SUBJECT_LIMIT) {
  if (typeof text !== 'string' || text === '') return []
  const commits = []
  for (const record of text.split(LOG_RECORD_SEP)) {
    const value = record.replace(/^\n+/u, '')
    if (value === '') continue
    const [hash, subject, author, date] = value.split(LOG_FIELD_SEP)
    if (typeof hash !== 'string' || hash === '') continue
    commits.push({
      hash,
      subject: (subject ?? '').slice(0, subjectLimit),
      author: author ?? '',
      date: date ?? '',
    })
  }
  return commits
}

/**
 * Parse a unified or combined (`git diff --cc`) diff into hunks of context/add/del/note
 * lines. A `Binary files … differ` answer has no hunk. Parsing stops after 2000 lines:
 * exactly 2000 is complete, and only a further line sets `truncated`.
 * @param {unknown} text - the diff output.
 * @param {number} [limit] - the most parsed lines to keep; default 2000.
 * @returns {{ binary: boolean, hunks: Array<{ header: string, lines: object[] }>, truncated: boolean }}
 */
export function parseUnifiedDiff(text, limit = DIFF_LINE_LIMIT) {
  const result = { binary: false, hunks: [], truncated: false }
  if (typeof text !== 'string' || text === '') return result
  if (/^Binary files .+ differ$/mu.test(text) || text.startsWith('GIT binary patch')) {
    result.binary = true
    return result
  }
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u
  const combinedHeader = /^@@@ -\d+(?:,\d+)? -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@@/u
  let current = null
  let oldLine = 0
  let newLine = 0
  let combined = false
  let count = 0
  for (const line of text.split('\n')) {
    const header = hunkHeader.exec(line)
    const combinedMatch = combinedHeader.exec(line)
    if (header !== null || combinedMatch !== null) {
      combined = combinedMatch !== null
      oldLine = combined ? 0 : Number(header[1])
      newLine = Number(combined ? combinedMatch[1] : header[3])
      current = { header: line, lines: [] }
      result.hunks.push(current)
      continue
    }
    if (current === null || line === '') continue
    let entry
    if (line.startsWith('\\')) {
      entry = { type: 'note', text: line, old: null, new: null }
    } else if (combined) {
      // A combined line has two prefix columns; a '+' in either means an added line.
      const first = line[0]
      const second = line[1]
      const value = line.slice(2)
      if (first === '+' || second === '+') entry = { type: 'add', text: value, old: null, new: newLine }
      else if (first === '-' || second === '-') entry = { type: 'del', text: value, old: null, new: null }
      else entry = { type: 'context', text: value, old: null, new: newLine }
    } else if (line.startsWith(' ')) {
      entry = { type: 'context', text: line.slice(1), old: oldLine, new: newLine }
    } else if (line.startsWith('+')) {
      entry = { type: 'add', text: line.slice(1), old: null, new: newLine }
    } else if (line.startsWith('-')) {
      entry = { type: 'del', text: line.slice(1), old: oldLine, new: null }
    } else {
      continue
    }
    if (count >= limit) {
      result.truncated = true
      break
    }
    current.lines.push(entry)
    count += 1
    if (entry.type === 'context' || entry.type === 'add') newLine += 1
    if (!combined && (entry.type === 'context' || entry.type === 'del')) oldLine += 1
  }
  return result
}

/**
 * The Host-side diff of an untracked file: one all-add hunk numbered 1..N, since there is
 * no HEAD version to diff against. The file's bytes are read and bounded by the Host.
 * @param {unknown} text - the file's bytes decoded as text.
 * @param {number} [limit] - the most lines to keep; default 2000.
 * @returns {{ binary: boolean, hunks: Array<{ header: string, lines: object[] }>, truncated: boolean }}
 */
export function untrackedDiff(text, limit = DIFF_LINE_LIMIT) {
  const lines = typeof text === 'string' && text !== '' ? text.split('\n') : []
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const hunk = { header: '@@ -0,0 +1,' + lines.length + ' @@', lines: [] }
  for (let index = 0; index < Math.min(lines.length, limit); index += 1) {
    hunk.lines.push({ type: 'add', text: lines[index], old: null, new: index + 1 })
  }
  return { binary: false, hunks: lines.length > 0 ? [hunk] : [], truncated: lines.length > limit }
}

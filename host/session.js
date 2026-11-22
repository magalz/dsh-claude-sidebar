/** Session-list lookup shared by the Environment and Git routes. */
import { isAbsolute } from 'node:path'

/** How long the session list read may take. */
const SESSION_LIST_TIMEOUT_MS = 5_000

/** The session-list row for one id, or null when the id names no session. */
export async function sessionRow(ctx, sessionId) {
  const controller = serviceOf(ctx, 'sessionController')
  if (controller === undefined || controller === null) throw new Error('sessionController is not mounted')
  const result = await controller.list({}, AbortSignal.timeout(SESSION_LIST_TIMEOUT_MS))
  const items = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : []
  return items.find(item => item !== null && typeof item === 'object' && item.sessionId === sessionId) ?? null
}

/**
 * The session's live working directory, or null when its row carries none. A row names two
 * folders: `cwd` is where the session was created, and the `workingDirectory` summary projection
 * is where it works now, following the session after the user moves it. The projection wins when
 * it is an absolute path; otherwise the creation folder is the only folder the row knows.
 */
export function cwdOf(row) {
  const projected = row?.projections?.values?.workingDirectory
  if (typeof projected === 'string' && projected !== '' && isAbsolute(projected)) return projected
  const cwd = row?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/** An optional Host service; a direct ctx.<name> read throws when the plugin did not inject it. */
export function serviceOf(ctx, name) {
  return typeof ctx.get === 'function' ? ctx.get(name) : undefined
}

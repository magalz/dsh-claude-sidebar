/** Redaction of the diagnostic text a Host route may put in an error answer. */

/** The most error text one connector or one failed section reports; a panel shows a cause, not a stack. */
export const MESSAGE_LIMIT = 200

/** A web URL inside diagnostic text. */
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu

/**
 * Remove credentials and volatile parts from the web URLs in a diagnostic string: the URL's
 * userinfo, query string and fragment go, everything else stays. Text without a URL is returned
 * unchanged, and nothing is parsed, so a malformed URL cannot throw here.
 * @param {string} text - diagnostic text that may carry a server URL.
 * @returns {string}
 */
export function redactUrls(text) {
  return text.replace(URL_PATTERN, redactUrl)
}

/** Drop one URL's userinfo, query and fragment without normalizing the rest of it. */
function redactUrl(url) {
  const schemeEnd = url.indexOf('://') + 3
  const rest = url.slice(schemeEnd)
  const authorityEnd = rest.search(/[/?#]/u)
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd)
  const at = authority.lastIndexOf('@')
  const host = at === -1 ? authority : authority.slice(at + 1)
  const path = authorityEnd === -1 ? '' : rest.slice(authorityEnd).split(/[?#]/u)[0]
  return url.slice(0, schemeEnd) + host + path
}

/** The message of a thrown value, without its stack. */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one section of a route answer; a throw becomes that section's fallback and a short,
 * redacted message. Used by both the Environment and the Git routes so one failing read leaves
 * the rest of the answer usable.
 */
export async function isolated(errors, section, fallback, compute) {
  try {
    return await compute()
  } catch (error) {
    errors[section] = redactUrls(messageOf(error)).slice(0, MESSAGE_LIMIT)
    return fallback
  }
}

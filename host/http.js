/**
 * The loopback guard and the JSON reply shared by every Host route of this package.
 * The shape follows dsh-session-console lib/index.js:75-117.
 */

/** Loopback hostname, as dsh-session-console lib/index.js:83-86 defines one. */
function isLoopbackHostname(hostname) {
  const name = String(hostname).toLowerCase().replace(/^\[|\]$/gu, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/** Reject requests whose Host header does not name this loopback listener (index.js:88-94). */
function hostTrusted(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return true
  return isLoopbackHostname(host.replace(/:\d+$/u, ''))
}

/** Reject cross-site browser origins; same-origin GETs carry no Origin header (index.js:96-105). */
function originTrusted(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    return isLoopbackHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

export function guard(req, res) {
  if (!hostTrusted(req)) {
    reply(res, 403, { error: 'host-not-trusted' })
    return false
  }
  if (!originTrusted(req)) {
    reply(res, 403, { error: 'origin-not-trusted' })
    return false
  }
  return true
}

/** JSON answer with no caching, the shape dsh-session-console lib/index.js:75-80 writes. */
export function reply(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

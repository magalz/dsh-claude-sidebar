/**
 * The guards and the JSON reply shared by every Host route of this package: loopback Host,
 * cross-site Origin and dsh's own Connection access check. The loopback and reply shape follow
 * dsh-session-console lib/index.js:75-117; the Connection gate follows
 * dsh-subagent-panel-plus host.js:63-83 and fails closed when the service is not mounted.
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

/**
 * Refuse a request before any route reads data: Host, then Origin, then dsh's Connection gate
 * (dsh-subagent-panel-plus host.js:63-83). A numeric rejection keeps its status; any other
 * rejection answers 403. Returns false after answering, so the route just returns.
 * @param {object} ctx - the Host plugin context, which mounts `connection` as a service.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} whether the request may continue.
 */
export function guard(ctx, req, res) {
  if (!hostTrusted(req)) {
    reply(res, 403, { error: 'host-not-trusted' })
    return false
  }
  if (!originTrusted(req)) {
    reply(res, 403, { error: 'origin-not-trusted' })
    return false
  }
  const gate = ctx.get('connection')
  if (typeof gate?.requestRejection !== 'function') {
    reply(res, 503, { error: 'connection service is not mounted' })
    return false
  }
  const rejection = gate.requestRejection(req)
  if (rejection !== undefined && rejection !== null && rejection !== false) {
    reply(res, typeof rejection === 'number' ? rejection : 403, { error: 'request rejected' })
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

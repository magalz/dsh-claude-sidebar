/**
 * Root row of the Claude sidebar package. It carries the one browser half and serves the list
 * of Host features that are switched on, so the client can mount only those features. Every
 * feature has its own row; turning this one off turns all of them off.
 */
import { getFeatures } from './host/features.js'
import { guard, reply } from './host/http.js'

export const name = 'claude-sidebar'
export const inject = ['webServer']

/** The route the browser half reads once at start to see which features are on. */
export const FEATURES_ROUTE = '/dsh-claude-sidebar/features'

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: FEATURES_ROUTE, handler: createFeaturesHandler(ctx) }), 'claude-sidebar: features route')
}

/** Build the features route handler; the shared guard needs the Host context for its Connection service. */
function createFeaturesHandler(ctx) {
  return function handler(req, res) {
    if (!guard(ctx, req, res)) return
    if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' })
    reply(res, 200, { features: getFeatures() })
  }
}

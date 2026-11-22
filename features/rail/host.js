/** Loader row for the sidebar's icon rail; the browser half does the work. */
import { enableFeature } from '../../host/features.js'

export const name = 'claude-sidebar-rail'
export const inject = []

export function apply(ctx) {
  enableFeature(ctx, 'rail')
}

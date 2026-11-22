/** Loader row for the sidebar's Subagents tab; the browser half does the work. */
import { enableFeature } from '../../host/features.js'

export const name = 'claude-sidebar-subagents'
export const inject = []

export function apply(ctx) {
  enableFeature(ctx, 'subagents')
}

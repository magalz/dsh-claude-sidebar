/** Loader row for the sidebar's Jobs tab; the browser half does the work. */
import { enableFeature } from '../../host/features.js'

export const name = 'claude-sidebar-jobs'
export const inject = []

export function apply(ctx) {
  enableFeature(ctx, 'jobs')
}

/** Loader row for the sidebar's automatic pane sizes; the browser half does the work. */
import { enableFeature } from '../../host/features.js'

export const name = 'claude-sidebar-sizing'
export const inject = []

export function apply(ctx) {
  enableFeature(ctx, 'sizing')
}

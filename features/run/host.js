/** Loader row for the Run button on chat code blocks; the browser half does the work. */
import { enableFeature } from '../../host/features.js'

export const name = 'claude-sidebar-run'
export const inject = []

export function apply(ctx) {
  enableFeature(ctx, 'run')
}

/**
 * Host row for the Environment tab. It owns only the row's identity, its Settings fields and
 * the wiring to the route; the route itself lives in route.js, which has no app imports so the
 * tests can load it without dsh installed.
 */
import z from '@deepseek-ai/schemastery'
import { enableFeature } from '../../host/features.js'
import { installEnvironment } from './route.js'

export const name = 'claude-sidebar-environment'
export const inject = ['webServer']

/**
 * The row's Settings fields: the private task facts stay off until the person turns them on.
 * All three are volatile, which is what makes them appear on dsh 0.2's Settings page and lets a
 * write land without a restart. In `apply` they arrive as live references; route.js unwraps them.
 */
export const Config = z.object({
  taskFacts: z.boolean().default(false).description('Show task facts: the tracker card named by the branch and the work tree\'s progress file').volatile(),
  trackerUrl: z.string().default('').description('Tracker web address used for card links, e.g. https://tracker.example.com; leave empty for cards without links').volatile(),
  registryPath: z.string().default('').description('Path of the itsaplan link registry; empty means ~/.claude/itsaplan/links.json').volatile(),
})

/**
 * Install the feature and its route with the validated config.
 * @param {object} ctx - Host plugin context.
 * @param {object} config - the validated row config.
 */
export function apply(ctx, config) {
  enableFeature(ctx, 'environment')
  installEnvironment(ctx, config)
}

/** Host row: register the open_in_browser tool on the tools service. */
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { enableFeature } from '../../host/features.js'
import { openInBrowserTool } from './core.js'

export const name = 'claude-sidebar-browser'
export const inject = ['tools']

/**
 * Install the tool in its own plugin row, so a failed import cannot take down
 * the sidebar tabs.
 * @param {object} ctx - Host plugin context.
 */
export function apply(ctx) {
  enableFeature(ctx, 'browser')
  ctx.tools.register(defineTool(openInBrowserTool({
    argsError: message => new ToolArgsError([message]),
  })))
}

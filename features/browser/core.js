/**
 * Address parsing and the tool definition for the Browser-tab tool.
 * No app imports here, so tests can load this module without dsh installed.
 */

/** Maximum accepted address length; this bounds the Browser tab's navigation state. */
const MAX_OPEN_URL_LENGTH = 16 * 1024

/** An explicit scheme, but not a host:port (the Browser tab's own detector). */
const EXPLICIT_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u

const DESCRIPTION = "Open a web page for the person in a Browser tab of the right sidebar in their dsh window, in this session. Use it to show them a page (documentation, a local dev server, a pull request). It does not return the page's content; use web_fetch to read a page."

const PARAM_DESCRIPTION = 'http or https address; localhost allowed; an address without a scheme gets https://'

/** What the model reads for each refusal reason, so it can correct the address. */
const REFUSALS = {
  empty: 'url is empty',
  invalid: 'url is not a valid address or is longer than 16 KiB',
  protocol: 'url must use http or https',
  credentials: 'url must not contain a user name or password',
}

/**
 * Parse one address into the Browser tab's HTTP(S) allowlist.
 * @param {string} input - the address the model supplied.
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }} the canonical href or the refusal reason.
 */
export function parseOpenUrl(input) {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  if (trimmed.length > MAX_OPEN_URL_LENGTH) return { ok: false, reason: 'invalid' }
  const candidate = EXPLICIT_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`
  let url
  try { url = new URL(candidate) } catch { return { ok: false, reason: 'invalid' } }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'protocol' }
  return { ok: true, url: url.href }
}

/**
 * Build the options passed to `defineTool` for `open_in_browser`.
 * @param {{ argsError?: (reason: string) => Error }} options - builder for the tools package's argument error.
 * @returns {object} the tool definition options.
 */
export function openInBrowserTool({ argsError = message => new Error(message) } = {}) {
  return {
    name: 'open_in_browser',
    description: DESCRIPTION,
    parameters: {
      url: { type: 'string', required: true, description: PARAM_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { url: { type: 'string', required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Asked the person's dsh window to open ${value.url} in a Browser tab. It opens when this session is on screen.`,
      }],
    },
    async execute(args) {
      const parsed = parseOpenUrl(args.url)
      if (!parsed.ok) throw argsError(REFUSALS[parsed.reason] ?? 'url was refused: ' + parsed.reason)
      return { url: parsed.url }
    },
  }
}

# Contributing

Thanks for helping improve dsh-claude-sidebar.

## Requirements

- Node.js 22 or newer.
- No dependencies to install.

## Commands

Available once the plugin source (and its `package.json`) is in the repository:

- `npm test` runs the `node:test` suites. They use fakes only and do not start a dsh process.
- `npm run build` regenerates `client.js` from the sources. **Never edit `client.js` by hand** — it is generated.
- `npm run check` verifies the syntax of the shipped files and that `client.js` is not stale.

## Pull requests

- Keep pull requests small and focused on one change.
- Describe what changed and why.
- Add or update tests for the behavior you change. For behavior changes, write the test first.
- Keep all UI text in English.
- If you change a source file, regenerate `client.js` in the same commit.

## Trying a change in dsh

Install this checkout as a local plugin from **Settings → Plugins → Add plugin**, or run `dsh plugin add <path>`. JavaScript changes take effect after restarting dsh.

## Reporting bugs and security issues

Use the issue templates to report bugs or request features. Do not report security issues in a public issue; see [SECURITY.md](SECURITY.md) for private reporting.

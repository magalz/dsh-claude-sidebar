## What and why

<!-- What changes, and why it belongs here. One or two sentences. -->

Fixes DCS-<n>

## Checklist

- [ ] Every commit carries `Refs: DCS-<n>` for an existing card, and this body closes it with `Fixes DCS-<n>`.
- [ ] Commit subjects use Conventional Commits; every commit has a DCO `Signed-off-by:` line.
- [ ] `npm test` and `npm run check` pass locally.
- [ ] Behavior changes have new or updated tests.
- [ ] Documentation is updated when behavior or UI changed.
- [ ] If a source file changed, `client.js` was regenerated in the same commit (`npm run build`), never edited by hand.

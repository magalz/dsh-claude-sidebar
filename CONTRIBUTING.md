# Contributing to dsh-claude-sidebar

Thanks for considering a contribution. This guide explains how work is organized here: how to pick it up, how it is reviewed, and what is expected before merge. Following it respects the time of the people who review your change.

## Contents

- [Ways to contribute](#ways-to-contribute)
- [Before you start](#before-you-start)
- [Development setup](#development-setup)
- [Conventions](#conventions)
- [Pull request lifecycle](#pull-request-lifecycle)
- [Review and approval](#review-and-approval)
- [Checklist](#checklist)
- [Sign your commits](#sign-your-commits)
- [Bugs and security](#bugs-and-security)

## Ways to contribute

- **Code** — the sidebar rail, the Environment/Git/Jobs/Subagents tabs, the Run button, or pane sizing.
- **Documentation** — README, developer docs, and this guide.
- **Bug reports and triage** — reproduce an issue, add detail, confirm duplicates.
- **Reviews** — reviewing someone else's pull request is a contribution too.
- **Translations** — the strings under `locale/`.

The plugin is intentionally focused on the local dsh session. Changes that make it call external services, run commands without the user asking, or change the host/browser boundary need an issue and agreement first.

## Before you start

- For anything larger than a typo or an obvious fix, open an issue first: describe the problem, the intended change, and why it belongs here.
- Every change in this repository is tracked by a card in the itsaplan project `ignis-dev.DCS`. Create the card **before** you commit and name it in a `Refs: DCS-N` trailer; a commit without an existing card is not accepted.
- Comment on the issue or card to say you are taking it, so two people do not do the same work.
- Issues labeled `good first issue` and `help wanted` are good starting points.
- If you get stuck, ask in the issue. Include what you tried, your OS, and your dsh version.

## Development setup

Requirements: Node.js 22 or newer. No dependencies to install.

| Command | What it does |
| --- | --- |
| `npm test` | `node --test` suites. Fakes only, no dsh process. |
| `npm run build` | Regenerates `client.js` from `client/shared.js` and `features/*/client/`. |
| `npm run check` | Syntax checks the shipped files and verifies `client.js` is not stale. |

To try a change in dsh, install this checkout as a local plugin from **Plugins → Add plugin** with its absolute path. JavaScript changes take effect after restarting dsh. (For a published package, the CLI form is `dsh plugin --profile <name> add <package>`.) `client.js` is generated from `client/shared.js` and `features/*/client/`. **Never edit `client.js` by hand** — change the sources and regenerate it in the same commit.

## Conventions

- **Branches:** `<type>/<short-slug>` or `<type>/DCS-<n>-<slug>` when a card exists, for example `docs/DCS-12-contribution-guide`. One change per branch.
- **Commit messages:** [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- **Card trailer:** every commit must end with `Refs: DCS-N` for an existing card. In the pull request body, use the closing word `Fixes DCS-N` so the webhook closes the card when the PR merges.
- Keep all UI text in English.
- Behavior changes come with tests. Write the failing test first where practical.
- If you change a source file, regenerate `client.js` in the same commit.

## Pull request lifecycle

- Open a draft PR early if you want feedback; mark it ready for review once the checklist passes.
- Keep pull requests small and focused on one change. Say what changed and why.
- Expect first feedback within about 7 days. If nothing arrives after that, ping the reviewer in the PR.
- Respond to review feedback within two weeks. After four weeks without activity we may close the pull request or pick it up.
- If you no longer want to finish, say so in the PR — we will close it or take it over.
- Merged work ships from `main`; release tags are cut separately by the maintainer.

## Review and approval

- `.github/CODEOWNERS` assigns `@magalz` to every file, so GitHub requests a review automatically for pull requests opened by other contributors.
- The policy is **one approving review from a code owner plus a green `CI result` run** before merge. Reviews should be specific and kind: comment on the line, not the person.
- GitHub does not count the author's own approval. Today branch protection enforces the pull request, the `CI result` status, and resolved conversations; the approval count is a documented policy until a maintainer enables it in branch protection after a second approver has write access.
- The author does not merge their own pull request while another reviewer is available.

## Checklist

- [ ] The change is small, focused, and the description explains why.
- [ ] The PR body closes the card (`Fixes DCS-N`) and every commit carries `Refs: DCS-N`.
- [ ] `npm test` and `npm run check` pass locally.
- [ ] Behavior changes have new or updated tests.
- [ ] Documentation is updated when behavior or UI changed.
- [ ] If a source file changed, `client.js` was regenerated in the same commit.
- [ ] Every commit has a DCO `Signed-off-by` line.
- [ ] The `CI result` run is green before merge.

## Sign your commits

We use the [Developer Certificate of Origin](https://developercertificate.org/) (DCO), not a contributor license agreement. Add a sign-off to every commit with `git commit -s`. Separately, every commit in this repository also carries the itsaplan card trailer:

```text
Signed-off-by: Jane Doe <jane@example.com>
Refs: DCS-12
```

By signing you certify that you wrote the contribution or otherwise have the right to submit it under this repository's license. A reviewer will ask for a sign-off if one is missing.

## Bugs and security

Use the issue templates to report bugs or request features. Never report a vulnerability in a public issue — use GitHub's **Report a vulnerability** link on the Security tab and see [SECURITY.md](SECURITY.md).

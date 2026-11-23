# Publication follow-ups

Work done right after the awesome-dsh-plugin submission on 2026-11-23, recorded with its
tracker cards. The commits below landed through automated publication follow-ups before
their cards existed; the reference pull request that carries this document names the cards
and closes them.

| Card | Work | Landed as |
|---|---|---|
| DCS-10 | `package.json` kept `"private": true` from local development; the readiness standard lists `private: false` among the publishing fields. | PR #3, commit `b3fd08d` |
| DCS-11 | The dsh-tools peer range and `engines.dsh` silently excluded any prerelease on a tuple other than 0.2.2 under node-semver; both now carry an explicit prerelease branch, and the README quotes the new range. | PR #4, commit `7f9afde` |

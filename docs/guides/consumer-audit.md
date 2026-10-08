# The consumer audit

No footprintjs release tags until every family consumer passes its own checks against the release candidate.

**Why.** hcifootprint 2.6.0 (`footprintjs ^9.10.1`) broke on every fresh install after footprintjs 9.36 removed `/advanced` internals it imported, and nobody noticed for weeks. footprintjs's own suite cannot see what a consumer imports; only the consumer's checks can.

**The four pieces.**

| Piece | Job |
|---|---|
| `scripts/family.json` | The one list: each consumer's repo, default branch, whether it is published, its checks and any setup it needs. `scripts/audit-family-versions.mjs` reads it too. |
| `scripts/audit-consumers.mjs` | Audits consumers against a candidate tarball. CI runs it once per consumer; you can run it locally. |
| `.github/workflows/consumers.yml` | On every PR to main and on demand: packs the candidate, then one job per consumer. |
| `scripts/release.sh`, gate 1b | Refuses to tag unless the latest `consumers.yml` run for HEAD's exact commit is green. |

## How a consumer is judged

For each consumer, in a fresh workspace where `footPrint` links to the footprintjs tree:

1. Clone its default branch, and any sibling checkout it needs, then `npm ci` (or `npm install` when it commits no lockfile).
2. Swap footprintjs for the candidate tarball with `npm install --no-save`, and run the consumer's checks.
3. If a step is red, run the same steps again on the published footprintjs (`npm view footprintjs version`).

| Candidate | Published footprintjs | Verdict | Blocks the release |
|---|---|---|---|
| all green | not run | `pass` | no |
| red | red on every step that is red on the candidate | `own failure`: the consumer is broken without this change | no; a warning on the run |
| red | green on a step that is red on the candidate | `BLOCKING` | yes: the job fails |
| could not clone or install the consumer | — | `no verdict` | yes: re-run the job; if it persists, the consumer's main is broken |

Each consumer job writes its table to the run's summary page. A `BLOCKING` consumer adds an error annotation, and an `own failure` adds a warning naming the red steps.

The rule compares steps, not single tests. While a consumer is red on its own, a new failure inside that same step cannot be seen, so fix an `own failure` promptly.

Each job also counts the consumer's imports from `footprintjs/advanced`. *Record symbols* are the ones `/advanced` hands out from `memory/` and `ids/`, plus `ExecutionRuntime` and `ScopeFacade`. The count is a measurement only, never a gate: it tracks the consumers' move to the record's own doors.

## Releasing

A merge commit, or a commit pushed straight to main, has no PR run of its own. Before `npm run release:<bump>`:

```bash
git push
gh workflow run consumers.yml --ref main               # about 15 minutes
gh run list --workflow consumers.yml --commit "$(git rev-parse HEAD)"
```

When the run is green, release. When it is red, open it: a `BLOCKING` consumer means this commit breaks it.

## Running it locally

```bash
npm run audit:consumers -- --local                      # your checkouts beside this repo
npm run audit:consumers -- --local --only hcifootprint  # one consumer
npm run audit:consumers -- --candidate ./footprintjs-x.tgz --only hcifootprint   # a given tarball, from GitHub
```

`--local` clones the checkouts under the org root (this repository's parent directory, or `--org <dir>`) into a temporary workspace and never touches them. A local checkout can be stale, so the script prints how far each one is behind its last-fetched origin. The CI run is the gate. Without `--candidate`, the script builds and packs this tree. A consumer with `apt` needs those tools on your PATH (storyreel needs `ffmpeg`).

## Adding a consumer

Add an entry to `scripts/family.json`:

```json
{
  "package": "my-consumer",
  "repo": "footprintjs/my-consumer",
  "branch": "main",
  "dir": "my-consumer",
  "published": true,
  "checks": ["npm run typecheck", "npm test"]
}
```

- `checks` are the consumer's own commands, run in order in its checkout. Every entry with `checks` is audited.
- `apt`: Ubuntu packages its checks need (CI installs them; locally they must be on PATH).
- `siblings`: checkouts it expects beside it (`{ repo, branch, dir, setup }`). Each is cloned and set up before the consumer installs, and any sibling that installs footprintjs gets the same swap.
- `registry`: family packages it links by `file:` path that should come from npm instead.
- `note`: why the setup is what it is.

Then run `npm run audit:consumers -- --only my-consumer` and open a PR. The PR's `Consumers` run shows the new job.

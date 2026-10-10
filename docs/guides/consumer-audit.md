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

1. Clone its default branch, and any sibling checkout it needs, then `npm ci` (or `npm install` when it commits no lockfile) and the entry's `setup`.
2. In the disposable checkout only, save exact concrete dependency replacements for footprintjs and any configured registry pins, retaining the original peer requirements. Install producer siblings in their configured order, then the consumer, so linked metadata describes the replacements. Verify Foottrace installation identity in the consumer and its siblings, then run the consumer's checks.
3. If a step is red, run the same steps again on the published footprintjs (`npm view footprintjs version`) — unless the entry says `fallback: false`.

| Candidate | Published footprintjs | Verdict | Blocks the release |
|---|---|---|---|
| all green | not run | `pass` | no |
| red | red on every step that is red on the candidate | `own failure`: the consumer is broken without this change | no; a warning on the run |
| red | green on a step that is red on the candidate | `BLOCKING` | yes: the job fails |
| red, and the entry says `fallback: false` | not run | `BLOCKING` | yes: the job fails |
| could not clone or install the consumer | — | `no verdict` | yes: re-run the job; if it persists, the consumer's main is broken |

Each consumer job writes its table to the run's summary page. A `BLOCKING` consumer adds an error annotation, and an `own failure` adds a warning naming the red steps.

The rule compares steps, not single tests. While a consumer is red on its own, a new failure inside that same step cannot be seen, so fix an `own failure` promptly.

The original dependency fields and ranges are retained across both audit legs and printed in the
report. Only concrete dependency declarations for footprintjs and the entry's configured `registry`
packages may change in the disposable manifest. A peer-only or undeclared package receives an
audit-only dev dependency; all peer requirements, unrelated declarations and manifest metadata are
checked against the original. Before changing any target, the audit's development-only `semver`
helper validates every intended version against its original peer requirement, including registry
pins. Invalid or incompatible requirements fail installation without changing a manifest. This is
explicit because npm can hide an incompatible peer behind that same package's dev dependency,
even when `npm ls` succeeds; the audit never widens the peer to make a candidate pass.
The exact candidate version is read from its archive manifest; the tarball is then selected with
`npm install --no-save` without rewriting peers. After every sibling and consumer has installed,
the audit verifies all selected sources in npm's installed-tree lock metadata (the exact canonical
archive path, or the published registry version), so a parent installation cannot silently replace
a sibling's candidate. Saving the exact version makes the manifest describe the installed candidate
honestly: leaving a `file:` declaration behind with `--no-save` makes npm correctly report the
replacement as invalid.
The planned requirement is a version, not an archive path: npm's graph for an external linked
sibling omits the child's archive resolution metadata, although its own installed-tree lock retains
that evidence. `npm install --save <tarball>` would also replace a matching peer requirement with an
invalid `file:` comparator.
These temporary audit overrides do not prove that a consumer's original ranges accept the candidate
and never change the source checkout. A declared local sibling must also exist, even if application
code never imports it: agent-playground therefore installs the real agent-samples sibling after
agentfootprint.

Each job also counts the consumer's imports from `footprintjs/advanced`. Record symbols are identified
by their original declaration in the extraction inventory, preserved in `scripts/trace-extraction.json`.
That historical inventory remains available after the current FootPrint doors remove those exports;
an old consumer import must not become a false zero. Engine-frame construction is reported separately.

The extraction branch remains a candidate, not a release. After E4 it installs published
`foottrace ^1.0.0` through the ordinary npm dependency resolver. Consumer `main` branches migrate
in E5; their pre-migration failures against this major candidate remain blocking evidence for E6.
The engine's own tests do not stand in for that consumer audit.

`scripts/foottrace-install.mjs` checks the actual npm dependency graph on both candidate and
published legs. Missing, invalid, conflicting, or physically duplicated foottrace installations
fail the install step. Linked siblings must resolve the same real package directory; equal
version strings alone do not prove shared class identity. A pre-extraction graph with no
foottrace dependency is reported as `NOT APPLICABLE`. The audit does not inject or relink Foottrace
to make this check pass.

The E3 source pin, archive provenance checks, bootstrap helper and its five temporary tests were
retired after publication. Those tests specified an unpublished-package workflow: exact source
pins and local archive identities are no longer installation requirements, and the audit no
longer creates links to force one shared copy. The duplicate-copy rejection remains covered by
the installed-dependency audit and its regression tests. Record behavior remains covered by the
existing engine integration tests and unchanged byte fixtures; the record implementation and
its own security regression matrix remain in Foottrace.

## Releasing

A merge commit, or a commit pushed straight to main, has no PR run of its own. Before `npm run release:<bump>`:

```bash
git push
gh workflow run consumers.yml --ref main               # about 11 minutes; agentfootprint's suite is most of it
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
- `install`: replaces the default `npm ci` / `npm install`. `setup`: one command run after the install, such as a browser download its tests need.
- `siblings`: checkouts it expects beside it (`{ repo, branch, dir, setup }`). Each is cloned and set up before the consumer installs, and any sibling that installs footprintjs gets the same swap.
- `registry`: family packages it links by `file:` path that should come from npm instead.
- `fallback: false`: no second leg on the published footprintjs, so any red step blocks. For a consumer on a same-train migration `branch` (plan §4, `docs/design/2026-10-trace-extraction.md`): its branch builds only on the candidate, so the published leg is red by construction, and "red on both" would read a real failure as an `own failure`. It goes back with the branch.
- `note`: why the setup is what it is.

Then run `npm run audit:consumers -- --only my-consumer` and open a PR. The PR's `Consumers` run shows the new job.

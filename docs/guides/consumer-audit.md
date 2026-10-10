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

1. Clone its default branch and any declared sibling checkouts. Capture authored manifests before installation or setup. Runtime-linked siblings retain their existing setup; source-only siblings are never independently installed.
2. Plan only the named candidate/registry replacements, retaining original peer requirements. The packaged strategy applies that plan before the first install; the linked strategy retains its producer-first preparation. Verify every selected source, archive integrity and complete installed graph, then run setup and the consumer's checks.
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
For runtime-linked installations, the exact candidate version is read from its archive manifest; the tarball is then selected with
`npm install --no-save` without rewriting peers. After every sibling and consumer has installed,
the audit verifies all selected sources in npm's installed-tree lock metadata (the exact canonical
archive path and SHA-512 integrity, or the published registry version), so a parent installation cannot silently replace
a sibling's candidate. Saving the exact version makes the manifest describe the installed candidate
honestly: leaving a `file:` declaration behind with `--no-save` makes npm correctly report the
replacement as invalid.
For that linked strategy, the planned requirement is a version, not an archive path: npm's graph for an external linked
sibling omits the child's archive resolution metadata, although its own installed-tree lock retains
that evidence. `npm install --save <tarball>` would also replace a matching peer requirement with an
invalid `file:` comparator.
These temporary audit overrides do not prove that a consumer's original concrete ranges accept the
candidate and never change the source checkout. Peer compatibility is explicitly checked. An
unrelated local declaration remains untouched and must resolve normally; missing dependencies are
not removed to make an install pass.

### Packaged applications and source-only examples

`installStrategy: "packaged"` uses the same single dependency boundary as the playgrounds' CI.
The common plan preserves authored manifests and peers, but materializes exact `file:` archive
requests for the candidate and exact versions for declared registry overrides **before** installation.
It runs scoped `npm update --package-lock-only --strict-peer-deps <named packages>`, then ordinary
`npm ci --strict-peer-deps`. Neither command rewrites peers; the resulting manifest must match the
plan exactly. A lock-only `--no-save` install is not interchangeable: it can retain an old lock, and
`--save` can remove a matching peer. Both failures have real-npm regression tests.

AgentFootprint in agent-playground is a `sourceOnly: true` sibling: its examples are read, while
its runtime, Lens and UI are published packages in the application's tree. As in the app's CI,
the common workspace's `node_modules` points to the app's **complete** installed tree. This is not
a Foottrace-specific alias or a way to conceal duplicates. Source-only siblings must contain no
independent `node_modules` (including nested ones) or source symlinks; existing conflicting or broken
workspace links are refused before installing. After each leg their engine/record resolution must
match the app's physical owners. Only the app is an install root, and its complete `npm ls` and
one-Foottrace checks still run. The removed, unused agent-samples dependency is not reconstructed.

Runtime-linked siblings, such as Viz's storydeck, keep the producer-first strategy and the strict
whole-workspace identity check. Packaged and runtime-linked strategies cannot be mixed in one entry.

Each job also counts the consumer's imports from `footprintjs/advanced`. Record symbols are identified
by their original declaration in the extraction inventory, preserved in `scripts/trace-extraction.json`.
That historical inventory remains available after the current FootPrint doors remove those exports;
an old consumer import must not become a false zero. Engine-frame construction is reported separately.

The extraction branch remains a candidate, not a release. After E4 it installs published
`foottrace ^1.0.0` through the ordinary npm dependency resolver. Consumer `main` branches migrate
in E5; their pre-migration failures against this major candidate remain blocking evidence for E6.
The engine's own tests do not stand in for that consumer audit.

The E3 source pin, archive provenance checks, bootstrap helper and its five temporary tests were
retired after publication. Those tests specified an unpublished-package workflow: exact source
pins and local archive identities are no longer installation requirements, and the audit no
longer creates links to force one shared copy. The duplicate-copy rejection remains covered by
the installed-dependency audit and its regression tests. Record behavior remains covered by the
existing engine integration tests and unchanged byte fixtures; the record implementation and
its own security regression matrix remain in Foottrace.
From E4, `scripts/foottrace-install.mjs` inspects the complete installed graph with
`npm ls --all --json --long`. When any installed package declares or resolves `foottrace`,
the graph must resolve one version at one physical path. Repeated references to that same
canonical path are fine; two different paths at the same version are not. Consumer and sibling
installs are checked together because linked siblings can execute in the same process.
Missing transitive or peer dependencies, invalid packages, malformed output and failed
inspection block the installation step. They cannot become a nonblocking `own failure`
when both audit legs fail.

A legacy graph with no declared or resolved Foottrace is reported prominently as
**NOT APPLICABLE — not migrated / no Foottrace dependency**. E4 publishes Foottrace before
E5 adds it to consumers, so this state remains releasable. The audit does not inject Foottrace
to manufacture a one-copy result. Once the extracted engine or a migrated consumer declares
it, the same check automatically requires its installation. Neither N/A nor a one-instance
result proves E5 completion: import ownership, dependency ranges, migrated mocks and the
consumer's checks against the extraction candidate remain separate requirements.

The family-version audit's `--deep` canary installs all published family packages, including
Foottrace, and always requires exactly one physical Foottrace instance. It does not have the
legacy N/A exception.


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
- `installStrategy: "packaged"`: apply the centrally planned replacements before the first strict install. No custom `install` override or runtime-linked siblings; absent means the existing linked strategy.
- `siblings`: runtime checkouts (`{ repo, branch, dir, setup }`) are cloned and installed before their consumer; any sibling installing footprintjs gets the same swap. A packaged app may instead declare `{ repo, branch, dir, sourceOnly: true }` for examples only, without `setup` or an independent install.
- `registry`: family packages it links by `file:` path that should come from npm instead.
- `fallback: false`: no second leg on the published footprintjs, so any red step blocks. For a consumer on a same-train migration `branch` (plan §4, `docs/design/2026-10-trace-extraction.md`): its branch builds only on the candidate, so the published leg is red by construction, and "red on both" would read a real failure as an `own failure`. It goes back with the branch.
- `note`: why the setup is what it is.

Then run `npm run audit:consumers -- --only my-consumer` and open a PR. The PR's `Consumers` run shows the new job.

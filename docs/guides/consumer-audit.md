# The consumer audit

No footprintjs release tags until every family consumer passes its own checks against the release candidate.

**Why.** hcifootprint 2.6.0 (`footprintjs ^9.10.1`) broke on every fresh install after footprintjs 9.36 removed `/advanced` internals it imported, and nobody noticed for weeks. footprintjs's own suite cannot see what a consumer imports; only the consumer's checks can.

**The four pieces.**

| Piece | Job |
|---|---|
| `scripts/family.json` | The one list: each consumer's repo, default branch, whether it is published, its checks and any setup it needs. `scripts/audit-family-versions.mjs` reads it too. |
| `scripts/audit-consumers.mjs` | Audits consumers against a candidate tarball. CI runs it once per consumer; you can run it locally. `consumer-range.mjs` decides who may block (against the base version) and under which label the code installs; `consumer-relabel.mjs` makes the relabelled copy. |
| `.github/workflows/consumers.yml` | On every PR to main and on demand: packs the candidate, reads the base branch's version (pull requests), then one job per consumer. |
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

### Who may block, and under which label the code is installed

Two questions per consumer, answered from different facts (`scripts/consumer-range.mjs`, pure: data in, data out).

**1. May this consumer block?** Only when every one of its *statements to its users* accepts the **base version**: the version of the branch the candidate merges into. Otherwise it *reports only*: its checks still run on the candidate's code, the result is reported, and it never fails the job.

- Statements to users: the authored manifests (captured before any audit change) of the consumer and of each participating runtime sibling, `dependencies`, `peerDependencies` and `optionalDependencies`; and each `registry` pin's published `peerDependencies.footprintjs` (`npm view <pin> peerDependencies --json`). Not `devDependencies`, and nothing else in the lock.
- The base version: on a pull request, `package.json · version` at the base commit, read by `consumers.yml` from git (its first step, before any of the pull request's code runs) and passed as `--base-version`. On a pull request (`GITHUB_EVENT_NAME=pull_request`) the audit refuses to run without it. On a manual run or locally, the default is the candidate's own version. A statement accepts a prerelease base when it accepts the base as written or its release: `^12.0.0` accepts base `12.0.0-rc.0` through `12.0.0`, and an exact pin `12.0.0-rc.0` accepts it as written. The `range:` line names both (`base 12.0.0-rc.0 (as written or as 12.0.0)`).

**Why the base, and not the candidate's own label.** The label is written by the change under test: one edited field (`"version": "99.0.0"`) must not decide who may block that change. Anchored to the base, a version bump frees nobody on its own pull request. A pure heading pull request (version and changelog only) is green, because its code already passed under the old label; a pull request that bumps the version AND breaks a consumer is still blocked. Once the bump is merged, later pull requests have the new base, and a consumer that has not opted in to it reports only. So the protocol for a breaking cycle is one sentence: **before the first change that breaks a family package, one pull request that only sets the next major version.**

What this delivers, and what it does not: an ordinary edit of the version no longer decides who may block. It does not put the gate out of the pull request's reach: on `pull_request`, the pull request's own copy of `consumers.yml`, `family.json` and the audit's scripts runs, as it always did. Review changes to those files as changes to the gate.

**Why only statements to users.** A package that only the consumer's tests, demos or workspaces install says nothing to the people who install the consumer. hcifootprint has opted in to footprintjs 12, while its demos lock an agentfootprint that refuses 12: it must keep its power to block 12. This errs on the strict side: a consumer whose runtime dependency (not a pin) refuses the base still blocks.

**2. Under which label is the candidate's code installed?** Every declaration in the install graph counts here: the statements above plus every installed package's `peerDependencies.footprintjs`, optional, dev and workspace ones included, from `node_modules/.package-lock.json` (a packaged app has not installed yet: its committed `package-lock.json`; a package a registry pin replaces is read from the registry instead). npm refuses them all, so if any refuses the candidate's version (`semver.satisfies`, npm's own reading: `12.0.0-rc.0` is outside `^12.0.0`), the code is installed under the **accepted version**, the newest published footprintjs every declaration accepts (`npm view footprintjs versions --json`, once per run). The published leg then installs that same version, not `latest`.

The relabelled archive (`scripts/consumer-relabel.mjs`) is a copy of the candidate in the audit's temporary workspace whose only change is `package.json · version`, named for what it is (`footprintjs-candidate-as-11.2.0.tgz`). It is made from a private copy of the bytes the release archive inspector (`scripts/publish-release/archive/inspector.cjs`) admitted, and checked against the input: the same members, every other member's bytes equal, and `package.json` exactly the input's text with only the version replaced (key order included: in `exports` it decides which file resolves). It goes through the same strict installation as every other consumer: no `--force`, no `--legacy-peer-deps`, no tolerated `npm ls` problem. Two things it cannot change: a version constant built into `dist` still says the candidate's real version, and npm `overrides` are not read, so a peer a consumer overrides still counts as declared.

| May block? | Label | Example | Verdicts |
|---|---|---|---|
| yes | real | an ordinary pull request | `pass`, `BLOCKING`, `own failure`, `no verdict`, as in the table above |
| yes | relabelled | the 12.0.0 heading pull request on base 11.2.0; or a consumer whose demos refuse the candidate | the same: a break still blocks |
| no | relabelled | base 12.0.0, a consumer still on `^11.2.0` | the table below |
| no | real | a candidate below the base | the table below |

For a consumer that reports only:

| Candidate's code | Published | Verdict | Fails the job |
|---|---|---|---|
| all green | not run | `opt-in needed`: it works on the new code; it must widen its range to take this version | no; a notice on the run |
| red (install or checks) | green on a step that is red on the candidate | `needs migration`: its own work when it opts in. When the only red step is installing the relabelled archive, no check ran, and the annotation says this may be the audit, not the code | no; a warning on the run |
| red | red on every step that is red on the candidate | `own failure` | no; a warning on the run |
| no published version satisfies every declaration | — | `own failure`, with a note | no |
| the relabelled archive could not be made or failed its check | — | `no verdict` | yes |
| the published leg's install is red (or, with `fallback: false`, the candidate's) | — | `no verdict` | yes |

A consumer that may block but has no accepted version is installed as is and judged as above: a missing label never excuses it.

**Fail closed.** If the declarations cannot be read or parsed (a field that is not an object, a range that is a number or does not parse, a lock without its packages map, a registry read that fails), the consumer is judged exactly as before: it may block, and the real candidate is installed. If only the published version list cannot be read, "may it block" was already answered from statements that were read, so the answer stands: no label can be chosen and the real candidate is installed; a consumer that may block is judged as before, and one that reports only stays reports-only, with an annotation that its code was NOT tested under a version its ranges accept. A registry outage never turns a reports-only consumer into `BLOCKING`. Its job can still fail as `no verdict` when nothing at all could be installed: nothing was tested, so the job says so and is re-run.

A statement that refuses a prerelease candidate but accepts its release (`^12.0.0` and `12.0.0-rc.1`) has already opted in: npm only skips prereleases. Its line says `Refuses 12.0.0-rc.1 only as a prerelease (…): it accepts 12.0.0.`, and it is not listed as "must opt in". Note: every consumer with a registry pin now makes one `npm view <pin> peerDependencies --json` call, even in the ordinary case.

**What the run says.** One `range:` line per consumer, both facts in plain words:

- `range: accepts base 11.2.0, so it can block. Refuses 12.0.0 (own peerDependencies ^11.1.0): must opt in before 12.0.0 is the newest version. Tested as 11.2.0.`
- `range: refuses base 12.0.0 (own dependencies ^11.2.0): reports only. Tested as 11.2.0.`
- `range: accepts base 12.0.0 and candidate 12.0.0.`

A relabelled consumer's table column reads `Candidate code as 11.2.0`. After "N consumer(s) block this candidate", the run names the consumers whose statements refuse the candidate's version and were tested ("must opt in to 12.0.0"), then those that report only.

**Worked example: footprintjs 12.0.0, 12 Nov 2026.** The heading pull request (base 11.2.0) had five of the seven consumer checks red at "install footprintjs", and no test had run; the same code labelled 11.2.0 one commit earlier passed all seven. The job logs named these declarations (the registry's peers as published; a consumer's own manifest may add more to its line). Under this rule every one of them accepts base 11.2.0, so every one may block, and is tested as 11.2.0:

| Consumer | Refuses 12.0.0 | Kind |
|---|---|---|
| agentfootprint | own peerDependencies ^11.1.0 | statement: must opt in |
| agentfootprint-lens | own peerDependencies ^11.0.0; agentfootprint@14.3.1 peer ^11.1.0 | statements |
| hcifootprint | agentfootprint@14.0.0 peer ^11.0.0 (locked through two workspace demos) | install graph only |
| vizfootprint | agentfootprint@14.3.1 peer ^11.1.0; footprint-storydeck@0.11.0 optional peer ^11.0.0 | a statement (the pin) and the install graph |
| agent-playground | agentfootprint@14.3.1 peer ^11.1.0; agentfootprint-lens@0.80.0 peer ^11.0.0 | statements (pins) |

Their checks would run on 12.0.0's code and judge it as on any pull request. After 12.0.0 is merged (base 12.0.0), a consumer whose statements still refuse 12 reports only until it widens its range and publishes; hcifootprint, whose own range accepts 12, keeps blocking. These shapes are tests in `test/architecture/consumer-range.test.ts` and `consumer-range-audit.test.ts`.

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

The engine's own tests do not stand in for that consumer audit.

The E3 source pin, archive provenance checks, bootstrap helper and its five temporary tests were
retired after publication. Those tests specified an unpublished-package workflow: exact source
pins and local archive identities are no longer installation requirements, and the audit no
longer creates links to force one shared copy. The duplicate-copy rejection remains covered by
the installed-dependency audit and its regression tests. Record behavior remains covered by the
existing engine integration tests and unchanged byte fixtures; the record implementation and
its own security regression matrix remain in Foottrace.
`scripts/foottrace-install.mjs` inspects the complete installed graph with
`npm ls --all --json --long`. When any installed package declares or resolves `foottrace`,
the graph must resolve one version at one physical path. Repeated references to that same
canonical path are fine; two different paths at the same version are not. Consumer and sibling
installs are checked together because linked siblings can execute in the same process.
Missing transitive or peer dependencies, invalid packages, malformed output and failed
inspection block the installation step. They cannot become a nonblocking `own failure`
when both audit legs fail.

A legacy graph with no declared or resolved Foottrace is reported prominently as
**NOT APPLICABLE — not migrated / no Foottrace dependency**. The audit does not inject Foottrace
to manufacture a one-copy result. Once the engine or a migrated consumer declares
it, the same check automatically requires its installation.

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

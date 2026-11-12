# The consumer audit

No footprintjs release tags until every family consumer passes its own checks against the release candidate.

**Why.** hcifootprint 2.6.0 (`footprintjs ^9.10.1`) broke on every fresh install after footprintjs 9.36 removed `/advanced` internals it imported, and nobody noticed for weeks. footprintjs's own suite cannot see what a consumer imports; only the consumer's checks can.

**The four pieces.**

| Piece | Job |
|---|---|
| `scripts/family.json` | The one list: each consumer's repo, default branch, whether it is published, its checks and any setup it needs. `scripts/audit-family-versions.mjs` reads it too. |
| `scripts/audit-consumers.mjs` | Audits consumers against a candidate tarball. CI runs it once per consumer; you can run it locally. `consumer-range.mjs` reads which versions each consumer declares, and `consumer-relabel.mjs` makes the relabelled copy a consumer outside its range is tested with. |
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

### A consumer blocks only inside the range it declares

**The rule.** A consumer can block a candidate only inside the version range it declares. Outside it, the consumer's checks still run on the candidate's code, the result is reported, and it never fails the job.

**Why.** A range is the consumer's own statement to its users about which footprintjs it works with. Inside the range, a fresh install picks the new version up by itself, so a red check there is a real break: that is the hcifootprint case the audit was built for, and it is judged exactly as above. Outside the range no install picks the candidate up, so the consumer has nothing to lose and nothing to veto; it only has work to do when it chooses to opt in. A major version is outside every caret range by definition: before this rule the audit refused a major's own pull request at "install footprintjs", before any test ran. The rule needs no "is this a major?" switch, and it covers an exact pin too.

**Which declarations count** (`scripts/consumer-range.mjs`, pure: data in, data out):

- the authored manifests (captured before any audit change) of the consumer and of each participating runtime sibling: `dependencies`, `peerDependencies`, `optionalDependencies`. Not `devDependencies`: that is a test setup, not a statement to users;
- each `registry` pin's published `peerDependencies.footprintjs` (`npm view <pin> peerDependencies --json`);
- every installed package's `peerDependencies.footprintjs`, optional peers included, from `node_modules/.package-lock.json` (a packaged app has not installed yet: its committed `package-lock.json`). A package a registry pin replaces is read from the registry instead.

A spec that names a place or a tag (`file:`, `link:`, a git URL, `latest`) is no statement and is skipped. A range refuses the candidate when `semver.satisfies` says so, which is npm's own reading: a prerelease such as `12.0.0-rc.0` is outside `^12.0.0` too.

**Fail closed.** If anything cannot be read or parsed (a field that is not an object, a range that is a number or does not parse, a lock without its packages map, a registry read that fails), the consumer is judged as before, inside its range, with the note `range: not read (…)`. Only a range that was parsed and refuses the candidate takes a consumer out.

**What is tested outside the range.** The newest published footprintjs that every declaration accepts is the *accepted version* (`npm view footprintjs versions --json`, once per run). The audit makes a copy of the candidate archive in its temporary workspace whose only change is `package.json · version`, named for what it is (`footprintjs-candidate-as-11.2.0.tgz`, `scripts/consumer-relabel.mjs`), checks it against the input with the release archive inspector (`scripts/publish-release/archive/inspector.cjs`: the manifests are equal except `version`, the members are the same, every other member's bytes are equal), and runs the candidate leg with it through the same strict installation as every other consumer: no `--force`, no `--legacy-peer-deps`, no tolerated `npm ls` problem. The published leg, when a step is red, installs the accepted version, not `latest`.

| Candidate's code, as the accepted version | Published, accepted version | Verdict | Fails the job |
|---|---|---|---|
| all green | not run | `opt-in needed`: it works on the new code; it must widen its range to take this version | no; a notice on the run |
| red | green on a step that is red on the candidate | `needs migration`: the new code breaks it, and that is its own work when it opts in | no; a warning on the run |
| red | red on every step that is red on the candidate | `own failure` | no; a warning on the run |
| no published version satisfies every declaration | — | `own failure`, with a note | no |
| the relabelled archive could not be made or failed its check, or the consumer could not be installed on either leg | — | `no verdict` | yes |

Each consumer's report has one line `range: accepts 12.0.0`, or `range: refuses 12.0.0 — own peerDependencies ^11.0.0; agentfootprint@14.3.1 peer ^11.1.0` (every refusing declaration, by who declares it). Outside its range the table's column reads `Candidate code as 11.2.0`. The run's last line names the consumers outside this version that must opt in.

**Worked example: footprintjs 12.0.0, 12 Nov 2026.** The heading pull request had five of the seven consumer checks red at "install footprintjs", and no test had run; the same code labelled 11.2.0 one commit earlier passed all seven. The job logs named these declarations (the registry's peers are as published; a consumer's own manifest may add more to its line). Under this rule:

| Consumer | `range:` line for 12.0.0 | Tested as |
|---|---|---|
| agentfootprint | `refuses 12.0.0 — own peerDependencies ^11.1.0` | 11.2.0 |
| agentfootprint-lens | `refuses 12.0.0 — own peerDependencies ^11.0.0; agentfootprint@14.3.1 peer ^11.1.0` | 11.2.0 |
| hcifootprint | `refuses 12.0.0 — agentfootprint@14.0.0 peer ^11.0.0` (locked through two workspace demos) | 11.2.0 |
| vizfootprint | `refuses 12.0.0 — agentfootprint@14.3.1 peer ^11.1.0; footprint-storydeck@0.11.0 optional peer ^11.0.0` | 11.2.0 |
| agent-playground | `refuses 12.0.0 — agentfootprint@14.3.1 peer ^11.1.0; agentfootprint-lens@0.80.0 peer ^11.0.0` | 11.2.0 |

Each would run its checks on 12.0.0's code: green ones say `opt-in needed`, red-only-on-the-new-code ones `needs migration`, and neither fails the job. Once a consumer widens its range to `^12.0.0` and publishes, it is back inside and can block again. These five shapes are tests in `test/architecture/consumer-range.test.ts`.

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

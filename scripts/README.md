# Architecture and extraction reports

Run `npm install` in this repository before invoking the reports: their shared declaration analysis
uses the declared TypeScript development dependency. Consumer CI installs the audit's dependencies
in its own checkout with lifecycle scripts disabled, independently of each consumer's install.

The extraction checks derive their facts from source declarations and imports. A missing checkout,
ref or unresolved access is **unknown**, never a measured zero. The scripts read files and Git
objects; the readiness report does not fetch, install dependencies or change a checkout.

```sh
npm run check:record-tests
npm run check:trace-ready
npm run trace:ready -- --org /path/to/footprintjs --consumer-ref origin/main
node scripts/trace-ready.mjs --org /path/to/footprintjs --consumer-ref origin/main --json
```

`check:record-tests` checks every entry in `record-tests.mjs`'s reasoned `STAYS` list and enforces
R4 ≥70%. The denominator includes all named engine witnesses, including the record-byte fixtures;
only tests whose subject stays with the engine are excluded. The classifier follows helpers,
re-exports, dynamic imports, `require` and type dependencies. The main and advanced doors count
as engine dependencies. The trace/write doors resolve each imported name to its declaration.
Type dependencies count because a moved test must also compile without the engine.

At E1, 73/104 record test files run without the engine, 31 are engine witnesses, and 13 tests of
engine-owned behavior are excluded. Splitting a mixed test preserves the engine assertions while
letting the original record assertions run against the record layer directly. This is not a
count of individual assertions, and a renamed or missing witness fails the check.

`doors.mjs` owns the shared TypeScript declaration map and import parser. `recordSymbols` counts
names whose declarations lie in `layering.config.cjs`'s `RECORD_FILES`; the consumer audit uses
that same map for `/advanced`. It does not infer record ownership from a folder name or classify
`ExecutionRuntime`, `StageContext` or `ScopeFacade` as record symbols.

`trace-ready.mjs` reports R1–R6 and co-change. Every consumer is read from the requested ref's
resolved commit, printed beside its checkout path. Source is read in one byte-framed Git batch
per consumer, so local changes do not contaminate the evidence. A bare Git repository works too.
The default consumer/history ref is `origin/main`; use `--consumer-ref main` for bare mirrors.
`--history-ref` and `--since` select the co-change history (default: the preceding three months).
Shallow or missing history is unknown; no record-touching commits gives no percentage.

The modes have separate purposes:

| Mode                                       | Required evidence                                   |
| ------------------------------------------ | --------------------------------------------------- |
| Default / `npm run trace:ready`            | Report only; no extraction claim                    |
| `--check-e1` / `npm run check:trace-ready` | R1/R2 zero, R4 ≥70%, all tests classified           |
| `--check-entry`                            | E1 plus R5/R6 zero, with complete consumer evidence |
| `--require-ready`                          | All six rows, including R3 zero at E3 completion    |

R3 uses declaration identity, including aliases, re-exports and dynamic/require dependencies.
Its E1 inventory is 18: the earlier import-only count was 16, and the fuller walk adds the
`ArrayWalk` and `DELIM` barrel re-exports. Each row names the declaration and every importer.
No public API is changed to reduce this number during E1.

R5 reports record names imported from `/advanced` separately from potential legacy frame
writers. An opaque `/advanced` access or import of `ExecutionRuntime`, `StageContext` or
`ScopeFacade` needs review and yields unknown; an import alone does not prove a record was
written. R6 counts runtime namespace access in `src/`; type-only references and module mocks
are inventoried but are not runtime reads. Only the two playgrounds are exempt, with their
namespace sites retained in the evidence.

Co-change is always informational, at any percentage. CI enforces only E1 and appends the full
table to its job summary. Its footprintjs-only checkout lacks consumer evidence, so R5/R6 are
unknown there; the consumer audit publishes each checked-out consumer's import inventory.

`test/architecture/trace-readiness.test.ts` includes negative controls for aliases, engine
helpers, missing declarations, all dependency forms, stale classifications, absent consumers,
changing working trees, partial Git history and the different readiness gates.

## Foottrace installation identity (E4 onward)

`foottrace-install.mjs` is the shared read-only installed-graph check for the consumer audit
and published-family canary. It checks complete npm dependency evidence, then resolves package
paths to their canonical physical locations. One version installed at two paths is a failure;
deduplicated references and links to one physical package are accepted. Consumer/sibling
workspaces must also share that identity. No package is installed, removed or linked by this check.

Legacy consumers without a declared or resolved Foottrace report **NOT APPLICABLE — not migrated**.
A declaration anywhere in the installed graph makes a missing package fail, including transitive
dependencies and peers. Development declarations count only at each installation root. The fleet
canary passes `required: true`, so missing Foottrace always fails there. Unsuccessful npm commands,
malformed trees and unreadable or mismatched physical package metadata fail closed.

The invariant belongs to the audit's installation step, before consumer checks: a failure on both
candidate and published legs still blocks. `test/architecture/consumer-foottrace.test.ts` exercises
real local npm trees with generated package manifests, including missing dependencies, deduplicated
references, identical-version duplicates, sibling copies and explicit legacy N/A. These checks do
not stand in for E5's migration evidence; see `docs/guides/consumer-audit.md`.

## Record freeze (E4–E6)

`npm run check:record-freeze` checks the maintained record copy while the extraction leaves it in
two repositories. This gate is prepared before E4, but its pull request must remain draft until
Foottrace's first publication. It is removed from the engine-only branch at E6; it must not make
the deliberate extraction look like an accidental deletion.

`layering.config.cjs` still owns membership (`RECORD_FILES`, `isRecordFile`, `listSourceFiles`).
`record-freeze.json` is frozen expected output, not a second ownership rule. It contains the
inventory fingerprint, source paths and SHA-256 digests of their exact bytes. The checker has one
pure comparison and thin file/command functions; it needs neither Git history nor a network.
It reports modified, added and deleted sources, and any change to the inventory itself. Narrowing
a pattern therefore cannot hide a changed file. Like the existing fence, its scope is `.ts`
source, not `.d.ts`, README files or build output. Missing or malformed evidence fails closed.
For this snapshot check the shared walker refuses source-tree symlinks before following them;
its other callers retain their existing behavior. The command recognizes aliased entry paths,
including Node's `--preserve-symlinks-main` mode, rather than silently skipping execution.

The initial 45-source baseline comes from the exact Git blobs of FootPrint's `v9.48.3` release,
`0df7f5dd2f399915d6c57ad806ca434481838515`. The inventory configuration was checked byte-for-byte
against that commit before capturing it. The paired Foottrace candidate is
`14db5f93d74313c9ed026aa4b67e5b0922e9b6a4`. This pair documents coordinated review; it does **not**
assert that every source file in the two repositories is identical after extraction, that the
candidate was published, or that its separate security gate passed.

For a critical fix during the freeze:

1. Prepare linked PRs for the shared fix in maintained FootPrint and Foottrace. The maintained
   FootPrint PR must contain the fix, regression tests and baseline update together, not defer
   fingerprints to a follow-up PR that the freeze would block. The linked Foottrace PR contains
   the equivalent fix and its regression tests; these are coordinated PRs, not an atomic change
   across repositories.
2. Commit the maintained fix and tests before adding the baseline commit within that same PR.
   Obtain expected source bytes from that fix commit's Git blobs, not a potentially edited working
   tree. Verify its ownership configuration before deriving the inventory and content digests.
   Record that exact maintained fix commit and the exact reviewed Foottrace fix commit in the
   baseline; the baseline commit does not need to name itself.
3. Review the baseline diff alongside both fixes and the regression/record-byte evidence, and
   verify both PRs' checks before merging. If either reviewed fix changes, refresh the paired
   commit evidence and verify again. Do not skip or suppress the freeze check, or change frozen
   record fixtures merely to clear it.

There is intentionally no `--update`, skip switch, automatic regeneration or remote fetch. A
passing freeze check only means this maintained copy has not drifted from its reviewed baseline;
it cannot attest to changes made later in the other repository. Paired review is still required.

`test/architecture/record-freeze.test.ts` checks modifications, glob additions, deletions, renames,
inventory narrowing, missing/malformed evidence, symlink substitution and the read-only command.

# Architecture and extraction reports

Run `npm ci` in this repository before invoking the reports: their shared declaration analysis
uses the declared TypeScript development dependency. Consumer CI installs the audit's dependencies
in its own checkout with lifecycle scripts disabled, independently of each consumer's install.

The extraction checks derive their facts from source declarations and imports. A missing checkout,
ref or unresolved access is **unknown**, never a measured zero.

```sh
npm run check:record-tests
```

`check:record-tests` checks every entry in `record-tests.mjs`'s reasoned `STAYS` list. After E3 it
also checks that the 74 moved test files are absent. R4 is **UNKNOWN** in the extracted checkout:
the engine-free population now lives in foottrace. `trace-extraction.json` preserves the historical
74/105 entry measurement, its source commit, the exact 44 source files and the published record
names for consumer audits; that snapshot is not a fresh R4 measurement. For a pre-extraction tree
the classifier still enforces R4 ≥70%. Its denominator includes the record-byte fixtures;
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

The consumer audit saves exact candidate/registry replacements in its disposable manifests, and
retains and reports every original declaration across both legs. It verifies that declarations and
metadata outside those named concrete replacements are unchanged, including every peer requirement.
Peer-only packages receive an audit-only dev dependency; peers are never rewritten to tarball paths
or widened to accommodate the candidate. Producer siblings install before their dependents. This
makes `npm ls` inspect the intended audit graph without ignoring a stale `file:` declaration's valid
error. The development-only `semver` dependency checks original peers before any target changes:
npm can otherwise hide an incompatible peer behind a same-name dev dependency. Source checkouts and
Foottrace declarations are not rewritten. Runtime-linked sibling dependencies are cloned and
installed even when unused by application code. `installStrategy: "packaged"` instead materializes
the same validated plan before the first install (scoped lock update, strict ordinary `npm ci`).
Archive paths and SHA-512 integrity remain independently verified after installation.

`consumer-workspace.mjs` owns the source-only boundary, not package installation: examples-only
siblings borrow the app's complete dependency tree via the workspace ancestor, matching app CI.
It refuses independent or nested installs, source symlinks and conflicting existing workspace
links, then checks engine/record module resolution against the app's actual physical owners.
There is no package-specific alias or duplicate suppression. Runtime-linked siblings retain their
existing setup and every-install-root identity check. The plan/materialization and orchestration
regressions are in `test/architecture/consumer-install.test.ts` and `consumer-audit.test.ts`.

## Record ownership after extraction

E6 removes the temporary maintained-copy freeze checker, its baseline and its checker tests:
FootPrint no longer owns a second record implementation to freeze. Foottrace owns record fixes;
the engine consumes them through its public dependency. The extraction ownership fence and
unchanged engine record-byte witnesses remain active. The E4–E6 paired-fix procedure and baseline
remain recoverable in the 9.x history; removing this temporary guard does not remove a record
regression test or permit copying record code back into the engine.

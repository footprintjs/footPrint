# Design notes

Why the library is the way it is. These notes are history, not instructions. Where a note and the code disagree, trust the code.

A note's own status line says what was true when it was written, and many are out of date. The Status column below says what happened, read from the code and `CHANGELOG.md`.

| Date | Note | Status | One line |
|---|---|---|---|
| 2026-10-29 | [Attempt effects outside a stage](2026-10-attempt-effects.md) | Shipped in 11.0.0. The note says not approved. | Standalone `attempt()` takes `onEnd`, `touches` and `idempotencyKey`, and a series reports one effect. |
| 2026-10-27 | [Native producer ownership evidence](2026-10-source-ownership.md) | Shipped in 10.6.0 | Native read sources carry a bounded witness of which execution owns a namespace. |
| 2026-10-22 | [Exact read sources](2026-10-exact-read-sources.md) | Shipped from 10.4.0. The note says not implemented. | Record which source each tracked read came from, behind `readSources`. |
| 2026-10-15 | [Time and failure evidence](2026-10-time-and-failure-evidence.md) | Shipped in 10.1.0 | Deadlines, attempt records, side effects, correlation, the crash-safe record and attempt metrics. |
| 2026-10-08 | [Extracting the record into its own package](2026-10-trace-extraction.md) | Done in 10.0.0 | The plan that moved the record and its readers into `foottrace`. |
| 2026-10-02 | [The admitted record](2026-10-admitted-record.md) | Shipped in 9.30.0 | A commit, replayed, gives back what its stage read. |
| 2026-10-01 | [Copy-on-write commit](2026-10-copy-on-write-commit.md) | Shipped in 9.29.0 | A write costs what it writes, not what the state holds. |
| 2026-09-16 | [The record contract](2026-09-record-contract.md) | Shipped in 9.27.0. The contract now lives in `foottrace`. | Time travel over a declared record that any runtime can write. |
| 2026-09-11 | [Clone once at commit](2026-09-clone-once-at-commit.md) | Shipped in 9.23.0 | Writing N array elements in one stage becomes linear. |
| 2026-09-10 | [Declared tags](2026-09-declared-tags.md) | Packet 1 shipped in 9.21.0 | A name on a stage, carried by its commit. |
| 2026-08-02 | [Execution control](execution-control.md) | Shipped in 9.14.0. The note says nothing is built. | `addParallelForEach` and `interrupt()`. |
| 2026-06-16 | [Subflow commit visibility](subflow-commit-visibility.md) | Shipped in 9.9.0. The note says proposed. | Keep each loop's subflow log, and do not merge it into the run log. |
| 2026-06-10 | [The `append` commit verb](13c-b-delta-commit-verb.md) | Shipped in 9.7.0 | Delta commits that lose nothing, behind `commitValues: 'delta'`. |
| 2026-06-10 | [RFC-001: deferred observer delivery](rfc-001-deferred-observers.md) | Shipped in 9.6.0. The note says the engine wiring is pending. | `delivery: 'deferred'` runs an observer one beat behind the stage. |
| 2026-06-09 | [RFC-003: contextual bug localization](rfc-003-contextual-bug-localization.md) | Part A shipped in 9.8.0. Part B is in agentfootprint. | Control-dependence edges and honesty flags here, and an LLM bug localizer on top. |
| 2026-06-09 | [Observer channels study](observer-channels-study.md) | Study. Fed RFC-001. | Each observer channel, as of June 2026, traced to where it dispatches. |
| 2026-06-07 | [Commits record changes, not writes](commit-change-semantics.md) | Shipped. The code now lives in `foottrace`. | A commit is the stage's net state change. |
| 2026-06-06 | [Scope vs emit](scope-vs-emit.md) | Standing rule | Business state goes in scope, and pure observation goes in emit. |
| 2026-05-25 | [Proposal 001: subflow path on the mount event](proposal-001-subflow-path-on-stage-added.md) | Shipped in 6.0.0 | Put the subflow spec and path on the mount event, and add `walkSubflowSpec`. |
| 2026-05-25 | [Proposal 002: stage ID naming](proposal-002-stage-id-symmetry.md) | Shipped in 6.0.0 | Add `splitStageId` and correct the docs on local and prefixed IDs. |
| 2026-05-25 | [Proposal 003: uniform `onStageExecuted`](proposal-003-onStageExecuted-uniform.md) | Shipped in 6.0.0 | Fire the event for every stage kind, with a `stageType`. |
| 2026-05-14 | [`CommitRangeIndex`](commit-range-index.md) | Shipped in version 5. The code now lives in `foottrace`. | An interval index over commit indices. |
| 2026-05-14 | [Recorder redesign for 5.0.0](v5-recorder-redesign.md) | Shipped in 5.0.0. The old base classes went in 7.0.0. | Recorders compose stores, and every run gets a `runId`. |
| 2026-04-17 | [ADR-001: emit channel](adr-001-emit-channel-pass-through.md) | Shipped in 4.13.0 | `scope.$emit` dispatches at once to every recorder, with no buffer. |
| 2026-04-17 | [ADR-002: redacted mirror](adr-002-redacted-mirror.md) | Shipped in 4.14.0 | Keep a redacted copy of state during the run, rather than scrub after it. |

The proposals, ADRs and research notes used to live in `docs/proposals`, `docs/internals` and `research`.

## Removed from the repository

The git tag `docs-before-cleanup` marks the repository before the docs cleanup. Read any of these files from it:

```sh
git show docs-before-cleanup:BACKLOG.md
```

| Path at the tag | What it was |
|---|---|
| `MIGRATION-5.md`, `MIGRATION-6.md` | Upgrade guides for versions 5 and 6. |
| `REVIEW.md`, `BACKLOG.md`, `DOC-GAPS.md` | A June 2026 review of version 8, its backlog and its documentation gaps. |
| `research/RFC-001-deferred-observers.md` | An earlier draft of RFC-001. It alone has the alternatives considered and the section on serverless runtimes. |
| `research/RFC-002-tool-choice-confusability.md` | The design for the tool-choice lint and recorder, which agentfootprint later built. |
| `docs-site/src/content/docs/api/agent.mdx` | An agentfootprint API page that was outside the site's sidebar. |
| `docs/guides/api-reference.md` | A hand-written reference that covered part of the API and named methods the code no longer has. The generated reference replaced it. |
| `.cursor/rules/footprint.md`, `.kiro/rules/footprint.md`, `.github/copilot-instructions.md`, `.clinerules`, `.windsurfrules` | Copies of the AI instructions for this repository. `ai-instructions/` keeps the sources. |
| `src/lib/slice/README.md`, `src/lib/time-travel/README.md`, `src/lib/memory/algorithm.md` | Pointers to `foottrace`. |
| `bt-phase4.jpeg`, `ch05-summary.jpeg`, `coco-2.jpeg`, `coco-3.jpeg`, `coco-4.jpeg`, `coco-hero.jpeg`, `mobile-engine.jpeg` | Images at the root that nothing used. |

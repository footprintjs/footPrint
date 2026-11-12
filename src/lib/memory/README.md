# memory/ — engine policy around a record

This directory owns the engine side. The record implementation lives in [foottrace](https://github.com/footprintjs/foottrace).

## Responsibilities

- `StageContext` composes `RecordFrame` from `foottrace/write`, decides retention, tracks engine read/write marks and delivers commit hooks.
- `ExecutionRuntime` (in `runner/`, not here) composes `SharedMemory` and `EventLog` with engine lifecycle, observers, snapshots and subflows.
- `runAddress` is the engine's single owner of run namespaces and frame addresses. The record receives an address as data.
- `logAddress` owns the child-log address law shared by sink wiring and native source books: append the actual mount runtime ID to its parent log's drill path.
- `redaction` decides retention and identity inheritance before a write. The record receives scrub bytes, not an engine policy object.
- `markPlaces` keeps where the value of a redaction mark lives. A mark is a name, and a run has more than one key of a name (each sub-flowchart has its own state, each parallel branch its own namespace). WHY: kept by name alone, a mark ended at the first delete of that name anywhere, and the key that still held the value was written to the log in the clear. The law now: a delete ends a mark only by taking away the last place that holds a value under it; a value decided hidden and written later holds a place of its own until it has landed; and a delete ends nothing while it is staged (the frame asks the state once its commit has landed, `StageContext · endMarksOfLandedDeletes`). The idea is plain reference counting (a mark is held by its places); no outside source.
- `frameTypes` describes engine frames, tracking and snapshots. Its referenced record types come from `foottrace`.
- `DiagnosticCollector` owns a separate bag of notes. Nested writes use `setNestedValue` / `updateNestedValue` from `foottrace/paths`: one safety rule and one merge implementation.

## One direction

Engine policy → public record writer → saved record → read-only queries.

Do not copy buffers, equality, codecs, merge/verb rules, encoders, freezing, causal queries or time-travel logic back here. FootPrint does not re-export record declarations. Public engine types may refer to record types, but consumers import those from their owner.

A tracked read is kept ONCE for each object a root key holds (`memory/keptReads.ts`), not at every read. WHY: keeping a read copies the value under the default setting, and a step that walked a list by index copied the whole list once per element (2 s for 3,000 records; `bench/repeat-reads.ts`). The rule rests on two laws this directory already has: a committed generation is never edited, and every engine write passes one funnel, which marks its root so that a root the step wrote is kept at every read again.

Stage writes use `StageContext.stageWrite`: decide redaction, preserve identity-based retention, delegate to `RecordFrame.write`, then mark the engine write. Commit delegates to the record frame before engine hooks. Retry and release reset stage-local tracking; replay is not a retry or a resume.

## Safety and evidence

Never freeze caller-owned live input as if it were writer-owned record data. Record freezing/serving uses the same installed foottrace module; consumer audits require one installed version.

A refused dangerous nested selector makes no partial write. Diagnostic helpers retain their 9.48.1 silent-no-op behavior; they do not emit synthetic commit evidence.

Unchanged engine byte fixtures cover traversal-produced records. Standalone writer/replay fixtures live with foottrace. See the [extraction plan](../../../docs/design/2026-10-trace-extraction.md), [scope retention guide](../../../docs/guides/scope.md) and [record contract](https://github.com/footprintjs/foottrace/blob/main/docs/guides/record-contract.md).


## Stage attention (C2)

`StageAttention` owns traversal-time attention state; `StageContext` keeps one optional helper and delegates at the boundaries that retain attempts, summaries or stage errors. Snapshot export only copies collected marks. `StageSnapshot.attention?` imports the shared type from the public `foottrace` root without a FootPrint re-export or a dependency on `foottrace/cause`. A new execution resets the helper; retry discards preserve its facts. Healthy nodes omit the field. Attempt proofs use Foottrace's canonical codec, scoped to the owning runtime execution; summary/error/omission locators name retained fields. Capacity or unavailable proof stays `not-collected`. The engine never inspects recorders or infers quality; saved quality rows can be adapted at read time. Snapshot attention is not another crash-safe sink format. See the [attention guide](../../../docs/guides/attention.md) and its runnable example.

# memory/ — engine policy around a record

This directory owns the engine side. The record implementation lives in [foottrace](https://github.com/footprintjs/foottrace); this extraction branch prepares FootPrint 10 and must remain unmerged until E5 consumer migrations finish.

## Responsibilities

- `StageContext` composes `RecordFrame` from `foottrace/write`, decides retention, tracks engine read/write marks and delivers commit hooks.
- `ExecutionRuntime` composes `SharedMemory` and `EventLog` with engine lifecycle, observers, snapshots and subflows.
- `runAddress` is the engine's single owner of run namespaces and frame addresses. The record receives an address as data.
- `redaction` decides retention and identity inheritance before a write. The record receives scrub bytes, not an engine policy object.
- `frameTypes` describes engine frames, tracking and snapshots. Its referenced record types come from `foottrace`.
- `DiagnosticCollector` owns a separate bag of notes. Nested writes use `setNestedValue` / `updateNestedValue` from `foottrace/paths`: one safety rule and one merge implementation.

## One direction

Engine policy → public record writer → saved record → read-only queries.

Do not copy buffers, equality, codecs, merge/verb rules, encoders, freezing, causal queries or time-travel logic back here. FootPrint does not re-export record declarations. Public engine types may refer to record types, but consumers import those from their owner.

Stage writes use `StageContext.stageWrite`: decide redaction, preserve identity-based retention, delegate to `RecordFrame.write`, then mark the engine write. Commit delegates to the record frame before engine hooks. Retry and release reset stage-local tracking; replay is not a retry or a resume.

## Safety and evidence

Never freeze caller-owned live input as if it were writer-owned record data. Record freezing/serving uses the same installed foottrace module; consumer audits require one installed version.

A refused dangerous nested selector makes no partial write. Diagnostic helpers retain their 9.48.1 silent-no-op behavior; they do not emit synthetic commit evidence.

Unchanged engine byte fixtures cover traversal-produced records. Standalone writer/replay fixtures live with foottrace. See the [extraction plan](../../../docs/design/2026-10-trace-extraction.md), [scope retention guide](../../../docs/guides/scope.md) and [record contract](https://github.com/footprintjs/foottrace/blob/main/docs/guides/record-contract.md).

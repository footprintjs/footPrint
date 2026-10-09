# ids/ — the id grammar, one owner

Every execution step has an address, `[subflowPath/]stageId#executionIndex`
(`sf-tools/execute-tool-calls#8`). This folder is the ONE place that grammar is
spelled, in two halves (C6):

- **The record's half** — `runtimeStageId.ts` builds, parses and reads ids, and
  imports nothing. It is a record file (`RECORD_FILES` in
  `scripts/layering.config.cjs`): the readers of a log key on runtimeStageIds,
  so the grammar travels with the record.
- **The engine's half** — `branchSegment.ts` owns the one generated segment,
  `<stageId>~<index>` (a `parallelForEach` branch), and `reservedIds.ts` owns
  `refuseReservedId`, the one refusal the engine's id doors ask. The refusal
  reads the grammar's delimiters (`PATH_DELIMITER`, `EXECUTION_DELIMITER`) and
  the `~` rule; the grammar never reads the refusal.

No file outside this folder splits on `#` or `/` — recorders, the scope, the
time-travel cursor and the subtree lookup all ask the readers here.

**The laws.**

- *The delimiters are reserved* (RFC 3986 §2.2 style). The builder refuses `#`
  and `/` in every user-authored id, and `~` in a subflow id or a
  `parallelForEach` id, through ONE function, `reservedIds.ts ·
  refuseReservedId` (9.37.0, R5; in `runtimeStageId.ts` until C6). That is what
  makes last-delimiter parsing sound: before it, a stage id `ns/a` was reported
  inside a subflow `ns` that does not exist.
- *The record's half imports nothing.* Which ids the engine admits is the
  engine's rule, not the grammar's: before C6 `runtimeStageId.ts` imported
  `branchSegment.ts` for the refusal, the one edge from the record's grammar
  into the engine's `~` rule. A reader that only parses ids never loads the
  refusal.
- *The prefixer and the stores never refuse.* `engine/graph/prefixNodeTree.ts`
  writes `/` on purpose, and stores (`BoundaryStateStore`, …) are keyed by
  runtimeStageIds, which carry both delimiters.
- *A generated segment is opaque.* `review~2/score#14` reads like any subflow
  path; no reader special-cases `~`.
- *Brands are types only.* `RuntimeStageId`, `ExecutionIndex` and `CommitIdx`
  are a `string` / `number` with a compile-time tag (Rust-newtype style); each
  is assignable to its plain type, so reading one needs no change.

```typescript
import { buildRuntimeStageId, parseRuntimeStageId } from 'footprintjs/trace';

const rid = buildRuntimeStageId('score', 14, 'review~2'); // 'review~2/score#14'
parseRuntimeStageId(rid); // { stageId: 'score', executionIndex: 14, subflowPath: 'review~2' }
```

The refusal, as the builder's doors meet it:

```typescript
import { flowChart } from 'footprintjs';

flowChart('Seed', () => undefined, 'ns/seed');
// throws: [FlowChartBuilder] stage id 'ns/seed' contains the reserved character '/'. …
```

Layer L0 (`scripts/layering.config.cjs`): pure leaves that import nothing
outside this folder, so every layer — time-travel (L3), scope and recorders
(L5), the engine (L6) — may read them. They lived under `engine/` until 9.37.0;
a scope → engine edge closes the engine ⇄ scope ⇄ recorder module cycle, so the
readers could not be shared from there. Public door: `footprintjs/trace` (the
grammar's readers, and `branchSegment.ts`'s; `/advanced` also hands out
`buildRuntimeStageId` / `parseRuntimeStageId` / `createExecutionCounter` until
10.0.0, the same symbols). `refuseReservedId` is on no door: the engine's id
doors — the builder's, and the run-time dynamic-StageNode door — are its only
callers.

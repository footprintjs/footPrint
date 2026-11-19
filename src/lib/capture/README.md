# capture/ — keep something about a value without holding it

The leaf helpers every layer shares to **record a value cheaply** (a marker, a one-line summary, a frozen envelope) and to **call a recorder's hook**. They sit at the bottom of the stack so `memory/`, `scope/`, `decide/`, `engine/narrative/`, `runner/` and `observer-queue/` can use the same code without importing each other.

**The law: L0 imports only.** The layer table puts `capture/**` at L0, the bottom (`scripts/layering.config.cjs`), and `npm run check:layering` plus the ESLint zones fail an import that reaches upward from it. Files here import this folder, other L0 files (today `errors/terminalFailure.ts` and `attempt/types.ts`, from `nativeCoverage.ts` and `nativeClosure/`), and the `foottrace`, `foottrace/write` and `foottrace/paths` doors by name. If a file needs the engine, it does not belong here.

| File | Owns |
|---|---|
| `policies.ts` | `RetentionPolicy` — `'full' \| 'summary' \| 'off'`, the vocabulary behind the `readTracking` and `writeTracking` dials |
| `summarize.ts` | `summarizeReadValue` / `summarizeWriteValue` — the O(1) markers a `'summary'` retention keeps (type, size, an 80-character preview); `summarizeValue` — the one-line narrative form; the preview-length constants |
| `envelope.ts` | The deferred-observer capture tier: `capture()` snapshots an event into a frozen `CaptureEnvelope` under `'summary' \| 'clone' \| 'ref'`; `summarizePayload` is the bounded summary (depth 3, 16 entries, 128 nodes). `observer-queue/` imports it directly — it is not in the barrel |
| `circular.ts` | `hasCircularReference` — the dev-mode cycle probe |
| `invokeHook.ts` | `invokeRecorderHook` — look up a hook, bind `this`, call it. The one primitive the inline and the deferred delivery tiers both use, so they cannot drift |
| `nativeCoverage.ts` | Native root-segment observation and the shared mode, channel-status and limitation vocabularies, with types derived from their values. No whole-workflow or storage acknowledgement is inferred |
| `explainWitness.ts` | Native log and leg facts bound to the exact served root snapshot or mounted subflow context |
| `checkpointCapture.ts` | Small identity, mode, channel and limitation validators compose bounded own-data copying of a paused observation. Uses the producer's vocabularies; adds back the version's base limitations (`nativeCoverage.ts · baseLimitationsFor`) and `checkpoint-history-not-included`; never promotes memory observations or missing recorder data to durable evidence |
| `sourceOwnershipFormat.ts` / `sourceOwnership.ts` | One versioned ownership vocabulary/ceiling and a bounded collector of actual native execution, invocation and first-commit facts. Namespaces come from the engine; selected source rows can only downgrade proof, never authorize it |
| `storedSourceOwnership.ts` | Consistency checks for inert stored ownership against native tree counts, first commits and source rows. Receipts and unkeyed fingerprints are not producer authentication |
| `readSources.ts` / `nativeSourceAddress.ts` | The engine's read-source coverage: the limitation vocabulary, the read capture note, and whether a log address can carry native read sources. Source descriptors and their codec belong to `foottrace/write` |
| `sourceReadCounts.ts` / `storedReadSourceCounts.ts` | Native per-execution read-source totals, and the reading of stored totals |
| `storedReadSources.ts` / `sourceReferenceBudget.ts` | Checks of stored read sources against the record, under a work cap per value query |
| `sinkSettlement.ts` | `settleOnce` — settle a value or thenable once, never through the value's own `then` |
| `noteShape.ts`, `history*.ts`, `absentEntries.ts` | The saved-capture codecs — see below |
| `evidenceInput/`, `nativeExtent/`, `nativeClosure/` | Evidence input before privacy, native invocation extent, and the native closure data boundary — each folder has its own README |
| `subflowHandoff.ts`, `fanoutCollections.ts`, `subflowCapability.ts` | Native value-free boundary shapes, UTF-8 reference accounting, privacy serving and the bounded parent collection store; observations confer no semantic, inventory or storage receipt |
| `nativeRootReads.ts` | Optional backend native read observer lifetimes; no replacement scope, tree reconstruction or record encoding change |
| `sinkStats.ts` | Existing runtime sink accounting vocabulary, moved whole from the runtime facade |
| `index.ts` | A barrel for the retention, summary and hook helpers |


Record freezing and value-kind classification moved to foottrace. The engine imports `deepFreeze` / `freezeRecord` from `foottrace/write` and `serveRecord` from `foottrace`; this folder contains no second implementation. Input ownership remains the engine's `scope/protection/readonlyInput.ts` concern.

```typescript
import { summarizeWriteValue } from './summarize.js';

// What `writeTracking: 'summary'` keeps instead of the value: a marker, no clone.
summarizeWriteValue(['a', 'b', 'c']);
// → { __writeSummary: true, type: 'array', size: 3 }
```

Consumers meet this folder through the dials (`readTracking`, `writeTracking`, the deferred tier's `capture` option) and the public `RetentionPolicy` / marker types, not by importing it. Tests: `test/lib/capture/`.

`noteShape` is the single owner of shared own-data, identity, mode, channel and limitation validation for checkpoints and saved history. Boundary policy and checkpoint control downgrades remain in the respective callers. Which base limitations a version carries is one rule, `nativeCoverage.ts · baseLimitationsFor`: saved history requires them and a checkpoint copy adds them back.

With `explain(true)`, use `captureWitnessOf(snapshot)` from `footprintjs/explain` for the root
log. For a mount, pass the exact `snapshot.subflowResults[mountRuntimeStageId].treeContext`.
Pass the returned witness alongside that log's capture note to Foottrace. The engine takes the
witness from the served log and its native capture boundary. Copies and reopened records have
no live witness.

`historyTypes`, `historyTarget`, `historyNote` and `historyData` own the engine-specific saved-capture envelopes and bounded inert-data codecs. They do not implement causal analysis or generic stored-log sequencing.

`absentEntries` owns the bounded literal-path sidecar for immediate undefined tracked reads/writes, including collection during the existing inert copy and validation against that copied projection. It preserves observations lost by JSON omission without inventing exact read sources or walking causal links.

`readStoredCapture` serves those paths as `absent` on the saved-capture route. Each stage snapshot also keeps `undefinedReadKeys`, the names whose retained read values are `undefined`. This list survives ordinary snapshot JSON round trips and agrees with the sidecar's read paths after capture redaction and within its bounds. A masked read keeps its name in the served read map. The list covers reads because the read map otherwise holds their only names. The commit trace already records write names.

`subflowCapability.ts` owns only same-loaded-instance token admission and private weak associations with immutable policies. No structural callback field or extra parameter is added to the public advanced RunPolicy/runPolicy API. Derivation explicitly carries this private association; observation and checkpoint data never contains it. Adjacent capability tests and the native backend activation tests exercise raw refusal, public advanced forgery and lifecycle behavior.

The optional backend also owns `privateCaptureResult`: one projection of its input and collection fields, with unchanged raw-result identity when those channels are absent. Core serving still owns the existing mirror, read-source and output channels and caches by the original native result, so runtime/static twins share the same served object. Policy authority is resolved once in a runtime constructor and remains a private association, never a new instance field or structural callback.

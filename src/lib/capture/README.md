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
| `checkpointCapture.ts` | Small identity, mode, channel and limitation validators compose bounded own-data copying of a paused observation. Uses the producer's vocabularies; adds `checkpoint-history-not-included`; never promotes memory observations or missing recorder data to durable evidence |
| `sourceOwnershipFormat.ts` / `sourceOwnership.ts` | One versioned ownership vocabulary/ceiling and a bounded collector of actual native execution, invocation and first-commit facts. Namespaces come from the engine; selected source rows can only downgrade proof, never authorize it |
| `storedSourceOwnership.ts` | Consistency checks for inert stored ownership against native tree counts, first commits and source rows. Receipts and unkeyed fingerprints are not producer authentication |
| `readSources.ts` / `nativeSourceAddress.ts` | The engine's read-source coverage: the limitation vocabulary, the read capture note, and whether a log address can carry native read sources. Source descriptors and their codec belong to `foottrace/write` |
| `sourceReadCounts.ts` / `storedReadSourceCounts.ts` | Native per-execution read-source totals, and the reading of stored totals |
| `storedReadSources.ts` / `sourceReferenceBudget.ts` | Checks of stored read sources against the record, under a work cap per value query |
| `sinkSettlement.ts` | `settleOnce` — settle a value or thenable once, never through the value's own `then` |
| `noteShape.ts`, `history*.ts`, `absentEntries.ts` | The saved-capture codecs — see below |
| `evidenceInput/`, `nativeExtent/`, `nativeClosure/` | Evidence input before privacy, native invocation extent, and the native closure data boundary — each folder has its own README |
| `index.ts` | A barrel for the retention, summary and hook helpers |


Record freezing and value-kind classification moved to foottrace. The engine imports `deepFreeze` / `freezeRecord` from `foottrace/write` and `serveRecord` from `foottrace`; this folder contains no second implementation. Input ownership remains the engine's `scope/protection/readonlyInput.ts` concern.

```typescript
import { summarizeWriteValue } from './summarize.js';

// What `writeTracking: 'summary'` keeps instead of the value: a marker, no clone.
summarizeWriteValue(['a', 'b', 'c']);
// → { __writeSummary: true, type: 'array', size: 3 }
```

Consumers meet this folder through the dials (`readTracking`, `writeTracking`, the deferred tier's `capture` option) and the public `RetentionPolicy` / marker types, not by importing it. Tests: `test/lib/capture/`.

`noteShape` is the single owner of shared own-data, identity, mode, channel and limitation validation for checkpoints and saved history. Boundary policy, checkpoint control downgrades and base-limitation handling remain in the respective callers.

`historyTypes`, `historyTarget`, `historyNote` and `historyData` own the engine-specific saved-capture envelopes and bounded inert-data codecs. They do not implement causal analysis or generic stored-log sequencing.

`absentEntries` owns the bounded literal-path sidecar for immediate undefined tracked reads/writes, including collection during the existing inert copy and validation against that copied projection. It preserves observations lost by JSON omission without inventing exact read sources or walking causal links.

# src/ — the seven doors

`src/*.ts` is the public surface — layer L8 in the fence, so it may import anything — and each file is one entry of `package.json` `exports`. Everything else is in [`lib/`](./lib/README.md), one folder per job, ordered by layer.

| Import | File | What it is for |
|---|---|---|
| `footprintjs` | `index.ts` | start here: `flowChart`, `FlowChartExecutor`, `decide` / `select`, `interrupt`, the recorder classes, contracts, schema helpers |
| `footprintjs/recorders` | `recorders.ts` | factories for the built-in recorders: `narrative()`, `metrics()`, `debug()`, `manifest()`, `adaptive()`, `milestone()`, `windowed()` |
| `footprintjs/trace` | `trace.ts` | reading a finished run: the record's shapes (`CommitBundle`, `TraceEntry`, `MemoryPatch`, `ExecutionTree`), the `runtimeStageId` codec, commit-log queries and `applySmartMerge`, `causalChain`, `slice/` and `time-travel/`, the recorder stores |
| `footprintjs/write` | `write.ts` | writing a record yourself: the record layer the engine writes with — `SharedMemory`, `EventLog`, `RecordFrame` and their option types |
| `footprintjs/advanced` | `advanced.ts` | engine internals: `StageContext`, `FlowchartTraverser`, scope providers, the run policy and the redaction rule |
| `footprintjs/detach` | `detach.ts` | the fire-and-forget drivers |
| `footprintjs/zod` | `zod.ts` | opt-in zod scope helpers — zod is an optional peer, and the core never imports it |

**The laws.** *Every public symbol has one canonical door.* A symbol two doors both hand out is two things to document and keep in step, so `test/architecture/exports.test.ts` lists every one that is — resolving aliases to the declaration — and fails on an undeclared second door and on a stale entry; the list only shrinks. A new public symbol is wired through the barrel that *owns* it, never by `export *` chaining. *A minor never drops a published name*: when a symbol moves to its own door, the old door keeps it — the same symbol, a second door marked `keptUntil` in the export test — until the next major (C5 gave the record's names their own doors this way, keeping the `/advanced` ones; 10.0.0 removes them), and `test/architecture/published-doors.test.ts` fails on any name the last published release hands out that a door no longer does. *`/write` is engine-free*: every type it names is the record's own, and importing it loads no frame, scope or engine file (`test/architecture/write-door.test.ts`). *`/trace` loads only what it hands out* (C6): the record's readers and the recorder-side tools it has always handed out — never the writer, which is `/write`, and nothing of the engine (`test/esm-packaging.test.ts` holds its module graph to that list). *Zod never reaches the core barrels* — `test/api-conformance/zod-subpath.test.ts` fails if a zod helper appears on `footprintjs` or `footprintjs/advanced`. *The doors hold no logic*: they re-export (`recorders.ts` adds only the small factory functions), so a behaviour change lands in `lib/`, whose READMEs carry examples that `npm run check:doc-snippets` type-checks against these barrels.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';             // start here
import { narrative, metrics } from 'footprintjs/recorders';             // recorder factories
import { causalChain, parseRuntimeStageId } from 'footprintjs/trace';   // read a finished run
import { EventLog, RecordFrame } from 'footprintjs/write';              // write a record yourself
import { StageContext } from 'footprintjs/advanced';                    // engine internals
import { microtaskBatchDriver } from 'footprintjs/detach';              // fire-and-forget drivers
import { defineScopeFromZod } from 'footprintjs/zod';                   // opt-in; needs zod installed
```

Layer L8 (`scripts/layering.config.cjs`): may import any layer. See also the repo [`README.md`](../README.md) for the quick start and `CLAUDE.md` for the feature-work map.

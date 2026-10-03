# src/ — the six doors

`src/*.ts` is the public surface — layer L8 in the fence, so it may import anything — and each file is one entry of `package.json` `exports`. Everything else is in [`lib/`](./lib/README.md), one folder per job, ordered by layer.

| Import | File | What it is for |
|---|---|---|
| `footprintjs` | `index.ts` | start here: `flowChart`, `FlowChartExecutor`, `decide` / `select`, `interrupt`, the recorder classes, contracts, schema helpers |
| `footprintjs/recorders` | `recorders.ts` | factories for the built-in recorders: `narrative()`, `metrics()`, `debug()`, `manifest()`, `adaptive()`, `milestone()`, `windowed()` |
| `footprintjs/trace` | `trace.ts` | reading a finished run: the `runtimeStageId` codec, commit-log queries, `causalChain`, `slice/` and `time-travel/`, the recorder stores |
| `footprintjs/advanced` | `advanced.ts` | engine internals: `SharedMemory`, `StageContext`, `FlowchartTraverser`, scope providers |
| `footprintjs/detach` | `detach.ts` | the fire-and-forget drivers |
| `footprintjs/zod` | `zod.ts` | opt-in zod scope helpers — zod is an optional peer, and the core never imports it |

**The laws.** *Every public symbol has one canonical door.* A symbol two doors both hand out is two things to document and keep in step, so `test/architecture/exports.test.ts` lists every one that is — resolving aliases to the declaration — and fails on an undeclared second door and on a stale entry; the list only shrinks. A new public symbol is wired through the barrel that *owns* it, never by `export *` chaining: `/advanced` re-exports only a small hand-picked subset of `/trace`, so a new trace symbol does not flow through. *Zod never reaches the core barrels* — `test/api-conformance/zod-subpath.test.ts` fails if a zod helper appears on `footprintjs` or `footprintjs/advanced`. *The doors hold no logic*: they re-export (`recorders.ts` adds only the small factory functions), so a behaviour change lands in `lib/`, whose READMEs carry examples that `npm run check:doc-snippets` type-checks against these barrels.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';             // start here
import { narrative, metrics } from 'footprintjs/recorders';             // recorder factories
import { causalChain, parseRuntimeStageId } from 'footprintjs/trace';   // read a finished run
import { SharedMemory } from 'footprintjs/advanced';                    // engine internals
import { microtaskBatchDriver } from 'footprintjs/detach';              // fire-and-forget drivers
import { defineScopeFromZod } from 'footprintjs/zod';                   // opt-in; needs zod installed
```

Layer L8 (`scripts/layering.config.cjs`): may import any layer. See also the repo [`README.md`](../README.md) for the quick start and `CLAUDE.md` for the feature-work map.

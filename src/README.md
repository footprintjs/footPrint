# src/ — the six engine doors

`src/*.ts` is the engine's public surface — layer L8 in the fence — and each
file is one entry of `package.json` `exports`. Engine implementation lives in
[`lib/`](./lib/README.md). The separate `foottrace` package owns the record.

| Import | File | What it is for |
|---|---|---|
| `footprintjs` | `index.ts` | `flowChart`, `FlowChartExecutor`, `decide` / `select`, `interrupt`, recorder classes, contracts and schema helpers |
| `footprintjs/recorders` | `recorders.ts` | Built-in recorder factories |
| `footprintjs/trace` | `trace.ts` | Engine recorders, recorder stores and structure walkers |
| `footprintjs/advanced` | `advanced.ts` | Engine internals: `StageContext`, `FlowchartTraverser`, scope providers, run policy and redaction |
| `footprintjs/detach` | `detach.ts` | Fire-and-forget drivers |
| `footprintjs/zod` | `zod.ts` | Opt-in zod scope helpers; zod is an optional peer, never a core import |

Records have their own three doors: `foottrace` for shapes, IDs and readers,
`foottrace/write` for writer primitives, and `foottrace/paths` for path rules
and safe nested access. There is no `footprintjs/write` door or compatibility
re-export of a foottrace declaration.

**The laws.** Every public symbol has a canonical owner. The export tests resolve
aliases to declarations and reject undeclared duplicate doors and foreign
foottrace re-exports. The published-door guard still checks the last published
FootPrint surface: only the planned record extraction removals are allowed on
this major-preparation branch. It cannot merge or release before E5's consumer
migrations. Engine `/trace` loads only the recorders, stores, helpers and their
public foottrace dependencies that it uses; no private foottrace paths are
allowed. Zod never reaches the core barrels. Doors contain exports (plus the
small recorder factories), not alternative implementations.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { narrative, metrics } from 'footprintjs/recorders';
import { KeyedStore, qualityTrace } from 'footprintjs/trace';
import { causalChain, parseRuntimeStageId } from 'foottrace';
import { EventLog, RecordFrame } from 'foottrace/write';
import { setNestedValue } from 'foottrace/paths';
import { StageContext } from 'footprintjs/advanced';
import { microtaskBatchDriver } from 'footprintjs/detach';
import { defineScopeFromZod } from 'footprintjs/zod';
```

The layer table is `scripts/layering.config.cjs`; ownership and export guards
live in `test/architecture/`. See also the root [README](../README.md) and
`CLAUDE.md` for the feature-work map.

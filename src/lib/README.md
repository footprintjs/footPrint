# src/lib/ — the engine, by layer

A file imports only files at its own layer or below. The source of truth is
`scripts/layering.config.cjs`, enforced by `check:layering`, lint and architecture
tests. The most specific matching pattern assigns a file's layer; an unmatched
file is an error. New files in `memory/` need an explicit entry.

| Layer | Current engine responsibilities |
|---|---|
| L0 values and leaves | Capture summaries and hook invocation, schema, pause, errors, dev mode, engine ID refusal and generated-branch grammar, input ownership |
| L1 deferred delivery | `observer-queue/` |
| L2–L3 | Historical record layers; their implementations moved to foottrace |
| L4 frame and run policy | `memory/StageContext`, frame types, diagnostics, run addresses, redaction and policy; `runner/ExecutionRuntime` |
| L5 scope, recorders and hooks | Scope, reactive state access, decide, recorder stores and strategies, engine narrative |
| L6 traversal | Engine traverser, handlers, graph and traversal context |
| L7 builder and executor | Builder, runner lifecycle, contracts, detach and `walkSubflowSpec` |
| L8 entry points | The [six public engine barrels](../README.md) |

Only runtime imports form graph edges; the named upward type-only allowances
remain explicit because lint also sees type imports. Three runtime exceptions
remain live-checked: builder to `runner/RunnableChart.ts`, engine to
`reactive/handles.ts`, and `ScopeFacade` to `detach/spawn.ts`. Existing engine
shims are listed in `SHIMS` and cannot be imported by source files.

**The record has a separate owner.** FootPrint imports only named public symbols
from `foottrace`, `foottrace/write` or `foottrace/paths`. No record
implementation or compatibility re-export remains here. The closed-record fence
is now checked in foottrace itself; this repository checks the consumer boundary
and the engine witnesses. Historical `RECORD_FILES` classifications and the
44-file/74-test manifest are retained only for extraction evidence, fixture
analysis and co-change history, not as a local implementation to extend.

```js
const { rankOf } = require('./scripts/layering.config.cjs');

rankOf('src/lib/ids/reservedIds.ts');                     // 0 — the engine's ID refusal
rankOf('src/lib/memory/StageContext.ts');                 // 4 — composes a foottrace RecordFrame
rankOf('src/lib/engine/narrative/types.ts');              // 5 — the flow channel
rankOf('src/lib/engine/traversal/FlowchartTraverser.ts');  // 6 — the walker
```

See [memory](./memory/README.md) for engine/record composition and the root
`CLAUDE.md` for change impact. The [slice](./slice/README.md) and
[time-travel](./time-travel/README.md) pages link to their canonical foottrace
contracts.

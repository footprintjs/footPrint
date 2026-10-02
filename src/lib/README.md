# src/lib/ — the library, by layer

Every folder here does one job and sits on a layer; **a file imports only files at its own layer or below**. The table is data, `scripts/layering.config.cjs`, and it is enforced rather than described: `npm run check:layering` fails on a value-level cycle or an upward runtime edge, and the `import/no-restricted-paths` zones in `.eslintrc.js` say the same thing at lint time (`test/architecture/layering.test.ts` pins that the real tree is clean). A file takes the most specific pattern that matches it, and a file no pattern matches is an error — which is why a new file in the multi-layer folders below is placed by hand.

| Layer | What lives there | The job |
|---|---|---|
| L0 values and leaves | [`capture/`](./capture/README.md), [`schema/`](./schema/README.md), [`pause/`](./pause/README.md), `devMode.ts`; the leaves of `memory/`, `engine/` and `scope/` | address, compare and summarise a value; the id grammar |
| L1 verbs | [`observer-queue/`](./observer-queue/README.md), [`engine/errors/`](./engine/errors/README.md), `memory/verbs.ts` | the one law that turns a trace row into a value; deferred delivery; error info |
| L2 staging and commit | [`memory/`](./memory/README.md) — `TransactionBuffer`, `SharedMemory`, `redaction` | one stage's ops become one net-change bundle |
| L3 the log as a read model | [`slice/`](./slice/README.md), [`time-travel/`](./time-travel/README.md), `memory/` — `EventLog`, `backtrack` | what a finished log can honestly say |
| L4 the frame and run policy | `memory/StageContext`, `runner/ExecutionRuntime` | one stage's frame; the run's runtime |
| L5 scope, recorders, hooks | [`scope/`](./scope/README.md), [`reactive/`](./reactive/README.md), [`decide/`](./decide/README.md), [`recorder/`](./recorder/README.md), [`engine/narrative/`](./engine/narrative/README.md) | what a stage may do; how every event reaches every recorder |
| L6 engine | [`engine/`](./engine/README.md) — traverser, handlers, graph | walking the chart: one phase chain, one id grammar |
| L7 builder and executor | [`builder/`](./builder/README.md), [`runner/`](./runner/README.md), [`contract/`](./contract/README.md), [`detach/`](./detach/README.md) | the DSL and the run lifecycle |
| L8 entry points | [`src/*.ts`](../README.md) | the public barrels; may import anything |

**The laws.** Only *runtime* imports are edges: a type-only import is erased by `tsc`, and the four upward ones that exist are listed in `TYPE_ONLY_ALLOWANCES` (a list that only shrinks). Three runtime edges are named on purpose — `builder/` → `runner/RunnableChart.ts` (a built chart becomes runnable there), `engine/**` → `reactive/handles.ts` (the registry of the scope's own proxies) and `scope/ScopeFacade.ts` → `detach/spawn.ts` (the scope's `$detachAndJoinLater` / `$detachAndForget`) — and the script fails if one stops existing. Four folders span layers and are placed file by file: `memory/` (L0–L4), `engine/` (L0, L1, L5, L6, and one L7 file), `runner/` (L4, L7) and `scope/` (L0, L5). Old import paths kept as re-exports are listed as `SHIMS`; nothing under `src/` may import them.

```js
const { rankOf } = require('./scripts/layering.config.cjs');

rankOf('src/lib/memory/verbs.ts');                         // 1 — the verb law, beside the leaves it reads
rankOf('src/lib/engine/narrative/types.ts');               // 5 — the flow channel sits with the recorders...
rankOf('src/lib/engine/traversal/FlowchartTraverser.ts');  // 6 — ...below the walker that fires it
```

Layer L8 is `src/*.ts` — see [`../README.md`](../README.md) for the six doors, and `CLAUDE.md` at the repo root for the feature-work map (blast radius per change).

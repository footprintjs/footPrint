# src/lib/ — the library, by layer

Every folder here does one job and sits on a layer; **a file imports only files at its own layer or below**. The table is data, `scripts/layering.config.cjs`, and it is enforced rather than described: `npm run check:layering` fails on a value-level cycle or an upward runtime edge, and the `import/no-restricted-paths` zones in `.eslintrc.js` say the same thing at lint time (`test/architecture/layering.test.ts` pins that the real tree is clean). A file takes the most specific pattern that matches it, and a file no pattern matches is an error: a new file in a folder that has a directory pattern inherits its layer — except `memory/`, which has none (it spans L0–L4) — while a file directly under `src/lib/` or in a new folder must be added to `LAYERS` by hand.

| Layer | What lives there | The job |
|---|---|---|
| L0 values and leaves | [`capture/`](./capture/README.md), [`schema/`](./schema/README.md), [`pause/`](./pause/README.md), [`errors/`](./errors/README.md), `devMode.ts`; the leaves of `memory/`, `engine/` and `scope/` | address, compare and summarise a value; the id grammar; error info |
| L1 verbs | [`observer-queue/`](./observer-queue/README.md), `memory/verbs.ts` | the one law that turns a trace row into a value; deferred delivery |
| L2 staging and commit | [`memory/`](./memory/README.md) — `TransactionBuffer`, `SharedMemory`, `scrub` | one stage's ops become one net-change bundle |
| L3 the log as a read model | [`slice/`](./slice/README.md), [`time-travel/`](./time-travel/README.md), `memory/` — `EventLog`, `RecordFrame`, `backtrack`; `recorder/CommitRangeIndex` | what a finished log can honestly say |
| L4 the frame and run policy | `memory/StageContext` (and its types, `frameTypes`), `runPolicy`, `redaction`; `runner/ExecutionRuntime` | one stage's frame; the run's policy and verdict; the run's runtime |
| L5 scope, recorders, hooks | [`scope/`](./scope/README.md), [`reactive/`](./reactive/README.md), [`decide/`](./decide/README.md), [`recorder/`](./recorder/README.md), [`engine/narrative/`](./engine/narrative/README.md) | what a stage may do; how every event reaches every recorder |
| L6 engine | [`engine/`](./engine/README.md) — traverser, handlers, graph | walking the chart: one phase chain, one id grammar |
| L7 builder and executor | [`builder/`](./builder/README.md), [`runner/`](./runner/README.md), [`contract/`](./contract/README.md), [`detach/`](./detach/README.md) | the DSL and the run lifecycle |
| L8 entry points | [`src/*.ts`](../README.md) | the public barrels; may import anything |

**The laws.** Only *runtime* imports are edges: a type-only import is erased by `tsc`, and the three upward `import type` declarations that exist are listed in `TYPE_ONLY_ALLOWANCES`, because ESLint cannot tell them from runtime imports (a list that only shrinks; none starts below L4 since C6). Three runtime edges are named on purpose — `builder/` → `runner/RunnableChart.ts` (a built chart becomes runnable there), `engine/**` → `reactive/handles.ts` (the registry of the scope's own proxies) and `scope/ScopeFacade.ts` → `detach/spawn.ts` (the scope's `$detachAndJoinLater` / `$detachAndForget`) — and the script fails if one stops existing. Five folders span layers and are placed file by file: `memory/` (L0–L4), `engine/` (L0, L1, L5, L6, and one L7 file), `runner/` (L4, L7), `scope/` (L0, L5) and `recorder/` (L3 for `CommitRangeIndex`, a record file; L5 for the rest). Old import paths kept as re-exports are listed as `SHIMS`; nothing under `src/` may import them.

**The second rule (C6): the record is closed.** `RECORD_FILES` in the same config is the record — the 44 files a trace package would hold (the record's types, the verb law and its leaves, staging and commit, the log, the record half of the frame, every reader of the log; all at L0–L3). A record file imports only record files, and here every import counts, `import type` included: a package cut along the list must compile on its own. `npm run check:layering` fails on an import out of the set (`recordEscapes`), on an entry that matches no file and on a record file above L3, and compiles the record files on their own: that program must load no other file and report no diagnostic (an `import('…')` type reference or a package import shows up there). The ESLint zone checks the imports at lint time. A new file that is the record's goes into `RECORD_FILES` as well as `LAYERS`. The engine may import the record, never the reverse. See [`memory/README.md`](./memory/README.md#the-record-is-closed--record_files-c6) for what C6 moved to close it.

```js
const { rankOf, isRecordFile } = require('./scripts/layering.config.cjs');

rankOf('src/lib/memory/verbs.ts');                         // 1 — the verb law, beside the leaves it reads
rankOf('src/lib/engine/narrative/types.ts');               // 5 — the flow channel sits with the recorders...
rankOf('src/lib/engine/traversal/FlowchartTraverser.ts');  // 6 — ...below the walker that fires it

isRecordFile('src/lib/ids/runtimeStageId.ts');  // true  — the grammar: build, parse, read
isRecordFile('src/lib/ids/reservedIds.ts');     // false — the engine's id doors' refusal
isRecordFile('src/lib/memory/frameTypes.ts');   // false — the frame's types (StageSnapshot), L4
```

Layer L8 is `src/*.ts` — see [`../README.md`](../README.md) for the seven doors, and `CLAUDE.md` at the repo root for the feature-work map (blast radius per change).

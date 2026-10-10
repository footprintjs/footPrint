# capture/ — keep something about a value without holding it

The leaf helpers every layer shares to **record a value cheaply** (a marker, a one-line summary, a frozen envelope) and to **call a recorder's hook**. They sit at the bottom of the stack so `memory/`, `scope/`, `decide/`, `engine/narrative/`, `runner/` and `observer-queue/` can use the same code without importing each other.

**The law: a leaf.** Nothing in this folder imports anything in `src/lib` outside `capture/` (one file, `envelope.ts`, imports a sibling, `summarize.ts`). The layer table puts `capture/**` at L0, the bottom (`scripts/layering.config.cjs`), and `npm run check:layering` plus the ESLint zones fail an import that reaches upward from it. Keep the stricter shape: a new file here imports nothing outside this folder — if it needs the engine, it does not belong here.

| File | Owns |
|---|---|
| `ownData.ts` | Private own-slot placement shared by record copies, merges, path writes, diagnostics and transaction privatization. `putOwn` retains native assignment semantics except that missing inherited names become own data; `setOwnValue` requires every missing diagnostic slot to be created. The distinction matters for invalid typed-array indices. Existing own accessors/descriptors retain their semantics; denied selectors belong to `memory/pathOps.ts`, not this payload primitive. |
| `policies.ts` | `RetentionPolicy` — `'full' \| 'summary' \| 'off'`, the vocabulary behind the `readTracking` and `writeTracking` dials |
| `summarize.ts` | `summarizeReadValue` / `summarizeWriteValue` — the O(1) markers a `'summary'` retention keeps (type, size, an 80-character preview); `summarizeValue` — the one-line narrative form; the preview-length constants |
| `envelope.ts` | The deferred-observer capture tier: `capture()` snapshots an event into a frozen `CaptureEnvelope` under `'summary' \| 'clone' \| 'ref'`; `summarizePayload` is the bounded summary (depth 3, 16 entries, 128 nodes). `observer-queue/` imports it directly — it is not in the barrel |
| `circular.ts` | `hasCircularReference` — the dev-mode cycle probe |
| `invokeHook.ts` | `invokeRecorderHook` — look up a hook, bind `this`, call it. The one primitive the inline and the deferred delivery tiers both use, so they cannot drift |
| `freeze.ts` | `deepFreeze` — the deep-freeze walk (iterative since 9.44.2): the dev-mode snapshot and every state `stateAt` hands out — fresh trees, each its caller's own. It stops at an already-frozen object, skips typed arrays (a non-empty one cannot be frozen), and can walk arrays by index (`'indices'`). `freezeRecord` / `serveRecord` (9.44.2) — the commit log's serve-time law, freeze what can be frozen and copy what can't: `freezeRecord` freezes a commit bundle (`EventLog · record`) or the fold base, remembers that it holds a value freezing cannot seal (a Date, Map, Set, RegExp, Error, buffer or view) and stores a view over a slice of a bigger buffer as a copy of the bytes it views; `serveRecord` serves a record freezing sealed whole as itself, any other as a copy of its open paths only (the containers on the way to each such value, mapped at its first serve), every other part shared. Served at `runner/snapshot.ts · servedSnapshot` and `EventLog.list()`, never on the run path. Args instead use `scope/protection/readonlyInput.ts` to copy owned containers without freezing borrowed caller objects |
| `valueKinds.ts` | `kindOf` — the ONE classifier of what kind of value a record holds (a built-in by its brand — its tag, then one brand-checked read, so a fake with the prototype or the tag is not one; any other object by what its clone is, once per prototype), and `SEALABLE` — which kinds `Object.freeze` seals. Read by `memory/equality.ts` (what counts as a change, one arm per kind) and `freeze.ts` (what a served record must copy) |

```typescript
import { summarizeWriteValue } from './summarize.js';

// What `writeTracking: 'summary'` keeps instead of the value: a marker, no clone.
summarizeWriteValue(['a', 'b', 'c']);
// → { __writeSummary: true, type: 'array', size: 3 }
```

Consumers meet this folder through the dials (`readTracking`, `writeTracking`, the deferred tier's `capture` option) and the public `RetentionPolicy` / marker types, not by importing it. Tests: `test/lib/capture/`.

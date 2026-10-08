# capture/ — keep something about a value without holding it

The leaf helpers every layer shares to **record a value cheaply** (a marker, a one-line summary, a frozen envelope) and to **call a recorder's hook**. They sit at the bottom of the stack so `memory/`, `scope/`, `decide/`, `engine/narrative/`, `runner/` and `observer-queue/` can use the same code without importing each other.

**The law: a leaf.** Nothing in this folder imports anything in `src/lib` outside `capture/` (one file, `envelope.ts`, imports a sibling, `summarize.ts`). The layer table puts `capture/**` at L0, the bottom (`scripts/layering.config.cjs`), and `npm run check:layering` plus the ESLint zones fail an import that reaches upward from it. Keep the stricter shape: a new file here imports nothing outside this folder — if it needs the engine, it does not belong here.

| File | Owns |
|---|---|
| `policies.ts` | `RetentionPolicy` — `'full' \| 'summary' \| 'off'`, the vocabulary behind the `readTracking` and `writeTracking` dials |
| `summarize.ts` | `summarizeReadValue` / `summarizeWriteValue` — the O(1) markers a `'summary'` retention keeps (type, size, an 80-character preview); `summarizeValue` — the one-line narrative form; the preview-length constants |
| `envelope.ts` | The deferred-observer capture tier: `capture()` snapshots an event into a frozen `CaptureEnvelope` under `'summary' \| 'clone' \| 'ref'`; `summarizePayload` is the bounded summary (depth 3, 16 entries, 128 nodes). `observer-queue/` imports it directly — it is not in the barrel |
| `circular.ts` | `hasCircularReference` — the dev-mode cycle probe |
| `invokeHook.ts` | `invokeRecorderHook` — look up a hook, bind `this`, call it. The one primitive the inline and the deferred delivery tiers both use, so they cannot drift |
| `freeze.ts` | `deepFreeze` — the in-place deep-freeze walk: the served fold base, the dev-mode snapshot, every state `stateAt` hands out, and every commit bundle (`EventLog · record`, F3). It stops at an already-frozen object, skips typed arrays (a non-empty one cannot be frozen), and walks arrays by index for the record (`'indices'`: an object on an array expando is the named hole). `freezeRecord` / `serveRecord` (9.45.0) — freeze what can be frozen, copy what can't: a record served to many readers (a commit bundle, the fold base, a retained read or write, a subflow's stored tree) that holds a value freezing cannot seal is served as a fresh frozen copy each time, any other as itself. `serveCopy` — a value the library keeps but cannot freeze in place (a diagnostic bag, a recorder row, a chart structure) is served as a fresh copy. Args instead use `scope/protection/readonlyInput.ts` to copy owned containers without freezing borrowed caller objects |
| `valueKinds.ts` | `kindOf` — the ONE classifier of what kind of value a record holds (a prototype lookup for the built-ins; any other object by what its clone is, once per prototype), and `SEALABLE` — which kinds `Object.freeze` seals. Read by `memory/equality.ts` (what counts as a change, one arm per kind) and `freeze.ts` (what a served record must copy) |

```typescript
import { summarizeWriteValue } from './summarize.js';

// What `writeTracking: 'summary'` keeps instead of the value: a marker, no clone.
summarizeWriteValue(['a', 'b', 'c']);
// → { __writeSummary: true, type: 'array', size: 3 }
```

Consumers meet this folder through the dials (`readTracking`, `writeTracking`, the deferred tier's `capture` option) and the public `RetentionPolicy` / marker types, not by importing it. Tests: `test/lib/capture/`.

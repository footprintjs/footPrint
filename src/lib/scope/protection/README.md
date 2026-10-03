# scope/protection/ — keep a stage from writing around its scope

Two guard rails. `createProtectedScope` wraps a raw (class- or factory-built) scope in a Proxy whose `set` trap refuses — or warns about — a direct assignment such as `scope.total = 5`: every stage gets a *new* scope, so a plain property would vanish with it, and the message points at `setValue()`. `readonlyInput.ts` guards the run's input: `createFrozenArgs` (a frozen shallow copy of the input, taken once) and `assertNotReadonly` (writing or deleting an input key throws). The freeze walk itself, `deepFreeze`, lives in `capture/freeze.ts` since 9.33.0 — the commit log freezes every bundle with it at `EventLog · record`, and `memory/` must not import `scope/`. The folder owns the guards; it does not own the scope (`scope/ScopeFacade.ts`; a `reactive/` TypedScope has its own set traps and is never wrapped) or the writes themselves (`memory/StageContext`).

**The laws.**

- *Protection is a mode, not a mood*: `'error'` (the default, set in `FlowchartTraverser`), `'warn'` (log, then allow) or `'off'`, chosen with the `scopeProtectionMode` executor option and applied by `StageRunner` to raw scopes only (`test/lib/scope/unit/protection.test.ts`).
- *Input has one door.* `ScopeFacade` and `attachScopeMethods` both read args through `createFrozenArgs` and gate writes through `assertNotReadonly`, so a class-built and a factory-built scope cannot disagree; the check asks `hasOwnProperty` on that object, so an inherited or polluted key is not an input key (`test/lib/scope/security/readonly-enforcement.test.ts`, `test/lib/scope/property/readonly-invariants.test.ts`).
- *Known gap — the input's nested values are frozen in place.* `createFrozenArgs` copies only the top level and then `deepFreeze`s that copy, so every nested object and array in it is the caller's own value, frozen as a side effect: after `run({ input })` the caller's `input.user` is frozen, though `input` itself is not. Since 9.33.0 the walk also descends an object the caller had frozen only shallowly, so its children are frozen too; a typed array in the input is skipped (it cannot be frozen — the freeze used to throw on it).
- *`readonlyInput.ts` is a leaf.* The layer table keeps it at L0: it imports only `capture/freeze.ts` (L0); the other files here are L5.

```typescript
import { createProtectedScope } from 'footprintjs/advanced';

const scope = createProtectedScope<Record<string, unknown>>({}, { mode: 'error', stageName: 'Charge' });

try {
  scope.total = 5;
} catch (error) {
  console.log((error as Error).message.split('\n')[0]); // [Scope Access Error] Direct property assignment detected in stage "Charge".
}
```

Layer: `createProtectedScope.ts` and `types.ts` are L5 (`scripts/layering.config.cjs`) and import nothing; `readonlyInput.ts` is L0 and imports only `capture/freeze.ts`. `createProtectedScope` is on `footprintjs/advanced`; `scope/providers/` and `scope/ScopeFacade.ts` import `readonlyInput`. See also [`../README.md`](../README.md).

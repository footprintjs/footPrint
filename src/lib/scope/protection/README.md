# scope/protection/ — keep a stage from writing around its scope

Two guard rails. `createProtectedScope` wraps a raw (class- or factory-built) scope in a Proxy whose `set` trap refuses — or warns about — a direct assignment such as `scope.total = 5`: every stage gets a *new* scope, so a plain property would vanish with it, and the message points at `setValue()`. `readonlyInput.ts` guards the run's input: `createFrozenArgs` (a frozen shallow copy of the input, taken once), `assertNotReadonly` (writing or deleting an input key throws) and `deepFreeze`. The folder owns the guards; it does not own the scope (`scope/ScopeFacade.ts`; a `reactive/` TypedScope has its own set traps and is never wrapped) or the writes themselves (`memory/StageContext`).

**The laws.**

- *Protection is a mode, not a mood*: `'error'` (the default, set in `FlowchartTraverser`), `'warn'` (log, then allow) or `'off'`, chosen with the `scopeProtectionMode` executor option and applied by `StageRunner` to raw scopes only (`test/lib/scope/unit/protection.test.ts`).
- *Input has one door.* `ScopeFacade` and `attachScopeMethods` both read args through `createFrozenArgs` and gate writes through `assertNotReadonly`, so a class-built and a factory-built scope cannot disagree; the check asks `hasOwnProperty` on that object, so an inherited or polluted key is not an input key (`test/lib/scope/security/readonly-enforcement.test.ts`, `test/lib/scope/property/readonly-invariants.test.ts`).
- *Known gap — the input's nested values are frozen in place.* `createFrozenArgs` copies only the top level and then `deepFreeze`s that copy, so every nested object and array in it is the caller's own value, frozen as a side effect: after `run({ input })` the caller's `input.user` is frozen, though `input` itself is not.
- *`readonlyInput.ts` is a pure leaf.* The layer table puts it at L0 because the runtime (L4) freezes its fold base with `deepFreeze` and the executor freezes a snapshot's `sharedState` with it; the other files here are L5.

```typescript
import { createProtectedScope } from 'footprintjs/advanced';

const scope = createProtectedScope<Record<string, unknown>>({}, { mode: 'error', stageName: 'Charge' });

try {
  scope.total = 5;
} catch (error) {
  console.log((error as Error).message.split('\n')[0]); // [Scope Access Error] Direct property assignment detected in stage "Charge".
}
```

Layer: `createProtectedScope.ts` and `types.ts` are L5 (`scripts/layering.config.cjs`) and import nothing; `readonlyInput.ts` is L0 and imports nothing. `createProtectedScope` is on `footprintjs/advanced`; `scope/providers/` and `scope/ScopeFacade.ts` import `readonlyInput`. See also [`../README.md`](../README.md).

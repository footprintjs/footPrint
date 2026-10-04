# scope/protection/ — keep a stage from writing around its scope

Two guard rails. `createProtectedScope` wraps a raw (class- or factory-built) scope in a Proxy whose `set` trap refuses — or warns about — a direct assignment such as `scope.total = 5`: every stage gets a *new* scope, so a plain property would vanish with it, and the message points at `setValue()`. `readonlyInput.ts` owns the argument boundary: `createFrozenArgs` copies and freezes owned data containers without freezing caller objects; `assertNotReadonly` refuses writes or deletes to the original input's own keys. The folder does not own the scope (`scope/ScopeFacade.ts`; a `reactive/` TypedScope has its own set traps and is never wrapped) or writes (`memory/StageContext`). Saved records still use the separate in-place freezer, `capture/freeze.ts · deepFreeze`.

**The laws.**

- *Protection is a mode, not a mood*: `'error'` (the default, set in `FlowchartTraverser`), `'warn'` (log, then allow) or `'off'`, chosen with the `scopeProtectionMode` executor option and applied by `StageRunner` to raw scopes only (`test/lib/scope/unit/protection.test.ts`).
- *Input has one door.* `ScopeFacade` and `attachScopeMethods` both read args through `createFrozenArgs` and gate writes through `assertNotReadonly`, so a class-built and a factory-built scope cannot disagree; the check asks `hasOwnProperty` on that object, so an inherited or polluted key is not an input key (`test/lib/scope/security/readonly-enforcement.test.ts`, `test/lib/scope/property/readonly-invariants.test.ts`).
- *Freeze owned containers, not borrowed capabilities.* Mutable ordinary records (`Object.prototype` or null prototype) and arrays (`Array.prototype` or null prototype) are copied and frozen in one memoized walk. Cycles and repeated references close within the owned graph. Functions, other prototypes (including array subclasses, services, signals, Dates, Maps, Sets, buffers and views), and explicitly frozen nested objects keep their identity and are not traversed. These borrowed values remain live; `getArgs()` is not a sandbox or a claim that native internal slots are immutable. A frozen wrapper deliberately remains a borrowing boundary, including its mutable descendants.
- *Capture once per scope, not per run.* Both scope doors cache the result at construction; repeated `getArgs()` calls allocate nothing. A later scope captures caller edits afresh. Readonly-key checks still consult the original input, including non-enumerable own keys. No global input cache or change to custom scope-factory arguments is involved.
- *Preserve shape and make accessors explicit.* The root remains a plain record containing only own enumerable string and symbol keys (even when input is an array). Owned nested containers preserve their own keys, enumerability, null prototypes, array holes and expandos. Their getters are evaluated once and replaced by captured data properties. An accessor failure propagates; the library never freezes caller objects along the failed path. Own `__proto__` keys are defined as data, never assigned through a prototype setter.
- *`readonlyInput.ts` is a leaf.* The layer table keeps it at L0 with no imports; the other files here are L5.

The ownership walk costs O(owned nodes + own properties) **per scope**, not once per run. Previously, freezing caller values made later steps skip their descendants; removing that side effect requires fresh copies. A memo avoids copying an aliased subgraph more than once in a scope. Use small input/data references for large datasets, or explicitly frozen boundaries only when shared live data is intentional. `bench/input-ownership.ts` measures construction, aliases, borrowed boundaries and cached reads; changing capture to once per run would need a separate lifecycle contract.

Migration: do not depend on `getArgs().nested === input.nested` or on a run freezing your own input. Snapshot accessors no longer execute on later reads. Put infrastructure signals in `$getEnv()`; borrowed services and native collections remain callable but are not isolated data. Regression coverage: `test/lib/scope/security/input-ownership.test.ts` and `test/lib/scope/scenario/input-ownership.test.ts`.

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

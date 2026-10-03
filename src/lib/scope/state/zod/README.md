# scope/state/zod/ — a scope built from a Zod schema

`defineScopeFromZod(schema, { strict })` returns a `ScopeFactory`; `createScopeProxyFromZod(ctx, schema, strict, readOnly)` is the proxy it builds for each stage — a lazy view of the stage's state shaped by a `z.object`. A scalar field is a node with `get` / `exists` / `set`; arrays add `push`, records add `at` / `keys` / `merge`, nested objects expose their own fields; a write is validated against that field's schema first. `ZodScopeResolver` claims *branded* schemas, which only `defineScopeSchema` (`schema/builder.ts`) mints; `utils/validateHelper.ts` holds the Zod helpers (`unwrap`, `parseWithThis`, …) the proxy builds on. The folder owns the schema-backed scope; it does not own the registry that finds resolvers (`scope/providers/`) or the engine's scope wiring.

**The laws.**

- *Validate before write, as `strict` says.* `'off'` skips validation, `'warn'` (the default) records a `'schema'` error on the context and drops the write, `'deny'` throws — a rejected value never reaches the buffer (`scopeFactory.ts · validateOnWrite`; `test/lib/scope/property/zod-rejects-invalid-writes.test.ts` pins only that `deny` throws and `warn` / `off` do not).
- *An unknown field is an error, not `undefined`.* The proxy's `get` trap throws on any string key outside the schema — bar the probes it answers (`then`, `asymmetricMatch`, `constructor`, `get`, `exists`, `toJSON`, `ro`, `Symbol.toStringTag`) and the methods `attachScopeMethods` adds; other symbol keys read as `undefined` (`test/lib/scope/scenario/zod-validated-scope.test.ts`).
- *Detection is by shape, structure is by `instanceof`.* `schema/detect` recognises a v3 (`_def`) and a v4 (`def`) schema alike, but `scopeFactory.ts · analyze` builds the proxy's fields with `instanceof z.ZodObject` / `ZodRecord` / `ZodArray` from the *installed* zod, so a schema from another zod copy or from `zod/v3` is detected yet comes out as a scalar root whose fields read `undefined`; wrappers are another matter, see the second known gap. Zod is imported here and nowhere in the core, behind `footprintjs/zod` (`test/api-conformance/zod-subpath.test.ts`).

**Known gap — the executor.** Because of that throwing `get` trap, a scope from `defineScopeFromZod` fails the first stage under `FlowChartExecutor`: `runner/attach.ts · RunObservers · composeScopeFactory` wraps every scope factory and probes the scope with `typeof scope.useSharedRedactedKeys === 'function'`, and the proxy answers `Unknown field 'useSharedRedactedKeys' under <root>`. The tests drive the proxy through a stub `StageContextLike`, never through the executor, so nothing catches it today.

**Known gap — Zod 4 wrappers.** `utils/validateHelper.ts · unwrap` recognises a wrapper only by the Zod v3 `_def.typeName` (`ZodOptional`, `ZodNullable`, `ZodDefault`, …); a Zod 4 schema carries `def.type` instead, so on the installed Zod 4.4.3 `unwrap` returns the wrapper itself and `scopeFactory.ts · analyze` treats an optional, nullable or defaulted array, record or object as a scalar: `z.array(z.string()).optional()` gets `get` / `exists` / `set` but no `push`, an optional object exposes no fields. `test/lib/scope/unit/validateHelper.test.ts` only asserts that `unwrap` does not return `null`, so it cannot see this.

```typescript
import { z } from 'zod';
import { defineScopeSchema, isScopeSchema, ZodScopeResolver } from 'footprintjs/zod';

const branded = defineScopeSchema({ score: z.number() }); // strict, and branded
isScopeSchema(branded);                                   // true
isScopeSchema(z.object({ score: z.number() }));           // false — a plain Zod object is not a scope schema
ZodScopeResolver.canHandle(branded);                      // true — what `registerScopeResolver(ZodScopeResolver)` would claim
```

Layer L5 (`scripts/layering.config.cjs`): imports `scope/providers/` (`attachScopeMethods`, the provider types) and `schema/detect` (L0), plus `zod`. Public only through `footprintjs/zod`. Sub-folders: [`schema/`](./schema/README.md), [`utils/`](./utils/README.md). See also [`../README.md`](../README.md).

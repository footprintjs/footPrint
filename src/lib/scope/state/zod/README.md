# scope/state/zod/ — a scope built from a Zod schema

`defineScopeFromZod(schema, { strict })` returns a `ScopeFactory`; `createScopeProxyFromZod(ctx, schema, strict, readOnly)` is the proxy it builds for each stage — a lazy, copy-on-write view of the shared state shaped by a `z.object`. Each field is a node with `get` / `exists` / `set` (arrays add `push`; records add `at`, `keys`, `merge`), and a write is validated against that field's schema first. `ZodScopeResolver` claims *branded* schemas, which only `defineScopeSchema` (`schema/builder.ts`) mints; `utils/validateHelper.ts` holds the cross-version Zod helpers. The folder owns the schema-backed scope; it does not own the registry that finds resolvers (`scope/providers/`) or the engine's scope wiring.

**The laws.**

- *Validate before write, as `strict` says.* `'off'` skips validation, `'warn'` (the default) records a `'schema'` error on the context and drops the write, `'deny'` throws — a rejected value never reaches the buffer (`test/lib/scope/property/zod-rejects-invalid-writes.test.ts`).
- *An unknown field is an error, not `undefined`.* The proxy's `get` trap throws on any string key outside the schema (`test/lib/scope/scenario/zod-validated-scope.test.ts`).
- *Zod is detected by shape* through `schema/detect`, so v3 `_def` and v4 `def` schemas both work (`test/lib/scope/unit/validateHelper.test.ts`); it is imported here and nowhere in the core, behind `footprintjs/zod` (`test/api-conformance/zod-subpath.test.ts`).

**Known gap.** Because of that throwing `get` trap, a scope from `defineScopeFromZod` fails the first stage under `FlowChartExecutor`: `FlowChartExecutor · createTraverser` wraps every scope factory and probes the scope with `typeof scope.useSharedRedactedKeys === 'function'`, and the proxy answers `Unknown field 'useSharedRedactedKeys' under <root>`. The tests drive the proxy through a stub `StageContextLike`, never through the executor, so nothing catches it today.

```typescript
import { z } from 'zod';
import { defineScopeSchema, isScopeSchema, ZodScopeResolver } from 'footprintjs/zod';

const branded = defineScopeSchema({ score: z.number() }); // strict, and branded
isScopeSchema(branded);                                   // true
isScopeSchema(z.object({ score: z.number() }));           // false — a plain Zod object is not a scope schema
ZodScopeResolver.canHandle(branded);                      // true — what `registerScopeResolver(ZodScopeResolver)` would claim
```

Layer L5 (`scripts/layering.config.cjs`): imports `scope/providers/` (`attachScopeMethods`, the provider types) and `schema/detect` (L0), plus `zod`. Public only through `footprintjs/zod`. Sub-folders: [`schema/`](./schema/README.md), [`utils/`](./utils/README.md). See also [`../README.md`](../README.md).

# scope/state/zod/ — a scope built from a Zod schema

`defineScopeFromZod(schema, { strict })` returns an executor-ready `ScopeFactory`. Each stage gets one `ScopeFacade` and a lazy schema-shaped proxy over its path-aware accessors. A scalar field has `get` / `exists` / `set`; arrays add `push`, records add `at` / `keys` / `merge`, and nested objects expose their fields. Validation belongs here; recording, redaction, argument ownership and handle lifetime belong to the facade. `ZodScopeResolver` delegates to that same factory for branded schemas from `defineScopeSchema`.

**The laws.**

- _Validate before write, as `strict` says._ `'off'` skips validation, `'warn'` (the default) records a `'schema'` error on the context and drops the write, `'deny'` throws — a rejected value never reaches the buffer (`scopeFactory.ts · validateOnWrite`; `test/lib/scope/property/zod-rejects-invalid-writes.test.ts` pins only that `deny` throws and `warn` / `off` do not).
- _An unknown field is an error, not `undefined`._ The proxy still throws on undeclared string fields. Object-node names `get`, `exists`, `then`, `asymmetricMatch`, `constructor` and `toJSON` are reserved; root `ro` and the convenience methods listed in `scope/providers/baseStateCompatible.ts` are reserved too. Construction refuses a collision instead of hiding the field. Lifecycle names such as `notifyStageStart` are valid data fields: the engine never probes them on the proxy.
- _Structure is version-neutral; validation keeps the original schema._ `utils/validateHelper.ts` reads classic Zod 3/4 metadata, not installed constructors. Known wrappers are peeled only to identify object, array and record structure. Writes validate against the original schema, preserving optionality, nullability and refinements. Parsing is a check, not a transformation: defaults/transforms are not substituted into stored values. Array mutations and record `set`/`merge` validate the proposed collection; nested field writes validate that field, not parent-object cross-field refinements. `record.at(key).set` validates the value schema, not the record's key schema or whole-record constraints. Recursive schemas are not supported by this eager structural analysis.
- _Unsafe memory paths are refused before recording._ Declared fields and `record.at` keys use memory's existing `isDeniedSegment` predicate. Dynamic keys must be strings before any coercion or state access. `__proto__`, `constructor` and `prototype` cannot claim a successful write that memory would discard. This does not alter memory's own defense or forbid safe literal dotted/empty keys.
- _All executor operations use one facade._ `getValueAt` / `setValueAt` / `updateValueAt` preserve path segments, enforce read-only input roots, reject writes after commit, and use the existing redaction rule for recorder events. `.ro` and `getArgs()` expose the same owned frozen view; reading either marks the argument dependency. `getEnv()` receives the executor's fourth factory argument, including through a resolver. Scope and emit recorders attach to that same facade, inline or deferred.
- _The optional dependency stays optional._ Zod is loaded only through `footprintjs/zod`, never the core or `/advanced` barrels (`test/api-conformance/zod-subpath.test.ts`).

`createScopeProxyFromZod(ctx, schema, strict, readOnly)` remains a low-level adapter for a minimal `StageContextLike`. It validates and delegates to the supplied adapter; it does not invent recorder/lifecycle capabilities. Use `defineScopeFromZod` with an executor. Its public regressions cover both factory doors, retries, pause/resume, parallel-for-each, subflows, recorder failure isolation, redaction and stale/read-only handles (`test/lib/scope/scenario/zod-executor.test.ts`, `security/zod-scope-security.test.ts`). Real Zod 3/4 wrapper cases are pinned in `scenario/zod-wrapper-compat.test.ts`.

```typescript
import { z } from 'zod';
import { defineScopeSchema, isScopeSchema, ZodScopeResolver } from 'footprintjs/zod';

const branded = defineScopeSchema({ score: z.number() }); // strict, and branded
isScopeSchema(branded); // true
isScopeSchema(z.object({ score: z.number() })); // false — a plain Zod object is not a scope schema
ZodScopeResolver.canHandle(branded); // true — what `registerScopeResolver(ZodScopeResolver)` would claim
```

Layer L5 (`scripts/layering.config.cjs`): builds on `ScopeFacade`, `scope/providers/`, input ownership and schema detection. Public only through `footprintjs/zod`. Sub-folders: [`schema/`](./schema/README.md), [`utils/`](./utils/README.md). See also [`../README.md`](../README.md).

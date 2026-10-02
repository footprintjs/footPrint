# scope/state/ — scopes whose shape is declared by a schema

Today that is one thing, in [`zod/`](./zod/README.md): a scope built from a Zod object schema that validates each write. The only file at this level is `installResolvers.ts`, which registers `ZodScopeResolver` with `scope/providers/` as a side effect of being imported. The folder owns the schema-backed scope; it does not own the provider registry it plugs into (`scope/providers/`) or the plain `ScopeFacade`.

**The law: zod stays out of the core.** zod is an *optional* peer dependency, so nothing outside this folder imports it and `scope/index.ts` deliberately does not re-export it. The one door is `footprintjs/zod` (`src/zod.ts`), and `test/api-conformance/zod-subpath.test.ts` fails if a zod helper reaches the `footprintjs` or `footprintjs/advanced` barrel. `installResolvers.ts` is imported by nothing today, so the resolver is not installed behind your back — an app opts in with `registerScopeResolver(ZodScopeResolver)`.

```typescript
import { z } from 'zod';
import { registerScopeResolver, toScopeFactory } from 'footprintjs/advanced';
import { defineScopeSchema, ZodScopeResolver } from 'footprintjs/zod';

registerScopeResolver(ZodScopeResolver); // opt in once, at startup

const scopeSchema = defineScopeSchema({ score: z.number() }); // a branded, strict schema the resolver claims
const scopeFactory = toScopeFactory(scopeSchema);              // resolved through the registry
```

Layer L5 (`scripts/layering.config.cjs`): imports `scope/providers/` and `schema/detect` (L0), plus `zod` itself, and is imported only by `src/zod.ts`. See also [`../README.md`](../README.md).

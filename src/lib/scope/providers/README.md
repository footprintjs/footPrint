# scope/providers/ — turn "something that makes a scope" into a scope factory

A stage's scope can come from a plain factory function, a class extending `ScopeFacade`, or a schema-like input some resolver recognises. `toScopeFactory(input, options?)` normalizes any of them into the `ScopeFactory` the engine calls once per stage; `resolveScopeProvider` is the registry behind it, `makeFactoryProvider` / `makeClassProvider` wrap the two built-in shapes, `guards.ts` tells them apart, and `attachScopeMethods` gives a non-class scope (a Zod proxy, say) the `ScopeFacade`-compatible methods. It owns that normalization and the resolver seam; it does not own the scope itself (`scope/ScopeFacade.ts`, `reactive/`) and the executor never calls it — it takes a ready `scopeFactory`, so this folder serves consumers and integrations such as `footprintjs/zod`.

**The laws.**

- *Registered resolvers first, built-ins last.* `resolveScopeProvider` tries every resolver in registration order and the first `canHandle` wins; only then does it fall back to a class that extends `ScopeFacade` or a factory function, and an input nobody claims throws a message that names the three ways out (`test/lib/scope/unit/providers.test.ts`).
- *Providers see a minimal frame.* They are written against `StageContextLike` — `getValue`, `setObject`, `updateObject` and a few optional extras — not the whole `StageContext`, so a test or a foreign scope can stand in.
- *The registry is process-wide state*, which is why `__clearScopeResolversForTests` exists.
- *A class is told from a factory by heuristics* (`looksLikeClassCtor`, then the prototype chain for `isSubclassOfScopeFacade`), pinned in `test/lib/scope/unit/guards.test.ts`.

```typescript
import { registerScopeResolver, toScopeFactory, type ProviderResolver, type StageContextLike } from 'footprintjs/advanced';

// A resolver recognises an input and makes a provider for it; the first match wins.
const lookupResolver: ProviderResolver = {
  name: 'lookup',
  canHandle: (input) => typeof input === 'object' && input !== null && 'lookup' in input,
  makeProvider: () => ({ kind: 'lookup', create: (ctx) => ({ read: (key: string) => ctx.getValue([], key) }) }),
};
registerScopeResolver(lookupResolver);

const fromResolver = toScopeFactory<{ read(key: string): unknown }>({ lookup: true });
const fromFactory = toScopeFactory((ctx: StageContextLike, stageName: string) => ({ stageName, peek: (key: string) => ctx.getValue([], key) }));
```

Layer L5 (`scripts/layering.config.cjs`): imports `scope/ScopeFacade` (for the subclass test) and `scope/protection/readonlyInput` (L0); `scope/state/` builds on it. Public through `footprintjs/advanced`. See also [`../README.md`](../README.md).

# scope/providers/ — turn "something that makes a scope" into a scope factory

A stage's scope can come from a plain factory function, a class extending `ScopeFacade`, or a schema-like input some resolver recognises. `toScopeFactory(input, options?)` normalizes any of them into the `ScopeFactory` the engine calls once per stage; `resolveScopeProvider` is the registry behind it, `makeFactoryProvider` / `makeClassProvider` wrap the two built-in shapes, `guards.ts` tells them apart, and `attachScopeMethods` gives a non-class scope (a Zod proxy, say) the `ScopeFacade`-compatible methods. It owns that normalization and the resolver seam; it does not own the scope itself (`scope/ScopeFacade.ts`, `reactive/`) and the executor never calls it — it takes a ready `scopeFactory`, so this folder serves consumers and integrations such as `footprintjs/zod`.

**The laws.**

- _Registered resolvers first, built-ins last._ `resolveScopeProvider` tries every resolver in registration order and the first `canHandle` wins; only then does it fall back to a class that extends `ScopeFacade` or a factory function, and an input nobody claims throws a message that names the three ways out (`test/lib/scope/unit/providers.test.ts`).
- _Executor factories receive a real frame and all four arguments._ `(context, stageName, readOnly, executionEnv)` survives class/factory/provider normalization. `StageContextLike` remains the minimal contract for low-level state adapters, not a substitute for the frame required by `ScopeFacade`.
- _Conveniences delegate; they do not reimplement._ `attachScopeMethods` constructs one `ScopeFacade` and binds the inventory in `baseStateCompatible.ts`. `attachFacadeMethods` reuses an existing facade for integrations such as Zod. State events, redaction, commit sealing, arguments, metrics/evaluations and emits therefore have one implementation. Do not construct two facades over one context: each stage has one commit observer.
- _Runtime capabilities are explicit._ Every scope used by the executor or `decide`/`select` is registered through `scope/runtime.ts`. Built-in scopes and `attachScopeMethods` register automatically. A custom provider registers its own target port with `registerScopeRuntime`, exported from `/advanced`; the engine never guesses by reading property names on a user proxy. An unregistered object fails with migration guidance, rather than silently losing recorder hooks.
- _The registry is process-wide state_, which is why `__clearScopeResolversForTests` exists.
- _A class is told from a factory by heuristics_ (`looksLikeClassCtor`, then the prototype chain for `isSubclassOfScopeFacade`), pinned in `test/lib/scope/unit/guards.test.ts`.

```typescript
import {
  attachScopeMethods,
  registerScopeResolver,
  toScopeFactory,
  type ProviderResolver,
  type ScopeFactory,
} from 'footprintjs/advanced';

// A resolver recognises an input and makes a provider for it; the first match wins.
const lookupResolver: ProviderResolver = {
  name: 'lookup',
  canHandle: (input) => typeof input === 'object' && input !== null && 'lookup' in input,
  makeProvider: () => ({
    kind: 'lookup',
    create: (ctx, name, input, env) => attachScopeMethods({}, ctx, name, input, env),
  }),
};
registerScopeResolver(lookupResolver);

const fromResolver = toScopeFactory({ lookup: true });
const makeScope: ScopeFactory<object> = (ctx, name, input, env) => attachScopeMethods({}, ctx, name, input, env);
const fromFactory = toScopeFactory(makeScope);
```

Layer L5 (`scripts/layering.config.cjs`): imports `ScopeFacade` and the runtime registration seam; `scope/state/` builds on it. Public through `footprintjs/advanced`. See also [`../README.md`](../README.md).

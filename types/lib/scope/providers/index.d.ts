export { attachScopeMethods } from './baseStateCompatible.js';
export { isSubclassOfScopeFacade, looksLikeClassCtor, looksLikeFactory } from './guards.js';
export { makeClassProvider, makeFactoryProvider } from './providers.js';
export { __clearScopeResolversForTests, resolveScopeProvider } from './registry.js';
export { registerScopeResolver, toScopeFactory } from './resolve.js';
export type { ProviderResolver, ResolveOptions, ScopeFactory, ScopeProvider, StageContextLike, StrictMode, } from './types.js';

/* istanbul ignore file */
export { attachBaseStateCompat, attachScopeMethods } from './baseStateCompatible';
export { isSubclassOfScopeFacade, looksLikeClassCtor, looksLikeFactory } from './guards';
export { makeClassProvider, makeFactoryProvider } from './providers';
export { __clearScopeResolversForTests, resolveScopeProvider } from './registry';
export { registerScopeResolver, toScopeFactory } from './resolve';
export type {
  ProviderResolver,
  ResolveOptions,
  ScopeFactory,
  ScopeProvider,
  StageContextLike,
  StrictMode,
} from './types';

/* istanbul ignore file */
export { toScopeFactory, registerScopeResolver } from './resolve';
export { resolveScopeProvider, __clearScopeResolversForTests } from './registry';
export { looksLikeClassCtor, looksLikeFactory, isSubclassOfScopeFacade } from './guards';
export { makeFactoryProvider, makeClassProvider } from './providers';
export { attachScopeMethods, attachBaseStateCompat } from './baseStateCompatible';

export type {
  StageContextLike,
  ScopeFactory,
  ScopeProvider,
  ProviderResolver,
  StrictMode,
  ResolveOptions,
} from './types';

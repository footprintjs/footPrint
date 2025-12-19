/* istanbul ignore file */
/**
 * scope/ — Scope management library
 *
 * Depends on memory/ (Phase 1). Provides ScopeFacade, recorders,
 * providers, protection, and Zod-based scope definitions.
 */

// Core
export { ScopeFacade } from './ScopeFacade';

// Types
export type {
  Recorder,
  RecorderContext,
  ReadEvent,
  WriteEvent,
  CommitEvent,
  ErrorEvent,
  StageEvent,
} from './types';

// Recorders
export { MetricRecorder } from './recorders/MetricRecorder';
export type { StageMetrics, AggregatedMetrics } from './recorders/MetricRecorder';

export { DebugRecorder } from './recorders/DebugRecorder';
export type { DebugVerbosity, DebugEntry, DebugRecorderOptions } from './recorders/DebugRecorder';

export { NarrativeRecorder } from './recorders/NarrativeRecorder';
export type {
  NarrativeDetail,
  NarrativeOperation,
  StageNarrativeData,
  NarrativeRecorderOptions,
} from './recorders/NarrativeRecorder';

// Protection
export { createProtectedScope, createErrorMessage } from './protection';
export type { ScopeProtectionMode, ScopeProtectionOptions } from './protection';

// Providers
export {
  toScopeFactory,
  registerScopeResolver,
  resolveScopeProvider,
  __clearScopeResolversForTests,
  looksLikeClassCtor,
  looksLikeFactory,
  isSubclassOfScopeFacade,
  makeFactoryProvider,
  makeClassProvider,
  attachScopeMethods,
  attachBaseStateCompat,
} from './providers';

export type {
  StageContextLike,
  ScopeFactory,
  ScopeProvider,
  ProviderResolver,
  StrictMode,
  ResolveOptions,
} from './providers';

// State / Zod
export { defineScopeFromZod } from './state/zod/defineScopeFromZod';
export type { DefineScopeOptions } from './state/zod/defineScopeFromZod';
export { defineScopeSchema, isScopeSchema } from './state/zod/schema/builder';
export { createScopeProxyFromZod } from './state/zod/scopeFactory';
export { ZodScopeResolver } from './state/zod/resolver';

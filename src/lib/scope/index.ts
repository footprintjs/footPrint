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
  CommitEvent,
  ErrorEvent,
  ReadEvent,
  Recorder,
  RecorderContext,
  RedactionPolicy,
  RedactionReport,
  StageEvent,
  WriteEvent,
} from './types';

// Recorders
export type { DebugEntry, DebugRecorderOptions, DebugVerbosity } from './recorders/DebugRecorder';
export { DebugRecorder } from './recorders/DebugRecorder';
export type { AggregatedMetrics, StageMetrics } from './recorders/MetricRecorder';
export { MetricRecorder } from './recorders/MetricRecorder';
export type {
  NarrativeDetail,
  NarrativeOperation,
  NarrativeRecorderOptions,
  StageNarrativeData,
} from './recorders/NarrativeRecorder';
export { NarrativeRecorder } from './recorders/NarrativeRecorder';

// Protection
export type { ScopeProtectionMode, ScopeProtectionOptions } from './protection';
export { createErrorMessage, createProtectedScope } from './protection';

// Providers
export type {
  ProviderResolver,
  ResolveOptions,
  ScopeFactory,
  ScopeProvider,
  StageContextLike,
  StrictMode,
} from './providers';
export {
  __clearScopeResolversForTests,
  attachBaseStateCompat,
  attachScopeMethods,
  isSubclassOfScopeFacade,
  looksLikeClassCtor,
  looksLikeFactory,
  makeClassProvider,
  makeFactoryProvider,
  registerScopeResolver,
  resolveScopeProvider,
  toScopeFactory,
} from './providers';

// State / Zod
export type { DefineScopeOptions } from './state/zod/defineScopeFromZod';
export { defineScopeFromZod } from './state/zod/defineScopeFromZod';
export { ZodScopeResolver } from './state/zod/resolver';
export { defineScopeSchema, isScopeSchema } from './state/zod/schema/builder';
export { createScopeProxyFromZod } from './state/zod/scopeFactory';

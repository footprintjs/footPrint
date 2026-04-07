/**
 * scope/ — Scope management library
 *
 * Depends on memory/ (Phase 1). Provides ScopeFacade, recorders,
 * providers, protection, and Zod-based scope definitions.
 */
export { ScopeFacade } from './ScopeFacade.js';
export type { CommitEvent, ErrorEvent, ReadEvent, Recorder, RecorderContext, RedactionPolicy, RedactionReport, StageEvent, WriteEvent, } from './types.js';
export type { DebugEntry, DebugRecorderOptions, DebugVerbosity } from './recorders/DebugRecorder.js';
export { DebugRecorder } from './recorders/DebugRecorder.js';
export type { AggregatedMetrics, StageMetrics } from './recorders/MetricRecorder.js';
export { MetricRecorder } from './recorders/MetricRecorder.js';
export type { ScopeProtectionMode, ScopeProtectionOptions } from './protection/index.js';
export { createErrorMessage, createProtectedScope } from './protection/index.js';
export type { ProviderResolver, ResolveOptions, ScopeFactory, ScopeProvider, StageContextLike, StrictMode, } from './providers/index.js';
export { __clearScopeResolversForTests, attachScopeMethods, isSubclassOfScopeFacade, looksLikeClassCtor, looksLikeFactory, makeClassProvider, makeFactoryProvider, registerScopeResolver, resolveScopeProvider, toScopeFactory, } from './providers/index.js';
export type { DefineScopeOptions } from './state/zod/defineScopeFromZod.js';
export { defineScopeFromZod } from './state/zod/defineScopeFromZod.js';
export { ZodScopeResolver } from './state/zod/resolver.js';
export { defineScopeSchema, isScopeSchema } from './state/zod/schema/builder.js';
export { createScopeProxyFromZod } from './state/zod/scopeFactory.js';

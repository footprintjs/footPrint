/* istanbul ignore file */
/**
 * scope/ — Scope management library
 *
 * Depends on memory/ (Phase 1). Provides ScopeFacade, recorders,
 * providers, protection, and Zod-based scope definitions.
 */

// Core
export { ScopeFacade } from './ScopeFacade.js';

// Types
export type {
  CommitEvent,
  ErrorEvent,
  ReadEvent,
  RecorderContext,
  RedactionPolicy,
  RedactionReport,
  ScopeRecorder,
  StageEvent,
  WriteEvent,
} from './types.js';

// Recorders
export type { DebugEntry, DebugRecorderOptions, DebugVerbosity } from './recorders/DebugRecorder.js';
export { DebugRecorder } from './recorders/DebugRecorder.js';
export type { AggregatedMetrics, StageMetrics } from './recorders/MetricRecorder.js';
export { MetricRecorder } from './recorders/MetricRecorder.js';

// Protection
export type { ScopeProtectionMode, ScopeProtectionOptions } from './protection/index.js';
export { createErrorMessage, createProtectedScope } from './protection/index.js';

// Providers
export type {
  ProviderResolver,
  ResolveOptions,
  ScopeFactory,
  ScopeProvider,
  StageContextLike,
  StrictMode,
} from './providers/index.js';
export {
  __clearScopeResolversForTests,
  attachScopeMethods,
  isSubclassOfScopeFacade,
  looksLikeClassCtor,
  looksLikeFactory,
  makeClassProvider,
  makeFactoryProvider,
  registerScopeResolver,
  resolveScopeProvider,
  toScopeFactory,
} from './providers/index.js';

// State / Zod — INTENTIONALLY NOT re-exported here.
// Zod is an OPTIONAL peer; re-exporting it from this barrel would force every
// `footprintjs` consumer to load zod eagerly (and crash if it isn't installed).
// The zod-based scope helpers live behind the opt-in `footprintjs/zod` entry
// (src/zod.ts). Import them from there and add zod to your own dependencies.

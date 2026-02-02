/**
 * Scope Module - Barrel Export
 * ----------------------------------------------------------------------------
 * This module provides a single entry point for all scope-related exports.
 * Consumers can import everything they need from this location:
 *
 * @example
 * ```typescript
 * import {
 *   // Core Scope class
 *   Scope,
 *
 *   // BaseState for custom scope classes
 *   BaseState,
 *
 *   // Types
 *   ScopeOptions,
 *   ScopeSnapshot,
 *   Recorder,
 *   RecorderContext,
 *   ReadEvent,
 *   WriteEvent,
 *   CommitEvent,
 *   ErrorEvent,
 *   StageEvent,
 *
 *   // Library-provided recorders
 *   MetricRecorder,
 *   DebugRecorder,
 *
 *   // Recorder types
 *   StageMetrics,
 *   AggregatedMetrics,
 *   DebugVerbosity,
 *   DebugEntry,
 *   DebugRecorderOptions,
 *
 *   // Provider system (for plugin authors)
 *   toScopeFactory,
 *   registerScopeResolver,
 * } from './scope';
 * ```
 *
 * @module scope
 *
 * Requirements: 7.1 - All interfaces and types are exported for consumer use
 */

// ============================================================================
// Core Scope Class
// ============================================================================

/**
 * Scope - Core runtime memory container for pipeline execution.
 * Provides getValue, setValue, updateValue, and commit operations with
 * namespace isolation, time-travel support, and pluggable recorders.
 */
export { Scope } from './Scope';

// ============================================================================
// BaseState - Base class for custom scope classes
// ============================================================================

/**
 * BaseState - Base class that library consumers extend to create custom scope classes.
 * Provides a consistent interface for accessing pipeline context, debug logging,
 * metrics, and state management.
 */
export { BaseState } from './BaseState';

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Re-export all types from the types module.
 * These include the Recorder interface, event types, and scope configuration types.
 */
export type {
  // Recorder interface for consumer implementation
  Recorder,

  // Event types passed to recorder hooks
  RecorderContext,
  ReadEvent,
  WriteEvent,
  CommitEvent,
  ErrorEvent,
  StageEvent,

  // Scope configuration and state types
  ScopeOptions,
  ScopeSnapshot,
} from './types';

// ============================================================================
// Library-Provided Recorders
// ============================================================================

/**
 * Re-export all recorders and their types from the recorders module.
 * This includes both the recorder classes and their associated types.
 */
export {
  // MetricRecorder - Production monitoring (timing, counts)
  MetricRecorder,

  // DebugRecorder - Development/OE debugging (errors, mutations, verbose logs)
  DebugRecorder,
} from './recorders';

/**
 * Re-export recorder-specific types.
 */
export type {
  // MetricRecorder types
  StageMetrics,
  AggregatedMetrics,

  // DebugRecorder types
  DebugVerbosity,
  DebugEntry,
  DebugRecorderOptions,
} from './recorders';

// ============================================================================
// Provider System (for plugin authors and advanced use cases)
// ============================================================================

/**
 * Re-export provider system for plugin authors.
 * - toScopeFactory: Convert arbitrary inputs to ScopeFactory
 * - registerScopeResolver: Register custom resolvers
 */
export {
  toScopeFactory,
  registerScopeResolver,
  resolveScopeProvider,
  __clearScopeResolversForTests,
  looksLikeClassCtor,
  looksLikeFactory,
  isSubclassOfStateScope,
  makeFactoryProvider,
  makeClassProvider,
  attachBaseStateCompat,
} from './providers';

/**
 * Re-export provider types.
 */
export type {
  StageContextLike,
  ScopeFactory,
  ScopeProvider,
  ProviderResolver,
  StrictMode,
  ResolveOptions,
} from './providers';

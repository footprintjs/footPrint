/**
 * Providers Module - Barrel Export
 * ----------------------------------------------------------------------------
 * This module provides the scope provider system for resolving arbitrary inputs
 * (factory functions, classes, schemas) into ScopeFactory instances.
 *
 * WHY: Centralizes the provider resolution logic and allows plugins to register
 * custom resolvers for different input types (e.g., Zod schemas).
 *
 * EXPORTS:
 * - toScopeFactory: Main API for converting inputs to ScopeFactory
 * - registerScopeResolver: Plugin registration API
 * - Guards: Heuristics for detecting input types
 * - Providers: Factory functions for creating providers
 * - Types: Type definitions for the provider system
 *
 * @module scope/providers
 */

// ============================================================================
// Main API
// ============================================================================

/**
 * toScopeFactory - Convert arbitrary inputs to ScopeFactory.
 * registerScopeResolver - Register custom resolvers for plugin support.
 */
export { toScopeFactory, registerScopeResolver } from './resolve';

// ============================================================================
// Registry (for advanced use cases)
// ============================================================================

/**
 * resolveScopeProvider - Lower-level API for getting a ScopeProvider.
 * __clearScopeResolversForTests - Test helper to clear registered resolvers.
 */
export { resolveScopeProvider, __clearScopeResolversForTests } from './registry';

// ============================================================================
// Guards (for plugin authors)
// ============================================================================

/**
 * Heuristic functions for detecting input types.
 */
export { looksLikeClassCtor, looksLikeFactory, isSubclassOfStateScope } from './guards';

// ============================================================================
// Provider Factories (for plugin authors)
// ============================================================================

/**
 * Factory functions for creating ScopeProvider instances.
 */
export { makeFactoryProvider, makeClassProvider } from './providers';

// ============================================================================
// BaseState Compatibility (for plugin authors)
// ============================================================================

/**
 * Attach BaseState-like methods to any object.
 */
export { attachBaseStateCompat } from './baseStateCompatible';

// ============================================================================
// Types
// ============================================================================

/**
 * Type definitions for the provider system.
 */
export type {
  StageContextLike,
  ScopeFactory,
  ScopeProvider,
  ProviderResolver,
  StrictMode,
  ResolveOptions,
} from './types';

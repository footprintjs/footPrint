/**
 * providers.ts
 *
 * WHY: Factory functions for creating ScopeProvider instances from different
 * input types (factory functions, class constructors).
 *
 * RESPONSIBILITIES:
 * - Wrap factory functions as ScopeProviders
 * - Wrap class constructors as ScopeProviders
 *
 * DESIGN DECISIONS:
 * - Each provider has a 'kind' property for debugging/introspection
 * - Providers are simple wrappers - no complex logic
 * - Class providers use 'new' to instantiate
 *
 * RELATED:
 * - {@link registry.ts} - Uses these to create providers
 * - {@link types.ts} - Type definitions for ScopeProvider
 */

import { ScopeFactory, ScopeProvider, StageContextLike } from './types';

/** Wrap an existing factory function as a ScopeProvider */
export function makeFactoryProvider<TScope>(factory: ScopeFactory<TScope>): ScopeProvider<TScope> {
  return {
    kind: 'factory',
    create: (ctx, stageName, ro) => factory(ctx, stageName, ro),
  };
}

/** Wrap a class constructor as a ScopeProvider */
export function makeClassProvider<TScope>(
  Ctor: new (ctx: StageContextLike, stageName: string, readOnly?: unknown) => TScope,
): ScopeProvider<TScope> {
  return {
    kind: 'class',
    create: (ctx, stageName, ro) => new Ctor(ctx, stageName, ro),
  };
}

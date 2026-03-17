/**
 * Provider Factories — Wrap factory functions and class constructors as ScopeProviders
 */

import type { ScopeFactory, ScopeProvider, StageContextLike } from './types.js';

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

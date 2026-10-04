/**
 * Provider Factories — Wrap factory functions and class constructors as ScopeProviders
 */

import type { ScopeFactory, ScopeProvider } from './types.js';

/** Wrap an existing factory function as a ScopeProvider */
export function makeFactoryProvider<TScope>(factory: ScopeFactory<TScope>): ScopeProvider<TScope> {
  return {
    kind: 'factory',
    create: (ctx, stageName, ro, env) => factory(ctx, stageName, ro, env),
  };
}

/** Wrap a class constructor as a ScopeProvider */
export function makeClassProvider<TScope>(
  Ctor: new (...args: Parameters<ScopeFactory<TScope>>) => TScope,
): ScopeProvider<TScope> {
  return {
    kind: 'class',
    create: (ctx, stageName, ro, env) => new Ctor(ctx, stageName, ro, env),
  };
}

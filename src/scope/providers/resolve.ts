/**
 * resolve.ts
 *
 * WHY: Public API for converting arbitrary scope inputs (factory functions,
 * classes, schemas) into the ScopeFactory type that the pipeline expects.
 *
 * RESPONSIBILITIES:
 * - Normalize various input types to a consistent ScopeFactory
 * - Re-export registerScopeResolver for plugin registration
 * - Re-export types for consumer use
 *
 * DESIGN DECISIONS:
 * - Single entry point for scope resolution
 * - Delegates to registry for actual resolution logic
 * - Returns a ScopeFactory that can be used directly by the pipeline
 *
 * RELATED:
 * - {@link registry.ts} - Contains the resolution logic
 * - {@link types.ts} - Type definitions
 */

import { resolveScopeProvider } from './registry';
import type { ResolveOptions, ScopeFactory, ScopeProvider } from './types';

/** Normalize a factory/class/schema-like input into a ScopeFactory the pipeline expects */
export function toScopeFactory<TScope>(input: unknown, options?: ResolveOptions): ScopeFactory<TScope> {
  const provider: ScopeProvider<TScope> = resolveScopeProvider<TScope>(input, options);
  return (ctx, stageName, ro) => provider.create(ctx, stageName, ro);
}

export { registerScopeResolver } from './registry';
export type { ResolveOptions, ScopeProvider } from './types';

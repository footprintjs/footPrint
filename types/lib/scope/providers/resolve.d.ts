/**
 * resolve.ts — Public API for converting scope inputs to ScopeFactory
 */
import type { ResolveOptions, ScopeFactory } from './types.js';
/** Normalize a factory/class/schema-like input into a ScopeFactory the pipeline expects */
export declare function toScopeFactory<TScope>(input: unknown, options?: ResolveOptions): ScopeFactory<TScope>;
export { registerScopeResolver } from './registry.js';
export type { ResolveOptions, ScopeProvider } from './types.js';

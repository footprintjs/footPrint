/**
 * Provider Factories — Wrap factory functions and class constructors as ScopeProviders
 */
import type { ScopeFactory, ScopeProvider, StageContextLike } from './types.js';
/** Wrap an existing factory function as a ScopeProvider */
export declare function makeFactoryProvider<TScope>(factory: ScopeFactory<TScope>): ScopeProvider<TScope>;
/** Wrap a class constructor as a ScopeProvider */
export declare function makeClassProvider<TScope>(Ctor: new (ctx: StageContextLike, stageName: string, readOnly?: unknown) => TScope): ScopeProvider<TScope>;

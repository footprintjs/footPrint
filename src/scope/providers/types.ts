/**
 * types.ts
 *
 * WHY: Type definitions for the scope provider system. These types define
 * the contracts between the registry, resolvers, and providers.
 *
 * RESPONSIBILITIES:
 * - Define StageContextLike interface (minimal surface from StageContext)
 * - Define ScopeFactory type (what the pipeline expects)
 * - Define ScopeProvider interface (strategy for creating scopes)
 * - Define ProviderResolver interface (plugin contract)
 * - Define ResolveOptions for configuration
 *
 * DESIGN DECISIONS:
 * - StageContextLike is minimal to avoid tight coupling with StageContext
 * - ScopeProvider uses 'kind' for debugging/introspection
 * - ProviderResolver allows plugins to handle custom input types
 * - ResolveOptions is extensible for future plugin options
 *
 * RELATED:
 * - {@link StageContext} - The actual context that implements StageContextLike
 * - {@link registry.ts} - Uses these types for resolution
 */

/** Minimal surface from your StageContext (patch-based) */
export interface StageContextLike {
  // reads / writes
  getValue(path: string[], key?: string): unknown;
  setObject(path: string[], key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
  updateObject(path: string[], key: string, value: unknown, description?: string): void;

  // optional diagnostics (new method names)
  addLog?(key: string, val: unknown): void;
  addError?(key: string, val: unknown): void;

  // optional helpers used by BaseState / compat
  getFromGlobalContext?(key: string): unknown;
  setRoot?(key: string, value: unknown): void;
  setGlobal?(key: string, value: unknown, description?: string): void;

  // optional metadata (read-only)
  pipelineId?: string;
}

/** Existing factory type the pipeline already supports */
export type ScopeFactory<TScope> = (ctx: StageContextLike, stageName: string, readOnly?: unknown) => TScope;

/** Strategy object that creates a scope */
export interface ScopeProvider<TScope> {
  readonly kind: string; // e.g., 'factory' | 'class' | 'zod'
  create(ctx: StageContextLike, stageName: string, readOnly?: unknown): TScope;
}

/** Resolver that can turn an arbitrary input into a ScopeProvider */
export interface ProviderResolver<TScope = any> {
  name: string;
  canHandle(input: unknown): boolean;
  makeProvider(input: unknown, options?: unknown): ScopeProvider<TScope>;
}

/** Optional strictness for schema-backed providers (reserved for future) */
export type StrictMode = 'off' | 'warn' | 'deny';

/** Options bag passed to resolve(); extended by plugins later */
export type ResolveOptions = {
  zod?: { strict?: StrictMode };
};

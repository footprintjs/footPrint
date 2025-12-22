/** Minimal surface from your StageContext (patch-based) */
export interface StageContextLike {
  // reads / writes
  getValue(path: string[], key?: string): unknown;
  setObject(path: string[], key: string, value: unknown): void; // copy-on-write into stage-local patch
  updateObject(path: string[], key: string, value: unknown): void; // merge into stage-local patch

  // optional diagnostics
  addDebugInfo?(key: string, val: unknown): void;
  addErrorInfo?(key: string, val: unknown): void;

  // optional helpers used by BaseState / compat
  getFromGlobalContext?(key: string): unknown;
  setRoot?(key: string, value: unknown): void;

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

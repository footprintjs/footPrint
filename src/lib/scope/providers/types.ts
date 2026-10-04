/**
 * Provider System Types
 *
 * Defines contracts between the registry, resolvers, and providers.
 * StageContextLike is the minimal surface from StageContext to avoid tight coupling.
 */

import type { StageContext } from '../../memory/StageContext.js';
import type { ScopeFacade } from '../ScopeFacade.js';

/** Minimal surface from StageContext (patch-based) */
export interface StageContextLike {
  getValue(path: string[], key?: string): unknown;
  setObject(path: string[], key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
  updateObject(path: string[], key: string, value: unknown, description?: string): void;

  addLog?(key: string, val: unknown): void;
  addError?(key: string, val: unknown): void;

  getGlobal?(key: string): unknown;
  setRoot?(key: string, value: unknown): void;
  setGlobal?(key: string, value: unknown, description?: string): void;

  pipelineId?: string;
  runId?: string;
}

/** Factory type the pipeline expects */
export type ScopeFactory<TScope> = (
  ctx: StageContext,
  stageName: string,
  readOnly?: unknown,
  executionEnv?: ConstructorParameters<typeof ScopeFacade>[3],
) => TScope;

/** Strategy object that creates a scope */
export interface ScopeProvider<TScope> {
  readonly kind: string;
  create(...args: Parameters<ScopeFactory<TScope>>): TScope;
}

/** Resolver that can turn an arbitrary input into a ScopeProvider */
export interface ProviderResolver<TScope = any> {
  name: string;
  canHandle(input: unknown): boolean;
  makeProvider(input: unknown, options?: unknown): ScopeProvider<TScope>;
}

/** Optional strictness for schema-backed providers */
export type StrictMode = 'off' | 'warn' | 'deny';

/** Options bag passed to resolve() */
export type ResolveOptions = {
  zod?: { strict?: StrictMode };
};

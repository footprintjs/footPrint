import { z } from 'zod';

import { attachBaseStateCompat } from '../../core/baseStateCompatible';
import type { ScopeFactory, StageContextLike, StrictMode } from '../../core/types';
import { createScopeProxyFromZod } from './scopeFactory';

export type DefineScopeOptions = {
  /** Zod validation mode for writes; default "warn" */
  strict?: StrictMode; // "off" | "warn" | "deny"
};

/**
 * Build a ScopeFactory from a Zod object schema.
 * - Creates a lazy, copy-on-write proxy driven by the schema
 * - Attaches BaseState-compatible helpers (addDebugInfo, getValue, setObject, etc.)
 * - Honors strictness for validation on writes
 */
export function defineScopeFromZod<S extends z.ZodObject<any>>(
  schema: S,
  opts?: DefineScopeOptions,
): ScopeFactory<any> {
  const strict = opts?.strict ?? 'warn';
  return (ctx: StageContextLike, stageName: string, readOnly?: unknown) => {
    // 1) build the schema-driven proxy
    const proxy = createScopeProxyFromZod(ctx, schema, strict, readOnly);
    // 2) attach BaseState-compatible methods directly on the proxy
    return attachBaseStateCompat(proxy, ctx, stageName, readOnly);
  };
}

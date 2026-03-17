/**
 * defineScopeFromZod — Build a ScopeFactory from a Zod object schema
 */

import { z } from 'zod';

import { attachScopeMethods } from '../../providers/baseStateCompatible.js';
import type { ScopeFactory, StageContextLike, StrictMode } from '../../providers/types.js';
import { createScopeProxyFromZod } from './scopeFactory.js';

export type DefineScopeOptions = {
  strict?: StrictMode;
};

export function defineScopeFromZod<S extends z.ZodObject<any>>(
  schema: S,
  opts?: DefineScopeOptions,
): ScopeFactory<any> {
  const strict = opts?.strict ?? 'warn';
  return (ctx: StageContextLike, stageName: string, readOnly?: unknown) => {
    const proxy = createScopeProxyFromZod(ctx, schema, strict, readOnly);
    return attachScopeMethods(proxy, ctx, stageName, readOnly);
  };
}

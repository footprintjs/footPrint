/**
 * Scope Proxy Factory — Build lazy, copy-on-write scope from a Zod object schema
 */
import { z } from 'zod';
import type { StageContextLike, StrictMode } from '../../providers/types.js';
/** Build lazy, copy-on-write scope from a Zod object schema */
export declare function createScopeProxyFromZod<S extends z.ZodObject<any>>(ctx: StageContextLike, schema: S, strict?: StrictMode, readOnly?: unknown): z.infer<S> & {
    ro?: unknown;
};

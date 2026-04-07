/**
 * defineScopeFromZod — Build a ScopeFactory from a Zod object schema
 */
import { z } from 'zod';
import type { ScopeFactory, StrictMode } from '../../providers/types.js';
export type DefineScopeOptions = {
    strict?: StrictMode;
};
export declare function defineScopeFromZod<S extends z.ZodObject<any>>(schema: S, opts?: DefineScopeOptions): ScopeFactory<any>;

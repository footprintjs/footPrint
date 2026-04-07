/**
 * Scope Schema Builder — Brand-based schema factory
 */
import { z } from 'zod';
export declare const SCOPE_SCHEMA_BRAND: unique symbol;
export type ScopeSchema<T extends z.ZodRawShape = any> = z.ZodObject<T> & {
    [SCOPE_SCHEMA_BRAND]: true;
};
/** Define a scope shape (object only). Branded so only our builder mints valid scope schemas. */
export declare function defineScopeSchema<Ext extends z.ZodRawShape>(ext: Ext): ScopeSchema<Ext>;
/** Runtime guard */
export declare function isScopeSchema(x: unknown): x is ScopeSchema;

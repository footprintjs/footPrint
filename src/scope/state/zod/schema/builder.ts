import { z } from 'zod';

/** Unique brand so only our builder can mint valid scope schemas */
export const SCOPE_SCHEMA_BRAND = Symbol.for('ScopeSchemaBrand@v1');

export type ScopeSchema<T extends z.ZodRawShape = any> = z.ZodObject<T> & { [SCOPE_SCHEMA_BRAND]: true };

/** Consumers define their scope shape here (object only). */
export function defineScopeSchema<Ext extends z.ZodRawShape>(ext: Ext) {
  const merged = z.object(ext).strict().describe('ScopeSchema@v1');
  Object.defineProperty(merged, SCOPE_SCHEMA_BRAND, { value: true });
  return merged as ScopeSchema<Ext>;
}

/** Runtime guard */
export function isScopeSchema(x: unknown): x is ScopeSchema {
  return !!x && typeof x === 'object' && (x as any)[SCOPE_SCHEMA_BRAND] === true;
}

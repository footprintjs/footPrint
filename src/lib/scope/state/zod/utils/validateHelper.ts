/**
 * Zod Validation Helpers — Cross-version compatible Zod utilities
 *
 * Detection delegated to schema/detect.ts (single source of truth).
 */

import { type ZodRecord, type ZodTypeAny, z } from 'zod';

import { detectSchema } from '../../../../schema/detect.js';

/** @deprecated Use `detectSchema()` from `schema/detect` instead. Kept for backward compatibility. */
export function isZodNode(x: unknown): x is ZodTypeAny {
  return detectSchema(x) !== 'none';
}

/** Peel wrappers; returns the underlying base Zod node (or null). */
export function unwrap(schema: ZodTypeAny | null | undefined): ZodTypeAny | null {
  let s: unknown = schema ?? null;
  while (isZodNode(s)) {
    const def = (s as any)._def ?? {};
    if (isZodNode(def.innerType)) {
      s = def.innerType;
      continue;
    }
    if (isZodNode(def.schema)) {
      s = def.schema;
      continue;
    }
    if (isZodNode(def.type)) {
      s = def.type;
      continue;
    }
    break;
  }
  return isZodNode(s) ? (s as ZodTypeAny) : null;
}

/** Version-tolerant access to ZodRecord value schema. */
export function getRecordValueType(rec: ZodRecord<any, any>): ZodTypeAny | null {
  const r: any = rec as any;
  const def = r._def ?? {};
  return (
    r.valueSchema ??
    r.valueType ??
    def.valueType ??
    def.value ??
    (def.schema && (def.schema.valueType ?? def.schema.value)) ??
    (def.innerType && (def.innerType.valueType ?? def.innerType.value)) ??
    null
  );
}

function looksLikeBindingError(err: unknown): boolean {
  const msg = (err as any)?.message ?? '';
  return msg.includes('_zod') || msg.includes('inst._zod') || msg.includes('Cannot read properties of undefined');
}

const WRAPPER_CACHE = new WeakMap<ZodTypeAny, ZodTypeAny>();

export function parseWithThis(schema: ZodTypeAny, value: unknown): unknown {
  const anySchema = schema as any;

  if (typeof anySchema.safeParse === 'function') {
    try {
      const res = anySchema.safeParse(value);
      if (res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'success')) {
        if (res.success) return res.data;
        throw res.error;
      }
    } catch (err) {
      if (!looksLikeBindingError(err)) throw err;
    }
  }

  if (typeof anySchema.safeParse === 'function') {
    try {
      const res = anySchema.safeParse.call(schema, value);
      if (res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'success')) {
        if (res.success) return res.data;
        throw res.error;
      }
    } catch (err) {
      if (!looksLikeBindingError(err)) throw err;
    }
  }

  if (typeof anySchema.parse === 'function') {
    try {
      return anySchema.parse(value);
    } catch (err) {
      if (!looksLikeBindingError(err)) throw err;
    }
  }

  let wrapper = WRAPPER_CACHE.get(schema);
  if (!wrapper) {
    wrapper = (z.any() as any).pipe(schema as any);
    WRAPPER_CACHE.set(schema, wrapper!);
  }
  const res = (wrapper as any).safeParse(value);
  if (res && res.success) return res.data;

  throw res?.error ?? new TypeError('Zod validation binding failed (wrapper fallback).');
}

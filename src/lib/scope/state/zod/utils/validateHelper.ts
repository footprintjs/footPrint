/**
 * Zod Validation Helpers — Cross-version compatible Zod utilities
 *
 * Detection delegated to schema/detect.ts (single source of truth).
 */

import { type ZodRecord, type ZodTypeAny, z } from 'zod';

import { detectSchema } from '../../../../schema/detect.js';

/** Check if the value is a Zod schema node. */
export function isZodNode(x: unknown): x is ZodTypeAny {
  return detectSchema(x) !== 'none';
}

/** Peel wrappers; returns the underlying base Zod node (or null).
 *
 *  Wrapper-aware: only descends through fields that are KNOWN to hold
 *  the inner schema for wrapper Zod types (Optional, Default, Nullable,
 *  Effects/Pipeline). Notably, `_def.type` is treated as the inner
 *  schema ONLY for v3 Effects/Pipeline — it is NOT the inner schema
 *  for ZodArray (where `_def.type` holds the ELEMENT schema, which is
 *  a separate concern from wrapper unwrapping).
 *
 *  Without this gate, `unwrap(z.array(z.string()))` would incorrectly
 *  follow `_def.type` and return `ZodString`, breaking array detection
 *  in `scopeFactory.analyze()`.
 */
export function unwrap(schema: ZodTypeAny | null | undefined): ZodTypeAny | null {
  let s: unknown = schema ?? null;
  while (isZodNode(s)) {
    const def = ((s as any)._def ?? {}) as Record<string, unknown>;
    const tn = def.typeName as string | undefined;
    // Only known wrapper typeNames descend. ZodArray / ZodObject /
    // ZodRecord / ZodUnion etc. break out so the caller can branch
    // on the base instance check.
    const isWrapper =
      tn === 'ZodOptional' ||
      tn === 'ZodDefault' ||
      tn === 'ZodNullable' ||
      tn === 'ZodReadonly' ||
      tn === 'ZodBranded' ||
      tn === 'ZodCatch' ||
      tn === 'ZodEffects' ||
      tn === 'ZodPipeline' ||
      tn === 'ZodLazy';
    if (!isWrapper) break;
    if (isZodNode(def.innerType)) {
      s = def.innerType;
      continue;
    }
    if (isZodNode(def.schema)) {
      s = def.schema;
      continue;
    }
    // Pipeline (`in` / `out`) — descend into `in` (input side).
    if (isZodNode(def.in)) {
      s = def.in;
      continue;
    }
    // Lazy holds a getter under `getter`. Last-resort fallback.
    if (typeof def.getter === 'function') {
      try {
        const inner = (def.getter as () => unknown)();
        if (isZodNode(inner)) {
          s = inner;
          continue;
        }
      } catch {
        /* fall through */
      }
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

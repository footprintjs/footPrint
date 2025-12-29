import { type ZodRecord, type ZodTypeAny, z } from 'zod';

export function isZodNode(x: unknown): x is ZodTypeAny {
  return !!(
    x &&
    typeof x === 'object' &&
    ((x as any)._def !== undefined ||
      typeof (x as any).parse === 'function' ||
      typeof (x as any).safeParse === 'function')
  );
}

/** Peel wrappers; returns the underlying base Zod node (or null). */
export function unwrap(schema: ZodTypeAny | null | undefined): ZodTypeAny | null {
  let s: unknown = schema ?? null;
  while (isZodNode(s)) {
    const def = (s as any)._def ?? {};
    if (isZodNode(def.innerType)) {
      s = def.innerType;
      continue;
    } // default/optional/nullable
    if (isZodNode(def.schema)) {
      s = def.schema;
      continue;
    } // effects/branded/catch
    if (isZodNode(def.type)) {
      s = def.type;
      continue;
    } // readonly
    break;
  }
  return isZodNode(s) ? (s as ZodTypeAny) : null;
}

/** Version-tolerant access to ZodRecord value schema. */
export function getRecordValueType(rec: ZodRecord<any, any>): ZodTypeAny | null {
  const r: any = rec as any;
  const def = r._def ?? {};

  // Common places across zod v3/v4 and different bundles
  return (
    r.valueSchema ?? // some ESM builds
    r.valueType ?? // older v3 typings
    def.valueType ?? // v3 internal def
    def.value ?? // some v4 builds
    // occasionally nested under another schema/def node
    (def.schema && (def.schema.valueType ?? def.schema.value)) ??
    (def.innerType && (def.innerType.valueType ?? def.innerType.value)) ??
    null
  );
}

/** Heuristic: errors that indicate a Zod binding/vendor problem, not user data error. */
function looksLikeBindingError(err: unknown): boolean {
  const msg = (err as any)?.message ?? '';
  return msg.includes('_zod') || msg.includes('inst._zod') || msg.includes('Cannot read properties of undefined');
}

/**
 * Parse with maximum tolerance across CJS/ESM and wrapper stacks:
 *  1) schema.safeParse(value)
 *  2) schema.safeParse.call(schema, value)
 *  3) schema.parse(value)
 *  4) wrapper fallback: z.any().pipe(schema).safeParse(value)
 *
 * On invalid data: throws ZodError (never hides validation failures).
 * On binding glitches: falls through to wrapper (never crashes on '_zod').
 */
const WRAPPER_CACHE = new WeakMap<ZodTypeAny, ZodTypeAny>();
export function parseWithThis(schema: ZodTypeAny, value: unknown): unknown {
  const anySchema = schema as any;

  // 1) direct safeParse
  if (typeof anySchema.safeParse === 'function') {
    try {
      const res = anySchema.safeParse(value);
      if (res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'success')) {
        if (res.success) return res.data;
        throw res.error; // ZodError on invalid
      }
    } catch (err) {
      if (!looksLikeBindingError(err)) throw err;
    }
  }

  // 2) bound safeParse
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

  // 3) parse (throws on invalid)
  if (typeof anySchema.parse === 'function') {
    try {
      return anySchema.parse(value);
    } catch (err) {
      if (!looksLikeBindingError(err)) throw err;
    }
  }

  // 4) wrapper fallback (uses our local z import)
  let wrapper = WRAPPER_CACHE.get(schema);
  if (!wrapper) {
    wrapper = (z.any() as any).pipe(schema as any);
    WRAPPER_CACHE.set(schema, wrapper!);
  }
  const res = (wrapper as any).safeParse(value);
  if (res && res.success) return res.data;

  throw res?.error ?? new TypeError('Zod validation binding failed (wrapper fallback).');
}

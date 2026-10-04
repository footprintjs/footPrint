/**
 * Zod Validation Helpers — Cross-version compatible Zod utilities
 *
 * Detection delegated to schema/detect.ts (single source of truth).
 */

import { type ZodTypeAny, z } from 'zod';

import { detectSchema } from '../../../../schema/detect.js';

/** The classic Zod 3/4 surface, without coupling to either constructor family. */
export interface ZodSchema {
  readonly _def: object;
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: unknown };
}

/** Check if the value is a Zod schema node. */
export function isZodNode(x: unknown): x is ZodSchema {
  return detectSchema(x) !== 'none';
}

/** Both classic Zod versions expose their definition at `_def`. */
function definition(schema: ZodSchema): Record<string, unknown> {
  return (schema._def as Record<string, unknown>) ?? {};
}

/** Structural kind, independent of the installed copy's constructors. */
export function getZodKind(schema: ZodSchema): string | undefined {
  const def = definition(schema);
  if (typeof def.typeName === 'string') {
    const kind = def.typeName.slice(3).toLowerCase();
    return kind === 'pipeline' ? 'pipe' : kind;
  }
  return typeof def.type === 'string' ? def.type : undefined;
}

/** The actual object fields: a getter in Zod 3, an object in Zod 4. */
export function getObjectShape(schema: ZodSchema): Record<string, ZodSchema> {
  const def = definition(schema);
  const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
  if (!shape || typeof shape !== 'object') throw new TypeError('Zod object has no valid shape.');
  return shape as Record<string, ZodSchema>;
}

/** Array element metadata is not a wrapper edge. */
export function getArrayElementType(schema: ZodSchema): ZodSchema | null {
  const def = definition(schema);
  const element = def.typeName === 'ZodArray' ? def.type : def.element;
  return isZodNode(element) ? element : null;
}

/**
 * Peel only known wrappers for structural classification. The caller must
 * retain the original schema for write validation: unwrapping is not parsing.
 * Arrays stop here; a pipeline follows its input, since scope writes are inputs.
 */
export function unwrap(schema: ZodSchema | null | undefined): ZodSchema | null {
  let s: unknown = schema ?? null;
  while (isZodNode(s)) {
    const def = definition(s);
    let inner: unknown;
    switch (getZodKind(s)) {
      case 'optional':
      case 'nullable':
      case 'default':
      case 'readonly':
      case 'catch':
      case 'prefault':
      case 'nonoptional':
        inner = def.innerType;
        break;
      case 'effects':
        inner = def.schema;
        break;
      case 'branded':
        inner = def.type;
        break;
      case 'pipe':
        inner = def.in;
        break;
      case 'lazy':
        inner = typeof def.getter === 'function' ? def.getter() : undefined;
        break;
      default:
        return s;
    }
    if (!isZodNode(inner)) throw new TypeError('Zod wrapper has no valid inner schema.');
    s = inner;
  }
  return null;
}

/** Both Zod versions store the record's value schema at `valueType`. */
export function getRecordValueType(schema: ZodSchema): ZodSchema | null {
  const value = definition(schema).valueType;
  return isZodNode(value) ? value : null;
}

function looksLikeBindingError(err: unknown): boolean {
  const msg = (err as any)?.message ?? '';
  return msg.includes('_zod') || msg.includes('inst._zod') || msg.includes('Cannot read properties of undefined');
}

const WRAPPER_CACHE = new WeakMap<ZodSchema, ZodTypeAny>();

export function parseWithThis(schema: ZodSchema, value: unknown): unknown {
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

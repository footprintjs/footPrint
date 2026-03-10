/**
 * detect.ts — Single source of truth for schema detection.
 *
 * Replaces three separate detection strategies:
 * - contract/schema.ts  isZodSchema()    (structural: .def/.type)
 * - scope/zod/utils      isZodNode()      (permissive: ._def OR .parse)
 * - runner/validateInput  inline checks    (behavioral: .safeParse)
 *
 * One function, one decision. Every module imports this instead.
 */

/** The kind of schema detected. */
export type SchemaKind = 'zod' | 'parseable' | 'json-schema' | 'none';

/**
 * Detect what kind of schema an unknown value is.
 *
 * Detection order (most specific → least specific):
 * 1. Zod v3/v4 — has `._def.type` or `.def.type` string
 * 2. Parseable — has `.safeParse()` or `.parse()` (Zod-like, yup, superstruct, etc.)
 * 3. JSON Schema — has `.type` string or `.properties` object (structural markers)
 * 4. None — not a recognized schema
 */
export function detectSchema(input: unknown): SchemaKind {
  if (!input || typeof input !== 'object') return 'none';

  const obj = input as Record<string, unknown>;

  // ── Zod v4: top-level `.def` with `.type` string ──
  if (obj.def && typeof obj.def === 'object') {
    if (typeof (obj.def as Record<string, unknown>).type === 'string') {
      return 'zod';
    }
  }

  // ── Zod v3: `._def` with `.type` or `.typeName` string ──
  if (obj._def && typeof obj._def === 'object') {
    const def = obj._def as Record<string, unknown>;
    if (typeof def.type === 'string' || typeof def.typeName === 'string') {
      return 'zod';
    }
  }

  // ── Parseable: has .safeParse() or .parse() ──
  if (typeof obj.safeParse === 'function' || typeof obj.parse === 'function') {
    return 'parseable';
  }

  // ── JSON Schema: structural markers ──
  if (typeof obj.type === 'string' || (typeof obj.properties === 'object' && obj.properties !== null)) {
    return 'json-schema';
  }

  return 'none';
}

/**
 * Returns true if the input is a Zod schema (v3 or v4).
 * Convenience wrapper — prefer detectSchema() when you need the full kind.
 */
export function isZod(input: unknown): boolean {
  return detectSchema(input) === 'zod';
}

/**
 * Returns true if the input can be used for runtime validation
 * (has .safeParse()/.parse(), or is a Zod schema).
 */
export function isValidatable(input: unknown): boolean {
  const kind = detectSchema(input);
  return kind === 'zod' || kind === 'parseable';
}

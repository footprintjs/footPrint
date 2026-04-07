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
export declare function detectSchema(input: unknown): SchemaKind;
/**
 * Returns true if the input is a Zod schema (v3 or v4).
 * Convenience wrapper — prefer detectSchema() when you need the full kind.
 */
export declare function isZod(input: unknown): boolean;
/**
 * Returns true if the input can be used for runtime validation
 * (has .safeParse()/.parse(), or is a Zod schema).
 */
export declare function isValidatable(input: unknown): boolean;

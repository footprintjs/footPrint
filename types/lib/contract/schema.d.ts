/**
 * contract/schema.ts — Schema normalization utilities.
 *
 * Converts Zod schemas or raw JSON Schema objects into a normalized
 * JsonSchema format. Detection delegated to schema/detect.ts (single source of truth).
 *
 * Standalone: no dependency on Zod at import time.
 * Compatible with Zod v4 internals.
 */
import type { JsonSchema, SchemaInput } from './types.js';
/** Convert a Zod schema object to JSON Schema. */
export declare function zodToJsonSchema(zodSchema: Record<string, unknown>): JsonSchema;
export declare function normalizeSchema(input: SchemaInput): JsonSchema;

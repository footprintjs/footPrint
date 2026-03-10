/**
 * contract/schema.ts — Schema normalization utilities.
 *
 * Converts Zod schemas or raw JSON Schema objects into a normalized
 * JsonSchema format. Detection delegated to schema/detect.ts (single source of truth).
 *
 * Standalone: no dependency on Zod at import time.
 * Compatible with Zod v4 internals.
 */

import { isZod } from '../schema/detect';
import type { JsonSchema, SchemaInput } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Zod Detection — delegates to unified schema/detect.ts
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use `isZod()` from `schema/detect` instead. Kept for backward compatibility. */
export function isZodSchema(input: unknown): boolean {
  return isZod(input);
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod v4 → JSON Schema (minimal converter for common types)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the def object from a Zod schema.
 * In Zod v4, top-level schemas have `.def`, inner types accessed via
 * `_def` or `.def` depending on context.
 */
function getDef(zodSchema: Record<string, unknown>): Record<string, unknown> | undefined {
  // Top-level Zod v4 schema: `.def` property
  if (zodSchema.def && typeof zodSchema.def === 'object') {
    return zodSchema.def as Record<string, unknown>;
  }
  // Nested via _def (e.g., when accessing directly)
  if (zodSchema._def && typeof zodSchema._def === 'object') {
    return zodSchema._def as Record<string, unknown>;
  }
  return undefined;
}

/** Get description from a Zod v4 schema (stored via .description or .meta()) */
function getDescription(zodSchema: Record<string, unknown>): string | undefined {
  if (typeof zodSchema.description === 'string') return zodSchema.description;
  return undefined;
}

function zodDefToJsonSchema(def: Record<string, unknown>, zodSchema?: Record<string, unknown>): JsonSchema {
  const typeName = def.type as string | undefined;
  const description = zodSchema ? getDescription(zodSchema) : undefined;
  const base: JsonSchema = {};
  if (description) base.description = description;

  switch (typeName) {
    case 'string':
      return { ...base, type: 'string' };

    case 'number':
      return { ...base, type: 'number' };

    case 'boolean':
      return { ...base, type: 'boolean' };

    case 'literal': {
      // Zod v4: _def.values is an array of literal values
      const values = def.values as unknown[] | undefined;
      if (values && values.length === 1) {
        return { ...base, type: typeof values[0], enum: values };
      }
      return { ...base, enum: values ?? [] };
    }

    case 'enum': {
      // Zod v4: _def.entries is { key: value } object
      const entries = def.entries as Record<string, unknown> | undefined;
      const values = entries ? Object.values(entries) : [];
      return { ...base, type: 'string', enum: values };
    }

    case 'array': {
      // Zod v4: _def.element is the inner schema object
      const element = def.element as Record<string, unknown> | undefined;
      const elementDef = element ? getDef(element) : undefined;
      const items = elementDef ? zodDefToJsonSchema(elementDef, element) : {};
      return { ...base, type: 'array', items };
    }

    case 'object': {
      // Zod v4: _def.shape is a direct object (not a function)
      const shape = def.shape as Record<string, unknown> | undefined;
      if (!shape) return { ...base, type: 'object' };

      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        const fieldSchema = value as Record<string, unknown>;
        const fieldDef = getDef(fieldSchema);
        if (fieldDef) {
          // Check if field is optional or has default
          if (fieldDef.type === 'optional' || fieldDef.type === 'default') {
            const inner = fieldDef.innerType as Record<string, unknown> | undefined;
            const innerDef = inner ? getDef(inner) : undefined;
            if (innerDef) {
              const schema = zodDefToJsonSchema(innerDef, inner);
              if (fieldDef.type === 'default' && fieldDef.defaultValue !== undefined) {
                schema.default = fieldDef.defaultValue;
              }
              properties[key] = schema;
            } else {
              properties[key] = {};
            }
          } else {
            properties[key] = zodDefToJsonSchema(fieldDef, fieldSchema);
            required.push(key);
          }
        }
      }

      return {
        ...base,
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }

    case 'optional': {
      const inner = def.innerType as Record<string, unknown> | undefined;
      const innerDef = inner ? getDef(inner) : undefined;
      return innerDef ? zodDefToJsonSchema(innerDef, inner) : base;
    }

    case 'default': {
      const inner = def.innerType as Record<string, unknown> | undefined;
      const innerDef = inner ? getDef(inner) : undefined;
      const schema = innerDef ? zodDefToJsonSchema(innerDef, inner) : base;
      if (def.defaultValue !== undefined) {
        schema.default = def.defaultValue;
      }
      return schema;
    }

    case 'nullable': {
      const inner = def.innerType as Record<string, unknown> | undefined;
      const innerDef = inner ? getDef(inner) : undefined;
      const schema = innerDef ? zodDefToJsonSchema(innerDef, inner) : {};
      return { ...base, oneOf: [schema, { type: 'null' }] };
    }

    case 'union': {
      const options = def.options as Array<Record<string, unknown>> | undefined;
      if (!options) return base;
      return {
        ...base,
        oneOf: options
          .map((o) => {
            const oDef = getDef(o);
            return oDef ? zodDefToJsonSchema(oDef, o) : null;
          })
          .filter((s): s is JsonSchema => s !== null),
      };
    }

    case 'record': {
      // Zod v4: _def.valueType is the value schema
      const valueType = def.valueType as Record<string, unknown> | undefined;
      const valueDef = valueType ? getDef(valueType) : undefined;
      return {
        ...base,
        type: 'object',
        additionalProperties: valueDef ? zodDefToJsonSchema(valueDef, valueType) : true,
      };
    }

    case 'any':
      return base;

    case 'pipe': {
      // Zod v4: .transform() / .refine() — unwrap to input schema
      const inner = def.in as Record<string, unknown> | undefined;
      const innerDef = inner ? getDef(inner) : undefined;
      return innerDef ? zodDefToJsonSchema(innerDef, inner) : base;
    }

    default:
      // Unknown Zod type — return empty schema
      return base;
  }
}

/** Convert a Zod schema object to JSON Schema. */
export function zodToJsonSchema(zodSchema: Record<string, unknown>): JsonSchema {
  const def = getDef(zodSchema);
  if (!def) return {};
  return zodDefToJsonSchema(def, zodSchema);
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalize — accepts either Zod or JSON Schema, returns JSON Schema
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeSchema(input: SchemaInput): JsonSchema {
  if (isZodSchema(input)) {
    return zodToJsonSchema(input as Record<string, unknown>);
  }
  // Already a JSON Schema
  return input as JsonSchema;
}

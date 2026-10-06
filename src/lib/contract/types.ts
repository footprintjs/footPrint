/**
 * contract/types.ts — Schema types for the FlowChart contract layer.
 *
 * JsonSchema and SchemaInput describe the normalization boundary. The chart's
 * own OpenAPI options are `ChartOpenAPIOptions` (runner/RunnableChart.ts).
 */

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema (subset of JSON Schema Draft 2020-12 / OpenAPI 3.1)
// ─────────────────────────────────────────────────────────────────────────────

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  format?: string;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  [key: string]: unknown;
};

// ─────────────────────────────────────────────────────────────────────────────
// Schema Input — accepts either Zod schema or raw JSON Schema
// ─────────────────────────────────────────────────────────────────────────────

/** Anything with a `def` (Zod v4) or `_def` (Zod v3) property is treated as a Zod schema. */
export type SchemaInput = JsonSchema | { def: unknown; [key: string]: unknown };

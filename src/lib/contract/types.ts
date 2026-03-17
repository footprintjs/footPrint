/**
 * contract/types.ts — Types for the FlowChart contract layer.
 *
 * Defines the I/O boundary for a flowchart: input schema, output schema,
 * and output mapper. Uses the same pattern as SubflowMountOptions
 * (inputMapper/outputMapper) but at the top-level flowchart boundary.
 */

import type { FlowChart } from '../builder/types.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// FlowChart Contract — I/O boundary definition
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowChartContractOptions<_TInput = unknown, TOutput = unknown> {
  /** Schema describing the input (readOnlyContext) shape. Zod or JSON Schema. */
  inputSchema?: SchemaInput;
  /** Schema describing the output shape. Zod or JSON Schema. */
  outputSchema?: SchemaInput;
  /** Maps the final scope state into the response shape. */
  outputMapper?: (finalScope: Record<string, unknown>) => TOutput;
}

export interface FlowChartContract<_TInput = unknown, TOutput = unknown> {
  /** The compiled flowchart. */
  chart: FlowChart;
  /** JSON Schema for the input (normalized from Zod or raw). */
  inputSchema?: JsonSchema;
  /** JSON Schema for the output (normalized from Zod or raw). */
  outputSchema?: JsonSchema;
  /** Maps the final scope state into the response shape. */
  outputMapper?: (finalScope: Record<string, unknown>) => TOutput;
  /** Auto-generated OpenAPI spec. */
  toOpenAPI(options?: OpenAPIOptions): OpenAPISpec;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAPI Types (minimal subset of OpenAPI 3.1)
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenAPIOptions {
  /** API version string (default: "1.0.0"). */
  version?: string;
  /** Base path prefix (default: "/"). */
  basePath?: string;
  /** HTTP method for the execute endpoint (default: "post"). */
  method?: string;
}

export interface OpenAPISpec {
  openapi: '3.1.0';
  info: {
    title: string;
    description: string;
    version: string;
  };
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
  };
}

export interface OpenAPIOperation {
  operationId: string;
  summary: string;
  description: string;
  requestBody?: {
    required: boolean;
    content: {
      'application/json': {
        schema: JsonSchema | { $ref: string };
      };
    };
  };
  responses: Record<
    string,
    {
      description: string;
      content?: {
        'application/json': {
          schema: JsonSchema | { $ref: string };
        };
      };
    }
  >;
}

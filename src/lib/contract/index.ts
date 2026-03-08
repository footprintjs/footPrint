/* istanbul ignore file */
/**
 * contract/ — FlowChart I/O contract and OpenAPI generation layer.
 *
 * Standalone library: wraps a compiled FlowChart with input/output schemas
 * and generates OpenAPI 3.1 specs. Uses the same inputMapper/outputMapper
 * pattern as subflow mounting.
 *
 * Zero runtime deps on Zod — Zod schemas detected via duck-typing and
 * converted to JSON Schema at contract creation time.
 */

// Factory
export { defineContract } from './defineContract';

// Schema utilities
export { isZodSchema, normalizeSchema, zodToJsonSchema } from './schema';

// OpenAPI generator
export { generateOpenAPI } from './openapi';

// Types
export type {
  FlowChartContract,
  FlowChartContractOptions,
  JsonSchema,
  OpenAPIOptions,
  OpenAPISpec,
  SchemaInput,
} from './types';

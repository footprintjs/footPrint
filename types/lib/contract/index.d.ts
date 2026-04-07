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
export { defineContract } from './defineContract.js';
export { normalizeSchema, zodToJsonSchema } from './schema.js';
export { generateOpenAPI } from './openapi.js';
export type { FlowChartContract, FlowChartContractOptions, JsonSchema, OpenAPIOptions, OpenAPISpec, SchemaInput, } from './types.js';

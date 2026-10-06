/* istanbul ignore file */
/**
 * contract/ — Schema normalization for self-describing charts.
 *
 * FlowChartBuilder.contract owns schema attachment. RunnableChart.makeRunnable
 * owns chart.toOpenAPI and chart.toMCPTool; both normalize schemas here.
 *
 * Zero runtime deps on Zod — Zod schemas detected via duck-typing and
 * converted to JSON Schema when a chart is described.
 */

// Schema utilities
export { normalizeSchema, zodToJsonSchema } from './schema.js';

// Types
export type { JsonSchema, SchemaInput } from './types.js';

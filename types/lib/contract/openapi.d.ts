/**
 * contract/openapi.ts — OpenAPI 3.1 spec generator.
 *
 * Generates an OpenAPI spec from a FlowChartContract by combining:
 * - chart.description → operation description (built incrementally during FlowChartBuilder.build())
 * - inputSchema → requestBody
 * - outputSchema → response
 *
 * chart.description is assembled by FlowChartBuilder as each stage is added —
 * no post-processing walk of buildTimeStructure is needed or performed here.
 */
import type { FlowChartContract, OpenAPIOptions, OpenAPISpec } from './types.js';
/**
 * Generates an OpenAPI 3.1 spec from a FlowChartContract.
 * Uses `chart.description` which FlowChartBuilder assembles at build time —
 * no post-processing walk of buildTimeStructure is performed here.
 */
export declare function generateOpenAPI(contract: FlowChartContract, options?: OpenAPIOptions): OpenAPISpec;

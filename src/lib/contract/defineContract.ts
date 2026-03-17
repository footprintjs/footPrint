/**
 * contract/defineContract.ts — Factory for creating a FlowChartContract.
 *
 * Wraps a compiled FlowChart with I/O schemas and an output mapper,
 * using the same pattern as SubflowMountOptions (inputMapper/outputMapper).
 *
 * Usage:
 *   const contract = defineContract(chart, {
 *     inputSchema: z.object({ name: z.string() }),
 *     outputSchema: z.object({ greeting: z.string() }),
 *     outputMapper: (scope) => ({ greeting: scope.message as string }),
 *   });
 *
 *   const openapi = contract.toOpenAPI();
 */

import type { FlowChart } from '../builder/types.js';
import { generateOpenAPI } from './openapi.js';
import { normalizeSchema } from './schema.js';
import type { FlowChartContract, FlowChartContractOptions, OpenAPIOptions, OpenAPISpec } from './types.js';

export function defineContract<TInput = unknown, TOutput = unknown>(
  chart: FlowChart,
  options: FlowChartContractOptions<TInput, TOutput>,
): FlowChartContract<TInput, TOutput> {
  const inputSchema = options.inputSchema ? normalizeSchema(options.inputSchema) : undefined;
  const outputSchema = options.outputSchema ? normalizeSchema(options.outputSchema) : undefined;

  // Propagate original schema to chart for runtime validation (if chart doesn't have one).
  // Contract schemas are normalized to JSON Schema for OpenAPI, but the chart needs the
  // original Zod schema to call .safeParse() at runtime in FlowChartExecutor.run().
  if (options.inputSchema && !chart.inputSchema) {
    (chart as { inputSchema?: unknown }).inputSchema = options.inputSchema;
  }

  const contract: FlowChartContract<TInput, TOutput> = {
    chart,
    inputSchema,
    outputSchema,
    outputMapper: options.outputMapper,
    toOpenAPI(apiOptions?: OpenAPIOptions): OpenAPISpec {
      return generateOpenAPI(contract, apiOptions);
    },
  };

  return contract;
}

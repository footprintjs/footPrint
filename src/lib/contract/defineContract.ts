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

import type { FlowChart } from '../builder/types';
import { generateOpenAPI } from './openapi';
import { normalizeSchema } from './schema';
import type { FlowChartContract, FlowChartContractOptions, OpenAPIOptions, OpenAPISpec } from './types';

export function defineContract<TInput = unknown, TOutput = unknown>(
  chart: FlowChart,
  options: FlowChartContractOptions<TInput, TOutput>,
): FlowChartContract<TInput, TOutput> {
  const inputSchema = options.inputSchema ? normalizeSchema(options.inputSchema) : undefined;
  const outputSchema = options.outputSchema ? normalizeSchema(options.outputSchema) : undefined;

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

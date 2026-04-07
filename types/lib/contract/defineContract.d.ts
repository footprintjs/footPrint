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
import type { FlowChartContract, FlowChartContractOptions } from './types.js';
export declare function defineContract<TInput = unknown, TOutput = unknown>(chart: FlowChart, options: FlowChartContractOptions<TInput, TOutput>): FlowChartContract<TInput, TOutput>;

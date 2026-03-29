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

  // Build a lightweight chart view for the contract.
  //
  // We must NOT mutate the original `chart` object because charts are compiled
  // artifacts meant to be shared across multiple concurrent executors. Mutating
  // any schema field after build would be visible to all holders of that chart
  // reference, causing cross-contract contamination.
  //
  // Instead, use Object.create(chart) to create a prototype-linked view:
  //   - All properties (root, stageMap, subflows, methods…) are inherited via
  //     the prototype chain — zero extra copying.
  //   - Setting schema fields on the view creates OWN properties that shadow
  //     the prototype's value, leaving the original chart untouched.
  //   - FlowChartExecutor reads chartView.inputSchema which resolves to the
  //     own-property (contract schema) before the prototype (builder schema).
  //   - RunContext reads chartView.outputMapper to apply the output transform —
  //     that must also be shadowed here so the contract's mapper wins.
  //
  // Limitation: Object.keys(chartView) returns only own properties (the schema
  // fields that were shadowed). Do NOT use Object.keys(), spread ({...chartView}),
  // or JSON.stringify(chartView) on this view — use named property access or
  // chart.toSpec() instead.
  const chartView = Object.create(chart) as FlowChart;
  const view = chartView as Partial<FlowChart>;
  if (options.inputSchema) {
    view.inputSchema = options.inputSchema;
  }
  if (options.outputSchema) {
    view.outputSchema = options.outputSchema;
  }
  if (options.outputMapper) {
    view.outputMapper = options.outputMapper as ((s: Record<string, unknown>) => unknown) | undefined;
  }

  const contract: FlowChartContract<TInput, TOutput> = {
    chart: chartView,
    inputSchema,
    outputSchema,
    outputMapper: options.outputMapper,
    toOpenAPI(apiOptions?: OpenAPIOptions): OpenAPISpec {
      return generateOpenAPI(contract, apiOptions);
    },
  };

  return contract;
}

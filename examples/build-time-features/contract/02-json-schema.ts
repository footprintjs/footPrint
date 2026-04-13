/**
 * Contract — Plain JSON Schema (No Zod)
 *
 * .contract() also accepts plain JSON Schema objects. Useful when
 * you don't want a Zod dependency.
 *
 * Run: npx tsx examples/build-time-features/contract/02-json-schema.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';

interface State { result?: string }

const chart = flowChart<State>('Process', async (scope) => {
  const { name, age } = scope.$getArgs<{ name: string; age: number }>();
  scope.result = `${name} is ${age} years old`;
}, 'process')
  .contract({
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name' },
        age: { type: 'number', description: 'Age in years' },
      },
      required: ['name', 'age'],
    },
    output: {
      type: 'object',
      properties: {
        result: { type: 'string' },
      },
    },
    mapper: (scope) => ({ result: scope.result }),
  })
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  await executor.run({ input: { name: 'Alice', age: 30 } });
  console.log('Result:', executor.getSnapshot().sharedState?.result);

  // toMCPTool uses the JSON schema directly
  const tool = chart.toMCPTool();
  console.log('\nMCP tool input schema:', JSON.stringify(tool.inputSchema, null, 2));
})().catch(console.error);

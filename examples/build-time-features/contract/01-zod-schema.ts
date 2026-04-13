/**
 * Contract — Zod Schema Validation
 *
 * .contract() with Zod schemas provides compile-time types AND runtime
 * validation. Invalid input throws InputValidationError with field-level details.
 *
 * Run: npx tsx examples/build-time-features/contract/01-zod-schema.ts
 */

import { z } from 'zod';
import { flowChart, FlowChartExecutor } from 'footprintjs';

interface State { subtotal?: number; tax?: number; total?: number }

const chart = flowChart<State>('Calculate', async (scope) => {
  const { quantity, unitPrice } = scope.$getArgs<{ quantity: number; unitPrice: number }>();
  scope.subtotal = quantity * unitPrice;
  scope.tax = Math.round(scope.subtotal * 0.08 * 100) / 100;
  scope.total = scope.subtotal + scope.tax;
}, 'calculate')
  .contract({
    input: z.object({
      quantity: z.number().positive().describe('Number of units'),
      unitPrice: z.number().positive().describe('Price per unit'),
    }),
    output: z.object({
      total: z.number().describe('Total including tax'),
    }),
    mapper: (scope) => ({ total: scope.total }),
  })
  .build();

(async () => {
  // Valid input
  const executor = new FlowChartExecutor(chart);
  await executor.run({ input: { quantity: 5, unitPrice: 9.99 } });
  console.log('Total:', executor.getSnapshot().sharedState?.total);

  // Invalid input — throws with field-level errors
  try {
    const executor2 = new FlowChartExecutor(chart);
    await executor2.run({ input: { quantity: -1, unitPrice: 0 } });
  } catch (err: any) {
    console.log('\nValidation error:', err.message);
    if (err.issues) {
      for (const issue of err.issues) {
        console.log(`  ${issue.path.join('.')}: ${issue.message}`);
      }
    }
  }
})().catch(console.error);

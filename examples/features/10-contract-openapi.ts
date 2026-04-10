/**
 * Feature: Contract & OpenAPI
 *
 * Demonstrates defining I/O contracts on flowcharts and generating
 * OpenAPI 3.1 specs. Supports both Zod schemas and raw JSON Schema.
 *
 * Run:  npm run feature:contract
 * Try it: https://footprintjs.github.io/footprint-playground/samples/contract-openapi
 */

import {
  flowChart,
  FlowChartExecutor,
  decide,
} from 'footprintjs';
import { z } from 'zod';

interface OrderState {
  subtotal?: number;
  tax?: number;
  total?: number;
  shippingMethod?: string;
  status?: string;
}

(async () => {

  const chart = flowChart<OrderState>('ReceiveOrder', async (scope) => {
    // Input arrives via $getArgs() — separate from state
    scope.$log('Order received');
  }, 'receive-order')

    .addFunction('CalculateTotal', async (scope) => {
      const { quantity, unitPrice } = scope.$getArgs<{ quantity: number; unitPrice: number }>();
      scope.subtotal = quantity * unitPrice;
      scope.tax = Math.round(scope.subtotal * 0.08 * 100) / 100;
      scope.total = scope.subtotal + scope.tax;
    }, 'calculate-total')
    .addDeciderFunction('ClassifyOrder', (scope) => {
      return decide(scope, [
        { when: { total: { gt: 100 } }, then: 'large', label: 'Large order' },
      ], 'small');
    }, 'classify-order', 'Route by order size')
      .addFunctionBranch('large', 'ProcessLargeOrder', async (scope) => {
        scope.shippingMethod = 'express';
        scope.status = 'approved -- large order, express shipping';
      })
      .addFunctionBranch('small', 'ProcessSmallOrder', async (scope) => {
        scope.shippingMethod = 'standard';
        scope.status = 'approved -- standard shipping';
      })
      .setDefault('small')
      .end()
    .contract({
      input: z.object({
        item: z.string().describe('Product name'),
        quantity: z.number().describe('Number of units'),
        unitPrice: z.number().describe('Price per unit in USD'),
      }),
      output: z.object({
        total: z.number().describe('Order total including tax'),
        shippingMethod: z.enum(['standard', 'express']),
        status: z.string(),
      }),
      mapper: (scope) => ({
        total: scope.total as number,
        shippingMethod: scope.shippingMethod as string,
        status: scope.status as string,
      }),
    })
    .build();

  // ── Contract metadata ────────────────────────────────────────────────────

  console.log('=== Contract with Zod Schemas ===\n');

  console.log('Input schema (JSON Schema):');
  console.log(JSON.stringify(chart.inputSchema, null, 2));

  // ── Run the pipeline ────────────────────────────────────────────────────

  console.log('\n=== Pipeline Execution ===\n');

  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run({
    input: { item: 'Widget Pro', quantity: 3, unitPrice: 29.99 },
  });

  const narrative = executor.getNarrative();
  console.log('Narrative:');
  narrative.forEach((line) => console.log(`  ${line}`));

  const snapshot = executor.getSnapshot();
  const output = chart.outputMapper?.(snapshot.sharedState || {});
  console.log('\nMapped output:');
  console.log(JSON.stringify(output, null, 2));

})().catch(console.error);

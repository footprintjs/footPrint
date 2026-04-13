/**
 * Self-Describing — OpenAPI 3.1 Generation
 *
 * chart.toOpenAPI() generates a complete OpenAPI spec from the
 * contract schemas and stage descriptions.
 *
 * Run: npx tsx examples/build-time-features/self-describing/01-openapi.ts
 */

import { z } from 'zod';
import { flowChart } from 'footprintjs';

interface State { total?: number; status?: string }

const chart = flowChart<State>('ReceiveOrder', async (scope) => {
  const { quantity, unitPrice } = scope.$getArgs<{ quantity: number; unitPrice: number }>();
  scope.total = quantity * unitPrice;
  scope.status = scope.total > 100 ? 'express' : 'standard';
}, 'receive', undefined, 'Calculate order total and assign shipping')
  .contract({
    input: z.object({
      quantity: z.number().positive(),
      unitPrice: z.number().positive(),
    }),
    output: z.object({
      total: z.number(),
      status: z.string(),
    }),
    mapper: (scope) => ({ total: scope.total, status: scope.status }),
  })
  .build();

const spec = chart.toOpenAPI({
  title: 'Order Processing API',
  version: '1.0.0',
  path: '/orders/process',
});

console.log(JSON.stringify(spec, null, 2));

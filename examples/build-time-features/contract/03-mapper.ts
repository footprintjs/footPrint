/**
 * Contract — Output Mapper
 *
 * The contract's `mapper` is what shapes the run's *public* output from the
 * pipeline's *internal* scope. Without it, callers see whatever fields the
 * stages happened to set. With it, you publish a stable contract: pick the
 * fields, rename them, derive new ones, hide internal state.
 *
 * The schema validates; the mapper projects. Both are optional — but pairing
 * them gives you a typed return value that doesn't leak implementation.
 *
 * Run: npx tsx examples/build-time-features/contract/03-mapper.ts
 */

import { z } from 'zod';
import { flowChart, FlowChartExecutor } from 'footprintjs';

interface InternalState {
  // Internal computation — should NOT leak to the caller
  _rawTax: number;
  _shippingCost: number;
  _discountApplied: number;
  // Surface fields
  total?: number;
  itemCount?: number;
  receiptId?: string;
}

const chart = flowChart<InternalState>('Calculate', async (scope) => {
  const { basePrice, quantity } = scope.$getArgs<{ basePrice: number; quantity: number }>();
  scope._rawTax = basePrice * quantity * 0.08;
  scope._shippingCost = quantity > 10 ? 0 : 4.99;
  scope._discountApplied = quantity >= 5 ? basePrice * quantity * 0.05 : 0;
  scope.total = basePrice * quantity + scope._rawTax + scope._shippingCost - scope._discountApplied;
  scope.itemCount = quantity;
  scope.receiptId = `R-${Date.now()}`;
}, 'calc')
  .contract({
    input: z.object({
      basePrice: z.number().positive(),
      quantity: z.number().int().positive(),
    }),
    output: z.object({
      receiptId: z.string(),
      total: z.number(),
      itemCount: z.number(),
      // Derived field — composed by the mapper, not stored in scope
      hasShippingFee: z.boolean(),
    }),
    // The mapper receives the raw scope as Record<string, unknown> — cast through the
    // known shape, project to the public surface, drop the `_` internals.
    mapper: (raw) => {
      const scope = raw as unknown as InternalState;
      return {
        receiptId: scope.receiptId!,
        total: Number(scope.total!.toFixed(2)),
        itemCount: scope.itemCount!,
        hasShippingFee: scope._shippingCost > 0,
      };
    },
  })
  .build();

(async () => {
  // chart.run() returns RunResult with `.output` (the mapped result).
  // Use it for the validated, clean public surface.
  const { output, state } = await chart.run({ input: { basePrice: 19.99, quantity: 7 } });

  console.log('Public output (mapper-projected):', output);

  console.log('\nInternal scope (still available for debugging):');
  console.log(state);
})().catch(console.error);

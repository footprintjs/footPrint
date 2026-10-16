/** Explicit provider-neutral workflow: a lost response is reconciled before another send. No real provider calls. */
import { flowChart, FlowChartExecutor, type RetryLoopState } from 'footprintjs';

type Order = { payment?: RetryLoopState<string> };
let sent = 0;
const keys: string[] = [];
const chart = flowChart<Order>('Load order', () => undefined, 'load')
  .addRetryLoop('payment', {
    touches: 'demo-payments',
    idempotencyKey: ({ args }) => `order-${(args as { id: string }).id}`,
    retry: { attempts: 3, timeoutMs: 50, backoffMs: 0 },
    attempt: (_scope, attempt) => {
      keys.push(attempt.idempotencyKey!);
      if (++sent === 1) throw new Error('The response was lost');
      return 'receipt-1';
    },
    // An adapter must authoritatively establish none; an empty search alone is insufficient.
    reconcile: () => 'none',
  })
  .build();
async function main() {
  const executor = new FlowChartExecutor(chart);
  await executor.run({ input: { id: 'synthetic-1' } });
  if (JSON.stringify(keys) !== JSON.stringify(['order-synthetic-1', 'order-synthetic-1']))
    throw new Error('operation key changed');
  if ((executor.getSnapshot().sharedState.payment as RetryLoopState<string>).value !== 'receipt-1')
    throw new Error('missing receipt');
  console.log('✓ explicit retry: reconcile, same key, then retry; no provider lock-in');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

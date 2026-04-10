/**
 * Quick Start — Build, run, and observe your first pipeline in under 5 minutes.
 *
 * Run: npx tsx examples/getting-started/quick-start.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';

// ── 1. Define your state ───────────────────────────────────────────────

interface OrderState {
  orderId: string;
  total: number;
  status?: string;
}

// ── 2. Build your flowchart ────────────────────────────────────────────

const chart = flowChart<OrderState>(
  'ValidateOrder',
  async (scope) => {
    scope.status = scope.total > 0 ? 'valid' : 'invalid';
  },
  'validate',
)
  .addFunction(
    'ProcessPayment',
    async (scope) => {
      scope.status = 'paid';
    },
    'process',
  )
  .build();

// ── 3. Run and observe ─────────────────────────────────────────────────

(async () => {

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run({ input: { orderId: 'ORD-001', total: 49.99 } });

// The narrative generates itself — no manual logging
console.log('=== Narrative ===\n');
for (const line of executor.getNarrative()) {
  console.log(line);
}

// Full state snapshot
console.log('\n=== Final State ===\n');
const snapshot = executor.getSnapshot();
console.log(JSON.stringify(snapshot?.sharedState, null, 2));

})().catch(console.error);

/**
 * Pause/Resume — Cross-Executor (Redis-style round trip)
 *
 * The real-world HITL pattern: pause in one process, persist the
 * checkpoint to external storage (Redis, Postgres, S3...), then resume
 * later from a fresh `FlowChartExecutor` instance — possibly on a
 * different host. The checkpoint is JSON-safe; that's the contract.
 *
 * What this exercises that the other pause-resume examples don't:
 *   1. `JSON.stringify(checkpoint)` → external storage → `JSON.parse(...)`
 *   2. A NEW `FlowChartExecutor(chart)` (no prior `run()` on it) calls
 *      `resume(checkpoint, input)` — the executor seeds its runtime
 *      from `checkpoint.sharedState` instead of reusing the original.
 *   3. Pre-pause subflow scope survives the round trip via
 *      `checkpoint.subflowStates` (always present — empty `{}` for
 *      root-level pauses).
 *
 * Run: npx tsx examples/runtime-features/pause-resume/07-cross-executor.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { PausableHandler } from 'footprintjs';

interface OrderState {
  history: string[];
  approved?: boolean;
  finalStatus?: string;
}

const approval: PausableHandler<any> = {
  execute: async (scope) => {
    scope.history = [...scope.history, `awaiting review @${new Date().toISOString()}`];
    const args = scope.$getArgs() as { orderId: string; amount: number };
    return { question: `Approve $${args.amount} for ${args.orderId}?` };
  },
  resume: async (scope, input) => {
    // CRITICAL: this read must work on a FRESH executor. Pre-pause
    // `scope.history` is in `checkpoint.sharedState`; the new executor
    // seeds its runtime from there before calling `resume`.
    const decision = input as { approved: boolean; reviewer: string };
    scope.history = [...scope.history, `reviewed by ${decision.reviewer}`];
    scope.approved = decision.approved;
  },
};

const chart = flowChart<OrderState>('Receive', async (scope) => {
  scope.history = ['received'];
}, 'receive')
  .addPausableFunction('Approval', approval, 'approval')
  .addFunction('Finalize', async (scope) => {
    scope.finalStatus = scope.approved ? 'shipped' : 'rejected';
    scope.history = [...scope.history, `final: ${scope.finalStatus}`];
  }, 'finalize')
  .build();

// ─── Process A: pause and persist ────────────────────────────────────
async function processA(): Promise<string> {
  const executor = new FlowChartExecutor(chart);
  await executor.run({ input: { orderId: 'ORD-42', amount: 299 } });

  if (!executor.isPaused()) throw new Error('expected pause');

  const checkpoint = executor.getCheckpoint()!;
  // JSON-safe by contract. Store anywhere — Redis, Postgres, S3.
  const wire = JSON.stringify(checkpoint);
  console.log(`[A] paused at ${checkpoint.pausedStageId}, ${wire.length} bytes serialized`);
  return wire;
}

// ─── Process B: resume on a fresh executor ──────────────────────────
async function processB(wire: string, decision: { approved: boolean; reviewer: string }) {
  const checkpoint = JSON.parse(wire);
  const executor = new FlowChartExecutor(chart); // brand new instance — no prior run()
  await executor.resume(checkpoint, decision);

  const state = executor.getSnapshot().sharedState as Record<string, unknown>;
  console.log(`[B] resumed on fresh executor, final status: ${state.finalStatus}`);
  console.log(`[B] history (pre-pause + resume): ${JSON.stringify(state.history)}`);
}

(async () => {
  const wire = await processA();
  await processB(wire, { approved: true, reviewer: 'alice' });
})().catch(console.error);

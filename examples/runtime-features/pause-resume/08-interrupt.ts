/**
 * interrupt() — stop mid-stage to ask, and get the answer back
 *
 * `addPausableFunction` splits a stage you DECLARED pausable into two halves.
 * `interrupt()` is the other shape: an ordinary stage stops in the middle of
 * its body to ask a question, and the answer comes back out of the same call
 * when the run resumes.
 *
 *     const approval = interrupt(scope, { reason: 'Approve this refund?' });
 *     //                ^ throws on the first pass
 *     //                ^ returns your answer after resume()
 *
 * ## The law that decides how you write the body
 *
 * RESUME RE-ENTERS THE STAGE FROM ITS TOP. Stages are atomic — a stage that
 * stopped in the middle has no half to resume into — so everything before the
 * `interrupt()` call runs AGAIN. (This is the same law `resumeOnError`
 * states.) In practice:
 *
 *   - keep the half before the call idempotent: compute, read, stage a value;
 *   - put anything that must happen exactly once AFTER the call, or in a
 *     later stage;
 *   - writes made before the interrupt ARE committed (footprintjs never rolls
 *     state back), which is exactly why the resumed pass can see its own
 *     earlier work.
 *
 * ## Everything else is the pause machinery you already have
 *
 * One `FlowchartCheckpoint`, JSON-safe, store it anywhere. The payload you
 * passed is its `pauseData`, and `pausedBy: 'interrupt'` tells `resume()`
 * which re-entry to use.
 *
 * Run: npx tsx examples/runtime-features/pause-resume/08-interrupt.ts
 */

import type { FlowchartCheckpoint } from 'footprintjs';
import { flowChart, FlowChartExecutor, interrupt } from 'footprintjs';

interface RefundState {
  orderId: string;
  amount: number;
  riskLevel: string;
  approved: boolean;
  approver: string;
  outcome: string;
  [key: string]: unknown;
}

/** What we ask the human for, and what they send back. */
interface ApprovalAnswer {
  approved: boolean;
  approver: string;
}

const chart = flowChart<RefundState>(
  'Assess refund',
  (scope) => {
    // ── Idempotent half: safe to re-run on resume ──
    scope.orderId = 'ORD-4471';
    scope.amount = 4200;
    scope.riskLevel = scope.amount > 1000 ? 'high' : 'normal';

    // ── The question ──
    const answer = interrupt<ApprovalAnswer>(scope, {
      reason: `Approve a $${scope.amount} refund on ${scope.orderId}? (risk: ${scope.riskLevel})`,
      // `expects` is carried verbatim to the checkpoint — the engine never
      // interprets it. A UI uses it to render the right form.
      expects: { approved: 'boolean', approver: 'string' },
    });

    // ── Everything below runs only after resume() ──
    scope.approved = answer.approved;
    scope.approver = answer.approver;
  },
  'assess-refund',
)
  .addFunction(
    'Settle',
    (scope) => {
      scope.outcome = scope.approved ? `refunded by ${scope.approver}` : `declined by ${scope.approver}`;
    },
    'settle',
  )
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);

  // ── Pass 1: the stage asks ────────────────────────────────────────────────
  const first = await executor.run();

  if (!(typeof first === 'object' && first !== null && 'paused' in first)) {
    throw new Error('expected the run to pause');
  }
  const checkpoint = (first as { checkpoint: FlowchartCheckpoint }).checkpoint;

  console.log('\n── Paused ──');
  console.log('  stage:      ', checkpoint.pausedStageId);
  console.log('  raised by:  ', checkpoint.pausedBy);
  console.log('  question:   ', (checkpoint.pauseData as { reason: string }).reason);
  console.log('  expects:    ', (checkpoint.pauseData as { expects: unknown }).expects);
  console.log('  state so far:', { amount: checkpoint.sharedState.amount, riskLevel: checkpoint.sharedState.riskLevel });

  // The checkpoint is JSON-safe by contract — persist it wherever you like.
  const persisted = JSON.stringify(checkpoint);
  console.log(`  checkpoint serializes to ${persisted.length} bytes (Redis/Postgres/a file)`);

  // ── Meanwhile: a human answers ────────────────────────────────────────────
  const humanAnswer: ApprovalAnswer = { approved: true, approver: 'Dana (finance)' };

  // ── Pass 2: resume — possibly on another process, from the stored bytes ───
  const resumed = new FlowChartExecutor(chart);
  await resumed.resume(JSON.parse(persisted) as FlowchartCheckpoint, humanAnswer);

  const state = resumed.getSnapshot().sharedState as unknown as RefundState;
  console.log('\n── Resumed ──');
  console.log('  the interrupt() call returned:', humanAnswer);
  console.log('  outcome:', state.outcome);

  // ── The re-entry, made visible ────────────────────────────────────────────
  console.log('\n── Note the re-entry ──');
  console.log('  The stage body ran TWICE: once to ask, once with the answer.');
  console.log('  Its idempotent half re-computed the same values, so the');
  console.log('  net-change filter dropped them — no duplicate commit noise.');
  const assessCommits = resumed.getSnapshot().commitLog.filter((b) => b.stageId === 'assess-refund');
  console.log('  commits by assess-refund in the resumed run:', assessCommits.length);
})();

/**
 * Causal Chain — Through a Decider Branch
 *
 * Backtracks from the chosen branch through the decider back to
 * the seed data. Shows that the causal chain follows only the
 * path that was actually taken, not all branches.
 *
 * Pipeline: Seed → Route(decide) → [large: Express] / [small: Standard]
 *
 * Run: npx tsx examples/post-execution/causal-chain/02-decider.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';
import { causalChain, formatCausalChain, QualityRecorder } from 'footprintjs/trace';

interface State { amount: number; result?: string }

const chart = flowChart<State>('Seed', async (scope) => {
  scope.amount = 500;
}, 'seed')
  .addDeciderFunction('Route', (scope) => {
    return decide(scope, [
      { when: { amount: { gt: 100 } }, then: 'large', label: 'Large order' },
    ], 'small');
  }, 'route')
    .addFunctionBranch('large', 'Express', async (scope) => {
      scope.result = `express-${scope.amount}`;
    })
    .addFunctionBranch('small', 'Standard', async (scope) => {
      scope.result = `standard-${scope.amount}`;
    })
    .setDefault('small')
    .end()
  .build();

(async () => {
  const quality = new QualityRecorder(() => ({ score: 1.0 }));
  const executor = new FlowChartExecutor(chart);
  executor.attachRecorder(quality);
  await executor.run();

  const { commitLog } = executor.getSnapshot();
  const branchCommit = commitLog.find(c => c.stage === 'Express')!;

  const dag = causalChain(commitLog, branchCommit.runtimeStageId, (id) => quality.getByKey(id)?.keysRead ?? []);
  console.log(formatCausalChain(dag!));
})().catch(console.error);

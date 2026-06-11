/**
 * Causal slicing with CONTROL-dependence edges (RFC-003 Part A: D1–D5).
 *
 * The credit fixture: "why was status set to 'approved'?"
 *
 *   PullBureau   — reads the applicant's SSN from run ARGS (untracked by
 *                  design → the slice gets an honesty marker), writes
 *                  creditScore
 *   ClassifyRisk — decide() over creditScore: rule 'Good credit' → approved
 *   Approve      — writes status = 'approved'
 *
 * Data edges alone can't answer the question: Approve never READ anything —
 * it ran BECAUSE ClassifyRisk chose it. The controlDepRecorder (D5) watches
 * decisions + the runtime ancestor chain (D1's parentRuntimeStageId) and
 * gives the backtracker a `controlDeps` lookup (D3), so the slice chains
 * end-to-end:
 *
 *   status ← [control: Good credit] ClassifyRisk ← via creditScore PullBureau
 *                                                    ⚠ also consumed args
 *
 * The ⚠ honesty marker (D2) tells a consumer — human or LLM — that
 * PullBureau ALSO consumed untracked input, so the backward slice may be
 * incomplete there. The optional `weigh` hook (D4) stamps consumer-computed
 * edge weights; the engine never invents them.
 *
 * Run: npx tsx examples/runtime-features/causal-control-deps/01-credit-fixture.ts
 */

import type { ScopeRecorder, TypedScope } from 'footprintjs';
import { decide, flowChart, FlowChartExecutor } from 'footprintjs';
import type { CommitBundle } from 'footprintjs/advanced';
import type { EdgeWeigher } from 'footprintjs/trace';
import { causalChain, controlDepRecorder, formatCausalChain } from 'footprintjs/trace';

interface LoanState {
  creditScore: number;
  status: string;
  reviewer: string;
  [key: string]: unknown;
}

const chart = flowChart<LoanState>(
  'PullBureau',
  async (scope) => {
    // ARGS are untracked by design — this read marks the stage's commit
    // with untrackedSources: ['args'] (the D2 honesty flag).
    const { ssn } = scope.$getArgs<{ ssn: string }>();
    scope.creditScore = ssn.endsWith('89') ? 750 : 580;
  },
  'pull-bureau',
)
  .addDeciderFunction(
    'ClassifyRisk',
    async (scope) =>
      decide(
        scope as TypedScope<LoanState>,
        [
          { when: { creditScore: { gt: 700 } }, then: 'approved', label: 'Good credit' },
          { when: { creditScore: { gt: 600 } }, then: 'manual-review', label: 'Marginal' },
        ],
        'rejected',
      ),
    'classify-risk',
  )
  .addFunctionBranch('approved', 'Approve', async (scope: TypedScope<LoanState>) => {
    scope.status = 'approved';
  })
  .addFunctionBranch('manual-review', 'ManualReview', async (scope: TypedScope<LoanState>) => {
    scope.status = 'pending';
    scope.reviewer = 'human';
  })
  .addFunctionBranch('rejected', 'Reject', async (scope: TypedScope<LoanState>) => {
    scope.status = 'rejected';
  })
  .setDefault('rejected')
  .end()
  .build();

(async () => {
  // 1. The control-dependence recorder (D5) — watches decisions + the
  //    runtime ancestor chain during traversal. Attach BEFORE running.
  const ctrl = controlDepRecorder();

  // 2. A keysRead collector — the standard producer for the backtracker's
  //    data edges (one Map from onRead events).
  const reads = new Map<string, string[]>();
  const readsRecorder: ScopeRecorder = {
    id: 'keys-read',
    onRead: (e) => {
      if (!e.key) return;
      const arr = reads.get(e.runtimeStageId) ?? [];
      arr.push(e.key);
      reads.set(e.runtimeStageId, arr);
    },
  };

  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(ctrl);
  executor.attachScopeRecorder(readsRecorder);

  await executor.run({ input: { ssn: '123-45-6789' } });

  // 3. Slice backwards from the stage that wrote `status`.
  const commitLog = executor.getSnapshot().commitLog as CommitBundle[];
  const statusCommit = commitLog.find((b) => b.trace.some((t: { path: string }) => t.path === 'status'));
  if (!statusCommit) throw new Error('no stage wrote status');

  const dag = causalChain(commitLog, statusCommit.runtimeStageId, (id) => reads.get(id) ?? [], {
    controlDeps: ctrl.asLookup(), // D3+D5: control edges
  });
  if (!dag) throw new Error('startId not found in commit log');

  console.log('— Causal slice for `status` —');
  console.log(formatCausalChain(dag));
  // Output:
  //   Approve (approved#2) [wrote: status]
  //     ClassifyRisk (classify-risk#1) ← [control: Good credit]
  //       PullBureau (pull-bureau#0) ← via creditScore [wrote: creditScore]
  //         ⚠ also consumed args — slice may be incomplete here
  //
  // Read bottom-up: PullBureau produced creditScore (and ALSO consumed
  // untracked args — the honesty marker), ClassifyRisk read it and chose
  // 'approved' under rule 'Good credit', and Approve wrote status BECAUSE
  // of that decision.

  // 4. Optional (D4): a consumer-injected weigher — here a toy heuristic
  //    that de-emphasizes control edges. Real consumers plug embedding
  //    similarity / influence scores; the ENGINE never computes weights.
  const weigh: EdgeWeigher = (_child, _parent, _key, kind) => (kind === 'control' ? 0.5 : undefined);
  const weighted = causalChain(commitLog, statusCommit.runtimeStageId, (id) => reads.get(id) ?? [], {
    controlDeps: ctrl.asLookup(),
    weigh,
  });

  console.log('\n— Same slice, with consumer-injected edge weights —');
  console.log(formatCausalChain(weighted!));
  // Control edge now renders as: ← [control: Good credit] (0.5)

  // 5. The recorded decision itself — evidence included.
  console.log('\n— Recorded decisions —');
  for (const d of ctrl.getDecisions()) {
    console.log(`${d.deciderRuntimeStageId} chose '${String(d.chosen)}' (rule: ${d.ruleLabel ?? 'n/a'})`);
  }
})();

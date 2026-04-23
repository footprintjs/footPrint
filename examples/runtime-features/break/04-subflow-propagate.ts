/**
 * Break — Subflow propagateBreak pattern
 *
 * A subflow mounted with `propagateBreak: true` can terminate the PARENT's
 * loop when an inner stage calls `scope.$break(reason)`. Without this
 * option, an inner `$break` only stops the subflow; the parent continues.
 *
 * ## Why this matters
 *
 * Makes "terminal subflow branches" possible: a subflow runs, produces the
 * final answer, and ends the outer loop — WITHOUT losing drill-down
 * visibility (unlike the old workaround of wrapping a runner in a single
 * fn-stage that called `$break` itself). The subflow's internal stages,
 * narrative, and recorders all remain observable.
 *
 * ## When to use it
 *
 * - Escalation gates: an agent's loop hands off to a human-review runner;
 *   once the runner responds, the outer loop is done.
 * - Safety halts: a policy-check subflow that stops the outer workflow on
 *   violation.
 * - Final-answer subflows: any case where the subflow's output IS the
 *   terminal result and there's no iteration left for the outer loop.
 *
 * ## What you'll see
 *
 * Pipeline: Seed → [Escalate subflow] → Finalize(never-runs)
 *
 * The Escalate subflow has two stages — ReceiveRequest and RouteToHuman.
 * RouteToHuman calls `scope.$break('routed-to-human')`. Because the mount
 * sets `propagateBreak: true`, the reason propagates to the parent, the
 * parent breaks, and Finalize never runs.
 *
 * Run: npx tsx examples/runtime-features/break/04-subflow-propagate.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';

// ── State shapes ────────────────────────────────────────────────────────────

interface ParentState {
  userRequest: string;
  handedOff: string;
  finalized: boolean;
}

interface EscalateState {
  userRequest: string;
  handedOff: string;
}

// ── Subflow: escalation handoff ─────────────────────────────────────────────

const escalateSubflow = flowChart<EscalateState>(
  'ReceiveRequest',
  (scope) => {
    scope.handedOff = `received: ${scope.userRequest}`;
  },
  'receive-request',
)
  .addFunction(
    'RouteToHuman',
    (scope) => {
      scope.handedOff = `queued-for-human: ${scope.userRequest}`;
      // Terminate the outer loop. `propagateBreak: true` on the parent
      // mount is what makes this reach the parent scope.
      scope.$break('routed-to-human');
    },
    'route-to-human',
  )
  .build();

// ── Parent chart ────────────────────────────────────────────────────────────

const chart = flowChart<ParentState>(
  'Seed',
  (scope) => {
    scope.userRequest = 'my refund is wrong';
  },
  'seed',
)
  .addSubFlowChartNext('sf-escalate', escalateSubflow, 'Escalate', {
    inputMapper: (parent) => ({ userRequest: parent.userRequest }),
    outputMapper: (sf: Partial<EscalateState>) => ({ handedOff: sf.handedOff ?? '' }),
    propagateBreak: true, // ← the new option
  })
  .addFunction(
    'Finalize',
    (scope) => {
      // Without propagateBreak, the subflow's inner $break would only
      // stop the subflow and this would still run. With propagateBreak,
      // it never runs.
      scope.finalized = true;
    },
    'finalize',
  )
  .build();

// ── Run + verify ────────────────────────────────────────────────────────────

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  const state = executor.getSnapshot()?.sharedState as Partial<ParentState>;

  console.log('Parent scope after run:');
  console.log('  userRequest:', state.userRequest);
  console.log('  handedOff: ', state.handedOff);
  console.log('  finalized: ', state.finalized);

  console.log('\nNarrative:');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));

  // ── Regression guards — fail the example if Phase 2 semantics break ──
  if (state.finalized === true) {
    console.error(
      '\nREGRESSION: Finalize ran despite propagateBreak=true. The parent ' +
        'break did not propagate from the inner subflow.',
    );
    process.exit(1);
  }
  if (state.handedOff !== 'queued-for-human: my refund is wrong') {
    console.error(
      '\nREGRESSION: subflow outputMapper did not run, or ran before ' +
        '$break completed its write. The "partial-write lands in parent" ' +
        'invariant is violated.',
    );
    process.exit(1);
  }

  console.log(
    '\nOK — Finalize was skipped (parent broke), AND the subflow\'s ' +
      'partial output landed in parent scope via outputMapper.',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

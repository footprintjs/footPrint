/**
 * decide() — Naming the DEFAULT branch
 *
 * Every branch of a decider is named by the rule that chose it: the rule
 * carries a `label`, and that label rides out on the decision evidence.
 *
 * The default branch is different. It is chosen by NO rule — it fires exactly
 * when every rule failed — so there is no rule to carry its name. Anything
 * built from evidence (a narrative, an audit, a tool that publishes "what each
 * verdict means") can name every branch except the one the run actually took
 * when nothing matched.
 *
 * The fix is one word at the call site: pass the default as
 * `{ branch, label }` instead of a bare string. The label lands on
 * `evidence.defaultLabel` — on EVERY decision, not just the runs that fell
 * through, so a harvester sees the same meanings whichever way the data went.
 *
 * Run: npx tsx examples/build-time-features/decide-select/05-default-label.ts
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';
import type { DecisionEvidence, FlowRecorder } from 'footprintjs';

interface AssetState {
  riskScore: number;
  verdict?: string;
}

/**
 * A meanings harvest — the shape a tool-boundary consumer builds so callers
 * know what each verdict means. Generated from the run's own evidence; never
 * hand-declared, so it can only ever claim what the rules actually said.
 */
function harvestMeanings(evidence: DecisionEvidence | undefined): Record<string, string> {
  const meanings: Record<string, string> = {};
  if (!evidence) return meanings;
  for (const rule of evidence.rules) {
    if (rule.label) meanings[rule.branch] = rule.label;
  }
  // The default is chosen by no rule — without `defaultLabel` this line has
  // nothing to read, and the branch stays anonymous.
  if (evidence.defaultLabel) meanings[evidence.default] = evidence.defaultLabel;
  return meanings;
}

function evidenceProbe(): FlowRecorder & { evidence?: DecisionEvidence } {
  return {
    id: 'evidence-probe',
    evidence: undefined as DecisionEvidence | undefined,
    onDecision(event) {
      this.evidence = event.evidence;
    },
  };
}

function buildChart(riskScore: number, labelledDefault: boolean) {
  // ── THE ONE-LINE CHANGE ────────────────────────────────────────────────
  //   before:  'protected'
  //   after :  { branch: 'protected', label: 'No rule fired — asset stays protected' }
  const fallback = labelledDefault
    ? ({ branch: 'protected', label: 'No rule fired — asset stays protected' } as const)
    : 'protected';

  return flowChart<AssetState>(
    'Load',
    async (scope) => {
      scope.riskScore = riskScore;
    },
    'load',
  )
    .addDeciderFunction(
      'Classify',
      (scope) =>
        decide(
          scope,
          [
            { when: { riskScore: { gt: 80 } }, then: 'quarantined', label: 'Risk above the quarantine line' },
            { when: { riskScore: { gt: 50 } }, then: 'flagged', label: 'Risk above the review line' },
          ],
          fallback,
        ),
      'classify',
      'classified the asset',
    )
    .addFunctionBranch('quarantined', 'Quarantine', async (scope) => {
      scope.verdict = 'quarantined';
    })
    .addFunctionBranch('flagged', 'Flag', async (scope) => {
      scope.verdict = 'flagged';
    })
    .addFunctionBranch('protected', 'Protect', async (scope) => {
      scope.verdict = 'protected';
    })
    .setDefault('protected')
    .end()
    .build();
}

async function run(label: string, riskScore: number, labelledDefault: boolean) {
  const probe = evidenceProbe();
  const executor = new FlowChartExecutor(buildChart(riskScore, labelledDefault));
  executor.attachFlowRecorder(probe);
  executor.enableNarrative();
  await executor.run();

  const verdict = executor.getSnapshot().sharedState?.verdict;
  console.log(`\n${label}`);
  console.log(`  verdict  : ${verdict}`);
  console.log(`  meanings : ${JSON.stringify(harvestMeanings(probe.evidence))}`);
  const condition = executor
    .getNarrativeEntries()
    .map((e) => e.text)
    .find((t) => t.startsWith('[Condition]'));
  console.log(`  narrative: ${condition}`);
}

(async () => {
  // 1. Bare-string default, nothing matched. The run took `protected` and the
  //    harvest cannot say what `protected` means.
  await run('BARE STRING default, low risk (the default fires)', 10, false);

  // 2. Same run, default declared with a label. The verdict the rows show is
  //    now a verdict the meanings map can name.
  await run('LABELLED default, low risk (the default fires)', 10, true);

  // 3. A rule won. The default did not fire — and its meaning is recorded
  //    anyway, so the published meanings do not change shape with the data.
  await run('LABELLED default, high risk (a rule wins)', 95, true);
})().catch(console.error);

/* Output:

BARE STRING default, low risk (the default fires)
  verdict  : protected
  meanings : {"quarantined":"Risk above the quarantine line","flagged":"Risk above the review line"}
  narrative: [Condition]: No rules matched, fell back to default: Protect.

LABELLED default, low risk (the default fires)
  verdict  : protected
  meanings : {"quarantined":"Risk above the quarantine line","flagged":"Risk above the review line","protected":"No rule fired — asset stays protected"}
  narrative: [Condition]: No rules matched, fell back to default "No rule fired — asset stays protected": Protect.

LABELLED default, high risk (a rule wins)
  verdict  : quarantined
  meanings : {"quarantined":"Risk above the quarantine line","protected":"No rule fired — asset stays protected"}
  narrative: [Condition]: It evaluated Rule 0 "Risk above the quarantine line": riskScore 95 gt 80 ✓, and chose Quarantine.

Note run 3: decide() is first-match, so the rule AFTER the winner was never
evaluated and its branch is absent from that run's evidence — evidence reports
what actually happened, not what could have. The default's meaning is there
regardless, because it belongs to the decider rather than to the run.
*/

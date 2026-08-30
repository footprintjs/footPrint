/**
 * Scenario test: a labelled default branch travels the whole pipeline.
 *
 * flowChart → addDeciderFunction using decide(scope, rules, { branch, label })
 * → executor.run() → the label is on the FlowRecorder's decision evidence AND
 * in the narrative sentence for the fallback.
 *
 * Covers: integration (engine + evidence + narrative), plus the regression that
 * an unlabelled default renders exactly the sentence it always did.
 */
import { describe, expect, it } from 'vitest';

import type { DecisionEvidence, FlowRecorder } from '../../../../src/index';
import { decide, flowChart, FlowChartExecutor } from '../../../../src/index';

interface AssetState {
  riskScore: number;
  owner: string;
  verdict?: string;
}

/** Collects the evidence the engine hands to FlowRecorder.onDecision. */
function evidenceCollector(): FlowRecorder & { evidence: DecisionEvidence | undefined } {
  return {
    id: 'evidence-probe',
    evidence: undefined as DecisionEvidence | undefined,
    onDecision(event) {
      this.evidence = event.evidence;
    },
  };
}

function buildChart(riskScore: number, labelled: boolean) {
  const fallback = labelled
    ? ({ branch: 'protected', label: 'No rule fired — the asset stays protected' } as const)
    : 'protected';

  return flowChart<AssetState>(
    'Load',
    async (scope) => {
      scope.riskScore = riskScore;
      scope.owner = 'ops';
    },
    'load',
  )
    .addDeciderFunction(
      'ClassifyAsset',
      (scope) =>
        decide(
          scope,
          [
            { when: { riskScore: { gt: 80 } }, then: 'quarantined', label: 'Risk above the quarantine line' },
            { when: { riskScore: { gt: 50 } }, then: 'flagged', label: 'Risk above the review line' },
          ],
          fallback,
        ),
      'classify-asset',
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

describe('Scenario: a labelled default branch end-to-end', () => {
  it('the narrative names the default when the default fires', async () => {
    const executor = new FlowChartExecutor(buildChart(10, true));
    executor.enableNarrative();
    await executor.run();

    const lines = executor.getNarrativeEntries().map((e) => e.text);
    expect(lines).toContain(
      '[Condition]: No rules matched, fell back to default "No rule fired — the asset stays protected": Protect.',
    );
  });

  it('an unlabelled default renders exactly the sentence it always did', async () => {
    const executor = new FlowChartExecutor(buildChart(10, false));
    executor.enableNarrative();
    await executor.run();

    const lines = executor.getNarrativeEntries().map((e) => e.text);
    expect(lines).toContain('[Condition]: No rules matched, fell back to default: Protect.');
  });

  it('the engine hands the label to FlowRecorder.onDecision — on the fallback run', async () => {
    const probe = evidenceCollector();
    const executor = new FlowChartExecutor(buildChart(10, true));
    executor.attachFlowRecorder(probe);
    await executor.run();

    expect(probe.evidence?.chosen).toBe('protected');
    expect(probe.evidence?.defaultLabel).toBe('No rule fired — the asset stays protected');
  });

  it('the engine hands the label to FlowRecorder.onDecision — on a run where a RULE won', async () => {
    const probe = evidenceCollector();
    const executor = new FlowChartExecutor(buildChart(95, true));
    executor.attachFlowRecorder(probe);
    await executor.run();

    expect(executor.getSnapshot().sharedState.verdict).toBe('quarantined');
    expect(probe.evidence?.chosen).toBe('quarantined');
    // The decider's default means the same thing whichever way the data went.
    expect(probe.evidence?.defaultLabel).toBe('No rule fired — the asset stays protected');
  });

  it('on the fallthrough run, evidence names EVERY branch — including the default', async () => {
    // decide() is first-match, so a run where rule 0 wins never evaluates rule 1
    // and cannot name its branch. The fallthrough run evaluates them all — and
    // before this feature it was still the one run that could not name the
    // branch it actually took.
    const probe = evidenceCollector();
    const executor = new FlowChartExecutor(buildChart(10, true));
    executor.attachFlowRecorder(probe);
    await executor.run();

    const meanings: Record<string, string> = {};
    for (const rule of probe.evidence?.rules ?? []) if (rule.label) meanings[rule.branch] = rule.label;
    if (probe.evidence?.defaultLabel) meanings[probe.evidence.default] = probe.evidence.defaultLabel;

    expect(meanings).toEqual({
      quarantined: 'Risk above the quarantine line',
      flagged: 'Risk above the review line',
      protected: 'No rule fired — the asset stays protected',
    });
  });
});

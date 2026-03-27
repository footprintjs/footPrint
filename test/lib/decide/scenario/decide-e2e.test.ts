/**
 * Scenario test: decide()/select() end-to-end through full engine pipeline.
 *
 * Exercises: typedFlowChart → addDeciderFunction using decide() →
 * executor.run() → verify narrative contains evidence-based sentences.
 *
 * Also covers: select() with selector, function-when path, default fallback,
 * and spurious read prevention.
 */
import { describe, expect, it } from 'vitest';

import { decide, FlowChartExecutor, select } from '../../../../src/index';
import { typedFlowChart } from '../../../../src/lib/builder/typedFlowChart';

// ── State types ──────────────────────────────────────────────────────────

interface LoanState {
  creditScore: number;
  dti: number;
  employmentStatus: string;
  decision?: string;
}

interface ScreeningState {
  glucose: number;
  systolicBP: number;
  bmi: number;
}

describe('Scenario: decide()/select() E2E Pipeline Integration', () => {
  it('decide() with filter rules produces evidence-aware narrative', async () => {
    const chart = typedFlowChart<LoanState>(
      'LoadApp',
      async (scope) => {
        scope.creditScore = 750;
        scope.dti = 0.38;
        scope.employmentStatus = 'employed';
      },
      'load-app',
    )
      .addDeciderFunction(
        'ClassifyRisk',
        (scope) => {
          return decide(
            scope,
            [
              {
                when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } },
                then: 'approved',
                label: 'Good credit + low DTI',
              },
              {
                when: { creditScore: { gt: 600 } },
                then: 'manual-review',
                label: 'Marginal credit',
              },
            ],
            'rejected',
          );
        },
        'classify-risk',
        'Evaluate loan risk',
      )
      .addFunctionBranch('approved', 'Approve', async (scope) => {
        scope.decision = 'Approved';
      })
      .addFunctionBranch('manual-review', 'Review', async (scope) => {
        scope.decision = 'Manual review';
      })
      .addFunctionBranch('rejected', 'Reject', async (scope) => {
        scope.decision = 'Rejected';
      })
      .setDefault('rejected')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();

    // Should contain evidence-based sentence with operators and thresholds
    const decisionLine = narrative.find((line) => line.includes('evaluated'));
    expect(decisionLine).toBeDefined();
    expect(decisionLine).toContain('creditScore');
    expect(decisionLine).toContain('gt');
    expect(decisionLine).toContain('700');
    // Narrative uses display name "Approve" not branch ID "approved"
    expect(decisionLine).toContain('Approve');

    // Correct branch executed
    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.decision).toBe('Approved');
  });

  it('decide() with function rules captures read keys in narrative', async () => {
    const chart = typedFlowChart<LoanState>(
      'LoadApp',
      async (scope) => {
        scope.creditScore = 650;
        scope.dti = 0.5;
        scope.employmentStatus = 'self-employed';
      },
      'load-app',
    )
      .addDeciderFunction(
        'ClassifyRisk',
        (scope) => {
          return decide(
            scope,
            [
              {
                when: (s) => s.creditScore > 700 && s.dti < 0.43,
                then: 'approved',
                label: 'Full qualification',
              },
              {
                when: (s) => s.creditScore > 600,
                then: 'manual-review',
                label: 'Marginal - needs review',
              },
            ],
            'rejected',
          );
        },
        'classify-risk',
        'Route based on credit profile',
      )
      .addFunctionBranch('approved', 'Approve', async (scope) => {
        scope.decision = 'Approved';
      })
      .addFunctionBranch('manual-review', 'Review', async (scope) => {
        scope.decision = 'Manual review';
      })
      .addFunctionBranch('rejected', 'Reject', async (scope) => {
        scope.decision = 'Rejected';
      })
      .setDefault('rejected')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();

    // Function evidence uses "examined" wording with key=value
    const decisionLine = narrative.find((line) => line.includes('examined'));
    expect(decisionLine).toBeDefined();
    expect(decisionLine).toContain('creditScore');
    // Narrative uses display name "Review" not branch ID "manual-review"
    expect(decisionLine).toContain('Review');

    // Second rule matched (creditScore 650 > 600)
    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.decision).toBe('Manual review');
  });

  it('decide() falls back to default when no rules match', async () => {
    const chart = typedFlowChart<LoanState>(
      'LoadApp',
      async (scope) => {
        scope.creditScore = 400;
        scope.dti = 0.8;
        scope.employmentStatus = 'unemployed';
      },
      'load-app',
    )
      .addDeciderFunction(
        'ClassifyRisk',
        (scope) => {
          return decide(
            scope,
            [
              {
                when: { creditScore: { gt: 700 } },
                then: 'approved',
                label: 'Good credit',
              },
              {
                when: { creditScore: { gt: 600 } },
                then: 'manual-review',
                label: 'Marginal credit',
              },
            ],
            'rejected',
          );
        },
        'classify-risk',
      )
      .addFunctionBranch('approved', 'Approve', async (scope) => {
        scope.decision = 'Approved';
      })
      .addFunctionBranch('manual-review', 'Review', async (scope) => {
        scope.decision = 'Manual review';
      })
      .addFunctionBranch('rejected', 'Reject', async (scope) => {
        scope.decision = 'Rejected';
      })
      .setDefault('rejected')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();

    // Should mention default fallback — narrative uses display name "Reject"
    const decisionLine = narrative.find((line) => line.includes('default'));
    expect(decisionLine).toBeDefined();
    expect(decisionLine).toContain('Reject');

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.decision).toBe('Rejected');
  });

  it('select() with filter rules picks correct branches and produces narrative', async () => {
    const chart = typedFlowChart<ScreeningState>(
      'LoadVitals',
      async (scope) => {
        scope.glucose = 128;
        scope.systolicBP = 148;
        scope.bmi = 25;
      },
      'load-vitals',
    )
      .addSelectorFunction(
        'Triage',
        (scope) => {
          return select(scope, [
            { when: { glucose: { gt: 100 } }, then: 'diabetes', label: 'Elevated glucose' },
            { when: { systolicBP: { gt: 140 } }, then: 'hypertension', label: 'High BP' },
            { when: { bmi: { gt: 30 } }, then: 'obesity', label: 'High BMI' },
          ]);
        },
        'triage',
        'Select screenings based on vitals',
      )
      .addFunctionBranch('diabetes', 'DiabetesScreen', async () => {
        /* branch executes */
      })
      .addFunctionBranch('hypertension', 'BPCheck', async () => {
        /* branch executes */
      })
      .addFunctionBranch('obesity', 'BMIAssess', async () => {
        /* branch executes */
      })
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();

    // Narrative should show 2 of 3 selected
    const selectionLine = narrative.find((line) => line.includes('selected'));
    expect(selectionLine).toBeDefined();
    expect(selectionLine).toContain('2 of 3');

    // Evidence in narrative: matched branches appear
    expect(selectionLine).toContain('diabetes');
    expect(selectionLine).toContain('hypertension');

    // Parallel branches executed (visible in narrative as stage transitions)
    const branchLines = narrative.filter((line) => line.includes('DiabetesScreen') || line.includes('BPCheck'));
    expect(branchLines.length).toBeGreaterThanOrEqual(2);

    // Obesity branch should NOT have executed
    const obesityLines = narrative.filter((line) => line.includes('BMIAssess'));
    expect(obesityLines).toEqual([]);
  });

  it('narrative does NOT contain spurious "Read getValue" entries', async () => {
    const chart = typedFlowChart<LoanState>(
      'LoadApp',
      async (scope) => {
        scope.creditScore = 750;
        scope.dti = 0.3;
        scope.employmentStatus = 'employed';
      },
      'load-app',
    )
      .addDeciderFunction(
        'ClassifyRisk',
        (scope) => {
          return decide(
            scope,
            [
              {
                when: { creditScore: { gt: 700 } },
                then: 'approved',
              },
            ],
            'rejected',
          );
        },
        'classify-risk',
      )
      .addFunctionBranch('approved', 'Approve', async (scope) => {
        scope.decision = 'Approved';
      })
      .addFunctionBranch('rejected', 'Reject', async (scope) => {
        scope.decision = 'Rejected';
      })
      .setDefault('rejected')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();

    // No spurious "getValue" reads in narrative
    const spurious = narrative.filter((line) => line.includes('getValue'));
    expect(spurious).toEqual([]);

    // No spurious "attachRecorder" or "detachRecorder" reads
    const spuriousRecorder = narrative.filter(
      (line) => line.includes('attachRecorder') || line.includes('detachRecorder'),
    );
    expect(spuriousRecorder).toEqual([]);
  });
});

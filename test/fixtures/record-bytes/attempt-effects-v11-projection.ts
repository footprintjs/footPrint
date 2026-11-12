/** Test-only comparison with the unchanged historical retry bytes. No other scenario is projected. */
import { expect } from 'vitest';

interface RetryFixture {
  snapshot: {
    executionTree: [
      { id: string; runtimeStageId: string },
      {
        id: string;
        runtimeStageId: string;
        attempts: {
          series: string;
          kind: string;
          attempt: number;
          outcome: string;
          next: string;
          reason: string;
          decision: { rules: { type: string; ruleIndex: number; branch: string; matched: boolean; label: string }[] };
        }[];
        attemptSummary: { last: { next: string; reason: string } };
      },
    ];
  };
}

/** Assert the v11 law, then project only its five named fields on a detached JSON representation. */
export function projectAttemptEffectsV11(name: string, text: string): string {
  if (name !== 'retry') return text;
  const value = JSON.parse(text) as RetryFixture;
  const [root, stage] = value.snapshot.executionTree;
  expect([root.id, root.runtimeStageId]).toEqual(['seed', 'seed#0']);
  expect([stage.id, stage.runtimeStageId]).toEqual(['flaky', 'flaky#1']);
  expect(stage.attempts.map((a) => [a.series, a.kind, a.attempt, a.outcome, a.next, a.reason])).toEqual([
    ['flaky#1', 'stage', 1, 'failed', 'retry', 'retryable'],
    ['flaky#1', 'stage', 2, 'failed', 'retry', 'retryable'],
    ['flaky#1', 'stage', 3, 'ok', 'done', 'answered'],
  ]);
  for (const [index, attempt] of stage.attempts.entries()) {
    const first = attempt.decision.rules[0];
    expect(first).toMatchObject({
      type: 'filter',
      ruleIndex: 0,
      branch: 'done',
      matched: index === 2,
      label: 'answered',
    });
    first.label = 'succeeded';
  }
  expect(stage.attemptSummary.last).toEqual({ next: 'done', reason: 'answered' });
  stage.attempts[2].reason = 'succeeded';
  stage.attemptSummary.last.reason = 'succeeded';
  return JSON.stringify(value, null, 2) + '\n';
}

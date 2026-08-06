/**
 * Declarative per-stage retry — PROPERTY tests.
 *
 * Randomised over failure patterns and policies. The laws pinned here are the
 * ones a hand-picked example can only sample:
 *
 *   1. Attempts are internal to ONE stage execution: however many times the
 *      function ran, the stage contributes exactly ONE commit bundle.
 *   2. Event arithmetic is exact: retries fired == the number of failures the
 *      policy actually absorbed, never one more or one fewer.
 *   3. Only the FINAL attempt's writes exist anywhere — state, log, snapshot.
 *   4. Retry never widens the recorded read provenance: a discarded attempt's
 *      reads must not survive into the committed write's `readKeys`, or a
 *      backward slice would follow an edge no committed write ever had.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { FlowStageRetryEvent } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

interface State {
  value?: number;
  source?: number;
  ghost?: number;
  [key: string]: unknown;
}

/**
 * Run a chart whose single retryable stage fails `failures` times before
 * succeeding, under a policy allowing `attempts` runs.
 */
async function runFlaky(failures: number, attempts: number) {
  let calls = 0;
  const retries: FlowStageRetryEvent[] = [];
  const chart = flowChart<State>(
    'Seed',
    (scope) => {
      scope.source = 1;
    },
    'seed',
  )
    .addFunction(
      'Flaky',
      (scope: State) => {
        calls += 1;
        scope.ghost = calls; // written by EVERY attempt, kept only by the last
        if (calls <= failures) throw new Error(`fail ${calls}`);
        scope.value = calls;
      },
      'flaky',
    )
    .retry({ attempts })
    .build();

  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder({ id: 'probe', onStageRetry: (e) => retries.push(e) });
  const failed = await executor.run().then(
    () => false,
    () => true,
  );
  return { executor, calls, retries, failed };
}

describe('retry — property invariants', () => {
  it('however many attempts run, the stage contributes exactly ONE commit bundle', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1, max: 6 }), async (failures, attempts) => {
        const { executor } = await runFlaky(failures, attempts);
        const bundles = executor.getSnapshot().commitLog.filter((b) => b.stageId === 'flaky');
        expect(bundles).toHaveLength(1);
      }),
      { numRuns: 40 },
    );
  });

  it('fires exactly one retry event per failure the policy absorbed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1, max: 6 }), async (failures, attempts) => {
        const { retries, calls } = await runFlaky(failures, attempts);
        // Runs performed = min(failures + 1, attempts). Every run but the last
        // failed AND was followed by another, so it fired exactly one event.
        const expectedCalls = Math.min(failures + 1, attempts);
        expect(calls).toBe(expectedCalls);
        expect(retries).toHaveLength(expectedCalls - 1);
        // Attempt numbers are dense and 1-based — no gaps, no repeats.
        expect(retries.map((r) => r.attempt)).toEqual(retries.map((_, i) => i + 1));
        for (const r of retries) expect(r.maxAttempts).toBe(attempts);
      }),
      { numRuns: 40 },
    );
  });

  it('only the final attempt is visible in state — never an earlier one', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1, max: 6 }), async (failures, attempts) => {
        const { executor, calls } = await runFlaky(failures, attempts);
        const state = executor.getSnapshot().sharedState as State;
        expect(state.ghost).toBe(calls);
      }),
      { numRuns: 40 },
    );
  });

  it('a retried stage is indistinguishable, in the log, from one that succeeded first try', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (failures) => {
        // Same successful outcome, reached with and without failures along the
        // way: the committed record differs only by the attempt counter the
        // stage itself chose to write.
        const retried = await runFlaky(failures, failures + 1);
        const clean = await runFlaky(0, failures + 1);
        const shape = (ex: FlowChartExecutor<any, any>) =>
          ex
            .getSnapshot()
            .commitLog.map((b) => b.stageId)
            .join(',');
        expect(shape(retried.executor)).toBe(shape(clean.executor));
        expect(retried.failed).toBe(false);
        expect(clean.failed).toBe(false);
      }),
      { numRuns: 20 },
    );
  });

  it('discarded attempts never widen the committed write provenance', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (failures) => {
        let calls = 0;
        const chart = flowChart<State>(
          'Seed',
          (scope) => {
            scope.source = 1;
            scope.ghost = 2;
          },
          'seed',
        )
          .addFunction(
            'Flaky',
            (scope: State) => {
              calls += 1;
              if (calls <= failures) {
                // Failed attempts read a key the successful one never touches.
                const readOnlyByDiscardedAttempts = scope.ghost;
                throw new Error(`discard me (saw ${String(readOnlyByDiscardedAttempts)})`);
              }
              scope.value = (scope.source as number) + 1;
            },
            'flaky',
          )
          .retry({ attempts: failures + 1 })
          .build();

        const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix' });
        await executor.run();

        const bundle = executor.getSnapshot().commitLog.find((b) => b.stageId === 'flaky');
        const readKeys = (bundle?.trace ?? []).flatMap((t) => (t as { readKeys?: string[] }).readKeys ?? []);
        // `ghost` was read ONLY by attempts whose writes were thrown away, so
        // it must not appear as provenance for the write that survived.
        expect(readKeys).not.toContain('ghost');
        expect(readKeys).toContain('source');
      }),
      { numRuns: 20 },
    );
  });
});

/**
 * The attempt record — PROPERTY tests (design §10).
 *
 *   1. The series invariant, over random failure counts, ceilings and decline points on a real chart: the records
 *      are exactly the attempts the 9.15 loop made, dense and 1-based; exactly one record does not retry and it
 *      is the last; `onAttempt` fires once per record; `onStageRetry` once per record that retried; the summary
 *      counts what the records say.
 *   2. The evidence-equality law: for random `AttemptInputs`, the runner's hand-built `DecisionEvidence` deep-equals
 *      — key order included — what `decide(scope, retryRules(policy), …)` records on a registered scope holding the
 *      same inputs. One rule table, one evidence shape, two evaluators that cannot drift.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { DecisionEvidence } from '../../../../src/index.js';
import { decide, flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { decideAttempt, RETRY_DEFAULT, retryRules } from '../../../../src/lib/attempt/decision.js';
import type { AttemptInputs, AttemptRecord } from '../../../../src/lib/attempt/types.js';

type S = Record<string, unknown>;

/** What the 9.15 loop did for `failures` failures, a ceiling of `attempts`, and retryOn declining from `declineAt`. */
function expectedSeries(failures: number, attempts: number, declineAt: number) {
  const out: Array<[number, string, string, string]> = [];
  for (let n = 1; ; n++) {
    if (n > failures) return [...out, [n, 'ok', 'done', 'succeeded']];
    if (n >= attempts) return [...out, [n, 'failed', 'stop', 'exhausted']];
    if (n >= declineAt) return [...out, [n, 'failed', 'stop', 'declined']];
    out.push([n, 'failed', 'retry', 'retryable']);
  }
}

async function runSeries(failures: number, attempts: number, declineAt: number) {
  let calls = 0;
  const chart = flowChart<S>('Seed', () => undefined, 'seed')
    .addFunction(
      'Flaky',
      (scope: S) => {
        calls += 1;
        if (calls <= failures) throw Object.assign(new Error(`boom ${calls}`), { call: calls });
        scope.value = calls;
      },
      'flaky',
    )
    .retry({ attempts, retryOn: (error) => (error as { call: number }).call < declineAt })
    .build();
  const executor = new FlowChartExecutor(chart);
  const records: AttemptRecord[] = [];
  let retries = 0;
  executor.attachFlowRecorder({
    id: 'series',
    onAttempt: (e) => records.push(e.record),
    onStageRetry: () => (retries += 1),
  });
  await executor.run().catch(() => undefined);
  let flakyNode: any = executor.getSnapshot().executionTree;
  while (flakyNode && flakyNode.id !== 'flaky') flakyNode = flakyNode.next;
  return { records, retries, calls, node: flakyNode };
}

describe('the series invariant', () => {
  it('records = the attempts made; one non-retry record, last; hook and summary agree', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 1, max: 8 }),
        async (failures, attempts, declineAt) => {
          const { records, retries, calls, node } = await runSeries(failures, attempts, declineAt);
          const expected = expectedSeries(failures, attempts, declineAt);
          expect(records.map((r) => [r.attempt, r.outcome, r.next, r.reason])).toEqual(expected);
          expect(calls).toBe(expected.length);
          expect(records.length).toBeLessThanOrEqual(attempts);
          expect(records.filter((r) => r.next !== 'retry')).toEqual([records[records.length - 1]]);
          expect(retries).toBe(records.length - 1);
          expect(new Set(records.map((r) => r.series))).toEqual(new Set([node.runtimeStageId]));
          expect(node.attempts).toEqual(records);
          const count = (outcome: string) => records.filter((r) => r.outcome === outcome).length;
          const last = records[records.length - 1];
          expect(node.attemptSummary).toEqual({
            count: records.length,
            ok: count('ok'),
            failed: count('failed'),
            timeout: 0,
            aborted: 0,
            paused: 0,
            last: { next: last.next, reason: last.reason, ...(last.category && { category: last.category }) },
          });
        },
      ),
      { numRuns: 60 },
    );
  });
});

const inputsArb: fc.Arbitrary<AttemptInputs> = fc
  .record({
    outcome: fc.constantFrom('ok', 'failed', 'timeout', 'aborted', 'paused'),
    category: fc.constantFrom(
      undefined,
      'timeout',
      'rate-limited',
      'server',
      'network',
      'auth',
      'permanent',
      'unknown',
    ),
    aborted: fc.boolean(),
    attempt: fc.integer({ min: 1, max: 6 }),
    of: fc.integer({ min: 1, max: 6 }),
    timeLeftMs: fc.oneof(fc.constant(Infinity), fc.integer({ min: 0, max: 10_000 })),
    delayMs: fc.integer({ min: 0, max: 5_000 }),
    retryOn: fc.boolean(),
    keyPresent: fc.boolean(),
  })
  .map((r) => ({ ...r, timeLeftAfterWaitMs: r.timeLeftMs - r.delayMs } as AttemptInputs));

/** decide()'s evidence for `inputs`, from a decider stage reading them off a registered scope. */
async function evidenceFromDecide(inputs: AttemptInputs): Promise<DecisionEvidence> {
  let evidence: DecisionEvidence | undefined;
  const chart = flowChart<S>(
    'Seed',
    (scope: S) => {
      for (const [key, value] of Object.entries(inputs)) if (value !== undefined) scope[key] = value;
    },
    'seed',
  )
    .addDeciderFunction(
      'Decide',
      (scope: S) => decide(scope as never, retryRules({ attempts: inputs.of }) as never, RETRY_DEFAULT),
      'decide',
    )
    .addFunctionBranch('done', 'Done', () => undefined)
    .addFunctionBranch('stop', 'Stop', () => undefined)
    .addFunctionBranch('retry', 'Retry', () => undefined)
    .end()
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder({ id: 'evidence', onDecision: (e) => (evidence = e.evidence) });
  await executor.run();
  return evidence!;
}

describe('the evidence-equality law', () => {
  it('the runner’s evidence is decide()’s, for the same inputs — field for field, key for key', async () => {
    await fc.assert(
      fc.asyncProperty(inputsArb, async (inputs) => {
        const fromDecide = await evidenceFromDecide(inputs);
        const fromRunner = decideAttempt(
          retryRules({ attempts: inputs.of }),
          (key) => (inputs as unknown as Record<string, unknown>)[key],
        ).evidence;
        expect(fromRunner).toEqual(fromDecide);
        expect(JSON.stringify(fromRunner)).toBe(JSON.stringify(fromDecide));
      }),
      { numRuns: 60 },
    );
  });
});

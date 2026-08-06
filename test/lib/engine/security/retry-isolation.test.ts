/**
 * Declarative per-stage retry — SECURITY.
 *
 * A retry multiplies how many times a stage touches sensitive data, so it
 * multiplies the chances of leaking it. Three questions this pins:
 *
 *   1. Does redaction still hold on attempt N, or only on attempt 1?
 *   2. Does a DISCARDED attempt's secret survive anywhere — shared state, the
 *      commit log, the execution tree, the narrative?
 *   3. Does the retry event itself leak the scope it failed on?
 */
import { describe, expect, it } from 'vitest';

import type { FlowStageRetryEvent } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

interface State {
  ssn?: string;
  token?: string;
  ok?: string;
  [key: string]: unknown;
}

describe('retry — redaction survives every attempt', () => {
  it('redacts the secret on the retried attempt, not just the first', async () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    let calls = 0;

    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Flaky',
        (scope: State) => {
          calls += 1;
          scope.ssn = `secret-on-attempt-${calls}`;
          if (calls < 3) throw new Error('retry me');
          scope.ok = 'done';
        },
        'flaky',
      )
      .retry({ attempts: 3 })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    executor.attachScopeRecorder({
      id: 'writes',
      onWrite: (e) => writes.push({ key: e.key, value: e.value }),
    });
    await executor.run();

    const ssnWrites = writes.filter((w) => w.key === 'ssn');
    expect(ssnWrites).toHaveLength(3); // one per attempt — nothing hidden
    for (const w of ssnWrites) expect(w.value).toBe('[REDACTED]');

    const committed = JSON.stringify(executor.getSnapshot({ redact: true }).sharedState);
    expect(committed).not.toContain('secret-on-attempt');
  });
});

describe('retry — a discarded attempt leaves no trace of its secret', () => {
  it('keeps a failed attempt-only secret out of state, the log and the tree', async () => {
    let calls = 0;
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Flaky',
        (scope: State) => {
          calls += 1;
          if (calls === 1) {
            // Written ONLY by the attempt that gets thrown away.
            scope.token = 'leaked-token-value';
            throw new Error('discard me');
          }
          scope.ok = 'clean';
        },
        'flaky',
      )
      .retry({ attempts: 2 })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(JSON.stringify(snapshot.sharedState)).not.toContain('leaked-token-value');
    expect(JSON.stringify(snapshot.commitLog)).not.toContain('leaked-token-value');
    expect(JSON.stringify(snapshot.executionTree)).not.toContain('leaked-token-value');
  });

  it('keeps it out of the narrative’s committed record too', async () => {
    let calls = 0;
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Flaky',
        (scope: State) => {
          calls += 1;
          if (calls === 1) throw new Error('transient');
          scope.ok = 'clean';
        },
        'flaky',
      )
      .retry({ attempts: 2 })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ patterns: [/token/i] });
    executor.enableNarrative();
    await executor.run();

    // The retry line reports the FAILURE, never the scope it failed on.
    const retryEntry = executor.getNarrativeEntries().find((e) => e.type === 'retry');
    expect(retryEntry?.text).toContain('transient');
    expect(retryEntry?.rawValue).toBeUndefined();
  });
});

describe('retry — the event payload carries facts, not the scope', () => {
  it('exposes only the stage, the counters, the wait and the error', async () => {
    let calls = 0;
    const events: FlowStageRetryEvent[] = [];
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Flaky',
        (scope: State) => {
          calls += 1;
          scope.ssn = 'super-secret';
          if (calls < 2) throw new Error('transient');
          scope.ok = 'done';
        },
        'flaky',
      )
      .retry({ attempts: 2 })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    executor.attachFlowRecorder({ id: 'probe', onStageRetry: (e) => events.push(e) });
    await executor.run();

    expect(events).toHaveLength(1);
    const payload = { ...events[0], structuredError: { ...events[0].structuredError, raw: undefined } };
    expect(JSON.stringify(payload)).not.toContain('super-secret');
    // The payload is a CLOSED set of facts — no scope, no state, no values.
    expect(Object.keys(events[0]).sort()).toEqual([
      'attempt',
      'channel',
      'delayMs',
      'maxAttempts',
      'message',
      'stageId',
      'stageName',
      'structuredError',
      'traversalContext',
    ]);
  });
});

describe('retry — a policy cannot be used to run a stage forever', () => {
  it('honours the ceiling even when every attempt fails and every error is retryable', async () => {
    let calls = 0;
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addFunction(
        'Hostile',
        () => {
          calls += 1;
          throw new Error('always');
        },
        'hostile',
      )
      .retry({ attempts: 4, retryOn: () => true })
      .build();

    await expect(new FlowChartExecutor(chart).run()).rejects.toThrow('always');
    expect(calls).toBe(4);
  });
});

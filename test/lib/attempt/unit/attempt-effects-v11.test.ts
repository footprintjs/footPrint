import { describe, expect, it } from 'vitest';

import * as api from '../../../../src/index.js';
import { attempt } from '../../../../src/index.js';
import { runAttempts } from '../../../../src/lib/attempt/runner.js';
import type { AttemptRecord, AttemptSummary } from '../../../../src/lib/attempt/types.js';
import { metricRow } from '../../../../src/lib/recorder/attemptMetricRows.js';

describe('11.0 attempt effect contract', () => {
  it('reports answered rather than claiming application success and calls standalone onEnd once', async () => {
    const events: string[] = [];
    const summaries: AttemptSummary[] = [];
    const result = await attempt(() => ({ status: 503 }), undefined, {
      onAttempt(record: AttemptRecord) {
        events.push(record.reason);
      },
      onEnd(summary: AttemptSummary) {
        summaries.push(summary);
        events.push('end');
      },
    });
    expect(result).toEqual({ status: 503 });
    expect(events).toEqual(['end', 'answered']);
    expect(summaries).toHaveLength(1);
  });

  it('keeps a series unknown after an earlier unresolved effect even when the final attempt answers', async () => {
    const records: AttemptRecord[] = [];
    let summary: AttemptSummary | undefined;
    await runAttempts(
      (n) => {
        if (n === 1) throw new Error('reply lost');
        return 503;
      },
      { attempts: 2 },
      {
        series: 'request',
        effect: { system: 'inventory', idempotencyKey: 'request-1' },
        onAttempt: (r) => records.push(r),
        onEnd: (s) => {
          summary = s;
        },
      },
    );
    expect(records.map((r) => r.effect)).toEqual(['unknown', 'applied']);
    expect(summary).toMatchObject({ effect: 'unknown', ok: 1, last: { effect: 'applied', reason: 'answered' } });
  });

  it('last.effect is the final attempt own effect while a previous unknown stays in the summary', async () => {
    let summary: AttemptSummary | undefined;
    await expect(
      runAttempts(
        (n) => {
          throw n === 1 ? new Error('unknown') : Object.assign(new Error('unsent'), { effect: 'none' });
        },
        { attempts: 2 },
        {
          series: 'request',
          effect: { system: 'inventory', idempotencyKey: 'request-2' },
          onEnd: (s) => {
            summary = s;
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'UnknownEffectError' });
    expect(summary).toMatchObject({ effect: 'unknown', last: { effect: 'none' } });
  });

  it('records a cut wait in the summary without adding an attempt', async () => {
    const controller = new AbortController();
    const records: AttemptRecord[] = [];
    let summary: AttemptSummary | undefined;
    const error = new Error('failed');
    await expect(
      runAttempts(
        () => {
          throw error;
        },
        {
          attempts: 2,
          backoffMs: () => {
            controller.abort();
            return 1;
          },
        },
        {
          series: 'request',
          signal: controller.signal,
          onAttempt: (r) => records.push(r),
          onEnd: (s) => {
            summary = s;
          },
        },
      ),
    ).rejects.toBe(error);
    expect(records).toHaveLength(1);
    expect(summary).toMatchObject({ count: 1, last: { reason: 'aborted', during: 'wait' } });
  });

  it('standalone touching retries are refused without a key before invocation', () => {
    let calls = 0;
    expect(() => attempt(() => ++calls, { attempts: 2 }, { touches: 'inventory' })).toThrow(/idempotencyKey/);
    expect(calls).toBe(0);
  });

  it('exports the existing law and key admission rule', () => {
    expect(api.effectOf).toBeTypeOf('function');
    expect(api.idempotencyKeyProblem).toBeTypeOf('function');
    expect(api.MAX_IDEMPOTENCY_KEY_LENGTH).toBe(255);
  });

  it('does not invent a standalone summary when no attempt starts', async () => {
    const controller = new AbortController();
    const stopped = new Error('stopped');
    controller.abort(stopped);
    const observations: unknown[] = [];
    let calls = 0;
    await expect(
      attempt(() => ++calls, undefined, {
        signal: controller.signal,
        onAttempt: (r) => observations.push(r),
        onEnd: (s) => observations.push(s),
      }),
    ).rejects.toBe(stopped);
    await expect(
      attempt(() => ++calls, undefined, {
        deadline: -Infinity,
        onAttempt: (r) => observations.push(r),
        onEnd: (s) => observations.push(s),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(0);
    expect(observations).toEqual([]);
  });

  it('isolates standalone onEnd errors and keeps physical touching evidence on the public path', async () => {
    const records: AttemptRecord[] = [];
    let calls = 0;
    await expect(
      attempt(
        () => {
          if (++calls === 1) throw new Error('reply lost');
          return 503;
        },
        { attempts: 2 },
        {
          touches: 'inventory',
          idempotencyKey: 'request-3',
          onAttempt: (r) => records.push(r),
          onEnd() {
            throw new Error('observer');
          },
        },
      ),
    ).resolves.toBe(503);
    expect(records.map((r) => [r.reason, r.effect, r.idempotencyKey])).toEqual([
      ['retryable', 'unknown', 'request-3'],
      ['answered', 'applied', 'request-3'],
    ]);
  });

  it('normalizes retained legacy metric reasons at admission without manufacturing physical effect evidence', () => {
    const row = metricRow({
      kind: 'attempt',
      id: 'stage#0@1',
      series: 'stage#0',
      runtimeStageId: 'stage#0',
      target: 'stage',
      runId: 'run',
      startedAt: 1,
      durationMs: 1,
      outcome: 'ok',
      next: 'done',
      reason: 'succeeded',
      attemptKind: 'stage',
      attempt: 1,
    });
    expect(row).toMatchObject({ reason: 'answered', outcome: 'ok' });
    expect(row).not.toHaveProperty('effect');
  });
});

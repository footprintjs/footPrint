/**
 * The narrative of a retried stage: ONE line per attempt, in order inside its stage, the stop reason on the last
 * line (design §5). The line carries what the old `[Retry]` sentence did and what it could not: how long the try
 * took, its failure category, and why the series went on or stopped — so the built-in narrative renders no
 * separate retry sentence (two lines for one fact were rejected, §14).
 *
 * Test types: Scenario (the combined narrative on a real chart — success after failures, exhaustion, decline, a
 * category; the flow-only `NarrativeFlowRecorder`) · Functional (`NarrativeFormatter.renderAttempt`: a string, a
 * `null` exclusion, an `undefined` fallback; `renderRetry` is no longer called) · Byte identity (a stage with no
 * policy narrates exactly as before — its failure is one `[Error]` line).
 */
import { describe, expect, it, vi } from 'vitest';

import type { CombinedNarrativeEntry, NarrativeFormatter } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, NarrativeFlowRecorder } from '../../../../src/index.js';

type S = Record<string, unknown>;

/** A stage that reads `seed`, then throws `error(n)` for its first `fails` calls, then writes `value`. */
function flaky(fails: number, error: (n: number) => unknown = (n) => new Error(`boom ${n}`)) {
  let calls = 0;
  return (scope: S) => {
    calls += 1;
    if (scope.seed === undefined) throw new Error('the seed stage did not run');
    if (calls <= fails) throw error(calls);
    scope.value = `ok after ${calls}`;
  };
}

function chartOf(fails: number, retry: Record<string, unknown>, error?: (n: number) => unknown) {
  return flowChart<S>(
    'Seed',
    (scope: S) => {
      scope.seed = 1;
    },
    'seed',
  )
    .addFunction('Flaky', flaky(fails, error), 'flaky')
    .retry(retry as never)
    .build();
}

async function narrate(chart: ReturnType<typeof chartOf>, options: { renderer?: NarrativeFormatter } = {}) {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative(options.renderer ? { renderer: options.renderer } : undefined);
  const flowOnly = new NarrativeFlowRecorder('flow-only');
  executor.attachFlowRecorder(flowOnly);
  const failed = await executor.run().then(
    () => false,
    () => true,
  );
  return { executor, entries: executor.getNarrativeEntries(), sentences: flowOnly.getSentences(), failed };
}

/** The Flaky stage's own entries, as `[type, depth, text]`. */
const flakyEntries = (entries: CombinedNarrativeEntry[]) =>
  entries.filter((e) => e.stageName === 'Flaky').map((e) => [e.type, e.depth, e.text]);

describe('the combined narrative — one line per attempt', () => {
  it('recovered: each attempt’s line sits between that attempt’s own reads and writes', async () => {
    const { entries } = await narrate(chartOf(2, { attempts: 3 }));
    const lines = flakyEntries(entries);
    expect(lines).toEqual([
      ['stage', 0, 'Stage 2: Next, it moved on to Flaky.'],
      ['step', 1, 'Step 1: Read seed = 1'],
      [
        'attempt',
        1,
        expect.stringMatching(/^Attempt 1 of 3 at Flaky failed in \d+ms \(boom 1\), retrying immediately\.$/),
      ],
      ['step', 1, 'Step 3: Read seed = 1'],
      [
        'attempt',
        1,
        expect.stringMatching(/^Attempt 2 of 3 at Flaky failed in \d+ms \(boom 2\), retrying immediately\.$/),
      ],
      ['step', 1, 'Step 5: Read seed = 1'],
      ['step', 1, 'Step 6: Write value = "ok after 3"'],
      ['attempt', 1, expect.stringMatching(/^Attempt 3 of 3 at Flaky succeeded in \d+ms\.$/)],
    ]);
    expect(entries.some((e) => e.type === 'retry')).toBe(false);
    const attempt = entries.find((e) => e.type === 'attempt')!;
    expect(attempt).toMatchObject({ stageId: 'flaky', runtimeStageId: 'flaky#1', stepNumber: 2 });
  });

  it('says the wait: "retrying in 5ms"', async () => {
    const { entries } = await narrate(chartOf(1, { attempts: 2, backoffMs: 5 }));
    expect(flakyEntries(entries)[2][2]).toMatch(/, retrying in 5ms\.$/);
  });

  it('exhausted: the failed stage’s [Error] line, its attempts beneath it, the stop reason last', async () => {
    const { entries, failed } = await narrate(chartOf(9, { attempts: 3 }));
    expect(failed).toBe(true);
    expect(flakyEntries(entries)).toEqual([
      ['error', 0, '[Error]: An error occurred at Flaky: Error: boom 3.'],
      [
        'attempt',
        1,
        expect.stringMatching(/^Attempt 1 of 3 at Flaky failed in \d+ms \(boom 1\), retrying immediately\.$/),
      ],
      [
        'attempt',
        1,
        expect.stringMatching(/^Attempt 2 of 3 at Flaky failed in \d+ms \(boom 2\), retrying immediately\.$/),
      ],
      [
        'attempt',
        1,
        expect.stringMatching(/^Attempt 3 of 3 at Flaky failed in \d+ms \(boom 3\); stopped: no attempts left\.$/),
      ],
    ]);
  });

  it('declined: one attempt line that says retryOn declined — the stop that used to leave nothing', async () => {
    const { entries } = await narrate(chartOf(9, { attempts: 4, retryOn: () => false }));
    expect(flakyEntries(entries).slice(1)).toEqual([
      [
        'attempt',
        1,
        expect.stringMatching(/^Attempt 1 of 4 at Flaky failed in \d+ms \(boom 1\); stopped: retryOn declined\.$/),
      ],
    ]);
  });

  it('names the category of a recognisable failure', async () => {
    const rateLimited = (n: number) => Object.assign(new Error(`slow down ${n}`), { status: 429 });
    const { entries } = await narrate(chartOf(1, { attempts: 2 }, rateLimited));
    expect(flakyEntries(entries)[2][2]).toMatch(
      /failed in \d+ms \(rate-limited: slow down 1\), retrying immediately\.$/,
    );
  });

  it('a stage with no policy narrates exactly as before — its failure is one [Error] line', async () => {
    const chart = flowChart<S>('Seed', () => undefined, 'seed')
      .addFunction(
        'Flaky',
        () => {
          throw new Error('plain failure');
        },
        'flaky',
      )
      .build();
    const { entries } = await narrate(chart);
    expect(flakyEntries(entries)).toEqual([['error', 0, '[Error]: An error occurred at Flaky: Error: plain failure.']]);
  });
});

describe('NarrativeFormatter.renderAttempt', () => {
  it('a string replaces the line; null drops it; undefined falls back to the default', async () => {
    const renderAttempt = vi.fn((ctx: { stageName: string; record: { attempt: number; next: string } }) => {
      if (ctx.record.attempt === 1) return `try #1 of ${ctx.stageName}: ${ctx.record.next}`;
      if (ctx.record.attempt === 2) return null;
      return undefined;
    });
    const renderRetry = vi.fn(() => 'never');
    const { entries } = await narrate(chartOf(2, { attempts: 3 }), {
      renderer: { renderAttempt, renderRetry } as NarrativeFormatter,
    });
    const attempts = entries.filter((e) => e.type === 'attempt').map((e) => e.text);
    expect(attempts).toEqual(['try #1 of Flaky: retry', expect.stringMatching(/^Attempt 3 of 3 at Flaky succeeded/)]);
    expect(renderAttempt).toHaveBeenCalledTimes(3);
    expect(renderRetry).not.toHaveBeenCalled();
  });
});

describe('the flow-only narrative (NarrativeFlowRecorder and the strategies built on it)', () => {
  it('one sentence per attempt, in order, and no separate retry sentence', async () => {
    const { sentences } = await narrate(chartOf(2, { attempts: 3, backoffMs: 1 }));
    const attempts = sentences.filter((s) => s.startsWith('Attempt'));
    expect(attempts).toEqual([
      expect.stringMatching(/^Attempt 1 of 3 at Flaky failed in \d+ms \(boom 1\), retrying in 1ms\.$/),
      expect.stringMatching(/^Attempt 2 of 3 at Flaky failed in \d+ms \(boom 2\), retrying in 1ms\.$/),
      expect.stringMatching(/^Attempt 3 of 3 at Flaky succeeded in \d+ms\.$/),
    ]);
    expect(sentences.some((s) => s.includes('so it tried again'))).toBe(false);
  });

  it('on failure, the stop line comes before the error sentence', async () => {
    const { sentences } = await narrate(chartOf(9, { attempts: 2 }));
    const at = (pattern: RegExp) => sentences.findIndex((s) => pattern.test(s));
    expect(at(/^Attempt 2 of 2 at Flaky failed .*; stopped: no attempts left\.$/)).toBeGreaterThan(-1);
    expect(at(/^Attempt 2 of 2/)).toBeLessThan(at(/An error occurred at Flaky/));
  });
});

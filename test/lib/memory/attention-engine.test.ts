/** Functional/scenario integration: real engine events stamp proof-backed marks as the flow executes. */
import type { Attention } from 'foottrace';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StageSnapshot } from '../../../src/advanced.js';
import { flowChart, FlowChartExecutor, getSubtreeSnapshot, interrupt } from '../../../src/index.js';
import { StageContext } from '../../../src/lib/memory/StageContext.js';
import { QualityRecorder } from '../../../src/trace.js';

type State = Record<string, unknown>;
const PRIVATE = 'PRIVATE_ATTENTION_VALUE';
type MarkedStage = StageSnapshot & { attention?: readonly Attention[] };
function stages(root: StageSnapshot | undefined): MarkedStage[] {
  const out: MarkedStage[] = [];
  const pending = root ? [root] : [];
  while (pending.length) {
    const current = pending.pop()!;
    out.push(current);
    if (current.next) pending.push(current.next);
    for (const child of current.children ?? []) pending.push(child);
  }
  return out;
}
function stage(executor: FlowChartExecutor, id: string): MarkedStage {
  const found = stages(executor.getSnapshot().executionTree as StageSnapshot).find((item) => item.id === id);
  if (!found) throw new Error('TEST_STAGE_MISSING');
  return found;
}
function kinds(node: MarkedStage) {
  return (node.attention ?? []).map((mark) => mark.kind);
}
function expectProof(node: MarkedStage) {
  for (const mark of node.attention ?? []) {
    if (mark.kind !== 'not-collected') expect(mark.evidence.length).toBeGreaterThan(0);
    for (const ref of mark.evidence) {
      if (ref.startsWith('attempts:')) {
        const index = Number(ref.slice('attempts:'.length));
        expect(Number.isSafeInteger(index)).toBe(true);
        expect(node.attempts?.[index]).toBeDefined();
      } else if (ref === 'attemptSummary') expect(node.attemptSummary).toBeDefined();
      else if (ref === 'errors:stageExecutionError')
        expect(Object.hasOwn(node.errors, 'stageExecutionError')).toBe(true);
      else if (ref === 'attemptsDropped') expect(node.attemptsDropped).toBeGreaterThan(0);
      else throw new Error('TEST_UNRESOLVABLE_ATTENTION_REFERENCE');
    }
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('C2 attention on real engine executions', () => {
  it.each([1, 2, 3])(
    'uses observed SDK ordinal %i as evidence without treating the default retry table as an SDK decision',
    async (ordinal) => {
      const chart = flowChart<State>(
        'Observe',
        (scope) => {
          scope.$attempt().observed({
            target: 'synthetic-sdk',
            attempt: ordinal,
            of: 3,
            outcome: 'failed',
            durationMs: 2,
            error: new Error(PRIVATE),
          });
          scope.finished = true;
        },
        'observe',
      ).build();
      const executor = new FlowChartExecutor(chart);
      await executor.run();
      const observed = stage(executor, 'observe');
      expect(executor.getSnapshot().sharedState.finished).toBe(true);
      expect(observed.attempts).toHaveLength(1);
      expect(observed.attempts?.[0].kind).toBe('observed');
      // next/reason still describe the default-table interpretation; C2 may not relabel it as actual SDK control.
      expect(observed.attempts?.[0].next).toBe(ordinal < 3 ? 'retry' : 'stop');
      expect(kinds(observed).includes('retried')).toBe(ordinal > 1);
      expect(kinds(observed)).not.toContain('gave-up');
      expect(kinds(observed)).not.toContain('error');
      expectProof(observed);
    },
  );

  it('stamps an ordinary stage error while preserving commit-on-error and the original rejection', async () => {
    const error = new Error(PRIVATE);
    const chart = flowChart<State>(
      'Fail',
      (scope) => {
        scope.saved = 7;
        throw error;
      },
      'fail',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toBe(error);
    const failed = stage(executor, 'fail');
    expect(kinds(failed)).toContain('error');
    expect(failed.attention?.find((mark) => mark.kind === 'error')).toEqual({
      kind: 'error',
      reason: 'ERROR_RECORDED',
      evidence: ['errors:stageExecutionError'],
    });
    expect(executor.getSnapshot().sharedState.saved).toBe(7);
    expect(executor.getSnapshot().commitLog).toHaveLength(1);
    expect(JSON.stringify(failed.attention)).not.toContain(PRIVATE);
    expectProof(failed);
  });

  it('keeps a commit failure visible even though its attempt summary says the function succeeded', async () => {
    const chart = flowChart<State>(
      'Uncloneable',
      (scope) => {
        scope.value = () => PRIVATE;
      },
      'bad',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toBeDefined();
    const failed = stage(executor, 'bad');
    expect(failed.attemptSummary?.last).toEqual({ next: 'done', reason: 'succeeded' });
    expect(kinds(failed)).toContain('error');
    expect(kinds(failed)).not.toContain('gave-up');
    expectProof(failed);
    expect(executor.getSnapshot().commitLog).toEqual([]);
  });

  it('redacts commit-error diagnostics and onError while preserving the original rejection and cause', async () => {
    const cause = { secret: PRIVATE };
    const original = new Error(PRIVATE, { cause });
    // Controlled commit-boundary failure with a cause; the preceding test covers an actual clone failure.
    vi.spyOn(StageContext.prototype, 'commit').mockImplementationOnce(() => {
      throw original;
    });
    const chart = flowChart<State>(
      'Commit',
      (scope) => {
        scope.saved = 1;
      },
      'commit',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ diagnostics: { keys: ['errors.stageExecutionError'] } });
    const served: unknown[] = [];
    executor.attachFlowRecorder({
      id: 'served-commit-error',
      onError(event) {
        served.push(event);
      },
    });
    const rejected = await executor.run().catch((error: unknown) => error);
    expect(Object.is(rejected, original)).toBe(true);
    expect(Object.is((rejected as Error).cause, cause)).toBe(true);
    const failed = stage(executor, 'commit');
    expect(failed.attemptSummary?.last.next).toBe('done');
    expect(kinds(failed)).toContain('error');
    expect(failed.errors.stageExecutionError).toBe('[REDACTED]');
    expect(served).toHaveLength(1);
    expect(JSON.stringify(served)).not.toContain(PRIVATE);
    expect(JSON.stringify(failed.attention)).not.toContain(PRIVATE);
    expectProof(failed);
  });

  it('exposes a retry synchronously to the live attempt hook and preserves it after recovery', async () => {
    let attempts = 0;
    const chart = flowChart<State>(
      'Retry',
      (scope) => {
        if (++attempts === 1) throw new Error(PRIVATE);
        scope.done = true;
      },
      'retry',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    let live: readonly Attention[] | undefined;
    executor.attachFlowRecorder({
      id: 'attention-live',
      onAttempt(event) {
        if (event.record.next === 'retry') live = stage(executor, 'retry').attention;
      },
    });
    await executor.run();
    expect(live?.map((mark) => mark.kind)).toContain('retried');
    const recovered = stage(executor, 'retry');
    expect(kinds(recovered)).toContain('retried');
    expect(kinds(recovered)).not.toContain('gave-up');
    expect(kinds(recovered)).not.toContain('error');
    expectProof(recovered);
    expect(executor.getSnapshot().commitLog).toHaveLength(1);
  });

  it('distinguishes exhausted retries from a recovered operation', async () => {
    const chart = flowChart<State>(
      'Retry',
      () => {
        throw new Error(PRIVATE);
      },
      'retry',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toBeDefined();
    const failed = stage(executor, 'retry');
    expect(kinds(failed)).toEqual(expect.arrayContaining(['error', 'retried', 'gave-up']));
    expectProof(failed);
  });

  it('records a real timer timeout as timeout evidence without provider calls', async () => {
    vi.useFakeTimers();
    const chart = flowChart<State>('Wait', () => new Promise<void>(() => {}), 'wait')
      .retry({ attempts: 1, timeoutMs: 5 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const work = executor.run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5);
    expect(await work).toBeDefined();
    const timedOut = stage(executor, 'wait');
    expect(kinds(timedOut)).toContain('timeout');
    expectProof(timedOut);
  });

  it('preserves timeout and unknown side effect as separate facts on a synthetic payment boundary', async () => {
    vi.useFakeTimers();
    const chart = flowChart<State>('Charge', () => new Promise<void>(() => {}), 'charge')
      .touches('test-payments', { idempotencyKey: () => PRIVATE })
      .retry({ attempts: 1, timeoutMs: 5 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const work = executor.run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5);
    expect(await work).toBeDefined();
    const unknown = stage(executor, 'charge');
    expect(kinds(unknown)).toEqual(expect.arrayContaining(['timeout', 'unknown-effect']));
    expect(JSON.stringify(unknown.attention)).not.toContain(PRIVATE);
    expectProof(unknown);
  });

  it('does not flag an intentional interrupt or a healthy resumed stage', async () => {
    const chart = flowChart<State>(
      'Ask',
      (scope) => {
        scope.answer = interrupt(scope, { reason: 'Continue?' });
      },
      'ask',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.isPaused()).toBe(true);
    expect(stage(executor, 'ask').attention).toBeUndefined();
    await executor.resume(executor.getCheckpoint()!, { accepted: true });
    expect(executor.isPaused()).toBe(false);
    expect(
      stages(executor.getSnapshot().executionTree as StageSnapshot).every((node) => node.attention === undefined),
    ).toBe(true);
  });

  it('resets attention between separate runs of one executor', async () => {
    let fail = true;
    const chart = flowChart<State>(
      'Maybe',
      () => {
        if (fail) throw new Error(PRIVATE);
      },
      'maybe',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toBeDefined();
    expect(kinds(stage(executor, 'maybe'))).toContain('error');
    fail = false;
    await executor.run();
    expect(stage(executor, 'maybe').attention).toBeUndefined();
  });

  it('keeps retry attention within its loop execution instead of a later healthy visit', async () => {
    let pass = 0;
    const chart = flowChart<State>(
      'Loop',
      async (scope) => {
        pass++;
        if (pass === 1) {
          try {
            await scope.$call(
              'test-lookup',
              () => {
                throw new Error(PRIVATE);
              },
              { attempts: 2 },
            );
          } catch {
            /* a handled call failure */
          }
        } else scope.$break();
      },
      'loop',
    )
      .loopTo('loop')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const visits = stages(executor.getSnapshot().executionTree as StageSnapshot).filter((node) => node.id === 'loop');
    expect(visits).toHaveLength(2);
    expect(kinds(visits[0])).toContain('retried');
    expect(visits[1].attention).toBeUndefined();
    expect(visits[0].runtimeStageId).not.toBe(visits[1].runtimeStageId);
  });

  it('does not spread one failed sibling attention to a healthy parallel sibling', async () => {
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addListOfFunction([
        {
          id: 'bad',
          name: 'Bad',
          fn: () => {
            throw new Error(PRIVATE);
          },
        },
        { id: 'good', name: 'Good', fn: () => undefined },
      ])
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run().catch(() => undefined);
    expect(kinds(stage(executor, 'bad'))).toContain('error');
    expect(stage(executor, 'good').attention).toBeUndefined();
  });

  it('keeps subflow retries on the inner execution and leaves a healthy mount unflagged', async () => {
    let calls = 0;
    const sub = flowChart<State>(
      'Inner',
      () => {
        if (++calls === 1) throw new Error(PRIVATE);
      },
      'inner',
    )
      .retry({ attempts: 2 })
      .build();
    const chart = flowChart<State>('Seed', () => undefined, 'seed')
      .addSubFlowChartNext('sub', sub, 'Sub')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const result = getSubtreeSnapshot(executor.getSnapshot(), 'sub');
    const inner = stages(result?.executionTree as StageSnapshot).find((node) => node.id.endsWith('inner'));
    expect(inner).toBeDefined();
    expect(kinds(inner!)).toContain('retried');
    expect(stage(executor, 'sub').attention).toBeUndefined();
    expectProof(inner!);
  });

  it('does not infer outliers or errors from arbitrary diagnostics and metric values', async () => {
    const chart = flowChart<State>(
      'Report',
      (scope) => {
        scope.$metric('latency', 999999);
        scope.$error('business-note', PRIVATE);
        scope.$eval('score', 0.01);
      },
      'report',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(stage(executor, 'report').attention).toBeUndefined();
  });

  it('stamps quality-drop only when an inline combined quality recorder reports its actual retry drop', async () => {
    const chart = flowChart<State>(
      'Fail',
      () => {
        throw new Error(PRIVATE);
      },
      'fail',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const quality = new QualityRecorder(() => ({ score: 1 }));
    executor.attachCombinedRecorder(quality);
    await executor.run().catch(() => undefined);
    const failed = stage(executor, 'fail');
    expect(quality.getByKey(failed.runtimeStageId!)?.drop).toBe('attempts');
    expect(kinds(failed)).toContain('quality-drop');
    expect(failed.attention?.find((mark) => mark.kind === 'quality-drop')?.reason).toBe('QUALITY_DROP_RECORDED');
    expectProof(failed);
    expect(JSON.stringify(failed.attention)).not.toContain(PRIVATE);
  });

  it('does not turn an arbitrary low quality score into quality-drop or outlier attention', async () => {
    const chart = flowChart<State>('Score', () => undefined, 'score').build();
    const executor = new FlowChartExecutor(chart);
    const quality = new QualityRecorder(() => ({ score: 0.001, factors: [PRIVATE] }));
    executor.attachCombinedRecorder(quality);
    await executor.run();
    const scored = stage(executor, 'score');
    expect(quality.getByKey(scored.runtimeStageId!)?.score).toBe(0.001);
    expect(quality.getByKey(scored.runtimeStageId!)?.drop).toBeUndefined();
    expect(scored.attention).toBeUndefined();
  });

  it('does not claim quality-drop when the scoring recorder did not observe retry events', async () => {
    const chart = flowChart<State>(
      'Fail',
      () => {
        throw new Error(PRIVATE);
      },
      'fail',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachScopeRecorder(new QualityRecorder(() => ({ score: 0 })));
    await executor.run().catch(() => undefined);
    expect(kinds(stage(executor, 'fail'))).not.toContain('quality-drop');
  });

  it('keeps a cancelled backoff distinct from a new timeout or exhausted physical attempt', async () => {
    const controller = new AbortController();
    const chart = flowChart<State>(
      'Retry',
      () => {
        throw new Error(PRIVATE);
      },
      'retry',
    )
      .retry({ attempts: 4, backoffMs: 100 })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder({
      id: 'cut-wait',
      onStageRetry() {
        controller.abort();
      },
    });
    await executor.run({ signal: controller.signal }).catch(() => undefined);
    const cancelled = stage(executor, 'retry');
    expect(cancelled.attempts).toHaveLength(1);
    expect(cancelled.attemptSummary?.last.reason).toBe('aborted');
    expect(kinds(cancelled)).toContain('retried');
    expect(kinds(cancelled)).not.toContain('gave-up');
    expect(kinds(cancelled)).not.toContain('timeout');
    expectProof(cancelled);
  });

  it.each([
    null,
    Object.create(null),
    new Proxy(
      {},
      {
        get() {
          throw new Error(PRIVATE);
        },
      },
    ),
  ])('handles hostile or non-Error throws without copying them into attention', async (thrown) => {
    const chart = flowChart<State>(
      'Hostile',
      () => {
        throw thrown;
      },
      'hostile',
    ).build();
    const executor = new FlowChartExecutor(chart);
    const rejected = await executor.run().then(
      () => ({ ok: true }),
      (error: unknown) => ({ error }),
    );
    expect(Object.hasOwn(rejected, 'error')).toBe(true);
    expect(Object.is((rejected as { error: unknown }).error, thrown)).toBe(true);
    const failed = stage(executor, 'hostile');
    expect(kinds(failed)).toContain('error');
    expect(JSON.stringify(failed.attention)).not.toContain(PRIVATE);
    expectProof(failed);
  });
});

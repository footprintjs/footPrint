/** Unit/boundary/security coverage for bounded synchronous quality observation, plus real composition scenarios. */
import { EventLog, SharedMemory } from 'foottrace/write';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttemptRecord } from '../../../src/index.js';
import { CompositeRecorder, flowChart, FlowChartExecutor } from '../../../src/index.js';
import { inlineQualityAttention } from '../../../src/lib/engine/handlers/inlineQualityAttention.js';
import { FlowRecorderDispatcher } from '../../../src/lib/engine/narrative/FlowRecorderDispatcher.js';
import { StageContext } from '../../../src/lib/memory/StageContext.js';
import { QualityRecorder } from '../../../src/trace.js';

const series = 'quality#0';
const attempt: AttemptRecord = {
  series,
  kind: 'stage',
  attempt: 1,
  of: 2,
  outcome: 'failed',
  startedAt: 10,
  durationMs: 2,
  decision: { rules: [], chosen: 'stop', default: 'retry' },
  next: 'stop',
  reason: 'exhausted',
};
function fixture() {
  const context = new StageContext('quality-run', 'Quality', 'quality', new SharedMemory(), '', new EventLog({}));
  context.runtimeStageId = series;
  const proof = context.recordAttempt(attempt);
  const quality = new QualityRecorder(() => ({ score: 1 }));
  const publish = () =>
    quality.onAttempt({ stageName: 'Quality', stageId: 'quality', record: attempt, channel: 'flow' });
  return { context, proof, quality, publish, narrative: new FlowRecorderDispatcher() };
}
const kinds = (context: StageContext) => (context.getSnapshot().attention ?? []).map((mark) => mark.kind);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded inline quality observation', () => {
  it('contains recorder-list query failure when a retained proof is available', () => {
    const { context, proof, narrative } = fixture();
    vi.spyOn(narrative, 'getScopeRecorders').mockImplementation(() => {
      throw new Error('PRIVATE_LIST');
    });
    expect(() => inlineQualityAttention(narrative, context, series, proof)()).not.toThrow();
    expect(kinds(context)).toContain('not-collected');
    expect(kinds(context)).not.toContain('quality-drop');
    expect(JSON.stringify(context.getSnapshot().attention)).not.toContain('PRIVATE_LIST');
  });

  it('contains a throwing iterator while admitting the bounded recorder list', () => {
    const { context, proof, narrative } = fixture();
    const list: never[] = [];
    Object.defineProperty(list, Symbol.iterator, {
      get() {
        throw new Error('PRIVATE_ITERATOR');
      },
    });
    vi.spyOn(narrative, 'getScopeRecorders').mockReturnValue(list);
    expect(() => inlineQualityAttention(narrative, context, series, proof)()).not.toThrow();
    expect(kinds(context)).toContain('not-collected');
    expect(JSON.stringify(context.getSnapshot().attention)).not.toContain('PRIVATE_ITERATOR');
  });

  it('limits dispatcher peeks without copying the whole attached list or exposing its mutable array', () => {
    const narrative = new FlowRecorderDispatcher();
    const all = Array.from({ length: 200 }, (_, index) => ({ id: 'observer-' + index }));
    for (const recorder of all) narrative.attach(recorder);
    const limited = narrative.getScopeRecorders(3);
    expect(limited).toHaveLength(3);
    expect(limited).toEqual(all.slice(0, 3));
    limited.pop();
    expect(narrative.getScopeRecorders()).toHaveLength(200);
  });

  it('recognizes an already collected drop through nested real composites', () => {
    const { context, proof, quality, publish, narrative } = fixture();
    narrative.attach(new CompositeRecorder('outer', [new CompositeRecorder('inner', [quality])]));
    const after = inlineQualityAttention(narrative, context, series, proof);
    publish();
    after();
    expect(kinds(context)).toContain('quality-drop');
    expect(context.getSnapshot().attention?.find((mark) => mark.kind === 'quality-drop')?.evidence).toEqual([proof]);
  });

  it('does no recorder inspection when there is no retained proof to cite', () => {
    const { context, narrative } = fixture();
    const read = vi.spyOn(narrative, 'getScopeRecorders').mockImplementation(() => {
      throw new Error('PRIVATE_OBSERVER');
    });
    inlineQualityAttention(narrative, context, series)();
    expect(read).not.toHaveBeenCalled();
    expect(kinds(context)).not.toContain('quality-drop');
  });

  it('terminates cyclic composite inspection and reads a shared observer once per phase without executing fanout', () => {
    const { context, proof, quality, publish, narrative } = fixture();
    const composite = new CompositeRecorder('cyclic', []);
    // Deliberately malformed composition is inspected only; no cyclic hook fanout is ever executed.
    (composite.getChildren() as unknown[]).push(composite, quality, quality);
    narrative.attach(composite);
    const read = vi.spyOn(QualityRecorder.prototype, 'getByKey');
    const after = inlineQualityAttention(narrative, context, series, proof);
    publish();
    after();
    expect(kinds(context)).toContain('quality-drop');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('discloses its recorder-inspection cap without inspecting an unbounded tail or guessing a quality drop', () => {
    const { context, proof, quality, narrative } = fixture();
    const children = Array.from({ length: 129 }, (_, index) => ({ id: 'empty-' + index }));
    narrative.attach(new CompositeRecorder('wide', [...children, quality]));
    const read = vi.spyOn(QualityRecorder.prototype, 'getByKey');
    inlineQualityAttention(narrative, context, series, proof)();
    expect(kinds(context)).toContain('not-collected');
    expect(kinds(context)).not.toContain('quality-drop');
    expect(read).not.toHaveBeenCalled();
  });

  it('does not probe lookalike observer getters or arbitrary getByKey methods', () => {
    const { context, proof, narrative } = fixture();
    const get = vi.fn(() => {
      throw new Error('PRIVATE_OBSERVER');
    });
    narrative.attach(Object.defineProperty({ id: 'lookalike' }, 'getByKey', { get }));
    inlineQualityAttention(narrative, context, series, proof)();
    expect(get).not.toHaveBeenCalled();
    expect(kinds(context)).not.toContain('quality-drop');
  });

  it('turns an observer query failure into missing evidence without throwing or exposing its error', () => {
    const { context, proof, quality, narrative } = fixture();
    narrative.attach(quality);
    vi.spyOn(QualityRecorder.prototype, 'getByKey').mockImplementation(() => {
      throw new Error('PRIVATE_OBSERVER');
    });
    expect(() => inlineQualityAttention(narrative, context, series, proof)()).not.toThrow();
    expect(kinds(context)).toContain('not-collected');
    expect(kinds(context)).not.toContain('quality-drop');
    expect(JSON.stringify(context.getSnapshot().attention)).not.toContain('PRIVATE_OBSERVER');
  });

  it('does not reuse an unchanged quality row from before the current event', () => {
    const { context, proof, quality, publish, narrative } = fixture();
    publish();
    expect(quality.getByKey(series)?.drop).toBe('attempts');
    narrative.attach(quality);
    const after = inlineQualityAttention(narrative, context, series, proof);
    after();
    expect(kinds(context)).not.toContain('quality-drop');
  });
});

describe('quality composition on a real engine', () => {
  it('preserves a successful business result when the inline recorder-list query throws', async () => {
    const chart = flowChart<{ done?: boolean }>(
      'Quality',
      (scope) => {
        scope.done = true;
      },
      'quality',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(new QualityRecorder(() => ({ score: 1 })));
    vi.spyOn(FlowRecorderDispatcher.prototype, 'getScopeRecorders').mockImplementation(() => {
      throw new Error('PRIVATE_LIST');
    });
    await executor.run();
    expect(executor.getSnapshot().sharedState.done).toBe(true);
    expect(executor.getSnapshot().executionTree.attention?.map((mark) => mark.kind) ?? []).toContain('not-collected');
  });

  it('does not reuse a previous run drop when the current retry event did not update the quality row', async () => {
    vi.useFakeTimers();
    let mode: 'timeout' | 'ordinary' = 'timeout';
    let calls = 0;
    const chart = flowChart(
      'Quality',
      () => {
        if (++calls === 1) {
          if (mode === 'timeout') return new Promise<void>(() => {});
          throw new Error('synthetic ordinary failure');
        }
      },
      'quality',
    )
      .retry({ attempts: 2, timeoutMs: 5 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const quality = new QualityRecorder(() => ({ score: 1 }));
    executor.attachCombinedRecorder(quality);
    let atRetry: readonly string[] | undefined;
    executor.attachFlowRecorder({
      id: 'current-retry',
      onStageRetry() {
        if (mode === 'ordinary') atRetry = executor.getSnapshot().executionTree.attention?.map((mark) => mark.kind);
      },
    });
    const first = executor.run();
    await vi.advanceTimersByTimeAsync(5);
    await first;
    expect(quality.getByKey(executor.getSnapshot().executionTree.runtimeStageId!)?.drop).toBe('attempts');
    mode = 'ordinary';
    calls = 0;
    await executor.run();
    expect(atRetry).toContain('retried');
    expect(atRetry).not.toContain('quality-drop');
  });

  it('projects the nested inline recorder actual drop onto the owning stage', async () => {
    const chart = flowChart(
      'Quality',
      () => {
        throw new Error('synthetic failure');
      },
      'quality',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const quality = new QualityRecorder(() => ({ score: 1 }));
    executor.attachCombinedRecorder(new CompositeRecorder('outer', [new CompositeRecorder('inner', [quality])]));
    await executor.run().catch(() => undefined);
    const stage = executor.getSnapshot().executionTree;
    expect(quality.getByKey(stage.runtimeStageId!)?.drop).toBe('attempts');
    expect(stage.attention?.map((mark) => mark.kind)).toContain('quality-drop');
  });

  it('keeps the business outcome when querying a quality observer throws', async () => {
    const chart = flowChart<{ done?: boolean }>(
      'Quality',
      (scope) => {
        scope.done = true;
      },
      'quality',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(new QualityRecorder(() => ({ score: 1 })));
    vi.spyOn(QualityRecorder.prototype, 'getByKey').mockImplementation(() => {
      throw new Error('PRIVATE_OBSERVER');
    });
    await executor.run();
    expect(executor.getSnapshot().sharedState.done).toBe(true);
    expect(executor.getSnapshot().executionTree.attention?.map((mark) => mark.kind)).toContain('not-collected');
    expect(JSON.stringify(executor.getSnapshot().executionTree.attention)).not.toContain('PRIVATE_OBSERVER');
  });

  it('does not retroactively stamp a deferred quality observer row as a synchronous fact', async () => {
    const chart = flowChart(
      'Quality',
      () => {
        throw new Error('synthetic failure');
      },
      'quality',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    const quality = new QualityRecorder(() => ({ score: 1 }));
    executor.attachCombinedRecorder(quality, { delivery: 'deferred' });
    await executor.run().catch(() => undefined);
    const stage = executor.getSnapshot().executionTree;
    expect(quality.getByKey(stage.runtimeStageId!)?.drop).toBe('attempts');
    expect(stage.attention?.some((mark) => mark.kind === 'quality-drop')).toBe(false);
  });
});

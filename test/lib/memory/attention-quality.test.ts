/** Architecture/privacy: quality remains a recorder row; the engine never observes its observers. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompositeRecorder, flowChart, FlowChartExecutor } from '../../../src/index.js';
import { FlowRecorderDispatcher } from '../../../src/lib/engine/narrative/FlowRecorderDispatcher.js';
import { QualityRecorder } from '../../../src/trace.js';

afterEach(() => vi.restoreAllMocks());

describe('engine-owned attention without quality-recorder inspection', () => {
  it.each([false, true])(
    'retains quality drop rows without querying them or stamping engine attention (nested=%s)',
    async (nested) => {
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
      const readRow = QualityRecorder.prototype.getByKey;
      const queried = vi.spyOn(QualityRecorder.prototype, 'getByKey');
      executor.attachCombinedRecorder(
        nested ? new CompositeRecorder('outer', [new CompositeRecorder('inner', [quality])]) : quality,
      );
      await executor.run().catch(() => undefined);
      const stage = executor.getSnapshot().executionTree;
      expect(readRow.call(quality, stage.runtimeStageId!)?.drop).toBe('attempts');
      expect(queried).not.toHaveBeenCalled();
      expect(stage.attention?.some((mark) => mark.kind === 'quality-drop') ?? false).toBe(false);
      expect(stage.attention?.map((mark) => mark.kind)).toEqual(
        expect.arrayContaining(['retried', 'gave-up', 'error']),
      );
    },
  );

  it('does not enumerate the observer list to determine attention or fail a successful business run', async () => {
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
    const queried = vi.spyOn(FlowRecorderDispatcher.prototype, 'getScopeRecorders').mockImplementation(() => {
      throw new Error('PRIVATE_OBSERVER_LIST');
    });
    await executor.run();
    expect(executor.getSnapshot().sharedState.done).toBe(true);
    expect(executor.getSnapshot().executionTree.attention).toBeUndefined();
    expect(queried).not.toHaveBeenCalled();
  });

  it('never probes arbitrary observer quality or attention-source getters', async () => {
    const queried = vi.fn(() => {
      throw new Error('PRIVATE_OBSERVER_GETTER');
    });
    const observer = { id: 'custom-observer', onAttempt: vi.fn() };
    for (const key of ['getByKey', 'getChildren', 'attentionFor'])
      Object.defineProperty(observer, key, { get: queried });
    const chart = flowChart('Fine', () => undefined, 'fine')
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(observer);
    await executor.run();
    expect(observer.onAttempt).toHaveBeenCalledTimes(1);
    expect(queried).not.toHaveBeenCalled();
    expect(executor.getSnapshot().executionTree.attention).toBeUndefined();
  });

  it('keeps a low quality score as recorder data without inferring an engine quality drop or outlier', async () => {
    const quality = new QualityRecorder(() => ({ score: 0.001, factors: ['domain-specific score'] }));
    const chart = flowChart('Score', () => undefined, 'score').build();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(quality);
    await executor.run();
    const stage = executor.getSnapshot().executionTree;
    expect(quality.getByKey(stage.runtimeStageId!)?.score).toBe(0.001);
    expect(stage.attention).toBeUndefined();
  });
});

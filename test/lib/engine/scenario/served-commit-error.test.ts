/** Commit failures use the same retained diagnostic boundary as failures inside the stage function. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { StageContext } from '../../../../src/lib/memory/StageContext.js';

afterEach(() => vi.restoreAllMocks());

describe('served commit errors', () => {
  it('retains an actual clone failure, reports it once and preserves the failed commit boundary', async () => {
    const chart = flowChart<{ value?: unknown }>(
      'Clone',
      (scope) => {
        scope.value = () => 'synthetic uncloneable value';
      },
      'clone',
    ).build();
    const executor = new FlowChartExecutor(chart);
    const events: unknown[] = [];
    executor.attachFlowRecorder({ id: 'commit-events', onError: (event) => events.push(event) });
    const rejected = await executor.run().catch((error: unknown) => error);
    expect(rejected).toBeDefined();
    const failed = executor.getSnapshot().executionTree;
    expect(failed.id).toBe('clone');
    expect(failed.runtimeStageId).toBe('clone#0');
    expect(failed.errors.stageExecutionError).toBe(String(rejected));
    expect(failed.attention).toEqual([
      { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['errors:stageExecutionError'] },
    ]);
    expect(failed.attention?.some((mark) => mark.kind === 'gave-up')).toBe(false);
    expect(executor.getSnapshot().commitLog).toEqual([]);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('DataCloneError');
  });

  it('masks the diagnostic and recorder event while preserving the caller original error and cause', async () => {
    const secret = 'SYNTHETIC_COMMIT_SECRET';
    const cause = { secret };
    const original = new Error(secret, { cause });
    // Inject at the real commit boundary; the adjacent case exercises an actual structuredClone failure.
    vi.spyOn(StageContext.prototype, 'commit').mockImplementationOnce(() => {
      throw original;
    });
    const chart = flowChart<{ value?: number }>(
      'Commit',
      (scope) => {
        scope.value = 1;
      },
      'commit',
    ).build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ diagnostics: { keys: ['errors.stageExecutionError'] } });
    const events: unknown[] = [];
    executor.attachFlowRecorder({ id: 'served-commit-error', onError: (event) => events.push(event) });
    const rejected = await executor.run().catch((error: unknown) => error);
    expect(Object.is(rejected, original)).toBe(true);
    expect(Object.is((rejected as Error).cause, cause)).toBe(true);
    const failed = executor.getSnapshot().executionTree;
    expect(failed.errors.stageExecutionError).toBe('[REDACTED]');
    expect(failed.attention).toEqual([
      { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['errors:stageExecutionError'] },
    ]);
    expect(JSON.stringify(failed.attention)).not.toContain(secret);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(executor.getSnapshot())).not.toContain(secret);
    expect(executor.getSnapshot().commitLog).toEqual([]);
  });
});

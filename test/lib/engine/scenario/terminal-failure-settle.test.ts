import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowErrorEvent, FlowRunFailedEvent } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import type { ILogger } from '../../../../src/lib/engine/types.js';
import { StageContext } from '../../../../src/lib/memory/StageContext.js';

const silent: ILogger = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

afterEach(() => vi.restoreAllMocks());

function captureCommitFailures() {
  const commit = StageContext.prototype.commit;
  const failures: { phase: Parameters<StageContext['commit']>[0]; error: unknown; runtimeStageId: string }[] = [];
  vi.spyOn(StageContext.prototype, 'commit').mockImplementation(function (this: StageContext, ...args) {
    try {
      return commit.apply(this, args);
    } catch (error) {
      failures.push({ phase: args[0], error, runtimeStageId: this.runtimeStageId });
      throw error;
    }
  });
  return failures;
}

describe('terminal ownership at continuation commits', () => {
  it.each([false, true])('a fork settle clone failure owns its child frame (failFast=%s)', async (failFast) => {
    const business = new Error('synthetic superseded child failure');
    const executor = new FlowChartExecutor(
      flowChart<Record<string, unknown>>('Seed', () => {}, 'seed')
        .addListOfFunction(
          [
            {
              id: 'broken',
              name: 'Broken child',
              fn(scope) {
                scope.$setValue('uncloneable', () => 'synthetic uncloneable child write');
                throw business;
              },
            },
          ],
          { failFast },
        )
        .setLogger(silent)
        .build(),
    );
    const failures = captureCommitFailures();
    const stageErrors: FlowErrorEvent[] = [];
    const terminal: FlowRunFailedEvent[] = [];
    executor.attachFlowRecorder({
      id: 'child-settle-ownership',
      onError: (event) => stageErrors.push(event),
      onRunFailed: (event) => terminal.push(event),
    });
    let escaped: unknown;
    try {
      await executor.run();
    } catch (error) {
      escaped = error;
    }
    expect(failures).toHaveLength(2);
    expect(failures[0].error).not.toBe(failures[1].error);
    expect(failures[1].phase).toBe('repeat');
    expect(escaped).toBe(failures[1].error);
    expect(escaped).toHaveProperty('name', 'DataCloneError');
    expect(escaped).not.toBe(business);
    expect(failures[1].runtimeStageId).toMatch(/^broken#\d+$/);
    expect(stageErrors).toEqual([]);
    expect(executor.getSnapshot().commitLog.filter((bundle) => bundle.stageId === 'broken')).toEqual([]);
    expect(terminal).toHaveLength(1);
    const expected = {
      category: 'unknown',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: failures[1].runtimeStageId },
    };
    expect(executor.getFailureContext()).toEqual(expected);
    expect(terminal[0].failure).toEqual(expected);
  });

  it('a linear mount exit owns the exact escaping clone failure after a contained mapper failure', async () => {
    const inner = flowChart('Inner', () => {}, 'inner')
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addSubFlowChartNext('mount', inner, 'Mount', {
          outputMapper: () => ({ uncloneable: () => 'synthetic uncloneable mapped write' }),
        })
        .setLogger(silent)
        .build(),
    );
    const failures = captureCommitFailures();
    const stageErrors: FlowErrorEvent[] = [];
    const terminal: FlowRunFailedEvent[] = [];
    executor.attachFlowRecorder({
      id: 'mount-exit-ownership',
      onError: (event) => stageErrors.push(event),
      onRunFailed: (event) => terminal.push(event),
    });
    let escaped: unknown;
    try {
      await executor.run();
    } catch (error) {
      escaped = error;
    }
    expect(failures).toHaveLength(2);
    expect(failures[0].error).not.toBe(failures[1].error);
    expect(failures[1].phase).toBe('exit');
    expect(escaped).toBe(failures[1].error);
    expect(escaped).toHaveProperty('name', 'DataCloneError');
    expect(failures[1].runtimeStageId).toMatch(/^mount#\d+$/);
    expect(stageErrors).toEqual([]);
    expect(JSON.stringify(executor.getSnapshot().executionTree)).toContain('outputMapperError');
    expect(terminal).toHaveLength(1);
    const expected = {
      category: 'unknown',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: failures[1].runtimeStageId },
    };
    expect(executor.getFailureContext()).toEqual(expected);
    expect(terminal[0].failure).toEqual(expected);
  });

  it('a branch mapper failure that drops staged writes stays contained and has no terminal context', async () => {
    const inner = flowChart('Inner', () => {}, 'inner')
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addDeciderFunction('Choose mount', () => 'mount', 'choose')
        .addSubFlowChartBranch('mount', inner, 'Mount', {
          outputMapper: () => ({ uncloneable: () => 'synthetic discarded mapped write' }),
        })
        .end()
        .setLogger(silent)
        .build(),
    );
    const failures = captureCommitFailures();
    const terminal: FlowRunFailedEvent[] = [];
    executor.attachFlowRecorder({ id: 'contained-mapper-control', onRunFailed: (event) => terminal.push(event) });
    await executor.run();
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toHaveProperty('name', 'DataCloneError');
    expect(JSON.stringify(executor.getSnapshot().executionTree)).toContain('outputMapperError');
    expect(executor.getSnapshot().sharedState.uncloneable).toBeUndefined();
    expect(executor.getFailureContext()).toBeUndefined();
    expect(terminal).toEqual([]);
  });
});

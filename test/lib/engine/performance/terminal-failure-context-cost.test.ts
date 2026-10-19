import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import type { ILogger } from '../../../../src/lib/engine/types.js';
import { NativeFailureState } from '../../../../src/lib/errors/terminalFailure.js';

const silent: ILogger = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

describe('terminal failure context has bounded scalar ownership', () => {
  it('retains one candidate and serves reads without inspecting thrown payloads', () => {
    let payloadReads = 0;
    const error = new Proxy(
      {},
      {
        get() {
          payloadReads++;
          throw new Error('payload must not be read');
        },
      },
    );
    const state = new NativeFailureState();
    for (let index = 0; index < 2000; index++) {
      state.capture(error, 'unknown', { runId: 'synthetic-load-run', runtimeStageId: 'stage#' + index });
    }
    expect(state.result).toBeUndefined();
    state.finish(error);
    const retained = state.result;
    for (let index = 0; index < 10000; index++) expect(state.result).toBe(retained);
    expect(retained).toEqual({
      category: 'unknown',
      stage: { runId: 'synthetic-load-run', runtimeStageId: 'stage#1999' },
    });
    expect(Object.keys(retained ?? {})).toHaveLength(2);
    expect(payloadReads).toBe(0);
    expect(state.owns(error)).toBe(false);
  });

  it('many failed and successful legs on one executor expose only the current leg', async () => {
    let fail = true;
    const original = Object.assign(new Error('synthetic repeated load'), { status: 503 });
    const executor = new FlowChartExecutor(
      flowChart(
        'Work',
        () => {
          if (fail) throw original;
        },
        'work',
      )
        .setLogger(silent)
        .build(),
    );
    const runIds = new Set<string>();
    for (let index = 0; index < 80; index++) {
      fail = index % 2 === 0;
      if (fail) {
        await expect(executor.run()).rejects.toBe(original);
        const context = executor.getFailureContext();
        expect(context?.category).toBe('server');
        expect(context?.stage?.runtimeStageId).toBe('work#0');
        const runId = context?.stage?.runId;
        expect(runId).toBeDefined();
        expect(runIds.has(runId ?? '')).toBe(false);
        runIds.add(runId ?? '');
        expect(JSON.stringify(context).length).toBeLessThan(256);
      } else {
        await executor.run();
        expect(executor.getFailureContext()).toBeUndefined();
      }
    }
    expect(runIds.size).toBe(40);
  });

  it('concurrent executors of one chart keep separate current-run contexts', async () => {
    const chart = flowChart(
      'Fail',
      () => {
        throw new Error('synthetic parallel load');
      },
      'fail',
    )
      .setLogger(silent)
      .build();
    const executors = Array.from({ length: 48 }, () => new FlowChartExecutor(chart));
    await Promise.all(
      executors.map(async (executor) => {
        await expect(executor.run()).rejects.toThrow('synthetic parallel load');
        expect(executor.getFailureContext()).toEqual({
          category: 'unknown',
          stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'fail#0' },
        });
      }),
    );
    expect(new Set(executors.map((executor) => executor.getFailureContext()?.stage?.runId)).size).toBe(48);
  });
});

/**
 * runId FUNCTIONAL tests — single-feature happy path through executor.
 *
 * Pattern 2 of 7 (functional). One executor.run() carries one stable
 * runId across all events the recorders observe.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { FlowRecorder } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { _resetRunIdStateForTesting } from '../../../src/lib/runner/runId.js';

beforeEach(() => {
  _resetRunIdStateForTesting();
});

describe('runId — functional', () => {
  it('one executor.run() carries one stable runId across all events', async () => {
    const seen: string[] = [];
    const recorder: FlowRecorder = {
      id: 'test-rec',
      onSubflowEntry: (e) => {
        if (e.traversalContext?.runId) seen.push(e.traversalContext.runId);
      },
      onSubflowExit: (e) => {
        if (e.traversalContext?.runId) seen.push(e.traversalContext.runId);
      },
    };

    const subChart = flowChart('inner', () => 'sub-result', 'inner-stage').build();
    const chart = flowChart('start', () => null, 'seed-stage')
      .addSubFlowChart('sf-test', subChart, 'sf-test', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(recorder);
    await executor.run();

    expect(seen.length).toBeGreaterThan(0);
    // All events from one run share one runId.
    const distinct = new Set(seen);
    expect(distinct.size).toBe(1);
  });

  it('two consecutive runs of the same executor produce DIFFERENT runIds', async () => {
    const seen: string[] = [];
    const recorder: FlowRecorder = {
      id: 'rec-runstart',
      onRunStart: (e) => {
        if (e.traversalContext?.runId) seen.push(e.traversalContext.runId);
      },
    };

    const chart = flowChart('a', () => 'first', 'stage').build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(recorder);

    await executor.run();
    await executor.run();

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

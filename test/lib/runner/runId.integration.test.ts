/**
 * runId INTEGRATION tests — multi-component cooperation.
 *
 * Pattern 3 of 7 (integration). Multiple recorders attached to the
 * same executor see the same runId for the same run; subflow
 * traversers inherit the parent's runId.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { FlowRecorder } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { _resetRunIdStateForTesting } from '../../../src/lib/runner/runId.js';

beforeEach(() => {
  _resetRunIdStateForTesting();
});

describe('runId — integration', () => {
  it('two FlowRecorders attached to the same executor see the same runId', async () => {
    const a: string[] = [];
    const b: string[] = [];
    const recA: FlowRecorder = {
      id: 'rec-a',
      onRunStart: (e) => {
        if (e.traversalContext?.runId) a.push(e.traversalContext.runId);
      },
    };
    const recB: FlowRecorder = {
      id: 'rec-b',
      onRunStart: (e) => {
        if (e.traversalContext?.runId) b.push(e.traversalContext.runId);
      },
    };

    const chart = flowChart('s', () => 'r', 'stage').build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(recA);
    executor.attachFlowRecorder(recB);
    await executor.run();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toBe(b[0]);
  });

  it('subflow traversers inherit parent runId — single run, single runId across nesting', async () => {
    const seen: string[] = [];
    const recorder: FlowRecorder = {
      id: 'rec-nested',
      onSubflowEntry: (e) => {
        if (e.traversalContext?.runId) seen.push(e.traversalContext.runId);
      },
    };

    const inner = flowChart('inner-seed', () => 'inner-result', 'inner-stage').build();
    const chart = flowChart('seed', () => null, 'seed-stage')
      .addSubFlowChart('sf-1', inner, 'sf-1', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .addSubFlowChart('sf-2', inner, 'sf-2', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(recorder);
    await executor.run();

    expect(seen.length).toBeGreaterThanOrEqual(2);
    const distinct = new Set(seen);
    expect(distinct.size).toBe(1); // All subflow entries share the root runId.
  });
});

/**
 * Integration tests for runtimeStageId across 5 execution patterns.
 * Verifies uniqueness, ordering, and correct subflow prefixing.
 */
import { describe, expect, it } from 'vitest';

import type { Recorder, StageEvent } from '../../../../src';
import { flowChart, FlowChartExecutor } from '../../../../src';

function captureRuntimeIds(exec: FlowChartExecutor): string[] {
  const ids: string[] = [];
  exec.attachRecorder({
    id: 'capture',
    onStageStart(e: StageEvent) {
      ids.push((e as any).runtimeStageId);
    },
  } as Recorder);
  return ids;
}

describe('runtimeStageId integration', () => {
  it('linear chain — sequential unique indices', async () => {
    const chart = flowChart(
      'A',
      async (s) => {
        s.a = 1;
      },
      'stage-a',
    )
      .addFunction(
        'B',
        async (s) => {
          s.b = 2;
        },
        'stage-b',
      )
      .addFunction(
        'C',
        async (s) => {
          s.c = 3;
        },
        'stage-c',
      )
      .build();

    const exec = new FlowChartExecutor(chart);
    const ids = captureRuntimeIds(exec);
    await exec.run();

    expect(ids).toEqual(['stage-a#0', 'stage-b#1', 'stage-c#2']);
    // All unique
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('loop — same stageId, different execution indices', async () => {
    let count = 0;
    const chart = flowChart(
      'Init',
      async (s) => {
        s.n = 0;
      },
      'init',
    )
      .addFunction(
        'Step',
        async (s) => {
          s.n = s.n + 1;
          count++;
        },
        'step',
      )
      .addFunction(
        'Guard',
        async (s) => {
          if (count >= 3) s.$break();
        },
        'guard',
      )
      .loopTo('step')
      .build();

    const exec = new FlowChartExecutor(chart);
    const ids = captureRuntimeIds(exec);
    await exec.run();

    // 'step' appears 3 times with different indices
    const stepIds = ids.filter((id) => id.startsWith('step#'));
    expect(stepIds).toHaveLength(3);
    expect(new Set(stepIds).size).toBe(3); // all unique
    // Indices are monotonically increasing
    const stepIndices = stepIds.map((id) => parseInt(id.split('#')[1]));
    for (let i = 1; i < stepIndices.length; i++) {
      expect(stepIndices[i]).toBeGreaterThan(stepIndices[i - 1]);
    }
  });

  it('decider — branch stages have unique indices', async () => {
    const chart = flowChart(
      'Start',
      async (s) => {
        s.x = 1;
      },
      'start',
    )
      .addDeciderFunction('Decide', async () => 'yes', 'decide')
      .addFunctionBranch(
        'yes',
        'Yes',
        async (s) => {
          s.answer = 'yes';
        },
        'yes-branch',
      )
      .addFunctionBranch(
        'no',
        'No',
        async (s) => {
          s.answer = 'no';
        },
        'no-branch',
      )
      .setDefault('yes')
      .end()
      .build();

    const exec = new FlowChartExecutor(chart);
    const ids = captureRuntimeIds(exec);
    await exec.run();

    // start, decide, yes-branch — all unique indices
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toMatch(/^start#\d+$/);
    expect(ids[1]).toMatch(/^decide#\d+$/);
    // Branch ID becomes the stageId
    expect(ids[2]).toMatch(/^yes#\d+$/);
  });

  it('subflow — inner stages have subflow prefix in stageId', async () => {
    const inner = flowChart(
      'Inner',
      async (s) => {
        s.inner = true;
      },
      'inner-stage',
    ).build();

    const chart = flowChart(
      'Outer',
      async (s) => {
        s.outer = true;
      },
      'outer-stage',
    )
      .addSubFlowChart('sf-test', inner, 'TestSubflow')
      .addFunction(
        'After',
        async (s) => {
          s.done = true;
        },
        'after-stage',
      )
      .build();

    const exec = new FlowChartExecutor(chart);
    const ids = captureRuntimeIds(exec);
    await exec.run();

    expect(ids[0]).toBe('outer-stage#0');
    // Subflow stage has sf- prefix from builder
    expect(ids[1]).toMatch(/sf-test\/inner-stage#\d+/);
    expect(ids[2]).toBe('after-stage#2');
    // Counter continues across subflow boundary
    const indices = ids.map((id) => parseInt(id.split('#')[1]));
    expect(indices[0]).toBeLessThan(indices[1]);
    expect(indices[1]).toBeLessThan(indices[2]);
  });

  it('all runtimeStageIds are globally unique within a run', async () => {
    let count = 0;
    const inner = flowChart(
      'Inner',
      async (s) => {
        s.v = 1;
      },
      'inner',
    ).build();

    const chart = flowChart(
      'Init',
      async (s) => {
        s.n = 0;
      },
      'init',
    )
      .addSubFlowChart('sf', inner, 'SF')
      .addFunction(
        'Process',
        async (s) => {
          s.n = s.n + 1;
          count++;
        },
        'process',
      )
      .addFunction(
        'Guard',
        async (s) => {
          if (count >= 2) s.$break();
        },
        'guard',
      )
      .loopTo('process')
      .build();

    const exec = new FlowChartExecutor(chart);
    const ids = captureRuntimeIds(exec);
    await exec.run();

    // Every single runtimeStageId is unique
    expect(new Set(ids).size).toBe(ids.length);
    // Indices are strictly increasing
    const indices = ids.map((id) => parseInt(id.split('#').pop()!));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });
});

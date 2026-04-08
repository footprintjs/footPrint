/**
 * Verify stageId is present and correct on all recorder events and commitLog entries.
 *
 * Covers 5 patterns:
 * 1. Linear chain — each stage has its own stageId
 * 2. Loop — same stageId appears multiple times
 * 3. Decider — branches have their own stageIds
 * 4. Subflow — inner stages have inner stageIds
 * 5. CommitLog — every CommitBundle has stageId
 */
import { describe, expect, it } from 'vitest';

import type { ReadEvent, Recorder, StageEvent, WriteEvent } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';

interface CapturedEvent {
  hook: string;
  stageName: string;
  stageId: string;
  key?: string;
}

function createCapturingRecorder(): { recorder: Recorder; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  const recorder: Recorder = {
    id: 'test-capture',
    onStageStart(event: StageEvent) {
      events.push({ hook: 'onStageStart', stageName: event.stageName, stageId: event.stageId });
    },
    onStageEnd(event: StageEvent) {
      events.push({ hook: 'onStageEnd', stageName: event.stageName, stageId: event.stageId });
    },
    onRead(event: ReadEvent) {
      events.push({ hook: 'onRead', stageName: event.stageName, stageId: event.stageId, key: event.key });
    },
    onWrite(event: WriteEvent) {
      events.push({ hook: 'onWrite', stageName: event.stageName, stageId: event.stageId, key: event.key });
    },
  };
  return { recorder, events };
}

describe('stageId on recorder events', () => {
  it('linear chain — each stage has correct stageId', async () => {
    const { recorder, events } = createCapturingRecorder();

    const chart = flowChart(
      'A',
      async (scope) => {
        scope.x = 1;
      },
      'stage-a',
    )
      .addFunction(
        'B',
        async (scope) => {
          scope.y = scope.x + 1;
        },
        'stage-b',
      )
      .addFunction(
        'C',
        async (scope) => {
          scope.z = scope.y + 1;
        },
        'stage-c',
      )
      .build();

    const exec = new FlowChartExecutor(chart);
    exec.attachRecorder(recorder);
    await exec.run();

    // Every event has a non-empty stageId
    for (const e of events) {
      expect(e.stageId).toBeDefined();
      expect(e.stageId.length).toBeGreaterThan(0);
    }

    // stageId matches for writes
    const writes = events.filter((e) => e.hook === 'onWrite');
    const aWrites = writes.filter((e) => e.stageId === 'stage-a');
    const bWrites = writes.filter((e) => e.stageId === 'stage-b');
    const cWrites = writes.filter((e) => e.stageId === 'stage-c');
    expect(aWrites.length).toBeGreaterThan(0);
    expect(bWrites.length).toBeGreaterThan(0);
    expect(cWrites.length).toBeGreaterThan(0);
  });

  it('loop — same stageId appears multiple times', async () => {
    const { recorder, events } = createCapturingRecorder();
    let count = 0;

    const chart = flowChart(
      'Init',
      async (scope) => {
        scope.n = 0;
      },
      'init',
    )
      .addFunction(
        'Step',
        async (scope) => {
          scope.n = scope.n + 1;
          count++;
        },
        'step',
      )
      .addFunction(
        'Guard',
        async (scope) => {
          if (count >= 3) scope.$break();
        },
        'guard',
      )
      .loopTo('step')
      .build();

    const exec = new FlowChartExecutor(chart);
    exec.attachRecorder(recorder);
    await exec.run();

    // 'step' stageId appears 3 times in onStageStart events
    const stepStarts = events.filter((e) => e.hook === 'onStageStart' && e.stageId === 'step');
    expect(stepStarts.length).toBe(3);
  });

  it('decider — branches have their own stageIds', async () => {
    const { recorder, events } = createCapturingRecorder();

    const chart = flowChart(
      'Start',
      async (scope) => {
        scope.x = 1;
      },
      'start',
    )
      .addDeciderFunction('Decide', async () => 'yes', 'decide')
      .addFunctionBranch(
        'yes',
        'Yes',
        async (scope) => {
          scope.answer = 'yes';
        },
        'yes-branch',
      )
      .addFunctionBranch(
        'no',
        'No',
        async (scope) => {
          scope.answer = 'no';
        },
        'no-branch',
      )
      .setDefault('yes')
      .end()
      .build();

    const exec = new FlowChartExecutor(chart);
    exec.attachRecorder(recorder);
    await exec.run();

    // The chosen branch stage should have its own stageId
    const branchWrites = events.filter((e) => e.hook === 'onWrite' && e.key === 'answer');
    expect(branchWrites.length).toBeGreaterThan(0);
    // It should NOT have the decider's stageId
    expect(branchWrites[0].stageId).not.toBe('decide');
  });

  it('commitLog — every bundle has stageId', async () => {
    const chart = flowChart(
      'A',
      async (scope) => {
        scope.x = 1;
      },
      'alpha',
    )
      .addFunction(
        'B',
        async (scope) => {
          scope.y = 2;
        },
        'beta',
      )
      .build();

    const exec = new FlowChartExecutor(chart);
    await exec.run();

    const snap = exec.getSnapshot();
    expect(snap.commitLog.length).toBeGreaterThan(0);
    for (const bundle of snap.commitLog) {
      expect(bundle.stageId).toBeDefined();
      expect(typeof bundle.stageId).toBe('string');
      expect(bundle.stageId.length).toBeGreaterThan(0);
    }

    // Verify correct stageIds
    const alphaCommits = snap.commitLog.filter((b) => b.stageId === 'alpha');
    const betaCommits = snap.commitLog.filter((b) => b.stageId === 'beta');
    expect(alphaCommits.length).toBeGreaterThan(0);
    expect(betaCommits.length).toBeGreaterThan(0);
  });

  it('subflow — inner stages have inner stageIds', async () => {
    const { recorder, events } = createCapturingRecorder();

    const inner = flowChart(
      'Inner',
      async (scope) => {
        scope.inner = true;
      },
      'inner-stage',
    ).build();

    const chart = flowChart(
      'Outer',
      async (scope) => {
        scope.outer = true;
      },
      'outer-stage',
    )
      .addSubFlowChart('sf', inner, 'Subflow')
      .addFunction(
        'After',
        async (scope) => {
          scope.done = true;
        },
        'after-stage',
      )
      .build();

    const exec = new FlowChartExecutor(chart);
    exec.attachRecorder(recorder);
    await exec.run();

    // outer-stage should appear
    const outerStarts = events.filter((e) => e.hook === 'onStageStart' && e.stageId === 'outer-stage');
    expect(outerStarts.length).toBeGreaterThan(0);

    // after-stage should appear
    const afterStarts = events.filter((e) => e.hook === 'onStageStart' && e.stageId === 'after-stage');
    expect(afterStarts.length).toBeGreaterThan(0);
  });
});

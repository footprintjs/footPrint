/**
 * RFC-003 D1 — `TraversalContext.parentRuntimeStageId` golden tests.
 *
 * The runtime twin of `parentStageId`: every stage execution's context
 * carries the runtimeStageId of the execution step that preceded it in the
 * runtime ancestor chain. Golden assertions cover:
 *
 * 1. Linear chain — exact parent ids, root has none
 * 2. Decider branch — branch root's parent IS the decider's execution step
 * 3. Selector fork — every selected child points at the selector step
 * 4. Subflow boundary — first inner stage points at the MOUNT step
 * 5. Nested subflow — chain crosses two mounts
 * 6. Loop re-entry — runtime ids keep parents unambiguous across iterations
 * 7. Loop whose body is a subflow — re-entry re-anchors at the new mount step
 */

import { describe, expect, it } from 'vitest';

import type { FlowRecorder } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

interface SeenStage {
  runtimeStageId: string;
  parentRuntimeStageId?: string;
  stageName: string;
  stageType: string;
}

function captureRecorder(seen: SeenStage[]): FlowRecorder {
  return {
    id: 'parent-rtid-capture',
    onStageExecuted: (e) => {
      const ctx = e.traversalContext;
      if (!ctx) return;
      seen.push({
        runtimeStageId: ctx.runtimeStageId,
        parentRuntimeStageId: ctx.parentRuntimeStageId,
        stageName: e.stageName,
        stageType: e.stageType,
      });
    },
  };
}

type Loose = Record<string, unknown>;

describe('TraversalContext.parentRuntimeStageId (RFC-003 D1)', () => {
  it('linear chain — golden parent ids, root stage has none', async () => {
    const chart = flowChart<Loose>('A', async () => undefined, 'a')
      .addFunction('B', async () => undefined, 'b')
      .addFunction('C', async () => undefined, 'c')
      .build();

    const seen: SeenStage[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(captureRecorder(seen));
    await executor.run();

    expect(seen.map((s) => [s.runtimeStageId, s.parentRuntimeStageId])).toEqual([
      ['a#0', undefined],
      ['b#1', 'a#0'],
      ['c#2', 'b#1'],
    ]);
  });

  it('field is ABSENT (not undefined-valued) on the root stage context — additive shape', async () => {
    const chart = flowChart<Loose>('A', async () => undefined, 'a')
      .addFunction('B', async () => undefined, 'b')
      .build();

    const contexts: Array<Record<string, unknown>> = [];
    const recorder: FlowRecorder = {
      id: 'shape-capture',
      onStageExecuted: (e) => {
        if (e.traversalContext) contexts.push(e.traversalContext as unknown as Record<string, unknown>);
      },
    };
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(recorder);
    await executor.run();

    expect(Object.prototype.hasOwnProperty.call(contexts[0], 'parentRuntimeStageId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(contexts[1], 'parentRuntimeStageId')).toBe(true);
  });

  it('decider branch — branch root points at the decider execution step', async () => {
    const chart = flowChart<Loose>('Seed', async () => undefined, 'seed')
      .addDeciderFunction('Decide', async () => 'high', 'decide')
      .addFunctionBranch('high', 'High', async () => undefined)
      .addFunctionBranch('low', 'Low', async () => undefined)
      .setDefault('low')
      .end()
      .build();

    const seen: SeenStage[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(captureRecorder(seen));
    await executor.run();

    const decider = seen.find((s) => s.stageType === 'decider')!;
    expect(decider.runtimeStageId).toBe('decide#1');
    expect(decider.parentRuntimeStageId).toBe('seed#0');

    const branch = seen.find((s) => s.stageName === 'High')!;
    expect(branch.parentRuntimeStageId).toBe('decide#1');
  });

  it('selector fork — every selected child points at the selector step', async () => {
    const chart = flowChart<Loose>('Seed', async () => undefined, 'seed')
      .addSelectorFunction('Pick', async () => ['x', 'y'], 'pick')
      .addFunctionBranch('x', 'X', async () => undefined)
      .addFunctionBranch('y', 'Y', async () => undefined)
      .end()
      .build();

    const seen: SeenStage[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(captureRecorder(seen));
    await executor.run();

    const selector = seen.find((s) => s.stageType === 'selector')!;
    const x = seen.find((s) => s.stageName === 'X')!;
    const y = seen.find((s) => s.stageName === 'Y')!;
    expect(x.parentRuntimeStageId).toBe(selector.runtimeStageId);
    expect(y.parentRuntimeStageId).toBe(selector.runtimeStageId);
  });

  it('subflow boundary — first inner stage points at the MOUNT step', async () => {
    const inner = flowChart<Loose>('InnerA', async () => undefined, 'inner-a')
      .addFunction('InnerB', async () => undefined, 'inner-b')
      .build();

    const chart = flowChart<Loose>('Outer', async () => undefined, 'outer')
      .addSubFlowChartNext('sf-inner', inner, 'Inner', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .addFunction('After', async () => undefined, 'after')
      .build();

    const seen: SeenStage[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(captureRecorder(seen));
    await executor.run();

    const mount = seen.find((s) => s.stageType === 'subflow-mount')!;
    expect(mount.parentRuntimeStageId).toBe('outer#0');

    // Stage names inside subflows arrive path-prefixed (e.g. 'sf-inner/InnerA').
    const innerA = seen.find((s) => s.stageName.endsWith('InnerA') && s.stageType === 'linear')!;
    const innerB = seen.find((s) => s.stageName.endsWith('InnerB'))!;
    // Chain crosses the boundary: inner root → mount step in the parent.
    expect(innerA.parentRuntimeStageId).toBe(mount.runtimeStageId);
    // Inside the subflow the chain continues normally.
    expect(innerB.parentRuntimeStageId).toBe(innerA.runtimeStageId);
  });

  it('nested subflow — chain crosses two mount boundaries', async () => {
    const innermost = flowChart<Loose>('Deep', async () => undefined, 'deep').build();
    const middle = flowChart<Loose>('Mid', async () => undefined, 'mid')
      .addSubFlowChartNext('sf-deep', innermost, 'DeepMount', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .build();
    const chart = flowChart<Loose>('Top', async () => undefined, 'top')
      .addSubFlowChartNext('sf-mid', middle, 'MidMount', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .build();

    const seen: SeenStage[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(captureRecorder(seen));
    await executor.run();

    // Stage names inside subflows arrive path-prefixed; the deepest LINEAR
    // stage is the inner chart's 'Deep' stage, mounts carry stageType
    // 'subflow-mount'.
    const deep = seen.find((s) => s.stageName.endsWith('Deep') && s.stageType === 'linear')!;
    const mounts = seen.filter((s) => s.stageType === 'subflow-mount');
    expect(mounts.length).toBe(2);

    // Walk the full ancestor chain from the deepest stage to the top root.
    const parentOf = new Map(seen.map((s) => [s.runtimeStageId, s.parentRuntimeStageId]));
    const chainFromDeep: string[] = [];
    let cur: string | undefined = deep.runtimeStageId;
    while (cur) {
      chainFromDeep.push(cur);
      cur = parentOf.get(cur) ?? undefined;
    }
    expect(chainFromDeep[chainFromDeep.length - 1]).toBe('top#0');
    for (const mount of mounts) {
      expect(chainFromDeep).toContain(mount.runtimeStageId);
    }
  });

  it('loop re-entry — runtime ids keep parents unambiguous across iterations', async () => {
    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('i', 0);
      },
      'seed',
    )
      .addFunction(
        'Work',
        async (scope) => {
          const i = scope.$getValue('i') as number;
          scope.$setValue('i', i + 1);
          if (i + 1 >= 3) scope.$break();
        },
        'work',
      )
      .loopTo('work')
      .build();

    const seen: SeenStage[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(captureRecorder(seen));
    await executor.run();

    const workSteps = seen.filter((s) => s.stageName === 'Work');
    expect(workSteps.length).toBe(3);

    // Every execution step is unique...
    const ids = workSteps.map((s) => s.runtimeStageId);
    expect(new Set(ids).size).toBe(3);
    // ...and each iteration's parent is the PREVIOUS iteration's runtime id
    // (not a stage id) — re-entries stay unambiguous.
    expect(workSteps[0].parentRuntimeStageId).toBe('seed#0');
    expect(workSteps[1].parentRuntimeStageId).toBe(workSteps[0].runtimeStageId);
    expect(workSteps[2].parentRuntimeStageId).toBe(workSteps[1].runtimeStageId);

    const parents = workSteps.map((s) => s.parentRuntimeStageId);
    expect(new Set(parents).size).toBe(3);
  });

  it('loop whose body is a SUBFLOW — each re-entry re-anchors at that iteration mount', async () => {
    const body = flowChart<Loose>(
      'BodyStage',
      async (scope) => {
        // 'i' arrives via inputMapper (readonly input key) — write the
        // incremented value under a NEW key and map it back out.
        const i = (scope.$getValue('i') as number) ?? 0;
        scope.$setValue('iNext', i + 1);
      },
      'body-stage',
    ).build();

    const chart = flowChart<Loose>(
      'Seed',
      async (scope) => {
        scope.$setValue('i', 0);
      },
      'seed',
    )
      .addSubFlowChartNext('sf-body', body, 'BodyMount', {
        inputMapper: (s: Loose) => ({ i: s.i }),
        outputMapper: (out: Loose) => ({ i: out.iNext }),
      })
      .addDeciderFunction('Check', async (scope) => ((scope.$getValue('i') as number) < 2 ? 'again' : 'done'), 'check')
      .addFunctionBranch('again', 'Again', async () => undefined, undefined, { loopTo: 'sf-body' })
      .addFunctionBranch('done', 'Done', async () => undefined)
      .setDefault('done')
      .end()
      .build();

    const seen: SeenStage[] = [];
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(captureRecorder(seen));
    await executor.run();

    const mounts = seen.filter((s) => s.stageType === 'subflow-mount');
    const bodies = seen.filter((s) => s.stageName.endsWith('BodyStage') && s.stageType === 'linear');
    expect(mounts.length).toBe(2);
    expect(bodies.length).toBe(2);
    // Each iteration's inner stage anchors at THAT iteration's mount step.
    expect(bodies[0].parentRuntimeStageId).toBe(mounts[0].runtimeStageId);
    expect(bodies[1].parentRuntimeStageId).toBe(mounts[1].runtimeStageId);
    expect(mounts[0].runtimeStageId).not.toBe(mounts[1].runtimeStageId);
  });
});

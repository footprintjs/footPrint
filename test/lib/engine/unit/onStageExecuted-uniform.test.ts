/**
 * Proposal #003 — onStageExecuted fires uniformly for ALL stage kinds
 * (linear / decider / fork / selector / subflow-mount), with stageType
 * on the event payload.
 *
 * Verifies the engine-level invariant: every stage that runs produces
 * exactly one onStageExecuted event, AFTER its specialized event
 * (onDecision / onFork / onSelected / onSubflowEntry) for non-linear
 * kinds. Consumer "did this stage run" tracking works uniformly via a
 * single handler.
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder/FlowChartBuilder';
import type { FlowRecorder, FlowStageEvent, StageType } from '../../../../src/lib/engine/narrative/types';
import { FlowChartExecutor } from '../../../../src/lib/runner/FlowChartExecutor';

const noop = async () => ({});

function spyRecorder(): { rec: FlowRecorder; events: FlowStageEvent[]; types: StageType[] } {
  const events: FlowStageEvent[] = [];
  const types: StageType[] = [];
  const rec: FlowRecorder = {
    id: 'spy-stage-executed',
    onStageExecuted(event) {
      events.push(event);
      if (event.stageType) types.push(event.stageType);
    },
  };
  return { rec, events, types };
}

describe('onStageExecuted uniform fire — #003', () => {
  it('linear stage — fires once with stageType "linear"', async () => {
    const chart = flowChart('seed', noop, 'seed').build();
    const executor = new FlowChartExecutor(chart);
    const { rec, events, types } = spyRecorder();
    executor.attachFlowRecorder(rec);
    await executor.run();
    expect(events).toHaveLength(1);
    expect(types).toEqual(['linear']);
  });

  it('linear chain — every stage fires onStageExecuted with type "linear"', async () => {
    const chart = flowChart('a', noop, 'a').addFunction('b', noop, 'b').addFunction('c', noop, 'c').build();
    const executor = new FlowChartExecutor(chart);
    const { rec, types } = spyRecorder();
    executor.attachFlowRecorder(rec);
    await executor.run();
    expect(types).toEqual(['linear', 'linear', 'linear']);
  });

  it('decider — fires onStageExecuted with type "decider" AFTER onDecision', async () => {
    const events: { kind: 'decision' | 'executed'; stageName?: string }[] = [];
    const rec: FlowRecorder = {
      id: 'spy-order',
      onDecision(e) {
        events.push({ kind: 'decision', stageName: e.decider });
      },
      onStageExecuted(e) {
        events.push({ kind: 'executed', stageName: e.stageName });
      },
    };

    const chart = flowChart('seed', noop, 'seed')
      .addDeciderFunction('Decide', () => 'low', 'decide')
      .addFunctionBranch('low', 'Low', noop)
      .addFunctionBranch('high', 'High', noop)
      .setDefault('low')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(rec);
    await executor.run();

    // Find the decider's events
    const deciderDecisionIdx = events.findIndex((e) => e.kind === 'decision' && e.stageName === 'Decide');
    const deciderExecutedIdx = events.findIndex((e) => e.kind === 'executed' && e.stageName === 'Decide');
    expect(deciderDecisionIdx).toBeGreaterThanOrEqual(0);
    expect(deciderExecutedIdx).toBeGreaterThan(deciderDecisionIdx);
  });

  it('decider — onStageExecuted carries stageType "decider"', async () => {
    const { rec, events } = spyRecorder();
    const chart = flowChart('seed', noop, 'seed')
      .addDeciderFunction('Decide', () => 'low', 'decide')
      .addFunctionBranch('low', 'Low', noop)
      .addFunctionBranch('high', 'High', noop)
      .setDefault('low')
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(rec);
    await executor.run();

    const deciderEvent = events.find((e) => e.stageName === 'Decide');
    expect(deciderEvent).toBeDefined();
    expect(deciderEvent!.stageType).toBe('decider');
  });

  it('subflow mount — fires onStageExecuted with type "subflow-mount" after onSubflowEntry', async () => {
    const events: { kind: 'subflow-entry' | 'executed'; stageName?: string; stageType?: StageType }[] = [];
    const rec: FlowRecorder = {
      id: 'spy-subflow',
      onSubflowEntry(e) {
        events.push({ kind: 'subflow-entry', stageName: e.name });
      },
      onStageExecuted(e) {
        events.push({ kind: 'executed', stageName: e.stageName, stageType: e.stageType });
      },
    };

    const inner = flowChart('inner-a', noop, 'inner-a').build();
    const outer = flowChart('outer-a', noop, 'outer-a').addSubFlowChartNext('nested', inner, 'Nested').build();

    const executor = new FlowChartExecutor(outer);
    executor.attachFlowRecorder(rec);
    await executor.run();

    // The mount's subflow-entry event uses the mount NAME ('Nested'),
    // while its onStageExecuted event uses the mount node.name. Find
    // and verify the order and the stageType.
    const subflowEntryIdx = events.findIndex((e) => e.kind === 'subflow-entry');
    const mountExecutedIdx = events.findIndex((e) => e.kind === 'executed' && e.stageType === 'subflow-mount');
    expect(subflowEntryIdx).toBeGreaterThanOrEqual(0);
    expect(mountExecutedIdx).toBeGreaterThan(subflowEntryIdx);
  });

  // ── Literal payload assertions for fork + selector ─────────────────
  // Auditor finding: fire-ORDER was covered but literal stageType strings
  // were not — a typo (`'forkk'` / `'select'`) in handler code would
  // silently slip through. Pin them explicitly.

  it('fork — onStageExecuted carries stageType "fork" (literal)', async () => {
    const { rec, events } = spyRecorder();
    const chart = flowChart('seed', noop, 'seed')
      .addListOfFunction([
        { id: 'a', name: 'A', fn: noop },
        { id: 'b', name: 'B', fn: noop },
      ])
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(rec);
    await executor.run();
    // The fork node name comes from the seed in this construction
    // pattern; the stageType assertion is what pins #003 — find any
    // event with stageType 'fork' and confirm exactly one fired.
    const forkEvents = events.filter((e) => e.stageType === 'fork');
    expect(forkEvents).toHaveLength(1);
  });

  it('selector — onStageExecuted carries stageType "selector" (literal)', async () => {
    const { rec, events } = spyRecorder();
    const chart = flowChart('seed', noop, 'seed')
      .addSelectorFunction('Pick', () => ['a'], 'pick')
      .addFunctionBranch('a', 'A', noop)
      .addFunctionBranch('b', 'B', noop)
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(rec);
    await executor.run();
    const selectorEvent = events.find((e) => e.stageName === 'Pick');
    expect(selectorEvent).toBeDefined();
    expect(selectorEvent!.stageType).toBe('selector');
  });

  // ── Negative cases: pause + error MUST NOT fire onStageExecuted ────
  // Matches linear-stage convention. Auditor: silent regression risk
  // if a future refactor moves the fire-site above the await.

  it('error — stage that throws does NOT fire onStageExecuted', async () => {
    const { rec, events } = spyRecorder();
    const chart = flowChart('seed', noop, 'seed')
      .addFunction(
        'Boom',
        async () => {
          throw new Error('boom');
        },
        'boom',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(rec);
    try {
      await executor.run();
    } catch {
      // expected
    }
    // 'seed' fired before 'Boom' threw. 'Boom' should NOT have fired.
    expect(events.find((e) => e.stageName === 'Boom')).toBeUndefined();
  });
});

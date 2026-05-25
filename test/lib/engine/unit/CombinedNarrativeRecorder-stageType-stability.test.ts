/**
 * Proposal #003 — CombinedNarrativeRecorder byte-stability check.
 *
 * After #003, the engine fires onStageExecuted UNIFORMLY for every
 * stage kind (linear/decider/fork/selector/subflow-mount). The
 * CombinedNarrativeRecorder gates `onStageExecuted` to linear-only
 * so its narrative output stays byte-stable (decider/fork/selector
 * stage headers and ops flush are emitted by the specialized
 * `onDecision`/`onFork`/`onSelected`/`onSubflowEntry` handlers,
 * preserving the v5 behavior).
 *
 * This file pins that contract: for a chart with every stage kind,
 * no narrative-entry double-emission occurs.
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder/FlowChartBuilder';
import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/CombinedNarrativeRecorder';
import { FlowChartExecutor } from '../../../../src/lib/runner/FlowChartExecutor';

const noop = async () => ({});

describe('CombinedNarrativeRecorder — #003 byte-stability', () => {
  it('decider stage produces exactly ONE stage entry (no double-emit from uniform onStageExecuted)', async () => {
    const chart = flowChart('seed', noop, 'seed')
      .addDeciderFunction('Decide', () => 'low', 'decide')
      .addFunctionBranch('low', 'Low', noop)
      .addFunctionBranch('high', 'High', noop)
      .setDefault('low')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    const rec = new CombinedNarrativeRecorder();
    executor.attachCombinedRecorder(rec);
    await executor.run();

    const entries = rec.getEntries();
    // Decider stage 'Decide' must appear in EXACTLY ONE 'stage' entry,
    // not two. Pre-#003 path was onDecision → emit stage + flush ops +
    // emit condition. Post-#003 the same single emission persists
    // because onStageExecuted is gated to linear-only here.
    const deciderStageEntries = entries.filter((e) => e.type === 'stage' && e.stageName === 'Decide');
    expect(deciderStageEntries).toHaveLength(1);

    // The condition entry that explains the chosen branch is still
    // emitted exactly once (depth 1).
    const conditionEntries = entries.filter((e) => e.type === 'condition');
    expect(conditionEntries).toHaveLength(1);
    expect(conditionEntries[0]!.depth).toBe(1);
  });

  it('fork stage produces exactly ONE fork entry (no doubling)', async () => {
    const chart = flowChart('seed', noop, 'seed')
      .addListOfFunction([
        { id: 'a', name: 'A', fn: noop },
        { id: 'b', name: 'B', fn: noop },
      ])
      .build();

    const executor = new FlowChartExecutor(chart);
    const rec = new CombinedNarrativeRecorder();
    executor.attachCombinedRecorder(rec);
    await executor.run();

    const entries = rec.getEntries();
    const forkEntries = entries.filter((e) => e.type === 'fork');
    expect(forkEntries).toHaveLength(1);
  });

  it('subflow mount produces exactly ONE subflow-entry boundary (no doubling)', async () => {
    const inner = flowChart('inner-seed', noop, 'inner-seed').build();
    const outer = flowChart('outer-seed', noop, 'outer-seed').addSubFlowChartNext('sub', inner, 'Sub').build();

    const executor = new FlowChartExecutor(outer);
    const rec = new CombinedNarrativeRecorder();
    executor.attachCombinedRecorder(rec);
    await executor.run();

    const entries = rec.getEntries();
    const subflowEntries = entries.filter((e) => e.type === 'subflow' && e.direction === 'entry');
    expect(subflowEntries).toHaveLength(1);
  });
});

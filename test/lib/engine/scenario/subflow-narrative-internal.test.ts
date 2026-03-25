/**
 * Scenario test: Subflow internal narrative events.
 *
 * Validates that SubflowExecutor fires the same narrative events as
 * FlowchartTraverser — onStageExecuted, onNext, onBreak — so that
 * CombinedNarrativeRecorder captures subflow-internal detail, not just
 * entry/exit markers.
 *
 * These tests verify the fix where SubflowExecutor was missing narrative
 * event calls that the main traverser fires, causing getNarrativeEntries()
 * to contain only "Entering/Exiting" markers for subflows with no internal
 * stage entries.
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor, getSubtreeSnapshot } from '../../../../src/lib/runner';

const noopScope = () => ({});

describe('Scenario: Subflow internal narrative events', () => {
  it('subflow stages produce onStageExecuted entries in getNarrativeEntries()', async () => {
    const subChart = flowChart('SubStageA', () => {}, 'sub-a', undefined, 'First subflow stage')
      .addFunction('SubStageB', () => {}, 'sub-b', 'Second subflow stage')
      .build();

    const chart = flowChart('Parent', () => {}, 'parent')
      .addSubFlowChartNext('sf-test', subChart, 'TestSubflow')
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    executor.enableNarrative();
    await executor.run();

    const entries = executor.getNarrativeEntries();

    // Should have subflow entry marker
    const entryMarker = entries.find((e) => e.type === 'subflow' && e.text.toLowerCase().includes('entering'));
    expect(entryMarker).toBeDefined();

    // Should have subflow exit marker
    const exitMarker = entries.find((e) => e.type === 'subflow' && e.text.toLowerCase().includes('exiting'));
    expect(exitMarker).toBeDefined();

    // KEY ASSERTION: Should have internal stage entries between entry/exit
    const stageEntries = entries.filter((e) => e.type === 'stage');
    // Parent + SubStageA + SubStageB = at least 3 stage entries
    expect(stageEntries.length).toBeGreaterThanOrEqual(3);

    // Subflow internal stages should be present by name
    const stageNames = stageEntries.map((e) => e.stageName).filter(Boolean);
    const hasSubStageA = stageNames.some((n) => n?.includes('SubStageA'));
    const hasSubStageB = stageNames.some((n) => n?.includes('SubStageB'));
    expect(hasSubStageA).toBe(true);
    expect(hasSubStageB).toBe(true);
  });

  it('subflow linear continuation produces onNext entries', async () => {
    const subChart = flowChart('Step1', () => {}, 'step-1')
      .addFunction('Step2', () => {}, 'step-2')
      .addFunction('Step3', () => {}, 'step-3')
      .build();

    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('sf-linear', subChart, 'LinearSubflow')
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();

    // The narrative should mention transitions between subflow stages
    const entries = executor.getNarrativeEntries();

    // Count stage entries from subflow (Step1, Step2, Step3)
    const subflowStageEntries = entries.filter(
      (e) => e.type === 'stage' && e.stageName && /Step[123]/.test(e.stageName),
    );
    expect(subflowStageEntries.length).toBe(3);

    // Flow narrative should contain next-step references
    const flowNarrative = executor.getFlowNarrative();
    expect(flowNarrative.length).toBeGreaterThan(0);

    // Should mention Step2 and Step3 as destinations (from onNext calls)
    const mentionsStep2 = flowNarrative.some((s) => s.includes('Step2'));
    const mentionsStep3 = flowNarrative.some((s) => s.includes('Step3'));
    expect(mentionsStep2).toBe(true);
    expect(mentionsStep3).toBe(true);
  });

  it('subflow break produces onBreak entry and stops execution', async () => {
    const order: string[] = [];

    const subChart = flowChart(
      'BeforeBreak',
      (_scope: any, breakPipeline: () => void) => {
        order.push('BeforeBreak');
        breakPipeline();
      },
      'before-break',
    )
      .addFunction(
        'AfterBreak',
        () => {
          order.push('AfterBreak');
        },
        'after-break',
      )
      .build();

    const chart = flowChart('Start', () => {}, 'start')
      .addSubFlowChartNext('sf-break', subChart, 'BreakSubflow')
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    executor.enableNarrative();
    await executor.run();

    // AfterBreak should NOT have executed
    expect(order).toEqual(['BeforeBreak']);

    // Narrative should contain a break entry
    const entries = executor.getNarrativeEntries();
    const breakEntry = entries.find((e) => e.type === 'break');
    expect(breakEntry).toBeDefined();
    expect(breakEntry!.text.toLowerCase()).toContain('break');
  });

  it('getNarrativeEntries() includes subflow internal entries between Entering/Exiting markers', async () => {
    const subChart = flowChart('InnerWork', () => {}, 'inner-work', undefined, 'Does the work')
      .addFunction('InnerFinish', () => {}, 'inner-finish', 'Wraps up')
      .build();

    const chart = flowChart('Outer', () => {}, 'outer')
      .addSubFlowChartNext('sf-check', subChart, 'CheckSubflow')
      .addFunction('Final', () => {}, 'final')
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    executor.enableNarrative();
    await executor.run();

    const entries = executor.getNarrativeEntries();

    // Find the entering/exiting indices
    const enterIdx = entries.findIndex((e) => e.type === 'subflow' && e.text.toLowerCase().includes('entering'));
    const exitIdx = entries.findIndex((e) => e.type === 'subflow' && e.text.toLowerCase().includes('exiting'));

    expect(enterIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThan(enterIdx);

    // There should be entries BETWEEN entering and exiting (the internal stages)
    const internalEntries = entries.slice(enterIdx + 1, exitIdx);
    expect(internalEntries.length).toBeGreaterThan(0);

    // At least the internal stage entries should be present
    const internalStages = internalEntries.filter((e) => e.type === 'stage');
    expect(internalStages.length).toBeGreaterThanOrEqual(2); // InnerWork + InnerFinish
  });

  it('end-to-end: getSubtreeSnapshot with narrative entries contains subflow internal stages', async () => {
    const subChart = flowChart(
      'Validate',
      (scope: any) => {
        scope.valid = true;
      },
      'validate',
      undefined,
      'Validates input data',
    )
      .addFunction(
        'Transform',
        (scope: any) => {
          scope.transformed = true;
        },
        'transform',
        'Transforms the data',
      )
      .build();

    const chart = flowChart(
      'Ingest',
      (scope: any) => {
        scope.ingested = true;
      },
      'ingest',
    )
      .addSubFlowChartNext('sf-process', subChart, 'ProcessSubflow')
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const snapshot = executor.getSnapshot();
    const allEntries = executor.getNarrativeEntries();

    // Drill into the subflow with scoped narrative
    const subtree = getSubtreeSnapshot(snapshot, 'sf-process', allEntries);
    expect(subtree).toBeDefined();
    expect(subtree!.narrativeEntries).toBeDefined();
    expect(subtree!.narrativeEntries!.length).toBeGreaterThan(0);

    // Scoped narrative should contain internal stage entries (not just entry/exit)
    const scopedStageEntries = subtree!.narrativeEntries!.filter((e) => e.type === 'stage');
    // Validate + Transform = at least 2 internal stage entries
    expect(scopedStageEntries.length).toBeGreaterThanOrEqual(2);

    // Verify the internal stages are named correctly
    const scopedStageNames = scopedStageEntries.map((e) => e.stageName).filter(Boolean);
    const hasValidate = scopedStageNames.some((n) => n?.includes('Validate'));
    const hasTransform = scopedStageNames.some((n) => n?.includes('Transform'));
    expect(hasValidate).toBe(true);
    expect(hasTransform).toBe(true);

    // Full narrative entries should include more than just subflow markers
    const nonSubflowEntries = subtree!.narrativeEntries!.filter((e) => e.type !== 'subflow');
    expect(nonSubflowEntries.length).toBeGreaterThan(0);
  });
});

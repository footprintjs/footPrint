/**
 * Scenario Tests: Narrative Disabled (Zero-Cost)
 *
 * BUSINESS CONTEXT:
 * Production pipelines that don't need narrative should pay zero cost.
 * When enableNarrative() is NOT called, the library uses a NullNarrativeGenerator
 * that performs no allocations, no string formatting, and no array pushes.
 * getNarrative() must return an empty array regardless of pipeline complexity —
 * linear, decider, fork, or selector shapes should all behave identically when
 * narrative is disabled.
 *
 * MODULES INVOLVED:
 * - FlowChartBuilder: Constructs pipelines of varying complexity
 * - FlowChartExecutor: Runs the pipeline WITHOUT enableNarrative()
 * - NullNarrativeGenerator: No-op implementation wired when narrative is disabled
 *
 * KEY BEHAVIORS TESTED:
 * 1. Simple linear pipeline returns empty narrative when disabled
 * 2. Decider pipeline returns empty narrative when disabled
 * 3. Fork pipeline returns empty narrative when disabled
 * 4. Selector pipeline returns empty narrative when disabled
 *
 * _Requirements: 1.2, 2.3_
 */

import { FlowChartBuilder } from '../../src/core/builder/FlowChartBuilder';
import { FlowChartExecutor } from '../../src/core/executor/FlowChartExecutor';
import { StageContext } from '../../src/core/memory/StageContext';
import { ScopeFactory } from '../../src/core/memory/types';

// Simple scope factory — passes the StageContext through unchanged
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

describe('Scenario: Narrative Disabled — Zero-Cost for Production Pipelines', () => {
  /**
   * SCENARIO: Linear pipeline produces empty narrative when disabled
   *
   * GIVEN: A three-stage linear pipeline (A → B → C) where enableNarrative() is NOT called
   * WHEN: The pipeline executes to completion
   * THEN: getNarrative() returns an empty array
   *
   * WHY THIS MATTERS:
   * Requirement 1.2 mandates that when enableNarrative has not been called,
   * the Pipeline shall not generate any Narrative_Sentences and shall not
   * allocate narrative storage. This is the simplest pipeline shape — if
   * narrative leaks here, it leaks everywhere.
   *
   * _Requirements: 1.2, 2.3_
   */
  it('should return empty narrative for a linear pipeline when narrative is not enabled', async () => {
    // GIVEN: A linear pipeline without enableNarrative()
    const chart = new FlowChartBuilder()
      .start('stageA', () => 'a-output', undefined, 'Stage A')
      .addFunction('stageB', () => 'b-output', undefined, 'Stage B')
      .addFunction('stageC', () => 'c-output', undefined, 'Stage C')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    // NOTE: enableNarrative() is intentionally NOT called

    // WHEN: The pipeline runs to completion
    await executor.run();

    // THEN: getNarrative() returns an empty array
    const narrative = executor.getNarrative();
    expect(narrative).toEqual([]);
    expect(narrative).toHaveLength(0);
  });

  /**
   * SCENARIO: Decider pipeline produces empty narrative when disabled
   *
   * GIVEN: A pipeline with a decider node (entry → decider → branch) where
   *        enableNarrative() is NOT called
   * WHEN: The pipeline executes and the decider selects a branch
   * THEN: getNarrative() returns an empty array — no decision sentences leak
   *
   * WHY THIS MATTERS:
   * Decider pipelines are the most narrative-rich shape (they produce
   * rationale sentences). If the NullNarrativeGenerator fails to suppress
   * decision sentences, the zero-cost guarantee is broken.
   *
   * _Requirements: 1.2, 2.3_
   */
  it('should return empty narrative for a decider pipeline when narrative is not enabled', async () => {
    // GIVEN: A decider pipeline without enableNarrative()
    const chart = new FlowChartBuilder()
      .start('entry', (scope: StageContext) => {
        scope.setLog('deciderRationale', 'user is premium');
        scope.set([], 'route', 'premium');
        return 'premium';
      })
      .addDeciderFunction('Decider', (scope) => scope.get([], 'route') as string)
        .addFunctionBranch('premium', 'Premium Path', () => 'premium-result')
        .addFunctionBranch('basic', 'Basic Path', () => 'basic-result')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    // NOTE: enableNarrative() is intentionally NOT called

    // WHEN: The pipeline runs and the decider selects a branch
    await executor.run();

    // THEN: getNarrative() returns an empty array
    const narrative = executor.getNarrative();
    expect(narrative).toEqual([]);
    expect(narrative).toHaveLength(0);
  });

  /**
   * SCENARIO: Fork pipeline produces empty narrative when disabled
   *
   * GIVEN: A pipeline that forks into two subflows where enableNarrative()
   *        is NOT called
   * WHEN: The pipeline executes all children in parallel
   * THEN: getNarrative() returns an empty array — no fork or subflow sentences leak
   *
   * WHY THIS MATTERS:
   * Fork pipelines trigger multiple narrative events (onFork, onSubflowEntry,
   * onStageExecuted for each child, onSubflowExit). If any of these leak
   * through the NullNarrativeGenerator, the zero-cost guarantee is broken.
   *
   * _Requirements: 1.2, 2.3_
   */
  it('should return empty narrative for a fork pipeline when narrative is not enabled', async () => {
    // GIVEN: A fork pipeline without enableNarrative()
    const subflowA = new FlowChartBuilder()
      .start('taskA', () => 'a-result', undefined, 'Task Alpha')
      .build();

    const subflowB = new FlowChartBuilder()
      .start('taskB', () => 'b-result', undefined, 'Task Beta')
      .build();

    const chart = new FlowChartBuilder()
      .start('entry', () => 'ready', undefined, 'Entry')
      .addSubFlowChart('forkA', subflowA, 'Fork Alpha')
      .addSubFlowChart('forkB', subflowB, 'Fork Beta')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    // NOTE: enableNarrative() is intentionally NOT called

    // WHEN: The pipeline runs with parallel children
    await executor.run();

    // THEN: getNarrative() returns an empty array
    const narrative = executor.getNarrative();
    expect(narrative).toEqual([]);
    expect(narrative).toHaveLength(0);
  });

  /**
   * SCENARIO: Selector pipeline produces empty narrative when disabled
   *
   * GIVEN: A pipeline with a selector that picks a subset of children where
   *        enableNarrative() is NOT called
   * WHEN: The pipeline executes the selected children
   * THEN: getNarrative() returns an empty array — no selection sentences leak
   *
   * WHY THIS MATTERS:
   * Selector pipelines trigger onSelected() which produces "X of Y paths
   * were selected" sentences. This must be completely suppressed when
   * narrative is disabled.
   *
   * _Requirements: 1.2, 2.3_
   */
  it('should return empty narrative for a selector pipeline when narrative is not enabled', async () => {
    // GIVEN: A selector pipeline without enableNarrative()
    const chart = new FlowChartBuilder()
      .start('analyze', () => ['email', 'push'], undefined, 'Analyze Preferences')
      .addSelector((out) => out as string[])
        .addFunctionBranch('email', 'Send Email', () => 'email-sent')
        .addFunctionBranch('sms', 'Send SMS', () => 'sms-sent')
        .addFunctionBranch('push', 'Send Push', () => 'push-sent')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    // NOTE: enableNarrative() is intentionally NOT called

    // WHEN: The pipeline runs with selected children
    await executor.run();

    // THEN: getNarrative() returns an empty array
    const narrative = executor.getNarrative();
    expect(narrative).toEqual([]);
    expect(narrative).toHaveLength(0);
  });

  /**
   * SCENARIO: Pipeline still executes correctly when narrative is disabled
   *
   * GIVEN: A linear pipeline where enableNarrative() is NOT called
   * WHEN: The pipeline executes to completion
   * THEN: The pipeline produces correct execution results AND getNarrative()
   *       returns an empty array — disabling narrative does not affect execution
   *
   * WHY THIS MATTERS:
   * The NullNarrativeGenerator must be truly invisible — it should not
   * interfere with normal pipeline execution. This test confirms that
   * the pipeline runs correctly and produces results even when narrative
   * is disabled.
   *
   * _Requirements: 1.2, 2.3_
   */
  it('should execute pipeline correctly while returning empty narrative', async () => {
    // GIVEN: A linear pipeline without enableNarrative()
    const executionLog: string[] = [];

    const chart = new FlowChartBuilder()
      .start('step1', () => {
        executionLog.push('step1');
        return 'one';
      })
      .addFunction('step2', () => {
        executionLog.push('step2');
        return 'two';
      })
      .addFunction('step3', () => {
        executionLog.push('step3');
        return 'three';
      })
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    // NOTE: enableNarrative() is intentionally NOT called

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: All stages executed in order
    expect(executionLog).toEqual(['step1', 'step2', 'step3']);

    // AND: getNarrative() still returns an empty array
    const narrative = executor.getNarrative();
    expect(narrative).toEqual([]);
  });
});

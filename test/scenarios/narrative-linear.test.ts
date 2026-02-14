/**
 * Scenario Tests: Linear Pipeline Narrative
 *
 * BUSINESS CONTEXT:
 * The simplest pipeline shape is a linear chain (A → B → C). When narrative
 * generation is enabled, the library must produce a human-readable story that
 * follows the execution path in order. This is the foundation that every other
 * narrative pattern (decisions, forks, loops) builds on — if linear narration
 * is wrong, nothing else can be trusted.
 *
 * MODULES INVOLVED:
 * - FlowChartBuilder: Constructs the linear pipeline structure
 * - FlowChartExecutor: Runs the pipeline with narrative enabled
 * - NarrativeGenerator: Produces sentences during traversal
 *
 * KEY BEHAVIORS TESTED:
 * 1. First stage produces the opening sentence pattern
 * 2. Subsequent transitions produce "Next, it moved on to" sentences
 * 3. Sentences appear in execution order
 * 4. Narrative array is non-empty after execution
 *
 * _Requirements: 2.1, 2.2, 3.1, 3.2_
 */

import { FlowChartBuilder } from '../../src/core/builder/FlowChartBuilder';
import { FlowChartExecutor } from '../../src/core/executor/FlowChartExecutor';
import { StageContext } from '../../src/core/memory/StageContext';
import { ScopeFactory } from '../../src/core/memory/types';

// Simple scope factory — passes the StageContext through unchanged
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

describe('Scenario: Linear Pipeline Narrative (A → B → C)', () => {
  /**
   * SCENARIO: Three-stage linear pipeline produces an ordered narrative
   *
   * GIVEN: A pipeline with three stages (A → B → C) and narrative enabled
   * WHEN: The pipeline executes to completion
   * THEN: getNarrative() returns a non-empty array where:
   *       - The first sentence starts with "The process began with"
   *       - Subsequent sentences describe transitions with "Next, it moved on to"
   *       - Sentences reference stages in execution order (A, then B, then C)
   *
   * WHY THIS MATTERS:
   * Linear narration is the foundation of the narrative feature. If the
   * opening sentence or transition sentences are wrong, every consumer —
   * follow-up LLMs, logging systems, debug UIs — gets a broken story.
   *
   * _Requirements: 2.1, 2.2, 3.1, 3.2_
   */
  it('should produce an ordered narrative for a three-stage linear pipeline', async () => {
    // GIVEN: A linear pipeline A → B → C with narrative enabled
    const chart = new FlowChartBuilder()
      .start('stageA', () => 'a-output', undefined, 'Stage A')
      .addFunction('stageB', () => 'b-output', undefined, 'Stage B')
      .addFunction('stageC', () => 'c-output', undefined, 'Stage C')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: The pipeline runs to completion
    await executor.run();

    // THEN: The narrative is non-empty
    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);

    // First sentence uses the opening pattern with the first stage's displayName
    expect(narrative[0]).toBe('The process began with Stage A.');

    // Transition sentences reference stages B and C in order
    expect(narrative[1]).toBe('Next, it moved on to Stage B.');
    expect(narrative[2]).toBe('Next, it moved on to Stage C.');

    // Exactly 3 sentences for a 3-stage linear pipeline (1 opener + 2 transitions)
    expect(narrative).toHaveLength(3);
  });

  /**
   * SCENARIO: Narrative uses stage name when displayName is not provided
   *
   * GIVEN: A linear pipeline where stages have no displayName
   * WHEN: The pipeline executes with narrative enabled
   * THEN: Sentences fall back to the raw stage name
   *
   * WHY THIS MATTERS:
   * Not all pipelines set displayName. The narrative must still produce
   * readable output using the stage name as a fallback, so consumers
   * always get a complete story.
   *
   * _Requirements: 3.1, 3.2_
   */
  it('should fall back to stage name when displayName is not set', async () => {
    // GIVEN: Stages without displayName
    const chart = new FlowChartBuilder()
      .start('validate', () => 'ok')
      .addFunction('process', () => 'done')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: Pipeline runs
    await executor.run();

    // THEN: Sentences use the raw stage names
    const narrative = executor.getNarrative();
    expect(narrative[0]).toBe('The process began with validate.');
    expect(narrative[1]).toBe('Next, it moved on to process.');
  });

  /**
   * SCENARIO: Execution order is preserved in the narrative
   *
   * GIVEN: A linear pipeline with stages that execute in a known order
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative sentences reference stages in the same order
   *       they were traversed
   *
   * WHY THIS MATTERS:
   * Requirement 2.2 mandates that narrative order matches traversal
   * sequence. If sentences appear out of order, the story is misleading
   * and any downstream consumer (LLM, logger) draws wrong conclusions.
   *
   * _Requirements: 2.2_
   */
  it('should preserve execution order across all sentences', async () => {
    // GIVEN: A 4-stage pipeline with distinct names
    const chart = new FlowChartBuilder()
      .start('first', () => '1')
      .addFunction('second', () => '2')
      .addFunction('third', () => '3')
      .addFunction('fourth', () => '4')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: Pipeline runs
    await executor.run();

    // THEN: Sentences reference stages in traversal order
    const narrative = executor.getNarrative();
    expect(narrative[0]).toContain('first');
    expect(narrative[1]).toContain('second');
    expect(narrative[2]).toContain('third');
    expect(narrative[3]).toContain('fourth');

    // No sentence references a later stage before an earlier one
    const fullText = narrative.join(' ');
    expect(fullText.indexOf('first')).toBeLessThan(fullText.indexOf('second'));
    expect(fullText.indexOf('second')).toBeLessThan(fullText.indexOf('third'));
    expect(fullText.indexOf('third')).toBeLessThan(fullText.indexOf('fourth'));
  });
});

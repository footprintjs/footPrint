/**
 * Scenario Tests: Fork and Selector Pipeline Narrative
 *
 * BUSINESS CONTEXT:
 * Pipelines often fan out into parallel branches — either executing ALL children
 * (fork pattern via addSubFlowChart) or a SUBSET (selector pattern via addSelector).
 * The narrative must capture which paths ran concurrently and, for selectors, which
 * were chosen out of the total available. This is critical for LLM context engineering:
 * a follow-up model needs to know "3 of 5 paths were selected" to reason about what
 * was skipped and why.
 *
 * MODULES INVOLVED:
 * - FlowChartBuilder: Constructs fork and selector pipeline structures
 * - FlowChartExecutor: Runs the pipeline with narrative enabled
 * - NarrativeGenerator: Produces fork/selector sentences during traversal
 * - ChildrenExecutor: Calls onFork() and onSelected() during parallel execution
 *
 * KEY BEHAVIORS TESTED:
 * 1. Fork (all children) produces a sentence listing all children executed in parallel
 * 2. Selector (subset) produces a sentence listing selected children and total count
 * 3. Child execution sentences appear in definition order
 *
 * _Requirements: 5.1, 5.2, 5.3_
 */

import { FlowChartBuilder } from '../../src/core/builder/FlowChartBuilder';
import { FlowChartExecutor } from '../../src/core/executor/FlowChartExecutor';
import { StageContext } from '../../src/core/memory/StageContext';
import { ScopeFactory } from '../../src/core/memory/types';

// Simple scope factory — passes the StageContext through unchanged
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

describe('Scenario: Fork Pipeline Narrative (all children in parallel)', () => {
  /**
   * SCENARIO: Fork with two subflows produces a parallel-execution sentence
   *
   * GIVEN: A pipeline where the entry stage forks into two subflows via addSubFlowChart
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative contains a sentence listing both children being executed in parallel,
   *       following the pattern: "{count} paths were executed in parallel: {names}."
   *
   * WHY THIS MATTERS:
   * Requirement 5.1 mandates that when a fork node executes all children in parallel,
   * the narrative lists the children being executed. Without this, a downstream LLM
   * cannot tell which paths ran concurrently.
   *
   * _Requirements: 5.1_
   */
  it('should produce a fork sentence listing all children executed in parallel', async () => {
    // GIVEN: Two subflows mounted as children of the entry stage
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
    executor.enableNarrative();

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: The narrative contains a fork sentence
    const narrative = executor.getNarrative();

    const forkSentence = narrative.find((s) => s.includes('paths were executed in parallel'));
    expect(forkSentence).toBeDefined();
    expect(forkSentence).toBe('2 paths were executed in parallel: Fork Alpha, Fork Beta.');
  });

  /**
   * SCENARIO: Fork child execution sentences appear in definition order
   *
   * GIVEN: A pipeline that forks into three subflows defined in a specific order
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative includes sentences for each child's execution, and
   *       these sentences appear in the order the children were defined
   *
   * WHY THIS MATTERS:
   * Requirement 5.3 mandates that parallel children's execution sentences appear
   * in definition order, not completion order. This ensures the narrative is
   * deterministic and reproducible regardless of async timing.
   *
   * _Requirements: 5.3_
   */
  it('should include child execution sentences in definition order', async () => {
    // GIVEN: Three subflows mounted in a specific order
    const subflowX = new FlowChartBuilder()
      .start('x', () => 'x-result', undefined, 'Provider X')
      .build();

    const subflowY = new FlowChartBuilder()
      .start('y', () => 'y-result', undefined, 'Provider Y')
      .build();

    const subflowZ = new FlowChartBuilder()
      .start('z', () => 'z-result', undefined, 'Provider Z')
      .build();

    const chart = new FlowChartBuilder()
      .start('entry', () => 'ready', undefined, 'Entry')
      .addSubFlowChart('childX', subflowX, 'Provider X')
      .addSubFlowChart('childY', subflowY, 'Provider Y')
      .addSubFlowChart('childZ', subflowZ, 'Provider Z')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: The narrative mentions all three children
    const narrative = executor.getNarrative();
    const fullText = narrative.join(' ');

    // All three children appear in the narrative
    expect(fullText).toContain('Provider X');
    expect(fullText).toContain('Provider Y');
    expect(fullText).toContain('Provider Z');

    // Children appear in definition order (X before Y before Z)
    const xIndex = fullText.indexOf('Provider X');
    const yIndex = fullText.indexOf('Provider Y');
    const zIndex = fullText.indexOf('Provider Z');
    expect(xIndex).toBeLessThan(yIndex);
    expect(yIndex).toBeLessThan(zIndex);
  });
});

describe('Scenario: Selector Pipeline Narrative (subset of children)', () => {
  /**
   * SCENARIO: Selector picks a subset and produces a selection sentence
   *
   * GIVEN: A pipeline with a selector that picks 2 of 3 available branches
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative contains a sentence listing which children were selected
   *       and how many were available, following the pattern:
   *       "{selected} of {total} paths were selected: {names}."
   *
   * WHY THIS MATTERS:
   * Requirement 5.2 mandates that when a selector picks a subset of children,
   * the narrative lists which children were selected and how many were available.
   * This lets a downstream LLM understand what was skipped and reason about
   * the selection logic.
   *
   * _Requirements: 5.2_
   */
  it('should produce a selection sentence listing selected children and total count', async () => {
    // GIVEN: A selector that picks 'email' and 'push' out of 3 branches
    const chart = new FlowChartBuilder()
      .start('analyze', () => ['email', 'push'], undefined, 'Analyze Preferences')
      .addSelector((out) => out as string[])
        .addFunctionBranch('email', 'Send Email', () => 'email-sent')
        .addFunctionBranch('sms', 'Send SMS', () => 'sms-sent')
        .addFunctionBranch('push', 'Send Push', () => 'push-sent')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: The narrative contains a selection sentence
    const narrative = executor.getNarrative();

    const selectorSentence = narrative.find((s) => s.includes('paths were selected'));
    expect(selectorSentence).toBeDefined();
    expect(selectorSentence).toBe('2 of 3 paths were selected: Send Email, Send Push.');
  });

  /**
   * SCENARIO: Selector with single selection produces correct count
   *
   * GIVEN: A selector that picks 1 of 3 available branches
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative contains "1 of 3 paths were selected: {name}."
   *
   * WHY THIS MATTERS:
   * Edge case for Requirement 5.2 — even when only one child is selected,
   * the narrative must still show the total count so the reader knows
   * alternatives existed.
   *
   * _Requirements: 5.2_
   */
  it('should produce correct selection sentence for single selection', async () => {
    // GIVEN: A selector that picks only 'sms'
    const chart = new FlowChartBuilder()
      .start('analyze', () => 'sms', undefined, 'Analyze Preferences')
      .addSelector((out) => out as string)
        .addFunctionBranch('email', 'Send Email', () => 'email-sent')
        .addFunctionBranch('sms', 'Send SMS', () => 'sms-sent')
        .addFunctionBranch('push', 'Send Push', () => 'push-sent')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: The narrative contains a selection sentence with 1 of 3
    const narrative = executor.getNarrative();

    const selectorSentence = narrative.find((s) => s.includes('paths were selected'));
    expect(selectorSentence).toBeDefined();
    expect(selectorSentence).toBe('1 of 3 paths were selected: Send SMS.');
  });

  /**
   * SCENARIO: Selected children execution sentences appear in definition order
   *
   * GIVEN: A selector that picks 2 of 3 branches
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative includes execution sentences for the selected children
   *       in the order they were defined, not in completion order
   *
   * WHY THIS MATTERS:
   * Requirement 5.3 applies to selector pipelines too — the narrative must
   * be deterministic. If children complete in different orders due to async
   * timing, the narrative still lists them in definition order.
   *
   * _Requirements: 5.3_
   */
  it('should include selected child execution sentences in definition order', async () => {
    // GIVEN: A selector that picks 'email' and 'push' (defined as 1st and 3rd)
    const chart = new FlowChartBuilder()
      .start('analyze', () => ['email', 'push'], undefined, 'Analyze Preferences')
      .addSelector((out) => out as string[])
        .addFunctionBranch('email', 'Send Email', () => 'email-sent')
        .addFunctionBranch('sms', 'Send SMS', () => 'sms-sent')
        .addFunctionBranch('push', 'Send Push', () => 'push-sent')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: Selected children appear in definition order in the narrative
    const narrative = executor.getNarrative();
    const fullText = narrative.join(' ');

    // Both selected children appear
    expect(fullText).toContain('Send Email');
    expect(fullText).toContain('Send Push');

    // Email (defined first) appears before Push (defined third) in the narrative
    expect(fullText.indexOf('Send Email')).toBeLessThan(fullText.indexOf('Send Push'));
  });
});

describe('Scenario: Complete Fork/Selector Narrative Story', () => {
  /**
   * SCENARIO: Full narrative includes opening, fork, and child sentences
   *
   * GIVEN: A pipeline with an entry stage that forks into two subflows
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative tells a complete story: opening sentence, fork sentence,
   *       and child execution sentences — forming a coherent narrative
   *
   * WHY THIS MATTERS:
   * The narrative must be a coherent story, not isolated sentences. Consumers
   * (LLMs, loggers) need the full context: what started, what forked, and
   * what each child did.
   *
   * _Requirements: 5.1, 5.3_
   */
  it('should produce a complete narrative story for a fork pipeline', async () => {
    // GIVEN: Entry stage → fork into two subflows
    const subA = new FlowChartBuilder()
      .start('memoryTask', () => 'memory-loaded', undefined, 'Load Memory')
      .build();

    const subB = new FlowChartBuilder()
      .start('contextTask', () => 'context-loaded', undefined, 'Load Context')
      .build();

    const chart = new FlowChartBuilder()
      .start('init', () => 'initialized', undefined, 'Initialize')
      .addSubFlowChart('memory', subA, 'Load Memory')
      .addSubFlowChart('context', subB, 'Load Context')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: The narrative tells a complete story
    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThanOrEqual(2);

    // Opening sentence for the entry stage
    expect(narrative[0]).toBe('The process began with Initialize.');

    // Fork sentence appears in the narrative
    const forkSentence = narrative.find((s) => s.includes('paths were executed in parallel'));
    expect(forkSentence).toBeDefined();
    expect(forkSentence).toContain('Load Memory');
    expect(forkSentence).toContain('Load Context');
  });
});

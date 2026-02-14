/**
 * Scenario Tests: Decider Pipeline Narrative
 *
 * BUSINESS CONTEXT:
 * Decider nodes are the most valuable part of the narrative for LLM context
 * engineering — knowing *why* a branch was taken lets even a cheaper model
 * reason about the execution. This test verifies that both legacy deciders
 * (addDecider) and scope-based deciders (addDeciderFunction) produce correct
 * narrative sentences, with and without rationale.
 *
 * MODULES INVOLVED:
 * - FlowChartBuilder: Constructs pipelines with decider nodes
 * - FlowChartExecutor: Runs the pipeline with narrative enabled
 * - NarrativeGenerator: Produces decision sentences during traversal
 * - DeciderHandler: Calls onDecision() after branch selection
 *
 * KEY BEHAVIORS TESTED:
 * 1. Legacy decider with rationale produces sentence with branch name and rationale
 * 2. Legacy decider without rationale produces sentence with branch name only
 * 3. Scope-based decider produces decision sentence with branch selected
 *
 * _Requirements: 4.1, 4.2, 4.3_
 */

import { FlowChartBuilder } from '../../src/core/builder/FlowChartBuilder';
import { FlowChartExecutor } from '../../src/core/executor/FlowChartExecutor';
import { StageContext } from '../../src/core/memory/StageContext';
import { ScopeFactory } from '../../src/core/memory/types';

// Simple scope factory — passes the StageContext through unchanged
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

describe('Scenario: Decider Pipeline Narrative', () => {
  /**
   * SCENARIO: Legacy decider with rationale produces a decision sentence
   *
   * GIVEN: A pipeline with a stage that sets deciderRationale, followed by
   *        a legacy decider (addDecider) that selects a branch
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative contains a decision sentence with both the branch
   *       name and the rationale text
   *
   * WHY THIS MATTERS:
   * Requirement 4.1 mandates that when a decider evaluates and selects a
   * branch, the narrative sentence includes the chosen branch name AND the
   * rationale. This is the core value proposition — downstream LLMs can
   * understand *why* a path was taken, not just *which* path.
   *
   * _Requirements: 4.1_
   */
  it('should include branch name and rationale for legacy decider with rationale', async () => {
    // GIVEN: A pipeline where the entry stage sets deciderRationale,
    // then a legacy decider picks a branch
    const chart = new FlowChartBuilder()
      .start('entry', (scope: StageContext) => {
        scope.setLog('deciderRationale', 'the user role equals admin');
        return 'grantAccess';
      })
      .addDecider((out) => out as string)
        .addFunctionBranch('grantAccess', 'Grant Full Access', () => 'granted')
        .addFunctionBranch('denyAccess', 'Deny Access', () => 'denied')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: The narrative contains a decision sentence with rationale and branch name
    const narrative = executor.getNarrative();

    // The decision sentence should follow the pattern:
    // "A decision was made: {rationale}, so the path taken was {branch}."
    const decisionSentence = narrative.find((s) => s.startsWith('A decision was made:'));
    expect(decisionSentence).toBeDefined();
    expect(decisionSentence).toContain('the user role equals admin');
    expect(decisionSentence).toContain('Grant Full Access');
    expect(decisionSentence).toBe(
      'A decision was made: the user role equals admin, so the path taken was Grant Full Access.',
    );
  });

  /**
   * SCENARIO: Legacy decider without rationale still produces a decision sentence
   *
   * GIVEN: A pipeline with a legacy decider where no deciderRationale is set
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative contains a decision sentence with the branch name
   *       but no rationale clause
   *
   * WHY THIS MATTERS:
   * Requirement 4.3 mandates that even when no rationale is available, the
   * narrative still includes the chosen branch name. The story must never
   * have a gap at a decision point.
   *
   * _Requirements: 4.3_
   */
  it('should include branch name without rationale for legacy decider', async () => {
    // GIVEN: A pipeline where no deciderRationale is set
    const chart = new FlowChartBuilder()
      .start('entry', () => 'pathB')
      .addDecider((out) => out as string)
        .addFunctionBranch('pathA', 'Path Alpha', () => 'a')
        .addFunctionBranch('pathB', 'Path Beta', () => 'b')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: The narrative contains a decision sentence without rationale
    const narrative = executor.getNarrative();

    // The decision sentence should follow the pattern:
    // "A decision was made, and the path taken was {branch}."
    const decisionSentence = narrative.find((s) => s.startsWith('A decision was made'));
    expect(decisionSentence).toBeDefined();
    expect(decisionSentence).toContain('Path Beta');
    expect(decisionSentence).toBe(
      'A decision was made, and the path taken was Path Beta.',
    );
  });

  /**
   * SCENARIO: Scope-based decider produces a decision sentence with branch selected
   *
   * GIVEN: A pipeline with a scope-based decider (addDeciderFunction) that
   *        sets rationale and returns a branch ID
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative contains a decision sentence describing the decision
   *       including the branch selected
   *
   * WHY THIS MATTERS:
   * Requirement 4.2 mandates that scope-based decider functions produce
   * narrative sentences describing the decision. Scope-based deciders are
   * the modern pattern (aligned with LangGraph/Airflow), so they must be
   * first-class citizens in the narrative.
   *
   * _Requirements: 4.2_
   */
  it('should produce decision sentence for scope-based decider with rationale', async () => {
    // GIVEN: A scope-based decider that sets rationale and returns a branch ID
    const chart = new FlowChartBuilder()
      .start('entry', () => 'setup-done')
      .addDeciderFunction(
        'RouteDecider',
        (scope: StageContext) => {
          scope.setLog('deciderRationale', 'order type is express');
          return 'express';
        },
        'route-decider',
        'Route Decider',
      )
        .addFunctionBranch('express', 'Express Fulfillment', () => 'express-done')
        .addFunctionBranch('standard', 'Standard Fulfillment', () => 'standard-done')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: The narrative contains a decision sentence with rationale and branch
    const narrative = executor.getNarrative();

    const decisionSentence = narrative.find((s) => s.startsWith('A decision was made:'));
    expect(decisionSentence).toBeDefined();
    expect(decisionSentence).toContain('order type is express');
    expect(decisionSentence).toContain('Express Fulfillment');
    expect(decisionSentence).toBe(
      'A decision was made: order type is express, so the path taken was Express Fulfillment.',
    );
  });

  /**
   * SCENARIO: Scope-based decider without rationale still includes branch name
   *
   * GIVEN: A scope-based decider that does NOT set deciderRationale
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative contains a decision sentence with the branch name
   *
   * WHY THIS MATTERS:
   * Requirement 4.3 applies to scope-based deciders too — the narrative
   * must always include the chosen branch, even without rationale.
   *
   * _Requirements: 4.2, 4.3_
   */
  it('should produce decision sentence for scope-based decider without rationale', async () => {
    // GIVEN: A scope-based decider that returns a branch ID without setting rationale
    const chart = new FlowChartBuilder()
      .start('entry', () => 'setup-done')
      .addDeciderFunction(
        'SimpleDecider',
        () => 'optionA',
        'simple-decider',
        'Simple Decider',
      )
        .addFunctionBranch('optionA', 'Option Alpha', () => 'a-done')
        .addFunctionBranch('optionB', 'Option Bravo', () => 'b-done')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: The narrative contains a decision sentence without rationale
    const narrative = executor.getNarrative();

    const decisionSentence = narrative.find((s) => s.startsWith('A decision was made'));
    expect(decisionSentence).toBeDefined();
    expect(decisionSentence).toContain('Option Alpha');
    expect(decisionSentence).toBe(
      'A decision was made, and the path taken was Option Alpha.',
    );
  });

  /**
   * SCENARIO: Full narrative includes opening, transition, and decision
   *
   * GIVEN: A pipeline with a linear stage before the decider node
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative tells a complete story: opening sentence for the
   *       first stage, transition to the decider, and the decision sentence
   *
   * WHY THIS MATTERS:
   * The narrative must be a coherent story, not just isolated sentences.
   * Consumers (LLMs, loggers) need the full context: what started, what
   * decision was made, and what happened after. When the decider is on
   * a separate node (not the entry stage), the opening sentence and
   * transition appear before the decision.
   *
   * _Requirements: 4.1, 4.2, 4.3_
   */
  it('should produce a complete narrative story with linear stage before decider', async () => {
    // GIVEN: entry (linear) → decider node → chosen branch
    // The decider is on a separate node so the entry stage gets its own
    // opening sentence via onStageExecuted.
    const chart = new FlowChartBuilder()
      .start('entry', () => 'setup-done', undefined, 'Validate Input')
      .addFunction('router', (scope: StageContext) => {
        scope.setLog('deciderRationale', 'account balance exceeds threshold');
        return 'premium';
      })
      .addDecider((out) => out as string)
        .addFunctionBranch('premium', 'Premium Service', () => 'premium-result')
        .addFunctionBranch('basic', 'Basic Service', () => 'basic-result')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // WHEN: The pipeline runs
    await executor.run();

    // THEN: The narrative tells a complete story
    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThanOrEqual(2);

    // Opening sentence for the first linear stage
    expect(narrative[0]).toBe('The process began with Validate Input.');

    // Decision sentence with rationale appears in the narrative
    const decisionSentence = narrative.find((s) => s.startsWith('A decision was made:'));
    expect(decisionSentence).toBe(
      'A decision was made: account balance exceeds threshold, so the path taken was Premium Service.',
    );
  });
});

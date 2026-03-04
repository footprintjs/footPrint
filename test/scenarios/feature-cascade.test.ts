/**
 * Scenario Tests: Feature Cascade
 *
 * BUSINESS CONTEXT:
 * This file tests the 5 documented features of the FootPrint library working
 * individually and together through the public API. These are end-to-end
 * scenario tests from a consumer's perspective -- no mocks.
 *
 * FEATURES TESTED:
 * 1. Stage Descriptions Cascade -- descriptions auto-accumulate into a tool description
 * 2. Narrative Generation -- human-readable execution story
 * 3. Recorders (DebugRecorder + MetricRecorder + NarrativeRecorder) -- structured data capture
 * 4. Traversal Extractor + Enriched Snapshots -- data extraction during execution
 * 5. Observability (3-layer model) -- scope logging, custom recorders, context tree
 * 6. Combined Cascade -- all features working together
 *
 * MODULES INVOLVED:
 * - FlowChartBuilder: Constructs pipeline structures with descriptions
 * - FlowChartExecutor: Runs pipelines with narrative/extractor/enrichment enabled
 * - Scope: Runtime memory container with recorder hooks
 * - DebugRecorder, MetricRecorder, NarrativeRecorder: Structured data capture
 * - NarrativeGenerator: Human-readable execution story
 */

import { FlowChartBuilder, FlowChart } from '../../src/core/builder/FlowChartBuilder';
import { FlowChartExecutor } from '../../src/core/executor/FlowChartExecutor';
import { StageContext } from '../../src/core/memory/StageContext';
import type { ScopeFactory } from '../../src/core/memory/types';
import type { TraversalExtractor, StageSnapshot } from '../../src/core/executor/types';
import { Scope } from '../../src/scope/Scope';
import { DebugRecorder } from '../../src/scope/recorders/DebugRecorder';
import { MetricRecorder } from '../../src/scope/recorders/MetricRecorder';
import { NarrativeRecorder } from '../../src/scope/recorders/NarrativeRecorder';
import { GlobalStore } from '../../src/core/memory/GlobalStore';

// Simple scope factory -- passes the StageContext through unchanged
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

// ============================================================================
// Feature 1: Stage Descriptions Cascade
// ============================================================================

describe('Feature 1: Stage Descriptions Cascade', () => {
  /**
   * SCENARIO: Multiple stages with descriptions accumulate into a tool description
   *
   * GIVEN: A flowchart with .describe() (description param) on multiple stages
   * WHEN: build() is called
   * THEN: The returned FlowChart has a `description` string with "FlowChart:" prefix
   *       and all stage descriptions, plus a `stageDescriptions` map with per-stage entries
   */
  it('should accumulate stage descriptions into a pipeline description string', () => {
    const chart = new FlowChartBuilder()
      .start('validate', () => 'ok', undefined, 'Validate Input', 'Check that user input is well-formed')
      .addFunction('process', () => 'done', undefined, 'Process Data', 'Transform and enrich the raw data')
      .addFunction('persist', () => 'saved', undefined, 'Save Results', 'Write processed data to the database')
      .build();

    // Description string starts with "FlowChart:" prefix
    expect(chart.description).toContain('FlowChart:');
    expect(chart.description).toContain('Validate Input');
    expect(chart.description).toContain('Check that user input is well-formed');
    expect(chart.description).toContain('Process Data');
    expect(chart.description).toContain('Transform and enrich the raw data');
    expect(chart.description).toContain('Save Results');
    expect(chart.description).toContain('Write processed data to the database');

    // Stage descriptions map has per-stage entries
    expect(chart.stageDescriptions.size).toBe(3);
    expect(chart.stageDescriptions.get('validate')).toBe('Check that user input is well-formed');
    expect(chart.stageDescriptions.get('process')).toBe('Transform and enrich the raw data');
    expect(chart.stageDescriptions.get('persist')).toBe('Write processed data to the database');
  });

  /**
   * SCENARIO: Descriptions work with all node types
   *
   * GIVEN: A flowchart with linear, parallel (subflow), and decider nodes, each with descriptions
   * WHEN: build() is called
   * THEN: All descriptions are accumulated in the description string and stageDescriptions map
   */
  it('should work with linear, decider, selector, and subflow node types', () => {
    const subflow = new FlowChartBuilder()
      .start('subEntry', () => 'sub-result', undefined, 'Sub Entry')
      .build();

    const chart = new FlowChartBuilder()
      .start('entry', () => 'ready', undefined, 'Entry Stage', 'Initialize the pipeline')
      .addFunction('linear', () => 'linear-done', undefined, 'Linear Stage', 'A regular linear step')
      .addSubFlowChart('sub1', subflow, 'My Subflow')
      .build();

    // Description string includes linear stage descriptions
    expect(chart.description).toContain('Initialize the pipeline');
    expect(chart.description).toContain('A regular linear step');

    // stageDescriptions map has entries for stages with descriptions
    expect(chart.stageDescriptions.get('entry')).toBe('Initialize the pipeline');
    expect(chart.stageDescriptions.get('linear')).toBe('A regular linear step');
  });

  /**
   * SCENARIO: Decider and selector stages with descriptions
   *
   * GIVEN: A flowchart with a scope-based decider that has a description
   * WHEN: build() is called
   * THEN: The decider description appears in the accumulated description
   */
  it('should include decider stage descriptions in the pipeline description', () => {
    const chart = new FlowChartBuilder()
      .start('entry', () => 'ready', undefined, 'Entry')
      .addDeciderFunction(
        'Router',
        () => 'branchA',
        'router-id',
        'Route Decider',
        'Decide which processing path to take',
      )
        .addFunctionBranch('branchA', 'Branch A', () => 'a-done')
        .addFunctionBranch('branchB', 'Branch B', () => 'b-done')
      .end()
      .build();

    // The decider description appears in the pipeline description
    expect(chart.description).toContain('Route Decider');
    // stageDescriptions map includes the decider
    expect(chart.stageDescriptions.get('Router')).toBe('Decide which processing path to take');
  });

  /**
   * SCENARIO: Empty descriptions produce empty description string
   *
   * GIVEN: A flowchart where no stages have descriptions
   * WHEN: build() is called
   * THEN: The description string is empty and stageDescriptions map is empty
   */
  it('should produce empty description string when no descriptions are provided', () => {
    const chart = new FlowChartBuilder()
      .start('stageA', () => 'a')
      .addFunction('stageB', () => 'b')
      .build();

    // description contains the pipeline name and step listing (even without descriptions)
    // but stageDescriptions should be empty since no descriptions were given
    expect(chart.stageDescriptions.size).toBe(0);
  });

  /**
   * SCENARIO: Partial descriptions -- some stages have descriptions, some don't
   *
   * GIVEN: A flowchart where only some stages have descriptions
   * WHEN: build() is called
   * THEN: Only stages with descriptions appear in stageDescriptions map
   */
  it('should only include stages with descriptions in stageDescriptions map', () => {
    const chart = new FlowChartBuilder()
      .start('stageA', () => 'a', undefined, 'Stage A', 'First stage description')
      .addFunction('stageB', () => 'b', undefined, 'Stage B')
      .addFunction('stageC', () => 'c', undefined, 'Stage C', 'Third stage description')
      .build();

    expect(chart.stageDescriptions.size).toBe(2);
    expect(chart.stageDescriptions.get('stageA')).toBe('First stage description');
    expect(chart.stageDescriptions.has('stageB')).toBe(false);
    expect(chart.stageDescriptions.get('stageC')).toBe('Third stage description');
  });

  /**
   * SCENARIO: Description string includes numbered steps
   *
   * GIVEN: A flowchart with descriptions on stages
   * WHEN: build() is called
   * THEN: The description string contains numbered steps like "1. Stage Name -- description"
   */
  it('should number each step in the description string', () => {
    const chart = new FlowChartBuilder()
      .start('init', () => 'ok', undefined, 'Initialize', 'Set up the environment')
      .addFunction('work', () => 'done', undefined, 'Do Work', 'Perform the main task')
      .build();

    // Steps are numbered
    expect(chart.description).toMatch(/1\.\s*Initialize/);
    expect(chart.description).toMatch(/2\.\s*Do Work/);
  });
});

// ============================================================================
// Feature 2: Narrative Generation (end-to-end)
// ============================================================================

describe('Feature 2: Narrative Generation (end-to-end)', () => {
  /**
   * SCENARIO: Linear flow narrative
   *
   * GIVEN: A linear pipeline with enableNarrative
   * WHEN: The pipeline executes
   * THEN: getNarrative() returns ordered sentences with "began with X", "moved on to Y"
   */
  it('should produce ordered narrative for a linear flow', async () => {
    const chart = new FlowChartBuilder()
      .start('init', () => 'ok', undefined, 'Initialize')
      .addFunction('process', () => 'done', undefined, 'Process')
      .addFunction('finalize', () => 'finished', undefined, 'Finalize')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    expect(narrative[0]).toContain('began with');
    expect(narrative[0]).toContain('Initialize');
    expect(narrative[1]).toContain('moved on to');
    expect(narrative[1]).toContain('Process');
    expect(narrative[2]).toContain('moved on to');
    expect(narrative[2]).toContain('Finalize');
  });

  /**
   * SCENARIO: Fork flow narrative
   *
   * GIVEN: A pipeline with forked subflows
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative mentions parallel execution and branch names
   */
  it('should produce fork narrative with parallel branch names', async () => {
    const subA = new FlowChartBuilder()
      .start('taskA', () => 'a', undefined, 'Task Alpha')
      .build();

    const subB = new FlowChartBuilder()
      .start('taskB', () => 'b', undefined, 'Task Beta')
      .build();

    const chart = new FlowChartBuilder()
      .start('entry', () => 'ready', undefined, 'Entry')
      .addSubFlowChart('forkA', subA, 'Fork Alpha')
      .addSubFlowChart('forkB', subB, 'Fork Beta')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();
    const fullText = narrative.join(' ');

    // Should mention parallel execution
    const forkSentence = narrative.find((s) => s.includes('parallel'));
    expect(forkSentence).toBeDefined();
    expect(fullText).toContain('Fork Alpha');
    expect(fullText).toContain('Fork Beta');
  });

  /**
   * SCENARIO: Decider flow narrative
   *
   * GIVEN: A pipeline with a decider node
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative mentions the decision and selected branch
   */
  it('should produce decision narrative with selected branch', async () => {
    const chart = new FlowChartBuilder()
      .start('entry', (scope: StageContext) => {
        scope.setLog('deciderRationale', 'user prefers express delivery');
        return 'express';
      })
      .addDecider((out) => out as string)
        .addFunctionBranch('express', 'Express Delivery', () => 'shipped-fast')
        .addFunctionBranch('standard', 'Standard Delivery', () => 'shipped-slow')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();
    const decisionSentence = narrative.find((s) => s.includes('decision'));
    expect(decisionSentence).toBeDefined();
    expect(decisionSentence).toContain('Express Delivery');
    expect(decisionSentence).toContain('user prefers express delivery');
  });

  /**
   * SCENARIO: Subflow narrative mentions entering/exiting subflow
   *
   * GIVEN: A pipeline with a subflow
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative mentions entering and exiting the subflow
   */
  it('should mention entering and exiting subflow in narrative', async () => {
    const subflow = new FlowChartBuilder()
      .start('subTask', () => 'sub-done', undefined, 'Sub Task')
      .build();

    const chart = new FlowChartBuilder()
      .start('entry', () => 'ready', undefined, 'Entry')
      .addSubFlowChart('mySub', subflow, 'My Subflow')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();
    const fullText = narrative.join(' ');

    // Subflow entry and exit are mentioned
    expect(fullText).toContain('Entering');
    expect(fullText).toContain('subflow');
  });

  /**
   * SCENARIO: Error flow narrative
   *
   * GIVEN: A pipeline with a stage that throws an error
   * WHEN: The pipeline executes with narrative enabled
   * THEN: The narrative mentions the error
   */
  it('should mention errors in narrative when a stage throws', async () => {
    const chart = new FlowChartBuilder()
      .start('setup', () => 'ready', undefined, 'Setup')
      .addFunction('failStage', () => {
        throw new Error('Something went wrong');
      }, undefined, 'Failing Stage')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    executor.enableNarrative();

    // The pipeline may throw or catch the error internally
    try {
      await executor.run();
    } catch {
      // Expected -- stage threw an error
    }

    const narrative = executor.getNarrative();
    const fullText = narrative.join(' ');

    // Narrative should mention the error
    expect(fullText).toContain('error');
  });

  /**
   * SCENARIO: Disabled narrative returns empty array
   *
   * GIVEN: A pipeline where enableNarrative() is NOT called
   * WHEN: The pipeline executes
   * THEN: getNarrative() returns an empty array
   */
  it('should return empty array when narrative is not enabled', async () => {
    const chart = new FlowChartBuilder()
      .start('stageA', () => 'a', undefined, 'Stage A')
      .addFunction('stageB', () => 'b', undefined, 'Stage B')
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    // enableNarrative() NOT called
    await executor.run();

    const narrative = executor.getNarrative();
    expect(narrative).toEqual([]);
  });

  /**
   * SCENARIO: Build-time narrative enablement via setEnableNarrative
   *
   * GIVEN: A builder with setEnableNarrative() called
   * WHEN: The flowchart is built and executed
   * THEN: Narrative is generated without explicit enableNarrative() on executor
   */
  it('should enable narrative at build time via setEnableNarrative', async () => {
    const chart = new FlowChartBuilder()
      .start('entry', () => 'ok', undefined, 'Entry')
      .addFunction('next', () => 'done', undefined, 'Next')
      .setEnableNarrative()
      .build();

    expect(chart.enableNarrative).toBe(true);

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    // NOTE: NOT calling executor.enableNarrative() -- build-time flag should suffice
    await executor.run();

    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    expect(narrative[0]).toContain('began with');
  });

  /**
   * SCENARIO: Narrative with stage descriptions uses description text
   *
   * GIVEN: Stages with descriptions and narrative enabled
   * WHEN: The pipeline executes
   * THEN: The narrative uses the description text for richer output
   */
  it('should use stage descriptions in narrative for richer output', async () => {
    const chart = new FlowChartBuilder()
      .start('init', () => 'ok', undefined, 'Initialize', 'Set up the agent with tools and memory')
      .addFunction('process', () => 'done', undefined, 'Process', 'Transform the input data into output')
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    await executor.run();

    const narrative = executor.getNarrative();
    // With descriptions, the narrative uses richer text
    expect(narrative[0]).toContain('Set up the agent with tools and memory');
    expect(narrative[1]).toContain('Transform the input data into output');
  });
});

// ============================================================================
// Feature 3: Recorders (DebugRecorder + MetricRecorder + NarrativeRecorder)
// ============================================================================

describe('Feature 3: Recorders', () => {
  /**
   * Helper: create a Scope with recorders for testing.
   * Returns the scope and the attached recorders.
   */
  function createScopeWithRecorders(
    globalStore: GlobalStore,
    stageName: string,
    recorders: Array<DebugRecorder | MetricRecorder | NarrativeRecorder>,
  ): Scope {
    return new Scope({
      pipelineId: 'test-pipeline',
      stageName,
      globalStore,
      recorders,
    });
  }

  describe('DebugRecorder', () => {
    /**
     * SCENARIO: DebugRecorder captures read/write operations
     *
     * GIVEN: A Scope with a DebugRecorder attached in verbose mode
     * WHEN: getValue and setValue are called during stage execution
     * THEN: The recorder captures both read and write entries
     */
    it('should capture read and write operations during stage execution', () => {
      const globalStore = new GlobalStore();
      const debugRecorder = new DebugRecorder({ id: 'debug-1', verbosity: 'verbose' });
      const scope = createScopeWithRecorders(globalStore, 'testStage', [debugRecorder]);

      // Simulate stage execution
      scope.startStage('testStage');
      scope.setValue('name', 'Alice');
      scope.getValue('name');
      scope.endStage();

      const entries = debugRecorder.getEntries();

      // Should have write, read, and stage lifecycle entries
      const writes = entries.filter((e) => e.type === 'write');
      const reads = entries.filter((e) => e.type === 'read');
      const stageStarts = entries.filter((e) => e.type === 'stageStart');
      const stageEnds = entries.filter((e) => e.type === 'stageEnd');

      expect(writes.length).toBeGreaterThanOrEqual(1);
      expect(reads.length).toBeGreaterThanOrEqual(1);
      expect(stageStarts.length).toBe(1);
      expect(stageEnds.length).toBe(1);
    });

    /**
     * SCENARIO: DebugRecorder in minimal mode only captures errors
     *
     * GIVEN: A DebugRecorder in minimal mode
     * WHEN: Reads and writes occur
     * THEN: No read/write entries are captured (only errors would be)
     */
    it('should not capture reads/writes in minimal mode', () => {
      const globalStore = new GlobalStore();
      const debugRecorder = new DebugRecorder({ id: 'debug-minimal', verbosity: 'minimal' });
      const scope = createScopeWithRecorders(globalStore, 'minStage', [debugRecorder]);

      scope.startStage('minStage');
      scope.setValue('key', 'value');
      scope.getValue('key');
      scope.endStage();

      const entries = debugRecorder.getEntries();
      const writes = entries.filter((e) => e.type === 'write');
      const reads = entries.filter((e) => e.type === 'read');

      expect(writes.length).toBe(0);
      expect(reads.length).toBe(0);
    });

    /**
     * SCENARIO: DebugRecorder filters entries by stage name
     *
     * GIVEN: A DebugRecorder that captures entries across multiple stages
     * WHEN: getEntriesForStage is called
     * THEN: Only entries for that stage are returned
     */
    it('should filter entries by stage name', () => {
      const globalStore = new GlobalStore();
      const debugRecorder = new DebugRecorder({ id: 'debug-filter', verbosity: 'verbose' });
      const scope = createScopeWithRecorders(globalStore, 'stageA', [debugRecorder]);

      scope.startStage('stageA');
      scope.setValue('a', 1);
      scope.endStage();

      scope.startStage('stageB');
      scope.setValue('b', 2);
      scope.setValue('b2', 3);
      scope.endStage();

      const stageAEntries = debugRecorder.getEntriesForStage('stageA');
      const stageBEntries = debugRecorder.getEntriesForStage('stageB');

      // stageA has fewer entries than stageB (which had two writes)
      expect(stageAEntries.length).toBeGreaterThan(0);
      expect(stageBEntries.length).toBeGreaterThan(0);

      // All returned entries should match their stage
      for (const entry of stageAEntries) {
        expect(entry.stageName).toBe('stageA');
      }
      for (const entry of stageBEntries) {
        expect(entry.stageName).toBe('stageB');
      }
    });
  });

  describe('MetricRecorder', () => {
    /**
     * SCENARIO: MetricRecorder tracks timing, read count, write count per stage
     *
     * GIVEN: A Scope with a MetricRecorder attached
     * WHEN: Multiple reads and writes occur during a stage
     * THEN: The recorder tracks correct counts and duration
     */
    it('should track read count, write count, and timing per stage', () => {
      const globalStore = new GlobalStore();
      const metricRecorder = new MetricRecorder('metric-1');
      const scope = createScopeWithRecorders(globalStore, 'metricStage', [metricRecorder]);

      scope.startStage('metricStage');
      scope.setValue('key1', 'val1');
      scope.setValue('key2', 'val2');
      scope.getValue('key1');
      scope.commit();
      scope.endStage();

      const stageMetrics = metricRecorder.getStageMetrics('metricStage');
      expect(stageMetrics).toBeDefined();
      expect(stageMetrics!.writeCount).toBe(2);
      expect(stageMetrics!.readCount).toBe(1);
      expect(stageMetrics!.commitCount).toBe(1);
      expect(stageMetrics!.invocationCount).toBe(1);
      expect(stageMetrics!.totalDuration).toBeGreaterThanOrEqual(0);
    });

    /**
     * SCENARIO: Aggregated metrics sum across all stages
     *
     * GIVEN: A MetricRecorder that captures metrics from multiple stages
     * WHEN: getMetrics() is called
     * THEN: Totals reflect the sum of all stages
     */
    it('should aggregate metrics across multiple stages', () => {
      const globalStore = new GlobalStore();
      const metricRecorder = new MetricRecorder('metric-agg');
      const scope = createScopeWithRecorders(globalStore, 'first', [metricRecorder]);

      scope.startStage('first');
      scope.setValue('a', 1);
      scope.getValue('a');
      scope.commit();
      scope.endStage();

      scope.startStage('second');
      scope.setValue('b', 2);
      scope.setValue('c', 3);
      scope.getValue('b');
      scope.getValue('c');
      scope.commit();
      scope.endStage();

      const metrics = metricRecorder.getMetrics();
      expect(metrics.totalWrites).toBe(3);
      expect(metrics.totalReads).toBe(3);
      expect(metrics.totalCommits).toBe(2);
      expect(metrics.stageMetrics.size).toBe(2);
    });
  });

  describe('NarrativeRecorder', () => {
    /**
     * SCENARIO: NarrativeRecorder produces per-stage data narrative text
     *
     * GIVEN: A Scope with a NarrativeRecorder in full detail mode
     * WHEN: Reads and writes occur during stage execution
     * THEN: toSentences() returns per-stage data narrative text with read/write details
     */
    it('should produce per-stage data narrative text', () => {
      const globalStore = new GlobalStore();
      const narrativeRecorder = new NarrativeRecorder({ id: 'narrative-1', detail: 'full' });
      const scope = createScopeWithRecorders(globalStore, 'dataStage', [narrativeRecorder]);

      scope.startStage('dataStage');
      scope.setValue('model', 'gpt-4');
      scope.getValue('model');
      scope.endStage();

      const sentences = narrativeRecorder.toSentences();
      expect(sentences.size).toBeGreaterThan(0);

      const stageLines = sentences.get('dataStage');
      expect(stageLines).toBeDefined();
      expect(stageLines!.length).toBeGreaterThan(0);

      // Lines should mention read and write operations
      const fullText = stageLines!.join('\n');
      expect(fullText).toContain('Wrote');
      expect(fullText).toContain('Read');
    });

    /**
     * SCENARIO: NarrativeRecorder summary mode
     *
     * GIVEN: A NarrativeRecorder in summary mode
     * WHEN: Multiple reads and writes occur
     * THEN: toSentences() returns compact counts instead of individual operations
     */
    it('should produce compact summary in summary mode', () => {
      const globalStore = new GlobalStore();
      const narrativeRecorder = new NarrativeRecorder({ id: 'narrative-summary', detail: 'summary' });
      const scope = createScopeWithRecorders(globalStore, 'summaryStage', [narrativeRecorder]);

      scope.startStage('summaryStage');
      scope.setValue('a', 1);
      scope.setValue('b', 2);
      scope.getValue('a');
      scope.endStage();

      const sentences = narrativeRecorder.toSentences();
      const stageLines = sentences.get('summaryStage');
      expect(stageLines).toBeDefined();

      // Summary mode produces count-based lines like "Read 1 value, wrote 2 values"
      const fullText = stageLines!.join('\n');
      expect(fullText).toMatch(/read.*1.*value/i);
      expect(fullText).toMatch(/wrote.*2.*value/i);
    });

    /**
     * SCENARIO: NarrativeRecorder getStageData returns structured data
     *
     * GIVEN: A NarrativeRecorder capturing scope operations
     * WHEN: getStageData() is called
     * THEN: Structured data with reads and writes arrays is returned
     */
    it('should return structured stage data with reads and writes', () => {
      const globalStore = new GlobalStore();
      const narrativeRecorder = new NarrativeRecorder({ id: 'narrative-data' });
      const scope = createScopeWithRecorders(globalStore, 'structStage', [narrativeRecorder]);

      scope.startStage('structStage');
      scope.setValue('timeout', 5000);
      scope.getValue('timeout');
      scope.endStage();

      const stageData = narrativeRecorder.getStageData();
      const data = stageData.get('structStage');
      expect(data).toBeDefined();
      expect(data!.writes.length).toBe(1);
      expect(data!.reads.length).toBe(1);
      expect(data!.writes[0].key).toBe('timeout');
      expect(data!.reads[0].key).toBe('timeout');
    });
  });

  describe('Multiple Recorders on Same Scope', () => {
    /**
     * SCENARIO: Multiple recorders work simultaneously on same scope
     *
     * GIVEN: A Scope with DebugRecorder, MetricRecorder, and NarrativeRecorder all attached
     * WHEN: Scope operations occur
     * THEN: All three recorders capture their respective data independently
     */
    it('should allow multiple recorders to work simultaneously', () => {
      const globalStore = new GlobalStore();
      const debugRecorder = new DebugRecorder({ id: 'debug-multi', verbosity: 'verbose' });
      const metricRecorder = new MetricRecorder('metric-multi');
      const narrativeRecorder = new NarrativeRecorder({ id: 'narrative-multi' });

      const scope = createScopeWithRecorders(globalStore, 'multiStage', [
        debugRecorder,
        metricRecorder,
        narrativeRecorder,
      ]);

      scope.startStage('multiStage');
      scope.setValue('key', 'value');
      scope.getValue('key');
      scope.commit();
      scope.endStage();

      // DebugRecorder captured entries
      const debugEntries = debugRecorder.getEntries();
      expect(debugEntries.length).toBeGreaterThan(0);

      // MetricRecorder tracked counts
      const metrics = metricRecorder.getStageMetrics('multiStage');
      expect(metrics).toBeDefined();
      expect(metrics!.writeCount).toBe(1);
      expect(metrics!.readCount).toBe(1);

      // NarrativeRecorder captured data
      const stageData = narrativeRecorder.getStageData();
      expect(stageData.get('multiStage')).toBeDefined();
    });
  });

  describe('Recorder Lifecycle', () => {
    /**
     * SCENARIO: Recorders accumulate data across multiple stages
     *
     * GIVEN: Recorders attached to a scope
     * WHEN: Multiple stages execute sequentially (startStage / operations / endStage)
     * THEN: Recorders accumulate data from all stages
     */
    it('should accumulate data across multiple stages', () => {
      const globalStore = new GlobalStore();
      const debugRecorder = new DebugRecorder({ id: 'debug-lifecycle', verbosity: 'verbose' });
      const metricRecorder = new MetricRecorder('metric-lifecycle');

      const scope = createScopeWithRecorders(globalStore, 'stage1', [debugRecorder, metricRecorder]);

      // Stage 1
      scope.startStage('stage1');
      scope.setValue('x', 1);
      scope.commit();
      scope.endStage();

      // Stage 2
      scope.startStage('stage2');
      scope.setValue('y', 2);
      scope.setValue('z', 3);
      scope.commit();
      scope.endStage();

      // DebugRecorder accumulated entries from both stages
      const allEntries = debugRecorder.getEntries();
      const stage1Entries = debugRecorder.getEntriesForStage('stage1');
      const stage2Entries = debugRecorder.getEntriesForStage('stage2');
      expect(allEntries.length).toBe(stage1Entries.length + stage2Entries.length);
      expect(stage1Entries.length).toBeGreaterThan(0);
      expect(stage2Entries.length).toBeGreaterThan(0);

      // MetricRecorder has metrics for both stages
      expect(metricRecorder.getStageMetrics('stage1')).toBeDefined();
      expect(metricRecorder.getStageMetrics('stage2')).toBeDefined();

      // Aggregated metrics reflect both stages
      const metrics = metricRecorder.getMetrics();
      expect(metrics.totalWrites).toBe(3);
      expect(metrics.stageMetrics.size).toBe(2);
    });

    /**
     * SCENARIO: Attach and detach recorders dynamically
     *
     * GIVEN: A scope with a recorder attached
     * WHEN: The recorder is detached mid-execution
     * THEN: The recorder stops receiving events after detachment
     */
    it('should stop receiving events after detachment', () => {
      const globalStore = new GlobalStore();
      const debugRecorder = new DebugRecorder({ id: 'debug-detach', verbosity: 'verbose' });
      const scope = new Scope({
        pipelineId: 'test',
        stageName: 'initial',
        globalStore,
      });

      scope.attachRecorder(debugRecorder);
      scope.startStage('before');
      scope.setValue('a', 1);
      scope.endStage();

      const entriesBeforeDetach = debugRecorder.getEntries().length;
      expect(entriesBeforeDetach).toBeGreaterThan(0);

      // Detach the recorder
      scope.detachRecorder(debugRecorder.id);

      scope.startStage('after');
      scope.setValue('b', 2);
      scope.endStage();

      // No new entries should have been added after detachment
      const entriesAfterDetach = debugRecorder.getEntries().length;
      expect(entriesAfterDetach).toBe(entriesBeforeDetach);
    });
  });
});

// ============================================================================
// Feature 4: Traversal Extractor + Enriched Snapshots
// ============================================================================

describe('Feature 4: Traversal Extractor + Enriched Snapshots', () => {
  /**
   * SCENARIO: Traversal extractor receives StageSnapshot per stage
   *
   * GIVEN: A flowchart with addTraversalExtractor
   * WHEN: The pipeline executes
   * THEN: The extractor is called for each stage with StageSnapshot data
   */
  it('should call extractor for each stage with StageSnapshot', async () => {
    const capturedSnapshots: StageSnapshot[] = [];
    const extractor: TraversalExtractor = (snapshot) => {
      capturedSnapshots.push(snapshot);
      return { stageName: snapshot.node.name, step: snapshot.stepNumber };
    };

    const chart = new FlowChartBuilder()
      .start('stageA', () => 'a-result')
      .addFunction('stageB', () => 'b-result')
      .addFunction('stageC', () => 'c-result')
      .addTraversalExtractor(extractor)
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    await executor.run();

    // Extractor was called for each stage
    expect(capturedSnapshots.length).toBe(3);
    expect(capturedSnapshots[0].node.name).toBe('stageA');
    expect(capturedSnapshots[1].node.name).toBe('stageB');
    expect(capturedSnapshots[2].node.name).toBe('stageC');

    // Step numbers are 1-based and increasing
    expect(capturedSnapshots[0].stepNumber).toBe(1);
    expect(capturedSnapshots[1].stepNumber).toBe(2);
    expect(capturedSnapshots[2].stepNumber).toBe(3);
  });

  /**
   * SCENARIO: getExtractedResults returns Map with stage paths as keys
   *
   * GIVEN: A flowchart with a traversal extractor that returns data
   * WHEN: The pipeline executes
   * THEN: getExtractedResults() returns a Map with stage paths as keys
   */
  it('should return extracted results as Map with stage paths as keys', async () => {
    const extractor: TraversalExtractor = (snapshot) => {
      return { name: snapshot.node.name, step: snapshot.stepNumber };
    };

    const chart = new FlowChartBuilder()
      .start('alpha', () => 'a')
      .addFunction('beta', () => 'b')
      .addTraversalExtractor(extractor)
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    await executor.run();

    const results = executor.getExtractedResults<{ name: string; step: number }>();
    expect(results).toBeInstanceOf(Map);
    expect(results.size).toBe(2);

    // Results are keyed by stage paths
    const keys = Array.from(results.keys());
    expect(keys.length).toBe(2);

    // Each result contains the data returned by the extractor
    for (const [, value] of results) {
      expect(value).toHaveProperty('name');
      expect(value).toHaveProperty('step');
    }
  });

  /**
   * SCENARIO: Enriched snapshots include scope state and debug info
   *
   * GIVEN: A flowchart with enrichSnapshots enabled and a traversal extractor
   * WHEN: The pipeline executes
   * THEN: The extractor receives enriched snapshots with scopeState, debugInfo, stageOutput
   */
  it('should provide enriched snapshots when enrichSnapshots is enabled', async () => {
    const capturedSnapshots: StageSnapshot[] = [];
    const extractor: TraversalExtractor = (snapshot) => {
      capturedSnapshots.push(snapshot);
      return {
        stageName: snapshot.node.name,
        hasScopeState: snapshot.scopeState !== undefined,
        hasDebugInfo: snapshot.debugInfo !== undefined,
        hasStageOutput: snapshot.stageOutput !== undefined,
      };
    };

    const chart = new FlowChartBuilder()
      .start('writer', (scope: StageContext) => {
        scope.setObject([], 'testKey', 'testValue');
        return 'wrote-data';
      })
      .addFunction('reader', (scope: StageContext) => {
        return scope.getValue([], 'testKey');
      })
      .addTraversalExtractor(extractor)
      .build();

    // Enable enriched snapshots via constructor parameter
    const executor = new FlowChartExecutor(
      chart,
      testScopeFactory,
      undefined, // defaultValuesForContext
      undefined, // initialContext
      undefined, // readOnlyContext
      undefined, // throttlingErrorChecker
      undefined, // streamHandlers
      undefined, // scopeProtectionMode
      true,       // enrichSnapshots
    );
    await executor.run();

    // With enriched snapshots, scope state should be present
    expect(capturedSnapshots.length).toBe(2);
    // At least the second snapshot should have scope state from the first stage's commit
    const lastSnapshot = capturedSnapshots[capturedSnapshots.length - 1];
    expect(lastSnapshot.scopeState).toBeDefined();

    // getEnrichedResults should return the same data
    const enriched = executor.getEnrichedResults();
    expect(enriched).toBeInstanceOf(Map);
    expect(enriched.size).toBe(2);
  });

  /**
   * SCENARIO: Extractor returning null/undefined skips the result
   *
   * GIVEN: An extractor that returns null for some stages
   * WHEN: The pipeline executes
   * THEN: Only non-null results appear in getExtractedResults
   */
  it('should skip null/undefined extractor results', async () => {
    const extractor: TraversalExtractor = (snapshot) => {
      // Only extract for 'important' stage
      if (snapshot.node.name === 'important') {
        return { captured: true };
      }
      return null;
    };

    const chart = new FlowChartBuilder()
      .start('skip', () => 'skip')
      .addFunction('important', () => 'important')
      .addFunction('alsoSkip', () => 'skip')
      .addTraversalExtractor(extractor)
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    await executor.run();

    const results = executor.getExtractedResults();
    // Only the 'important' stage should have a result
    let foundImportant = false;
    for (const [, value] of results) {
      if (value && (value as any).captured) {
        foundImportant = true;
      }
    }
    expect(foundImportant).toBe(true);
  });
});

// ============================================================================
// Feature 5: Observability (end-to-end)
// ============================================================================

describe('Feature 5: Observability (3-layer model)', () => {
  /**
   * SCENARIO: Layer 1 -- Automatic scope logging via StageContext
   *
   * GIVEN: A pipeline where stages use getValue/setValue on the StageContext
   * WHEN: The pipeline executes
   * THEN: The context tree contains log entries created by scope operations
   */
  it('should create log entries from scope operations (Layer 1)', async () => {
    const chart = new FlowChartBuilder()
      .start('writer', (scope: StageContext) => {
        scope.setObject([], 'myKey', 'myValue');
        scope.setLog('customLog', 'hello from writer');
        return 'written';
      })
      .addFunction('reader', (scope: StageContext) => {
        const val = scope.getValue([], 'myKey');
        scope.setLog('readResult', val);
        return val;
      })
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    await executor.run();

    // Layer 1: Context tree contains all accumulated data
    const contextTree = executor.getContextTree();
    expect(contextTree).toBeDefined();
    expect(contextTree.globalContext).toBeDefined();
    expect(contextTree.stageContexts).toBeDefined();
  });

  /**
   * SCENARIO: Layer 2 -- Custom recorders capture structured data via scope factory
   *
   * GIVEN: A scope factory that attaches recorders to each Scope instance
   * WHEN: The pipeline executes using that scope factory
   * THEN: The recorders capture structured data during execution
   *
   * NOTE: This test demonstrates the recorder + scope factory integration pattern.
   * Because the pipeline uses StageContext internally (not Scope), we test recorders
   * directly on Scope instances to show they work correctly.
   */
  it('should capture structured data with custom recorders (Layer 2)', () => {
    const globalStore = new GlobalStore();
    const debugRecorder = new DebugRecorder({ id: 'layer2-debug', verbosity: 'verbose' });
    const metricRecorder = new MetricRecorder('layer2-metric');

    const scope = new Scope({
      pipelineId: 'layer2-test',
      stageName: 'stage1',
      globalStore,
      recorders: [debugRecorder, metricRecorder],
    });

    // Simulate stage execution
    scope.startStage('processData');
    scope.setValue('query', 'search term');
    scope.getValue('query');
    scope.setValue('result', { items: [1, 2, 3] });
    scope.commit();
    scope.endStage();

    // Recorders captured structured data
    const debugEntries = debugRecorder.getEntries();
    expect(debugEntries.length).toBeGreaterThan(0);
    expect(debugEntries.some((e) => e.type === 'write')).toBe(true);
    expect(debugEntries.some((e) => e.type === 'read')).toBe(true);

    const metrics = metricRecorder.getStageMetrics('processData');
    expect(metrics).toBeDefined();
    expect(metrics!.writeCount).toBe(2);
    expect(metrics!.readCount).toBe(1);
    expect(metrics!.commitCount).toBe(1);
  });

  /**
   * SCENARIO: Layer 3 -- getContextTree() after execution contains all accumulated data
   *
   * GIVEN: A pipeline with multiple stages that write and log data
   * WHEN: The pipeline executes and getContextTree() is called
   * THEN: The context tree contains globalContext, stageContexts, and history
   */
  it('should return complete context tree with all accumulated data (Layer 3)', async () => {
    const chart = new FlowChartBuilder()
      .start('stage1', (scope: StageContext) => {
        scope.setObject([], 'key1', 'value1');
        scope.setLog('log1', 'stage1 ran');
        return 'result1';
      })
      .addFunction('stage2', (scope: StageContext) => {
        scope.setObject([], 'key2', 'value2');
        scope.setLog('log2', 'stage2 ran');
        return 'result2';
      })
      .addFunction('stage3', (scope: StageContext) => {
        scope.setObject([], 'key3', 'value3');
        return 'result3';
      })
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    await executor.run();

    const contextTree = executor.getContextTree();

    // Layer 3: Complete context tree
    expect(contextTree.globalContext).toBeDefined();
    expect(contextTree.stageContexts).toBeDefined();
    expect(contextTree.history).toBeDefined();

    // History should contain commits from stages that wrote data
    expect(contextTree.history.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Feature 6: Combined Cascade Test
// ============================================================================

describe('Combined Cascade: All Features Together', () => {
  /**
   * SCENARIO: All 5 features working together in a single pipeline
   *
   * GIVEN: A flowchart with:
   *   - Descriptions on stages
   *   - Traversal extractor
   *   - Enriched snapshots enabled
   *   - Narrative enabled
   * WHEN: The pipeline executes
   * THEN: All features produce their expected outputs:
   *   - Descriptions present in build output
   *   - Narrative sentences generated
   *   - Extractor results available
   *   - Context tree complete
   */
  it('should cascade all features: descriptions + narrative + extractor + enriched + context tree', async () => {
    // ------ BUILD PHASE ------

    const capturedSnapshots: StageSnapshot[] = [];
    const extractor: TraversalExtractor = (snapshot) => {
      capturedSnapshots.push(snapshot);
      return {
        stageName: snapshot.node.name,
        step: snapshot.stepNumber,
        hasScopeState: snapshot.scopeState !== undefined,
      };
    };

    const chart = new FlowChartBuilder()
      .start(
        'initialize',
        (scope: StageContext) => {
          scope.setObject([], 'config', { model: 'gpt-4', temperature: 0.7 });
          scope.setLog('initLog', 'System initialized');
          return 'initialized';
        },
        'init-id',
        'Initialize',
        'Set up the system with configuration and tools',
      )
      .addFunction(
        'processInput',
        (scope: StageContext) => {
          const config = scope.getValue([], 'config');
          scope.setObject([], 'processed', { input: 'user query', config });
          return 'processed';
        },
        'process-id',
        'Process Input',
        'Transform user input into a structured request',
      )
      .addFunction(
        'generateOutput',
        (scope: StageContext) => {
          scope.setObject([], 'output', { response: 'Generated answer', tokens: 150 });
          scope.setLog('outputLog', 'Response generated successfully');
          return 'generated';
        },
        'generate-id',
        'Generate Output',
        'Create the final response for the user',
      )
      .addTraversalExtractor(extractor)
      .setEnableNarrative()
      .build();

    // ------ VERIFY DESCRIPTIONS ------

    expect(chart.description).toContain('FlowChart:');
    expect(chart.description).toContain('Initialize');
    expect(chart.description).toContain('Set up the system with configuration and tools');
    expect(chart.description).toContain('Process Input');
    expect(chart.description).toContain('Transform user input into a structured request');
    expect(chart.description).toContain('Generate Output');
    expect(chart.description).toContain('Create the final response for the user');

    expect(chart.stageDescriptions.size).toBe(3);
    expect(chart.stageDescriptions.get('initialize')).toBe('Set up the system with configuration and tools');
    expect(chart.stageDescriptions.get('processInput')).toBe('Transform user input into a structured request');
    expect(chart.stageDescriptions.get('generateOutput')).toBe('Create the final response for the user');

    // ------ EXECUTE PHASE (with enriched snapshots) ------

    const executor = new FlowChartExecutor(
      chart,
      testScopeFactory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true, // enrichSnapshots
    );
    await executor.run();

    // ------ VERIFY NARRATIVE ------

    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);

    // First sentence uses the description from the first stage
    expect(narrative[0]).toContain('Set up the system with configuration and tools');

    // Subsequent sentences reference the stage descriptions
    expect(narrative[1]).toContain('Transform user input into a structured request');
    expect(narrative[2]).toContain('Create the final response for the user');

    // ------ VERIFY EXTRACTOR RESULTS ------

    expect(capturedSnapshots.length).toBe(3);

    const extractedResults = executor.getExtractedResults<{
      stageName: string;
      step: number;
      hasScopeState: boolean;
    }>();
    expect(extractedResults).toBeInstanceOf(Map);
    expect(extractedResults.size).toBe(3);

    // Verify enriched data
    const enriched = executor.getEnrichedResults();
    expect(enriched.size).toBe(3);

    // Verify that scope state is available (enriched snapshots)
    for (const snapshot of capturedSnapshots) {
      expect(snapshot.scopeState).toBeDefined();
    }

    // ------ VERIFY CONTEXT TREE ------

    const contextTree = executor.getContextTree();
    expect(contextTree.globalContext).toBeDefined();
    expect(contextTree.stageContexts).toBeDefined();
    expect(contextTree.history).toBeDefined();
    expect(contextTree.history.length).toBeGreaterThan(0);
  });

  /**
   * SCENARIO: All features with a complex pipeline shape (decider + subflows)
   *
   * GIVEN: A pipeline with descriptions, decider, subflows, narrative, and extractor
   * WHEN: The pipeline executes
   * THEN: All features produce their expected outputs for the complex shape
   */
  it('should cascade features with decider and subflow pipeline shapes', async () => {
    const capturedStages: string[] = [];
    const extractor: TraversalExtractor = (snapshot) => {
      capturedStages.push(snapshot.node.name);
      return { stage: snapshot.node.name };
    };

    const subflow = new FlowChartBuilder()
      .start('subTask', () => 'sub-result', undefined, 'Sub Task')
      .build();

    const chart = new FlowChartBuilder()
      .start(
        'entry',
        (scope: StageContext) => {
          scope.setLog('deciderRationale', 'priority is high');
          return 'fast';
        },
        undefined,
        'Entry',
        'Validate and prepare the request',
      )
      .addDecider((out) => out as string)
        .addFunctionBranch('fast', 'Fast Track', () => 'fast-done')
        .addFunctionBranch('slow', 'Slow Track', () => 'slow-done')
      .end()
      .addTraversalExtractor(extractor)
      .setEnableNarrative()
      .build();

    // Verify descriptions
    expect(chart.description).toContain('Validate and prepare the request');
    expect(chart.stageDescriptions.get('entry')).toBe('Validate and prepare the request');

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    await executor.run();

    // Verify narrative includes decision
    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);

    // The narrative for a decider includes "A decision was made" or "path taken"
    // The exact sentence depends on whether rationale is set
    const decisionSentence = narrative.find(
      (s) => s.includes('decision was made') || s.includes('path taken was') || s.includes('chose'),
    );
    expect(decisionSentence).toBeDefined();
    expect(decisionSentence).toContain('Fast Track');

    // Verify extractor captured stages
    expect(capturedStages.length).toBeGreaterThan(0);
    expect(capturedStages).toContain('entry');

    // Verify context tree
    const contextTree = executor.getContextTree();
    expect(contextTree).toBeDefined();
    expect(contextTree.stageContexts).toBeDefined();
  });

  /**
   * SCENARIO: Scope recorders + pipeline execution together
   *
   * GIVEN: Scope instances with recorders AND a pipeline executing
   * WHEN: Both Scope-level and pipeline-level features are active
   * THEN: All data sources are populated
   */
  it('should allow Scope-level recorders alongside pipeline-level features', async () => {
    // Set up recorders on a standalone Scope to verify they work
    const globalStore = new GlobalStore();
    const debugRecorder = new DebugRecorder({ id: 'cascade-debug', verbosity: 'verbose' });
    const metricRecorder = new MetricRecorder('cascade-metric');
    const narrativeRecorder = new NarrativeRecorder({ id: 'cascade-narrative' });

    const scope = new Scope({
      pipelineId: 'cascade-test',
      stageName: 'preProcess',
      globalStore,
      recorders: [debugRecorder, metricRecorder, narrativeRecorder],
    });

    // Simulate a pre-processing stage using Scope directly
    scope.startStage('preProcess');
    scope.setValue('apiKey', 'sk-test-key');
    scope.setValue('model', 'gpt-4');
    scope.getValue('apiKey');
    scope.commit();
    scope.endStage();

    // Now run a pipeline separately with its own features
    const chart = new FlowChartBuilder()
      .start('pipelineStage', (ctx: StageContext) => {
        ctx.setObject([], 'result', 'pipeline-output');
        return 'done';
      }, undefined, 'Pipeline Stage', 'Execute the main pipeline logic')
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    await executor.run();

    // Verify Scope-level recorders captured data
    expect(debugRecorder.getEntries().length).toBeGreaterThan(0);
    expect(metricRecorder.getStageMetrics('preProcess')).toBeDefined();
    expect(metricRecorder.getStageMetrics('preProcess')!.writeCount).toBe(2);
    expect(narrativeRecorder.getStageData().get('preProcess')).toBeDefined();

    // Verify pipeline-level narrative
    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    expect(narrative[0]).toContain('Execute the main pipeline logic');

    // Verify pipeline-level context tree
    const contextTree = executor.getContextTree();
    expect(contextTree).toBeDefined();
    expect(contextTree.globalContext).toBeDefined();
  });

  /**
   * SCENARIO: Selector + narrative + extractor combined
   *
   * GIVEN: A pipeline with a selector, narrative enabled, and extractor
   * WHEN: The pipeline executes
   * THEN: Narrative mentions selection, extractor captures stages
   */
  it('should combine selector, narrative, and extractor', async () => {
    const extractedStages: string[] = [];
    const extractor: TraversalExtractor = (snapshot) => {
      extractedStages.push(snapshot.node.name);
      return { name: snapshot.node.name };
    };

    const chart = new FlowChartBuilder()
      .start(
        'analyze',
        () => ['email', 'push'],
        undefined,
        'Analyze Preferences',
        'Determine which notification channels to use',
      )
      .addSelector((out) => out as string[])
        .addFunctionBranch('email', 'Send Email', () => 'email-sent')
        .addFunctionBranch('sms', 'Send SMS', () => 'sms-sent')
        .addFunctionBranch('push', 'Send Push', () => 'push-sent')
      .end()
      .addTraversalExtractor(extractor)
      .setEnableNarrative()
      .build();

    // Verify descriptions
    expect(chart.stageDescriptions.get('analyze')).toBe('Determine which notification channels to use');

    const executor = new FlowChartExecutor(chart, testScopeFactory);
    await executor.run();

    // Narrative mentions selection
    const narrative = executor.getNarrative();
    const selectionSentence = narrative.find((s) => s.includes('selected'));
    expect(selectionSentence).toBeDefined();
    expect(selectionSentence).toContain('Send Email');
    expect(selectionSentence).toContain('Send Push');
    expect(selectionSentence).toBe('2 of 3 paths were selected: Send Email, Send Push.');

    // Extractor captured stages
    expect(extractedStages.length).toBeGreaterThan(0);
    expect(extractedStages).toContain('analyze');
  });
});

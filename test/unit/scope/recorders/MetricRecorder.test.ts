/**
 * MetricRecorder Unit Tests
 * ----------------------------------------------------------------------------
 * Tests for the MetricRecorder class that captures timing and execution counts.
 *
 * Requirements tested: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */

import { MetricRecorder, type StageMetrics, type AggregatedMetrics } from '../../../../src/scope/recorders/MetricRecorder';
import type { ReadEvent, WriteEvent, CommitEvent, StageEvent } from '../../../../src/scope/types';

describe('MetricRecorder', () => {
  // ==========================================================================
  // Construction
  // ==========================================================================

  describe('constructor', () => {
    it('should create with default id when none provided', () => {
      const recorder = new MetricRecorder();
      expect(recorder.id).toMatch(/^metric-recorder-\d+$/);
    });

    it('should create with custom id when provided', () => {
      const recorder = new MetricRecorder('my-custom-id');
      expect(recorder.id).toBe('my-custom-id');
    });

    it('should start with empty metrics', () => {
      const recorder = new MetricRecorder();
      const metrics = recorder.getMetrics();
      
      expect(metrics.totalReads).toBe(0);
      expect(metrics.totalWrites).toBe(0);
      expect(metrics.totalCommits).toBe(0);
      expect(metrics.totalDuration).toBe(0);
      expect(metrics.stageMetrics.size).toBe(0);
    });
  });

  // ==========================================================================
  // Read Tracking (Requirement 5.2)
  // ==========================================================================

  describe('onRead', () => {
    it('should increment read count for a stage', () => {
      const recorder = new MetricRecorder('test');
      
      const event: ReadEvent = {
        stageName: 'stage1',
        pipelineId: 'pipeline1',
        timestamp: Date.now(),
        path: ['data'],
        key: 'value',
        value: 'test',
      };

      recorder.onRead(event);
      
      const stageMetrics = recorder.getStageMetrics('stage1');
      expect(stageMetrics?.readCount).toBe(1);
    });

    it('should track reads across multiple stages', () => {
      const recorder = new MetricRecorder('test');
      const now = Date.now();

      recorder.onRead({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], value: null });
      recorder.onRead({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], value: null });
      recorder.onRead({ stageName: 'stage2', pipelineId: 'p1', timestamp: now, path: [], value: null });

      expect(recorder.getStageMetrics('stage1')?.readCount).toBe(2);
      expect(recorder.getStageMetrics('stage2')?.readCount).toBe(1);
      expect(recorder.getMetrics().totalReads).toBe(3);
    });
  });

  // ==========================================================================
  // Write Tracking (Requirement 5.3)
  // ==========================================================================

  describe('onWrite', () => {
    it('should increment write count for a stage', () => {
      const recorder = new MetricRecorder('test');
      
      const event: WriteEvent = {
        stageName: 'stage1',
        pipelineId: 'pipeline1',
        timestamp: Date.now(),
        path: ['data'],
        key: 'value',
        value: 'test',
        operation: 'set',
      };

      recorder.onWrite(event);
      
      const stageMetrics = recorder.getStageMetrics('stage1');
      expect(stageMetrics?.writeCount).toBe(1);
    });

    it('should track both set and update operations as writes', () => {
      const recorder = new MetricRecorder('test');
      const now = Date.now();

      recorder.onWrite({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], key: 'k1', value: 1, operation: 'set' });
      recorder.onWrite({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], key: 'k2', value: 2, operation: 'update' });

      expect(recorder.getStageMetrics('stage1')?.writeCount).toBe(2);
    });

    it('should track writes across multiple stages', () => {
      const recorder = new MetricRecorder('test');
      const now = Date.now();

      recorder.onWrite({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], key: 'k', value: 1, operation: 'set' });
      recorder.onWrite({ stageName: 'stage2', pipelineId: 'p1', timestamp: now, path: [], key: 'k', value: 2, operation: 'set' });
      recorder.onWrite({ stageName: 'stage2', pipelineId: 'p1', timestamp: now, path: [], key: 'k', value: 3, operation: 'set' });

      expect(recorder.getStageMetrics('stage1')?.writeCount).toBe(1);
      expect(recorder.getStageMetrics('stage2')?.writeCount).toBe(2);
      expect(recorder.getMetrics().totalWrites).toBe(3);
    });
  });

  // ==========================================================================
  // Commit Tracking (Requirement 5.4)
  // ==========================================================================

  describe('onCommit', () => {
    it('should increment commit count for a stage', () => {
      const recorder = new MetricRecorder('test');
      
      const event: CommitEvent = {
        stageName: 'stage1',
        pipelineId: 'pipeline1',
        timestamp: Date.now(),
        mutations: [],
      };

      recorder.onCommit(event);
      
      const stageMetrics = recorder.getStageMetrics('stage1');
      expect(stageMetrics?.commitCount).toBe(1);
    });

    it('should track commits across multiple stages', () => {
      const recorder = new MetricRecorder('test');
      const now = Date.now();

      recorder.onCommit({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, mutations: [] });
      recorder.onCommit({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, mutations: [] });
      recorder.onCommit({ stageName: 'stage2', pipelineId: 'p1', timestamp: now, mutations: [] });

      expect(recorder.getStageMetrics('stage1')?.commitCount).toBe(2);
      expect(recorder.getStageMetrics('stage2')?.commitCount).toBe(1);
      expect(recorder.getMetrics().totalCommits).toBe(3);
    });
  });

  // ==========================================================================
  // Duration Tracking (Requirements 5.1, 5.7)
  // ==========================================================================

  describe('onStageStart/onStageEnd', () => {
    it('should track stage duration using event duration', () => {
      const recorder = new MetricRecorder('test');
      const startTime = 1000;
      const endTime = 1500;

      recorder.onStageStart({ stageName: 'stage1', pipelineId: 'p1', timestamp: startTime });
      recorder.onStageEnd({ stageName: 'stage1', pipelineId: 'p1', timestamp: endTime, duration: 500 });

      const stageMetrics = recorder.getStageMetrics('stage1');
      expect(stageMetrics?.totalDuration).toBe(500);
    });

    it('should calculate duration from timestamps when duration not provided', () => {
      const recorder = new MetricRecorder('test');
      const startTime = 1000;
      const endTime = 1500;

      recorder.onStageStart({ stageName: 'stage1', pipelineId: 'p1', timestamp: startTime });
      recorder.onStageEnd({ stageName: 'stage1', pipelineId: 'p1', timestamp: endTime });

      const stageMetrics = recorder.getStageMetrics('stage1');
      expect(stageMetrics?.totalDuration).toBe(500);
    });

    it('should increment invocation count on stage start', () => {
      const recorder = new MetricRecorder('test');
      const now = Date.now();

      recorder.onStageStart({ stageName: 'stage1', pipelineId: 'p1', timestamp: now });
      recorder.onStageEnd({ stageName: 'stage1', pipelineId: 'p1', timestamp: now + 100, duration: 100 });
      
      recorder.onStageStart({ stageName: 'stage1', pipelineId: 'p1', timestamp: now + 200 });
      recorder.onStageEnd({ stageName: 'stage1', pipelineId: 'p1', timestamp: now + 300, duration: 100 });

      const stageMetrics = recorder.getStageMetrics('stage1');
      expect(stageMetrics?.invocationCount).toBe(2);
    });

    it('should accumulate duration across multiple invocations', () => {
      const recorder = new MetricRecorder('test');

      recorder.onStageStart({ stageName: 'stage1', pipelineId: 'p1', timestamp: 1000 });
      recorder.onStageEnd({ stageName: 'stage1', pipelineId: 'p1', timestamp: 1100, duration: 100 });
      
      recorder.onStageStart({ stageName: 'stage1', pipelineId: 'p1', timestamp: 2000 });
      recorder.onStageEnd({ stageName: 'stage1', pipelineId: 'p1', timestamp: 2200, duration: 200 });

      const stageMetrics = recorder.getStageMetrics('stage1');
      expect(stageMetrics?.totalDuration).toBe(300);
    });

    it('should handle onStageEnd without prior onStageStart', () => {
      const recorder = new MetricRecorder('test');

      // Should not throw, duration should be 0
      recorder.onStageEnd({ stageName: 'stage1', pipelineId: 'p1', timestamp: 1000 });

      const stageMetrics = recorder.getStageMetrics('stage1');
      expect(stageMetrics?.totalDuration).toBe(0);
    });

    it('should track duration across multiple stages', () => {
      const recorder = new MetricRecorder('test');

      recorder.onStageStart({ stageName: 'stage1', pipelineId: 'p1', timestamp: 1000 });
      recorder.onStageEnd({ stageName: 'stage1', pipelineId: 'p1', timestamp: 1100, duration: 100 });
      
      recorder.onStageStart({ stageName: 'stage2', pipelineId: 'p1', timestamp: 2000 });
      recorder.onStageEnd({ stageName: 'stage2', pipelineId: 'p1', timestamp: 2300, duration: 300 });

      expect(recorder.getStageMetrics('stage1')?.totalDuration).toBe(100);
      expect(recorder.getStageMetrics('stage2')?.totalDuration).toBe(300);
      expect(recorder.getMetrics().totalDuration).toBe(400);
    });
  });

  // ==========================================================================
  // Metrics Retrieval (Requirement 5.5)
  // ==========================================================================

  describe('getMetrics', () => {
    it('should return aggregated metrics across all stages', () => {
      const recorder = new MetricRecorder('test');
      const now = Date.now();

      // Stage 1: 2 reads, 1 write, 1 commit, 100ms
      recorder.onStageStart({ stageName: 'stage1', pipelineId: 'p1', timestamp: now });
      recorder.onRead({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], value: null });
      recorder.onRead({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], value: null });
      recorder.onWrite({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], key: 'k', value: 1, operation: 'set' });
      recorder.onCommit({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, mutations: [] });
      recorder.onStageEnd({ stageName: 'stage1', pipelineId: 'p1', timestamp: now + 100, duration: 100 });

      // Stage 2: 1 read, 2 writes, 1 commit, 200ms
      recorder.onStageStart({ stageName: 'stage2', pipelineId: 'p1', timestamp: now + 100 });
      recorder.onRead({ stageName: 'stage2', pipelineId: 'p1', timestamp: now + 100, path: [], value: null });
      recorder.onWrite({ stageName: 'stage2', pipelineId: 'p1', timestamp: now + 100, path: [], key: 'k', value: 1, operation: 'set' });
      recorder.onWrite({ stageName: 'stage2', pipelineId: 'p1', timestamp: now + 100, path: [], key: 'k', value: 2, operation: 'set' });
      recorder.onCommit({ stageName: 'stage2', pipelineId: 'p1', timestamp: now + 100, mutations: [] });
      recorder.onStageEnd({ stageName: 'stage2', pipelineId: 'p1', timestamp: now + 300, duration: 200 });

      const metrics = recorder.getMetrics();

      expect(metrics.totalReads).toBe(3);
      expect(metrics.totalWrites).toBe(3);
      expect(metrics.totalCommits).toBe(2);
      expect(metrics.totalDuration).toBe(300);
      expect(metrics.stageMetrics.size).toBe(2);
    });

    it('should return a copy of stageMetrics map', () => {
      const recorder = new MetricRecorder('test');
      const now = Date.now();

      recorder.onRead({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], value: null });

      const metrics1 = recorder.getMetrics();
      const metrics2 = recorder.getMetrics();

      // Should be different map instances
      expect(metrics1.stageMetrics).not.toBe(metrics2.stageMetrics);
      
      // Modifying one should not affect the other
      metrics1.stageMetrics.clear();
      expect(metrics2.stageMetrics.size).toBe(1);
    });
  });

  describe('getStageMetrics', () => {
    it('should return undefined for unknown stage', () => {
      const recorder = new MetricRecorder('test');
      expect(recorder.getStageMetrics('unknown')).toBeUndefined();
    });

    it('should return metrics for known stage', () => {
      const recorder = new MetricRecorder('test');
      const now = Date.now();

      recorder.onRead({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], value: null });
      recorder.onWrite({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], key: 'k', value: 1, operation: 'set' });

      const stageMetrics = recorder.getStageMetrics('stage1');
      
      expect(stageMetrics).toBeDefined();
      expect(stageMetrics?.stageName).toBe('stage1');
      expect(stageMetrics?.readCount).toBe(1);
      expect(stageMetrics?.writeCount).toBe(1);
    });

    it('should return a copy of stage metrics', () => {
      const recorder = new MetricRecorder('test');
      const now = Date.now();

      recorder.onRead({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], value: null });

      const metrics1 = recorder.getStageMetrics('stage1');
      const metrics2 = recorder.getStageMetrics('stage1');

      // Should be different object instances
      expect(metrics1).not.toBe(metrics2);
      
      // Modifying one should not affect the other
      if (metrics1) {
        metrics1.readCount = 999;
      }
      expect(metrics2?.readCount).toBe(1);
    });
  });

  // ==========================================================================
  // Reset (Requirement 5.6)
  // ==========================================================================

  describe('reset', () => {
    it('should clear all metrics', () => {
      const recorder = new MetricRecorder('test');
      const now = Date.now();

      // Add some metrics
      recorder.onStageStart({ stageName: 'stage1', pipelineId: 'p1', timestamp: now });
      recorder.onRead({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], value: null });
      recorder.onWrite({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], key: 'k', value: 1, operation: 'set' });
      recorder.onCommit({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, mutations: [] });
      recorder.onStageEnd({ stageName: 'stage1', pipelineId: 'p1', timestamp: now + 100, duration: 100 });

      // Verify metrics exist
      expect(recorder.getMetrics().totalReads).toBe(1);
      expect(recorder.getMetrics().stageMetrics.size).toBe(1);

      // Reset
      recorder.reset();

      // Verify all metrics are cleared
      const metrics = recorder.getMetrics();
      expect(metrics.totalReads).toBe(0);
      expect(metrics.totalWrites).toBe(0);
      expect(metrics.totalCommits).toBe(0);
      expect(metrics.totalDuration).toBe(0);
      expect(metrics.stageMetrics.size).toBe(0);
    });

    it('should allow recording new metrics after reset', () => {
      const recorder = new MetricRecorder('test');
      const now = Date.now();

      // Add metrics, reset, add more
      recorder.onRead({ stageName: 'stage1', pipelineId: 'p1', timestamp: now, path: [], value: null });
      recorder.reset();
      recorder.onRead({ stageName: 'stage2', pipelineId: 'p1', timestamp: now, path: [], value: null });

      const metrics = recorder.getMetrics();
      expect(metrics.totalReads).toBe(1);
      expect(metrics.stageMetrics.has('stage1')).toBe(false);
      expect(metrics.stageMetrics.has('stage2')).toBe(true);
    });

    it('should clear pending stage start times', () => {
      const recorder = new MetricRecorder('test');

      // Start a stage but don't end it
      recorder.onStageStart({ stageName: 'stage1', pipelineId: 'p1', timestamp: 1000 });
      
      // Reset
      recorder.reset();

      // End the stage - should not calculate duration from old start time
      recorder.onStageEnd({ stageName: 'stage1', pipelineId: 'p1', timestamp: 2000 });

      const stageMetrics = recorder.getStageMetrics('stage1');
      expect(stageMetrics?.totalDuration).toBe(0);
    });
  });

  // ==========================================================================
  // Integration with Scope
  // ==========================================================================

  describe('integration', () => {
    it('should work as a Recorder implementation', () => {
      const recorder = new MetricRecorder('test');

      // Verify it has the required Recorder interface
      expect(recorder.id).toBeDefined();
      expect(typeof recorder.onRead).toBe('function');
      expect(typeof recorder.onWrite).toBe('function');
      expect(typeof recorder.onCommit).toBe('function');
      expect(typeof recorder.onStageStart).toBe('function');
      expect(typeof recorder.onStageEnd).toBe('function');
    });

    it('should handle a realistic stage execution sequence', () => {
      const recorder = new MetricRecorder('test');
      const baseTime = 1000;

      // Simulate a stage execution
      recorder.onStageStart({ stageName: 'processData', pipelineId: 'main', timestamp: baseTime });
      
      // Read input
      recorder.onRead({ stageName: 'processData', pipelineId: 'main', timestamp: baseTime + 10, path: ['input'], key: 'data', value: { items: [1, 2, 3] } });
      
      // Process and write results
      recorder.onWrite({ stageName: 'processData', pipelineId: 'main', timestamp: baseTime + 50, path: ['output'], key: 'result', value: { sum: 6 }, operation: 'set' });
      recorder.onWrite({ stageName: 'processData', pipelineId: 'main', timestamp: baseTime + 60, path: ['output'], key: 'metadata', value: { count: 3 }, operation: 'set' });
      
      // Commit
      recorder.onCommit({ stageName: 'processData', pipelineId: 'main', timestamp: baseTime + 70, mutations: [] });
      
      // End stage
      recorder.onStageEnd({ stageName: 'processData', pipelineId: 'main', timestamp: baseTime + 100, duration: 100 });

      const metrics = recorder.getMetrics();
      expect(metrics.totalReads).toBe(1);
      expect(metrics.totalWrites).toBe(2);
      expect(metrics.totalCommits).toBe(1);
      expect(metrics.totalDuration).toBe(100);

      const stageMetrics = recorder.getStageMetrics('processData');
      expect(stageMetrics?.invocationCount).toBe(1);
    });
  });
});

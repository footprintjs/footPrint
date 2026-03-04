/**
 * DebugRecorder Unit Tests
 * ----------------------------------------------------------------------------
 * Tests for the DebugRecorder class that captures detailed debug information.
 *
 * Requirements tested: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */

import {
  DebugRecorder,
  type DebugEntry,
  type DebugVerbosity,
} from '../../../../src/scope/recorders/DebugRecorder';
import type { ReadEvent, WriteEvent, ErrorEvent, StageEvent } from '../../../../src/scope/types';

describe('DebugRecorder', () => {
  // ==========================================================================
  // Construction
  // ==========================================================================

  describe('constructor', () => {
    it('should create with default id when none provided', () => {
      const recorder = new DebugRecorder();
      expect(recorder.id).toMatch(/^debug-recorder-\d+$/);
    });

    it('should create with custom id when provided', () => {
      const recorder = new DebugRecorder({ id: 'my-custom-id' });
      expect(recorder.id).toBe('my-custom-id');
    });

    it('should start with empty entries', () => {
      const recorder = new DebugRecorder();
      expect(recorder.getEntries()).toHaveLength(0);
      expect(recorder.getErrors()).toHaveLength(0);
    });

    it('should default to verbose verbosity', () => {
      const recorder = new DebugRecorder();
      expect(recorder.getVerbosity()).toBe('verbose');
    });

    it('should accept custom verbosity', () => {
      const recorder = new DebugRecorder({ verbosity: 'minimal' });
      expect(recorder.getVerbosity()).toBe('minimal');
    });
  });

  // ==========================================================================
  // Error Recording (Requirement 6.1)
  // ==========================================================================

  describe('onError', () => {
    it('should record errors regardless of verbosity level', () => {
      const recorder = new DebugRecorder({ verbosity: 'minimal' });
      const error = new Error('Test error');

      const event: ErrorEvent = {
        stageName: 'stage1',
        pipelineId: 'pipeline1',
        timestamp: 1000,
        error,
        operation: 'read',
        key: 'value',
      };

      recorder.onError(event);

      const errors = recorder.getErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe('error');
      expect(errors[0].stageName).toBe('stage1');
      expect((errors[0].data as any).error).toBe(error);
    });

    it('should record errors in verbose mode', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });
      const error = new Error('Test error');

      recorder.onError({
        stageName: 'stage1',
        pipelineId: 'pipeline1',
        timestamp: 1000,
        error,
        operation: 'write',
      });

      expect(recorder.getErrors()).toHaveLength(1);
    });

    it('should capture error operation type', () => {
      const recorder = new DebugRecorder();
      const error = new Error('Test error');

      recorder.onError({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        error,
        operation: 'commit',
      });

      const errors = recorder.getErrors();
      expect((errors[0].data as any).operation).toBe('commit');
    });

    it('should capture error key when provided', () => {
      const recorder = new DebugRecorder();
      const error = new Error('Test error');

      recorder.onError({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        error,
        operation: 'read',
        key: 'myKey',
      });

      const errors = recorder.getErrors();
      expect((errors[0].data as any).key).toBe('myKey');
    });

    it('should track multiple errors', () => {
      const recorder = new DebugRecorder();

      recorder.onError({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        error: new Error('Error 1'),
        operation: 'read',
      });

      recorder.onError({
        stageName: 'stage2',
        pipelineId: 'p1',
        timestamp: 2000,
        error: new Error('Error 2'),
        operation: 'write',
      });

      expect(recorder.getErrors()).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Mutation Recording (Requirements 6.2, 6.3)
  // ==========================================================================

  describe('onWrite', () => {
    it('should record writes in verbose mode', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      const event: WriteEvent = {
        stageName: 'stage1',
        pipelineId: 'pipeline1',
        timestamp: 1000,
        key: 'value',
        value: { test: 'data' },
        operation: 'set',
      };

      recorder.onWrite(event);

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('write');
      expect(entries[0].stageName).toBe('stage1');
      expect((entries[0].data as any).key).toBe('value');
      expect((entries[0].data as any).value).toEqual({ test: 'data' });
      expect((entries[0].data as any).operation).toBe('set');
    });

    it('should NOT record writes in minimal mode', () => {
      const recorder = new DebugRecorder({ verbosity: 'minimal' });

      recorder.onWrite({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        key: 'value',
        value: 'test',
        operation: 'set',
      });

      expect(recorder.getEntries()).toHaveLength(0);
    });

    it('should record both set and update operations', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onWrite({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        key: 'k1',
        value: 1,
        operation: 'set',
      });

      recorder.onWrite({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 2000,
        key: 'k2',
        value: 2,
        operation: 'update',
      });

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(2);
      expect((entries[0].data as any).operation).toBe('set');
      expect((entries[1].data as any).operation).toBe('update');
    });

    it('should capture key for each write (Requirement 6.3)', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onWrite({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        key: 'myKey',
        value: 'myValue',
        operation: 'set',
      });

      const entries = recorder.getEntries();
      expect((entries[0].data as any).key).toBe('myKey');
    });
  });

  // ==========================================================================
  // Read Recording (Requirement 6.7)
  // ==========================================================================

  describe('onRead', () => {
    it('should record reads in verbose mode', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      const event: ReadEvent = {
        stageName: 'stage1',
        pipelineId: 'pipeline1',
        timestamp: 1000,
        key: 'value',
        value: 'test',
      };

      recorder.onRead(event);

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('read');
      expect(entries[0].stageName).toBe('stage1');
      expect((entries[0].data as any).key).toBe('value');
      expect((entries[0].data as any).value).toBe('test');
    });

    it('should NOT record reads in minimal mode', () => {
      const recorder = new DebugRecorder({ verbosity: 'minimal' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'test',
      });

      expect(recorder.getEntries()).toHaveLength(0);
    });

    it('should handle reads without key', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: { nested: 'object' },
      });

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(1);
      expect((entries[0].data as any).key).toBeUndefined();
    });
  });

  // ==========================================================================
  // Stage Events
  // ==========================================================================

  describe('onStageStart/onStageEnd', () => {
    it('should record stage start in verbose mode', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onStageStart({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
      });

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('stageStart');
      expect(entries[0].stageName).toBe('stage1');
    });

    it('should record stage end in verbose mode', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onStageEnd({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        duration: 500,
      });

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('stageEnd');
      expect((entries[0].data as any).duration).toBe(500);
    });

    it('should NOT record stage events in minimal mode', () => {
      const recorder = new DebugRecorder({ verbosity: 'minimal' });

      recorder.onStageStart({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
      });

      recorder.onStageEnd({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 2000,
        duration: 1000,
      });

      expect(recorder.getEntries()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Verbosity Levels (Requirement 6.4)
  // ==========================================================================

  describe('setVerbosity', () => {
    it('should change verbosity level', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });
      expect(recorder.getVerbosity()).toBe('verbose');

      recorder.setVerbosity('minimal');
      expect(recorder.getVerbosity()).toBe('minimal');

      recorder.setVerbosity('verbose');
      expect(recorder.getVerbosity()).toBe('verbose');
    });

    it('should affect future recordings', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      // Record in verbose mode
      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'test1',
      });

      // Switch to minimal
      recorder.setVerbosity('minimal');

      // This read should NOT be recorded
      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 2000,
        value: 'test2',
      });

      // But errors should still be recorded
      recorder.onError({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 3000,
        error: new Error('test'),
        operation: 'read',
      });

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(2); // 1 read + 1 error
      expect(entries[0].type).toBe('read');
      expect(entries[1].type).toBe('error');
    });

    it('should not affect existing entries', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'test',
      });

      recorder.setVerbosity('minimal');

      // Existing entries should still be there
      expect(recorder.getEntries()).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Entry Retrieval (Requirement 6.5)
  // ==========================================================================

  describe('getEntries', () => {
    it('should return all recorded entries', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'test',
      });

      recorder.onWrite({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 2000,
        key: 'k',
        value: 'v',
        operation: 'set',
      });

      recorder.onError({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 3000,
        error: new Error('test'),
        operation: 'read',
      });

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(3);
    });

    it('should return entries in chronological order', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'first',
      });

      recorder.onWrite({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 2000,
        key: 'k',
        value: 'second',
        operation: 'set',
      });

      const entries = recorder.getEntries();
      expect(entries[0].timestamp).toBe(1000);
      expect(entries[1].timestamp).toBe(2000);
    });

    it('should return a copy of entries array', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'test',
      });

      const entries1 = recorder.getEntries();
      const entries2 = recorder.getEntries();

      // Should be different array instances
      expect(entries1).not.toBe(entries2);

      // Modifying one should not affect the other
      entries1.pop();
      expect(entries2).toHaveLength(1);
    });
  });

  describe('getErrors', () => {
    it('should return only error entries', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'test',
      });

      recorder.onError({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 2000,
        error: new Error('error1'),
        operation: 'read',
      });

      recorder.onWrite({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 3000,
        key: 'k',
        value: 'v',
        operation: 'set',
      });

      recorder.onError({
        stageName: 'stage2',
        pipelineId: 'p1',
        timestamp: 4000,
        error: new Error('error2'),
        operation: 'write',
      });

      const errors = recorder.getErrors();
      expect(errors).toHaveLength(2);
      expect(errors.every((e) => e.type === 'error')).toBe(true);
    });

    it('should return empty array when no errors', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'test',
      });

      expect(recorder.getErrors()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Stage Filtering (Requirement 6.6)
  // ==========================================================================

  describe('getEntriesForStage', () => {
    it('should return only entries for the specified stage', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'test1',
      });

      recorder.onRead({
        stageName: 'stage2',
        pipelineId: 'p1',
        timestamp: 2000,
        value: 'test2',
      });

      recorder.onWrite({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 3000,
        key: 'k',
        value: 'v',
        operation: 'set',
      });

      const stage1Entries = recorder.getEntriesForStage('stage1');
      expect(stage1Entries).toHaveLength(2);
      expect(stage1Entries.every((e) => e.stageName === 'stage1')).toBe(true);

      const stage2Entries = recorder.getEntriesForStage('stage2');
      expect(stage2Entries).toHaveLength(1);
      expect(stage2Entries[0].stageName).toBe('stage2');
    });

    it('should return empty array for unknown stage', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'test',
      });

      expect(recorder.getEntriesForStage('unknown')).toHaveLength(0);
    });

    it('should include all entry types for the stage', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onStageStart({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
      });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 2000,
        value: 'test',
      });

      recorder.onWrite({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 3000,
        key: 'k',
        value: 'v',
        operation: 'set',
      });

      recorder.onError({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 4000,
        error: new Error('test'),
        operation: 'read',
      });

      recorder.onStageEnd({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 5000,
        duration: 4000,
      });

      const entries = recorder.getEntriesForStage('stage1');
      expect(entries).toHaveLength(5);

      const types = entries.map((e) => e.type);
      expect(types).toContain('stageStart');
      expect(types).toContain('read');
      expect(types).toContain('write');
      expect(types).toContain('error');
      expect(types).toContain('stageEnd');
    });
  });

  // ==========================================================================
  // Clear
  // ==========================================================================

  describe('clear', () => {
    it('should remove all entries', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'test',
      });

      recorder.onError({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 2000,
        error: new Error('test'),
        operation: 'read',
      });

      expect(recorder.getEntries()).toHaveLength(2);
      expect(recorder.getErrors()).toHaveLength(1);

      recorder.clear();

      expect(recorder.getEntries()).toHaveLength(0);
      expect(recorder.getErrors()).toHaveLength(0);
    });

    it('should allow recording new entries after clear', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'p1',
        timestamp: 1000,
        value: 'old',
      });

      recorder.clear();

      recorder.onRead({
        stageName: 'stage2',
        pipelineId: 'p1',
        timestamp: 2000,
        value: 'new',
      });

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].stageName).toBe('stage2');
    });

    it('should not affect verbosity setting', () => {
      const recorder = new DebugRecorder({ verbosity: 'minimal' });

      recorder.clear();

      expect(recorder.getVerbosity()).toBe('minimal');
    });
  });

  // ==========================================================================
  // Integration
  // ==========================================================================

  describe('integration', () => {
    it('should work as a Recorder implementation', () => {
      const recorder = new DebugRecorder();

      // Verify it has the required Recorder interface
      expect(recorder.id).toBeDefined();
      expect(typeof recorder.onRead).toBe('function');
      expect(typeof recorder.onWrite).toBe('function');
      expect(typeof recorder.onError).toBe('function');
      expect(typeof recorder.onStageStart).toBe('function');
      expect(typeof recorder.onStageEnd).toBe('function');
    });

    it('should handle a realistic stage execution sequence', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });
      const baseTime = 1000;

      // Simulate a stage execution
      recorder.onStageStart({
        stageName: 'processData',
        pipelineId: 'main',
        timestamp: baseTime,
      });

      // Read input
      recorder.onRead({
        stageName: 'processData',
        pipelineId: 'main',
        timestamp: baseTime + 10,
        key: 'data',
        value: { items: [1, 2, 3] },
      });

      // Process and write results
      recorder.onWrite({
        stageName: 'processData',
        pipelineId: 'main',
        timestamp: baseTime + 50,
        key: 'result',
        value: { sum: 6 },
        operation: 'set',
      });

      // End stage
      recorder.onStageEnd({
        stageName: 'processData',
        pipelineId: 'main',
        timestamp: baseTime + 100,
        duration: 100,
      });

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(4);
      expect(entries[0].type).toBe('stageStart');
      expect(entries[1].type).toBe('read');
      expect(entries[2].type).toBe('write');
      expect(entries[3].type).toBe('stageEnd');

      const stageEntries = recorder.getEntriesForStage('processData');
      expect(stageEntries).toHaveLength(4);
    });

    it('should capture errors during execution', () => {
      const recorder = new DebugRecorder({ verbosity: 'verbose' });

      recorder.onStageStart({
        stageName: 'failingStage',
        pipelineId: 'main',
        timestamp: 1000,
      });

      recorder.onRead({
        stageName: 'failingStage',
        pipelineId: 'main',
        timestamp: 1010,
        value: undefined,
      });

      recorder.onError({
        stageName: 'failingStage',
        pipelineId: 'main',
        timestamp: 1020,
        error: new Error('Input data not found'),
        operation: 'read',
        key: 'data',
      });

      recorder.onStageEnd({
        stageName: 'failingStage',
        pipelineId: 'main',
        timestamp: 1030,
        duration: 30,
      });

      const errors = recorder.getErrors();
      expect(errors).toHaveLength(1);
      expect((errors[0].data as any).error.message).toBe('Input data not found');

      const stageEntries = recorder.getEntriesForStage('failingStage');
      expect(stageEntries).toHaveLength(4);
    });

    it('should work in minimal mode for production-like behavior', () => {
      const recorder = new DebugRecorder({ verbosity: 'minimal' });

      // Simulate execution - only errors should be recorded
      recorder.onStageStart({
        stageName: 'stage1',
        pipelineId: 'main',
        timestamp: 1000,
      });

      recorder.onRead({
        stageName: 'stage1',
        pipelineId: 'main',
        timestamp: 1010,
        value: 'test',
      });

      recorder.onWrite({
        stageName: 'stage1',
        pipelineId: 'main',
        timestamp: 1020,
        key: 'k',
        value: 'v',
        operation: 'set',
      });

      recorder.onError({
        stageName: 'stage1',
        pipelineId: 'main',
        timestamp: 1030,
        error: new Error('Something went wrong'),
        operation: 'write',
      });

      recorder.onStageEnd({
        stageName: 'stage1',
        pipelineId: 'main',
        timestamp: 1040,
        duration: 40,
      });

      // Only the error should be recorded
      const entries = recorder.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('error');
    });
  });
});

/**
 * CombinedNarrativeBuilder Unit Tests
 * ----------------------------------------------------------------------------
 * Tests for merging flow-level narrative with step-level scope operations.
 */

import { CombinedNarrativeBuilder } from '../../../../../src/core/executor/narrative/CombinedNarrativeBuilder';
import { NarrativeRecorder } from '../../../../../src/scope/recorders/NarrativeRecorder';
import type { ReadEvent, WriteEvent } from '../../../../../src/scope/types';

// ============================================================================
// Test Helpers
// ============================================================================

function makeReadEvent(overrides: Partial<ReadEvent> = {}): ReadEvent {
  return {
    stageName: 'testStage',
    pipelineId: 'pipeline1',
    timestamp: Date.now(),
    key: 'value',
    value: 'test',
    ...overrides,
  };
}

function makeWriteEvent(overrides: Partial<WriteEvent> = {}): WriteEvent {
  return {
    stageName: 'testStage',
    pipelineId: 'pipeline1',
    timestamp: Date.now(),
    key: 'value',
    value: 'test',
    operation: 'set',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('CombinedNarrativeBuilder', () => {
  describe('build', () => {
    it('should combine flow sentences with step operations', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onWrite(makeWriteEvent({
        stageName: 'Initialize',
        key: 'applicantName',
        value: 'Bob',
      }));
      recorder.onWrite(makeWriteEvent({
        stageName: 'Initialize',
        key: 'annualIncome',
        value: 42000,
      }));

      const flowSentences = [
        'The process began with Initialize.',
      ];

      const builder = new CombinedNarrativeBuilder();
      const lines = builder.build(flowSentences, recorder);

      expect(lines[0]).toContain('Stage 1');
      expect(lines[0]).toContain('Initialize');
      expect(lines[1]).toContain('Step 1');
      expect(lines[1]).toContain('Write');
      expect(lines[1]).toContain('applicantName');
      expect(lines[2]).toContain('Step 2');
      expect(lines[2]).toContain('Write');
      expect(lines[2]).toContain('annualIncome');
    });

    it('should handle conditions from decider sentences', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });

      const flowSentences = [
        'The process began with Initialize.',
        'It evaluated the risk tier: risk tier is high, so it chose Reject Application.',
      ];

      const builder = new CombinedNarrativeBuilder();
      const lines = builder.build(flowSentences, recorder);

      expect(lines[0]).toContain('Stage 1');
      expect(lines[1]).toContain('[Condition]');
      expect(lines[1]).toContain('risk tier is high');
    });

    it('should handle multiple stages with operations', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onWrite(makeWriteEvent({
        stageName: 'ValidateCart',
        key: 'itemCount',
        value: 3,
      }));
      recorder.onRead(makeReadEvent({
        stageName: 'ProcessPayment',
        key: 'total',
        value: 99.99,
      }));
      recorder.onWrite(makeWriteEvent({
        stageName: 'ProcessPayment',
        key: 'transactionId',
        value: 'txn-123',
      }));

      const flowSentences = [
        'The process began with ValidateCart.',
        'Next, it moved on to ProcessPayment.',
      ];

      const builder = new CombinedNarrativeBuilder();
      const lines = builder.build(flowSentences, recorder);

      expect(lines.length).toBe(5); // 2 stages + 3 step operations
      expect(lines[0]).toContain('Stage 1');
      expect(lines[1]).toContain('Write');
      expect(lines[2]).toContain('Stage 2');
      expect(lines[3]).toContain('Read');
      expect(lines[4]).toContain('Write');
    });

    it('should handle fork sentences', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });

      const flowSentences = [
        'The process began with Entry.',
        '3 paths were executed in parallel: childA, childB, childC.',
      ];

      const builder = new CombinedNarrativeBuilder();
      const lines = builder.build(flowSentences, recorder);

      expect(lines[1]).toContain('[Parallel]');
    });

    it('should handle delete operations', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onWrite(makeWriteEvent({
        stageName: 'Cleanup',
        key: 'tempData',
        value: undefined,
        operation: 'delete',
      }));

      const flowSentences = [
        'The process began with Cleanup.',
      ];

      const builder = new CombinedNarrativeBuilder();
      const lines = builder.build(flowSentences, recorder);

      expect(lines[1]).toContain('Delete');
      expect(lines[1]).toContain('tempData');
    });

    it('should handle update operations distinctly', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onWrite(makeWriteEvent({
        stageName: 'UpdateSettings',
        key: 'config',
        value: { retries: 3 },
        operation: 'update',
      }));

      const flowSentences = [
        'The process began with UpdateSettings.',
      ];

      const builder = new CombinedNarrativeBuilder();
      const lines = builder.build(flowSentences, recorder);

      expect(lines[1]).toContain('Update');
    });

    it('should include unreferenced stages at the end', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onWrite(makeWriteEvent({
        stageName: 'UnreferencedStage',
        key: 'data',
        value: 42,
      }));

      const flowSentences: string[] = [];

      const builder = new CombinedNarrativeBuilder();
      const lines = builder.build(flowSentences, recorder);

      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('UnreferencedStage');
      expect(lines[1]).toContain('Write');
    });
  });

  describe('buildEntries', () => {
    it('should return structured entries with types and depths', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onWrite(makeWriteEvent({
        stageName: 'Init',
        key: 'value',
        value: 1,
      }));

      const flowSentences = ['The process began with Init.'];

      const builder = new CombinedNarrativeBuilder();
      const entries = builder.buildEntries(flowSentences, recorder);

      expect(entries[0].type).toBe('stage');
      expect(entries[0].depth).toBe(0);
      expect(entries[1].type).toBe('step');
      expect(entries[1].depth).toBe(1);
      expect(entries[1].stepNumber).toBe(1);
    });
  });

  describe('options', () => {
    it('should hide step numbers when includeStepNumbers is false', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onWrite(makeWriteEvent({
        stageName: 'Init',
        key: 'value',
        value: 1,
      }));

      const flowSentences = ['The process began with Init.'];

      const builder = new CombinedNarrativeBuilder({ includeStepNumbers: false });
      const lines = builder.build(flowSentences, recorder);

      expect(lines[1]).not.toContain('Step');
      expect(lines[1]).toContain('Write');
    });

    it('should hide values when includeValues is false', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onWrite(makeWriteEvent({
        stageName: 'Init',
        key: 'secret',
        value: 'password123',
      }));

      const flowSentences = ['The process began with Init.'];

      const builder = new CombinedNarrativeBuilder({ includeValues: false });
      const lines = builder.build(flowSentences, recorder);

      expect(lines[1]).toContain('Write secret');
      expect(lines[1]).not.toContain('password123');
    });

    it('should use custom indent', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onWrite(makeWriteEvent({
        stageName: 'Init',
        key: 'value',
        value: 1,
      }));

      const flowSentences = ['The process began with Init.'];

      const builder = new CombinedNarrativeBuilder({ indent: '    ' });
      const lines = builder.build(flowSentences, recorder);

      expect(lines[1]).toMatch(/^    /);
    });
  });
});

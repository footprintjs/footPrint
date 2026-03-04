/**
 * NarrativeRecorder Unit Tests
 * ----------------------------------------------------------------------------
 * Tests for the NarrativeRecorder class that captures per-stage scope
 * reads/writes for enriching narrative output with actual data values.
 */

import {
  NarrativeRecorder,
  type StageNarrativeData,
  type NarrativeOperation,
} from '../../../../src/scope/recorders/NarrativeRecorder';
import type { ReadEvent, WriteEvent } from '../../../../src/scope/types';

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

describe('NarrativeRecorder', () => {
  // ==========================================================================
  // Construction
  // ==========================================================================

  describe('constructor', () => {
    it('should create with default id when none provided', () => {
      const recorder = new NarrativeRecorder();
      expect(recorder.id).toMatch(/^narrative-recorder-\d+$/);
    });

    it('should create with custom id when provided', () => {
      const recorder = new NarrativeRecorder({ id: 'my-narrator' });
      expect(recorder.id).toBe('my-narrator');
    });

    it('should default to full detail level', () => {
      const recorder = new NarrativeRecorder();
      expect(recorder.getDetail()).toBe('full');
    });

    it('should accept custom detail level', () => {
      const recorder = new NarrativeRecorder({ detail: 'summary' });
      expect(recorder.getDetail()).toBe('summary');
    });

    it('should start with empty stage data', () => {
      const recorder = new NarrativeRecorder();
      const data = recorder.getStageData();
      expect(data.size).toBe(0);
    });
  });

  // ==========================================================================
  // Read Tracking
  // ==========================================================================

  describe('onRead', () => {
    it('should record a read operation', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });

      recorder.onRead(makeReadEvent({
        stageName: 'CallLLM',
        key: 'messages',
        value: ['hello'],
      }));

      const data = recorder.getStageDataFor('CallLLM');
      expect(data).toBeDefined();
      expect(data!.reads).toHaveLength(1);
      expect(data!.reads[0].type).toBe('read');
      expect(data!.reads[0].key).toBe('messages');
      expect(data!.reads[0].valueSummary).toBe('(1 item)');
    });

    it('should record multiple reads for the same stage', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });

      recorder.onRead(makeReadEvent({ stageName: 'stage1', key: 'a', value: 1 }));
      recorder.onRead(makeReadEvent({ stageName: 'stage1', key: 'b', value: 2 }));

      const data = recorder.getStageDataFor('stage1');
      expect(data!.reads).toHaveLength(2);
    });

    it('should group reads by stage', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });

      recorder.onRead(makeReadEvent({ stageName: 'stage1', key: 'a' }));
      recorder.onRead(makeReadEvent({ stageName: 'stage2', key: 'b' }));

      expect(recorder.getStageDataFor('stage1')!.reads).toHaveLength(1);
      expect(recorder.getStageDataFor('stage2')!.reads).toHaveLength(1);
    });

    it('should handle undefined key', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });

      recorder.onRead(makeReadEvent({ key: undefined, value: 42 }));

      const data = recorder.getStageDataFor('testStage');
      expect(data!.reads[0].key).toBe('');
    });
  });

  // ==========================================================================
  // Write Tracking
  // ==========================================================================

  describe('onWrite', () => {
    it('should record a write operation', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });

      recorder.onWrite(makeWriteEvent({
        stageName: 'Initialize',
        key: 'model',
        value: 'gpt-4',
        operation: 'set',
      }));

      const data = recorder.getStageDataFor('Initialize');
      expect(data).toBeDefined();
      expect(data!.writes).toHaveLength(1);
      expect(data!.writes[0].type).toBe('write');
      expect(data!.writes[0].key).toBe('model');
      expect(data!.writes[0].valueSummary).toBe('"gpt-4"');
      expect(data!.writes[0].operation).toBe('set');
    });

    it('should record update operations', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });

      recorder.onWrite(makeWriteEvent({
        key: 'count',
        value: 5,
        operation: 'update',
      }));

      const data = recorder.getStageDataFor('testStage');
      expect(data!.writes[0].operation).toBe('update');
      expect(data!.writes[0].valueSummary).toBe('5');
    });

    it('should record both reads and writes for the same stage', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });

      recorder.onRead(makeReadEvent({ stageName: 'stage1', key: 'input' }));
      recorder.onWrite(makeWriteEvent({ stageName: 'stage1', key: 'output' }));

      const data = recorder.getStageDataFor('stage1');
      expect(data!.reads).toHaveLength(1);
      expect(data!.writes).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Value Summarization
  // ==========================================================================

  describe('value summarization', () => {
    it('should summarize undefined as "undefined"', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onRead(makeReadEvent({ value: undefined }));
      expect(recorder.getStageDataFor('testStage')!.reads[0].valueSummary).toBe('undefined');
    });

    it('should summarize null as "null"', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onRead(makeReadEvent({ value: null }));
      expect(recorder.getStageDataFor('testStage')!.reads[0].valueSummary).toBe('null');
    });

    it('should summarize short strings with quotes', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onRead(makeReadEvent({ value: 'hello world' }));
      expect(recorder.getStageDataFor('testStage')!.reads[0].valueSummary).toBe('"hello world"');
    });

    it('should truncate long strings', () => {
      const recorder = new NarrativeRecorder({ id: 'test', maxValueLength: 20 });
      const longStr = 'This is a very long string that should be truncated';
      recorder.onRead(makeReadEvent({ value: longStr }));
      const summary = recorder.getStageDataFor('testStage')!.reads[0].valueSummary;
      expect(summary).toContain('...');
      expect(summary.length).toBeLessThanOrEqual(23); // 20 + quotes + "..."
    });

    it('should summarize numbers', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onRead(makeReadEvent({ value: 42 }));
      expect(recorder.getStageDataFor('testStage')!.reads[0].valueSummary).toBe('42');
    });

    it('should summarize booleans', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onRead(makeReadEvent({ value: true }));
      expect(recorder.getStageDataFor('testStage')!.reads[0].valueSummary).toBe('true');
    });

    it('should summarize arrays with item count', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onRead(makeReadEvent({ value: [1, 2, 3] }));
      expect(recorder.getStageDataFor('testStage')!.reads[0].valueSummary).toBe('(3 items)');
    });

    it('should summarize single-item arrays', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onRead(makeReadEvent({ value: ['only'] }));
      expect(recorder.getStageDataFor('testStage')!.reads[0].valueSummary).toBe('(1 item)');
    });

    it('should summarize empty arrays', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onRead(makeReadEvent({ value: [] }));
      expect(recorder.getStageDataFor('testStage')!.reads[0].valueSummary).toBe('[]');
    });

    it('should summarize objects with key names', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onRead(makeReadEvent({ value: { name: 'John', age: 30 } }));
      const summary = recorder.getStageDataFor('testStage')!.reads[0].valueSummary;
      expect(summary).toBe('{name, age}');
    });

    it('should summarize empty objects', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onRead(makeReadEvent({ value: {} }));
      expect(recorder.getStageDataFor('testStage')!.reads[0].valueSummary).toBe('{}');
    });

    it('should truncate objects with many keys', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      const obj = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
      recorder.onRead(makeReadEvent({ value: obj }));
      const summary = recorder.getStageDataFor('testStage')!.reads[0].valueSummary;
      expect(summary).toContain('a, b, c, d');
      expect(summary).toContain('6 keys');
    });
  });

  // ==========================================================================
  // toSentences - Full Detail Mode
  // ==========================================================================

  describe('toSentences (full detail)', () => {
    it('should produce read lines with key and value', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'full' });

      recorder.onRead(makeReadEvent({
        stageName: 'CallLLM',
        key: 'messages',
        value: ['msg1', 'msg2', 'msg3'],
      }));

      const sentences = recorder.toSentences();
      expect(sentences.get('CallLLM')).toEqual([
        '  - Read: messages = (3 items)',
      ]);
    });

    it('should produce write lines with key and value', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'full' });

      recorder.onWrite(makeWriteEvent({
        stageName: 'Initialize',
        key: 'model',
        value: 'gpt-4',
      }));

      const sentences = recorder.toSentences();
      expect(sentences.get('Initialize')).toEqual([
        '  - Wrote: model = "gpt-4"',
      ]);
    });

    it('should list reads before writes for a stage', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'full' });

      recorder.onRead(makeReadEvent({ stageName: 's1', key: 'input', value: 'data' }));
      recorder.onWrite(makeWriteEvent({ stageName: 's1', key: 'output', value: 'result' }));

      const lines = recorder.toSentences().get('s1')!;
      expect(lines[0]).toContain('Read');
      expect(lines[1]).toContain('Wrote');
    });

    it('should handle stages with key only', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'full' });

      recorder.onWrite(makeWriteEvent({
        stageName: 's1',
        key: 'rootKey',
        value: 42,
      }));

      const lines = recorder.toSentences().get('s1')!;
      expect(lines[0]).toBe('  - Wrote: rootKey = 42');
    });

    it('should preserve execution order across stages', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'full' });

      recorder.onWrite(makeWriteEvent({ stageName: 'stage1', key: 'a' }));
      recorder.onWrite(makeWriteEvent({ stageName: 'stage2', key: 'b' }));
      recorder.onWrite(makeWriteEvent({ stageName: 'stage3', key: 'c' }));

      const keys = [...recorder.toSentences().keys()];
      expect(keys).toEqual(['stage1', 'stage2', 'stage3']);
    });

    it('should skip stages with no operations', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'full' });

      recorder.onWrite(makeWriteEvent({ stageName: 'active' }));

      const sentences = recorder.toSentences();
      expect(sentences.size).toBe(1);
      expect(sentences.has('active')).toBe(true);
    });
  });

  // ==========================================================================
  // toSentences - Summary Mode
  // ==========================================================================

  describe('toSentences (summary mode)', () => {
    it('should produce compact read/write counts', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'summary' });

      recorder.onRead(makeReadEvent({ stageName: 's1', key: 'a' }));
      recorder.onRead(makeReadEvent({ stageName: 's1', key: 'b' }));
      recorder.onWrite(makeWriteEvent({ stageName: 's1', key: 'c' }));

      const lines = recorder.toSentences().get('s1')!;
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe('  - Read 2 values, wrote 1 value');
    });

    it('should handle reads-only stage', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'summary' });

      recorder.onRead(makeReadEvent({ stageName: 's1', key: 'a' }));

      const lines = recorder.toSentences().get('s1')!;
      expect(lines[0]).toBe('  - Read 1 value');
    });

    it('should handle writes-only stage', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'summary' });

      recorder.onWrite(makeWriteEvent({ stageName: 's1', key: 'a' }));
      recorder.onWrite(makeWriteEvent({ stageName: 's1', key: 'b' }));

      const lines = recorder.toSentences().get('s1')!;
      expect(lines[0]).toBe('  - Wrote 2 values');
    });
  });

  // ==========================================================================
  // toFlatSentences
  // ==========================================================================

  describe('toFlatSentences', () => {
    it('should produce stage-prefixed flat lines', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'full' });

      recorder.onRead(makeReadEvent({
        stageName: 'CallLLM',
        key: 'messages',
        value: [1, 2, 3],
      }));
      recorder.onWrite(makeWriteEvent({
        stageName: 'CallLLM',
        key: 'lastResponse',
        value: { content: 'hello' },
      }));

      const flat = recorder.toFlatSentences();
      expect(flat).toEqual([
        'CallLLM: Read: messages = (3 items)',
        'CallLLM: Wrote: lastResponse = {content}',
      ]);
    });

    it('should maintain execution order across stages', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'full' });

      recorder.onWrite(makeWriteEvent({ stageName: 'stage1', key: 'a', value: 1 }));
      recorder.onWrite(makeWriteEvent({ stageName: 'stage2', key: 'b', value: 2 }));

      const flat = recorder.toFlatSentences();
      expect(flat[0]).toContain('stage1');
      expect(flat[1]).toContain('stage2');
    });
  });

  // ==========================================================================
  // getStageData / getStageDataFor
  // ==========================================================================

  describe('getStageData', () => {
    it('should return defensive copy of all stage data', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });

      recorder.onRead(makeReadEvent({ stageName: 's1', key: 'a' }));
      recorder.onWrite(makeWriteEvent({ stageName: 's1', key: 'b' }));

      const data = recorder.getStageData();
      expect(data.size).toBe(1);

      // Verify it's a copy — modifying shouldn't affect recorder
      data.get('s1')!.reads.push({} as any);
      expect(recorder.getStageDataFor('s1')!.reads).toHaveLength(1);
    });
  });

  describe('getStageDataFor', () => {
    it('should return undefined for unknown stage', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      expect(recorder.getStageDataFor('nonexistent')).toBeUndefined();
    });

    it('should return defensive copy', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      recorder.onRead(makeReadEvent({ stageName: 's1' }));

      const data1 = recorder.getStageDataFor('s1')!;
      const data2 = recorder.getStageDataFor('s1')!;
      expect(data1).not.toBe(data2);
      expect(data1.reads).not.toBe(data2.reads);
    });
  });

  // ==========================================================================
  // clear
  // ==========================================================================

  describe('clear', () => {
    it('should remove all recorded data', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });

      recorder.onRead(makeReadEvent({ stageName: 's1' }));
      recorder.onWrite(makeWriteEvent({ stageName: 's2' }));

      recorder.clear();

      expect(recorder.getStageData().size).toBe(0);
      expect(recorder.toSentences().size).toBe(0);
      expect(recorder.toFlatSentences()).toEqual([]);
    });
  });

  // ==========================================================================
  // setDetail
  // ==========================================================================

  describe('setDetail', () => {
    it('should change output format without losing data', () => {
      const recorder = new NarrativeRecorder({ id: 'test', detail: 'full' });

      recorder.onRead(makeReadEvent({ stageName: 's1', key: 'a' }));
      recorder.onRead(makeReadEvent({ stageName: 's1', key: 'b' }));

      // Full mode shows individual operations
      const fullLines = recorder.toSentences().get('s1')!;
      expect(fullLines).toHaveLength(2);

      // Switch to summary mode
      recorder.setDetail('summary');
      const summaryLines = recorder.toSentences().get('s1')!;
      expect(summaryLines).toHaveLength(1);
      expect(summaryLines[0]).toContain('2 values');

      // Data is still there
      expect(recorder.getStageDataFor('s1')!.reads).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Implements Recorder interface
  // ==========================================================================

  describe('Recorder interface', () => {
    it('should have a readonly id property', () => {
      const recorder = new NarrativeRecorder({ id: 'test' });
      expect(recorder.id).toBe('test');
    });

    it('should implement onRead and onWrite hooks', () => {
      const recorder = new NarrativeRecorder();
      expect(typeof recorder.onRead).toBe('function');
      expect(typeof recorder.onWrite).toBe('function');
    });
  });

  // ==========================================================================
  // Integration-style: Realistic agent execution trace
  // ==========================================================================

  describe('realistic agent execution', () => {
    it('should capture a realistic agent turn', () => {
      const recorder = new NarrativeRecorder({ id: 'agent-trace', detail: 'full' });

      // Stage 1: Initialize — reads config, writes agent state
      recorder.onRead(makeReadEvent({
        stageName: 'Initialize',
        key: 'systemPrompt',
        value: 'You are a helpful assistant.',
      }));
      recorder.onWrite(makeWriteEvent({
        stageName: 'Initialize',
        key: 'model',
        value: 'gpt-4',
      }));

      // Stage 2: AssemblePrompt — reads conversation, writes messages
      recorder.onRead(makeReadEvent({
        stageName: 'Assemble Prompt',
        key: 'conversationHistory',
        value: [{ role: 'user', content: 'Hello' }],
      }));
      recorder.onWrite(makeWriteEvent({
        stageName: 'Assemble Prompt',
        key: 'messages',
        value: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
        ],
      }));

      // Stage 3: CallLLM — reads messages, writes response
      recorder.onRead(makeReadEvent({
        stageName: 'Call LLM',
        key: 'messages',
        value: [{ role: 'system' }, { role: 'user' }],
      }));
      recorder.onWrite(makeWriteEvent({
        stageName: 'Call LLM',
        key: 'lastResponse',
        value: {
          content: 'Hello! How can I help you today?',
          model: 'gpt-4',
          usage: { totalTokens: 42 },
        },
      }));

      // Verify structured data
      const data = recorder.getStageData();
      expect(data.size).toBe(3);
      expect(data.get('Initialize')!.reads).toHaveLength(1);
      expect(data.get('Initialize')!.writes).toHaveLength(1);
      expect(data.get('Assemble Prompt')!.reads).toHaveLength(1);
      expect(data.get('Assemble Prompt')!.writes).toHaveLength(1);
      expect(data.get('Call LLM')!.reads).toHaveLength(1);
      expect(data.get('Call LLM')!.writes).toHaveLength(1);

      // Verify text sentences
      const sentences = recorder.toSentences();
      expect(sentences.get('Initialize')).toEqual([
        '  - Read: systemPrompt = "You are a helpful assistant."',
        '  - Wrote: model = "gpt-4"',
      ]);
      expect(sentences.get('Call LLM')![0]).toContain('Read: messages');
      expect(sentences.get('Call LLM')![1]).toContain('Wrote: lastResponse');
      expect(sentences.get('Call LLM')![1]).toContain('content, model, usage');

      // Verify flat sentences
      const flat = recorder.toFlatSentences();
      expect(flat).toHaveLength(6);
      expect(flat[0]).toBe('Initialize: Read: systemPrompt = "You are a helpful assistant."');
      expect(flat[1]).toBe('Initialize: Wrote: model = "gpt-4"');
    });
  });
});

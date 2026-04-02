/**
 * Tests for raw value buffering + deferred summarization in CombinedNarrativeRecorder.
 *
 * The fix: BufferedOp stores rawValue (not pre-summarized string). summarizeValue()
 * (or custom formatValue) is called at flushOps time, not capture time.
 *
 * Coverage: unit, boundary, scenario, property, security.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CombinedNarrativeRecorder } from '../../../../../src/lib/engine/narrative/CombinedNarrativeRecorder';
import { summarizeValue } from '../../../../../src/lib/scope/recorders/summarizeValue';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStageEvent(stageName: string, stageId?: string) {
  return {
    stageName,
    traversalContext: { stageId: stageId ?? stageName, stageName, depth: 0, parentStageId: undefined },
  };
}

// ── Unit: step entries include rawValue with actual value ────────────────────

describe('raw value buffering — unit', () => {
  it('step entries include rawValue with actual value', () => {
    const rec = new CombinedNarrativeRecorder();

    // Simulate: stage writes name='Alice', then reads it
    rec.onWrite({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'name',
      value: 'Alice',
      operation: 'set',
    });
    rec.onRead({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'name',
      value: 'Alice',
    });
    rec.onStageExecuted(makeStageEvent('Init'));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(2);

    // Write step has rawValue
    expect(steps[0].rawValue).toBe('Alice');
    expect(steps[0].text).toContain('Write name = "Alice"');

    // Read step has rawValue
    expect(steps[1].rawValue).toBe('Alice');
    expect(steps[1].text).toContain('Read name = "Alice"');
  });

  it('rawValue contains the actual array, not "(N items)"', () => {
    const rec = new CombinedNarrativeRecorder();

    rec.onWrite({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'items',
      value: ['x', 'y', 'z'],
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init'));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(1);

    // rawValue is the actual array
    expect(steps[0].rawValue).toEqual(['x', 'y', 'z']);
    // But text uses summarized form
    expect(steps[0].text).toContain('(3 items)');
  });
});

// ── Boundary: buffer undefined, null, [], {} ────────────────────────────────

describe('raw value buffering — boundary', () => {
  it('undefined rawValue: no crash, correct rendering', () => {
    const rec = new CombinedNarrativeRecorder();

    rec.onWrite({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'count',
      value: undefined,
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init'));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(1);
    expect(steps[0].rawValue).toBeUndefined();
    expect(steps[0].text).toContain('undefined');
  });

  it('null rawValue: correct rendering', () => {
    const rec = new CombinedNarrativeRecorder();

    rec.onWrite({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'name',
      value: null,
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init'));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(1);
    expect(steps[0].rawValue).toBeNull();
    expect(steps[0].text).toContain('null');
  });

  it('empty array rawValue: correct rendering', () => {
    const rec = new CombinedNarrativeRecorder();

    rec.onWrite({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'items',
      value: [],
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init'));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(1);
    expect(steps[0].rawValue).toEqual([]);
    expect(steps[0].text).toContain('[]');
  });

  it('empty object rawValue: correct rendering', () => {
    const rec = new CombinedNarrativeRecorder();

    rec.onWrite({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'data',
      value: {},
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init'));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(1);
    expect(steps[0].rawValue).toEqual({});
    expect(steps[0].text).toContain('{}');
  });
});

// ── Scenario: custom formatValue → custom formatting in getNarrative() ──────

describe('raw value buffering — scenario', () => {
  it('custom formatValue produces custom formatting in narrative', () => {
    const rec = new CombinedNarrativeRecorder({
      formatValue: (value, _maxLen) => {
        if (Array.isArray(value)) return `[${value.join(', ')}]`;
        return String(value);
      },
    });

    rec.onWrite({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'items',
      value: ['a', 'b', 'c'],
      operation: 'set',
    });
    rec.onWrite({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'name',
      value: 'Bob',
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init'));

    const lines = rec.getNarrative();
    // Custom formatter shows [a, b, c] instead of (3 items)
    const itemsLine = lines.find((l) => l.includes('items'));
    expect(itemsLine).toBeDefined();
    expect(itemsLine).toContain('[a, b, c]');

    // Custom formatter shows Bob (no quotes) instead of "Bob"
    const nameLine = lines.find((l) => l.includes('name'));
    expect(nameLine).toBeDefined();
    expect(nameLine).toContain('Bob');
    expect(nameLine).not.toContain('"Bob"');
  });

  it('rawValue is present even when includeValues is false', () => {
    const rec = new CombinedNarrativeRecorder({ includeValues: false });

    rec.onWrite({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'items',
      value: ['a', 'b'],
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init'));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(1);
    // Text does NOT include the value (includeValues: false)
    expect(steps[0].text).not.toContain('(2 items)');
    expect(steps[0].text).toBe('Step 1: Write items');
    // But rawValue is still populated for programmatic access
    expect(steps[0].rawValue).toEqual(['a', 'b']);
  });

  it('formatValue receives rawValue, not pre-summarized string', () => {
    const receivedValues: unknown[] = [];
    const rec = new CombinedNarrativeRecorder({
      formatValue: (value, maxLen) => {
        receivedValues.push(value);
        return summarizeValue(value, maxLen);
      },
    });

    const originalArray = [1, 2, 3];
    rec.onWrite({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'nums',
      value: originalArray,
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init'));

    // formatValue was called with the actual array, not a string
    expect(receivedValues).toHaveLength(1);
    expect(receivedValues[0]).toEqual([1, 2, 3]);
    expect(typeof receivedValues[0]).not.toBe('string');
  });
});

// ── Property: default formatValue produces identical output to pre-refactor ──

describe('raw value buffering — property', () => {
  it('default formatting matches summarizeValue for any value', () => {
    const maxLen = 80;

    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.array(fc.integer()),
          fc.dictionary(
            fc.string().filter((s) => s.length > 0 && s.length < 20),
            fc.integer(),
          ),
        ),
        (value) => {
          const rec = new CombinedNarrativeRecorder({ maxValueLength: maxLen });

          rec.onWrite({
            stageName: 'Test',
            pipelineId: 'p1',
            timestamp: Date.now(),
            key: 'val',
            value,
            operation: 'set',
          });
          rec.onStageExecuted(makeStageEvent('Test'));

          const steps = rec.getEntries().filter((e) => e.type === 'step');
          const expected = summarizeValue(value, maxLen);
          // The text should contain the same summary as summarizeValue
          return steps[0].text.includes(`val = ${expected}`);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── Security: redacted values stored as '[REDACTED]' in rawValue ────────────

describe('raw value buffering — security', () => {
  it('redacted values appear as [REDACTED] in rawValue', () => {
    const rec = new CombinedNarrativeRecorder();

    // ScopeFacade sends '[REDACTED]' as the value for redacted keys
    rec.onWrite({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'secret',
      value: '[REDACTED]',
      operation: 'set',
      redacted: true,
    });
    rec.onRead({
      stageName: 'Init',
      pipelineId: 'p1',
      timestamp: Date.now(),
      key: 'secret',
      value: '[REDACTED]',
      redacted: true,
    });
    rec.onStageExecuted(makeStageEvent('Init'));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(2);

    // Write rawValue is '[REDACTED]' (the sanitized value from ScopeFacade)
    expect(steps[0].rawValue).toBe('[REDACTED]');
    // Read rawValue is '[REDACTED]'
    expect(steps[1].rawValue).toBe('[REDACTED]');
  });
});

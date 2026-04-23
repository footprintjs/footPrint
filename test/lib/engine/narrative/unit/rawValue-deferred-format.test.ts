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

let _counter = 0;
function nextId(stageId: string) {
  return `${stageId}#${_counter++}`;
}

function makeStageEvent(stageName: string, stageId?: string, runtimeStageId?: string) {
  const sid = stageId ?? stageName;
  const rid = runtimeStageId ?? nextId(sid);
  return {
    stageName,
    traversalContext: { stageId: sid, runtimeStageId: rid, stageName, depth: 0, parentStageId: undefined },
  };
}

function scopeEvent(stageName: string, runtimeStageId: string, extra: Record<string, unknown> = {}) {
  return { stageName, stageId: stageName, runtimeStageId, pipelineId: 'p1', timestamp: Date.now(), ...extra };
}

// ── Unit: step entries include rawValue with actual value ────────────────────

describe('raw value buffering — unit', () => {
  it('step entries include rawValue with actual value', () => {
    const rec = new CombinedNarrativeRecorder();
    const rid = 'Init#0';

    // Simulate: stage writes name='Alice', then reads it
    rec.onWrite({
      ...scopeEvent('Init', rid),
      key: 'name',
      value: 'Alice',
      operation: 'set',
    });
    rec.onRead({
      ...scopeEvent('Init', rid),
      key: 'name',
      value: 'Alice',
    });
    rec.onStageExecuted(makeStageEvent('Init', undefined, rid));

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
    const rid = 'Init#1';

    rec.onWrite({
      ...scopeEvent('Init', rid),
      key: 'items',
      value: ['x', 'y', 'z'],
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init', undefined, rid));

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
    const rid = 'Init#2';

    rec.onWrite({
      ...scopeEvent('Init', rid),
      key: 'count',
      value: undefined,
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init', undefined, rid));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(1);
    expect(steps[0].rawValue).toBeUndefined();
    expect(steps[0].text).toContain('undefined');
  });

  it('null rawValue: correct rendering', () => {
    const rec = new CombinedNarrativeRecorder();
    const rid = 'Init#3';

    rec.onWrite({
      ...scopeEvent('Init', rid),
      key: 'name',
      value: null,
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init', undefined, rid));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(1);
    expect(steps[0].rawValue).toBeNull();
    expect(steps[0].text).toContain('null');
  });

  it('empty array rawValue: correct rendering', () => {
    const rec = new CombinedNarrativeRecorder();
    const rid = 'Init#4';

    rec.onWrite({
      ...scopeEvent('Init', rid),
      key: 'items',
      value: [],
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init', undefined, rid));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(1);
    expect(steps[0].rawValue).toEqual([]);
    expect(steps[0].text).toContain('[]');
  });

  it('empty object rawValue: correct rendering', () => {
    const rec = new CombinedNarrativeRecorder();
    const rid = 'Init#5';

    rec.onWrite({
      ...scopeEvent('Init', rid),
      key: 'data',
      value: {},
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init', undefined, rid));

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
    const rid = 'Init#6';

    rec.onWrite({
      ...scopeEvent('Init', rid),
      key: 'items',
      value: ['a', 'b', 'c'],
      operation: 'set',
    });
    rec.onWrite({
      ...scopeEvent('Init', rid),
      key: 'name',
      value: 'Bob',
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init', undefined, rid));

    const lines = rec.getEntries().map((e) => e.text);
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
    const rid = 'Init#7';

    rec.onWrite({
      ...scopeEvent('Init', rid),
      key: 'items',
      value: ['a', 'b'],
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init', undefined, rid));

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
    const rid = 'Init#8';

    const originalArray = [1, 2, 3];
    rec.onWrite({
      ...scopeEvent('Init', rid),
      key: 'nums',
      value: originalArray,
      operation: 'set',
    });
    rec.onStageExecuted(makeStageEvent('Init', undefined, rid));

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
    let propCounter = 0;

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
          const rid = `Test#prop-${propCounter++}`;

          rec.onWrite({
            ...scopeEvent('Test', rid),
            key: 'val',
            value,
            operation: 'set',
          });
          rec.onStageExecuted(makeStageEvent('Test', undefined, rid));

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
    const rid = 'Init#9';

    // ScopeFacade sends '[REDACTED]' as the value for redacted keys
    rec.onWrite({
      ...scopeEvent('Init', rid),
      key: 'secret',
      value: '[REDACTED]',
      operation: 'set',
      redacted: true,
    });
    rec.onRead({
      ...scopeEvent('Init', rid),
      key: 'secret',
      value: '[REDACTED]',
      redacted: true,
    });
    rec.onStageExecuted(makeStageEvent('Init', undefined, rid));

    const steps = rec.getEntries().filter((e) => e.type === 'step');
    expect(steps).toHaveLength(2);

    // Write rawValue is '[REDACTED]' (the sanitized value from ScopeFacade)
    expect(steps[0].rawValue).toBe('[REDACTED]');
    // Read rawValue is '[REDACTED]'
    expect(steps[1].rawValue).toBe('[REDACTED]');
  });
});

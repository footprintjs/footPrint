import { describe, expect, it } from 'vitest';

import { SequenceRecorder } from '../../../src/lib/recorder/SequenceRecorder.js';

// ── Test fixture ────────────────────────────────────────────────────────────

interface TestEntry {
  runtimeStageId?: string;
  type: string;
  value: number;
}

class TestSequenceRecorder extends SequenceRecorder<TestEntry> {
  readonly id = 'test-seq';

  /** Public wrapper so tests can call emit(). */
  add(entry: TestEntry): void {
    this.emit(entry);
  }
}

function entry(runtimeStageId: string | undefined, type: string, value: number): TestEntry {
  return { runtimeStageId, type, value };
}

// ============================================================================
// 1. Unit tests — core behavior of each method
// ============================================================================

describe('SequenceRecorder: unit', () => {
  it('emit stores entries in insertion order', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry('a#0', 'step', 2));
    rec.add(entry('b#1', 'stage', 3));

    const entries = rec.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.value)).toEqual([1, 2, 3]);
  });

  it('getEntries returns a copy (mutation safe)', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));

    const copy = rec.getEntries();
    copy.push(entry('z#99', 'injected', 999));
    expect(rec.getEntries()).toHaveLength(1);
  });

  it('getEntriesForStep returns all entries for a given runtimeStageId', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry('a#0', 'step', 2));
    rec.add(entry('b#1', 'stage', 3));

    expect(rec.getEntriesForStep('a#0')).toHaveLength(2);
    expect(rec.getEntriesForStep('b#1')).toHaveLength(1);
  });

  it('getEntriesForStep returns a copy (mutation safe)', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));

    const copy = rec.getEntriesForStep('a#0');
    copy.push(entry('z#99', 'injected', 999));
    expect(rec.getEntriesForStep('a#0')).toHaveLength(1);
  });

  it('getEntriesForStep returns empty array for unknown key', () => {
    const rec = new TestSequenceRecorder();
    expect(rec.getEntriesForStep('nonexistent#99')).toEqual([]);
  });

  it('entryCount returns total entries', () => {
    const rec = new TestSequenceRecorder();
    expect(rec.entryCount).toBe(0);
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry('a#0', 'step', 2));
    expect(rec.entryCount).toBe(2);
  });

  it('stepCount returns unique runtimeStageIds', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry('a#0', 'step', 2)); // same key — not a new step
    rec.add(entry('b#1', 'stage', 3));
    expect(rec.stepCount).toBe(2);
  });

  it('entries without runtimeStageId do not increment stepCount', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry(undefined, 'marker', 0)); // structural marker
    rec.add(entry('b#1', 'stage', 2));
    expect(rec.stepCount).toBe(2);
  });

  it('clear resets all state', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry('b#1', 'stage', 2));
    rec.clear();

    expect(rec.getEntries()).toHaveLength(0);
    expect(rec.getEntriesForStep('a#0')).toEqual([]);
    expect(rec.entryCount).toBe(0);
    expect(rec.stepCount).toBe(0);
  });
});

// ============================================================================
// 2. Aggregate + Accumulate tests
// ============================================================================

describe('SequenceRecorder: aggregate / accumulate', () => {
  it('aggregate reduces all entries', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 10));
    rec.add(entry('a#0', 'step', 20));
    rec.add(entry('b#1', 'stage', 30));

    expect(rec.aggregate((sum, e) => sum + e.value, 0)).toBe(60);
  });

  it('aggregate with empty recorder returns initial', () => {
    const rec = new TestSequenceRecorder();
    expect(rec.aggregate((sum, e) => sum + e.value, 0)).toBe(0);
  });

  it('accumulate without keys reduces all entries (same as aggregate)', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 10));
    rec.add(entry('b#1', 'stage', 20));

    expect(rec.accumulate((sum, e) => sum + e.value, 0)).toBe(30);
  });

  it('accumulate with keys filters by runtimeStageId', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 10));
    rec.add(entry('a#0', 'step', 20));
    rec.add(entry('b#1', 'stage', 30));

    const atA = rec.accumulate((sum, e) => sum + e.value, 0, new Set(['a#0']));
    expect(atA).toBe(30); // 10 + 20

    const atAll = rec.accumulate((sum, e) => sum + e.value, 0, new Set(['a#0', 'b#1']));
    expect(atAll).toBe(60);
  });

  it('accumulate excludes entries without runtimeStageId when keys filter is set', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 10));
    rec.add(entry(undefined, 'marker', 5)); // no runtimeStageId — excluded when keys filter active
    rec.add(entry('b#1', 'stage', 30));

    // Markers without runtimeStageId are excluded (no temporal position in the slider)
    const atA = rec.accumulate((sum, e) => sum + e.value, 0, new Set(['a#0']));
    expect(atA).toBe(10);
  });

  it('accumulate without keys includes all entries including markers', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 10));
    rec.add(entry(undefined, 'marker', 5));
    rec.add(entry('b#1', 'stage', 30));

    // Without keys filter, all entries are included (same as aggregate)
    expect(rec.accumulate((sum, e) => sum + e.value, 0)).toBe(45);
  });

  it('accumulate with non-numeric reducer (string concat)', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry('b#1', 'step', 2));

    const result = rec.accumulate((acc, e) => `${acc}[${e.type}]`, '', new Set(['a#0']));
    expect(result).toBe('[stage]');
  });
});

// ============================================================================
// 3. getEntriesUpTo — progressive time-travel
// ============================================================================

describe('SequenceRecorder: getEntriesUpTo (time-travel)', () => {
  it('returns empty for empty visibleIds', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    expect(rec.getEntriesUpTo(new Set())).toEqual([]);
  });

  it('returns entries matching visibleIds in order', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry('a#0', 'step', 2));
    rec.add(entry('b#1', 'stage', 3));
    rec.add(entry('c#2', 'stage', 4));

    const visible = rec.getEntriesUpTo(new Set(['a#0', 'b#1']));
    expect(visible.map((e) => e.value)).toEqual([1, 2, 3]);
  });

  it('structural markers between visible steps are included', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry(undefined, 'marker', 99)); // between a#0 and b#1
    rec.add(entry('b#1', 'stage', 2));

    const visible = rec.getEntriesUpTo(new Set(['a#0', 'b#1']));
    expect(visible).toHaveLength(3);
    expect(visible[1].type).toBe('marker');
  });

  it('trailing structural markers are discarded', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry(undefined, 'marker', 99)); // after a#0, before b#1
    rec.add(entry('b#1', 'stage', 2)); // NOT in visible set

    const visible = rec.getEntriesUpTo(new Set(['a#0']));
    expect(visible).toHaveLength(1);
    expect(visible[0].value).toBe(1);
  });

  it('markers before any visible entry are excluded', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry(undefined, 'marker', 99)); // before any keyed entry
    rec.add(entry('a#0', 'stage', 1));

    const visible = rec.getEntriesUpTo(new Set(['a#0']));
    expect(visible).toHaveLength(1);
    expect(visible[0].value).toBe(1);
  });

  it('markers between visible steps included even with non-visible step in between', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry(undefined, 'marker', 99));
    rec.add(entry('b#1', 'stage', 2)); // NOT visible — but markers keep buffering
    rec.add(entry(undefined, 'marker2', 98));
    rec.add(entry('c#2', 'stage', 3)); // visible — flushes BOTH markers

    const visible = rec.getEntriesUpTo(new Set(['a#0', 'c#2']));
    // Both markers flushed when c#2 (visible) is reached
    expect(visible.map((e) => e.value)).toEqual([1, 99, 98, 3]);
  });

  it('multiple consecutive markers between visible steps all included', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry(undefined, 'loop', 10));
    rec.add(entry(undefined, 'break', 11));
    rec.add(entry('b#1', 'stage', 2));

    const visible = rec.getEntriesUpTo(new Set(['a#0', 'b#1']));
    expect(visible).toHaveLength(4);
  });
});

// ============================================================================
// 4. Edge cases
// ============================================================================

describe('SequenceRecorder: edge cases', () => {
  it('all entries have same runtimeStageId', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry('a#0', 'read', 2));
    rec.add(entry('a#0', 'write', 3));
    rec.add(entry('a#0', 'condition', 4));

    expect(rec.stepCount).toBe(1);
    expect(rec.getEntriesForStep('a#0')).toHaveLength(4);
    expect(rec.aggregate((sum, e) => sum + e.value, 0)).toBe(10);
  });

  it('all entries lack runtimeStageId (all markers)', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry(undefined, 'a', 1));
    rec.add(entry(undefined, 'b', 2));

    expect(rec.stepCount).toBe(0);
    expect(rec.entryCount).toBe(2);
    expect(rec.getEntriesUpTo(new Set(['anything']))).toEqual([]);
    expect(rec.aggregate((sum, e) => sum + e.value, 0)).toBe(3);
  });

  it('interleaved keyed and unkeyed entries', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry(undefined, 'marker', 10));
    rec.add(entry('a#0', 'step', 2)); // same key as earlier
    rec.add(entry(undefined, 'marker2', 11));
    rec.add(entry('b#1', 'stage', 3));

    expect(rec.stepCount).toBe(2);
    expect(rec.getEntriesForStep('a#0')).toHaveLength(2);
    expect(rec.entryCount).toBe(5);
  });

  it('clear then re-add works correctly', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.clear();
    rec.add(entry('b#0', 'stage', 2));

    expect(rec.getEntries()).toHaveLength(1);
    expect(rec.getEntriesForStep('a#0')).toEqual([]);
    expect(rec.getEntriesForStep('b#0')).toHaveLength(1);
    expect(rec.stepCount).toBe(1);
  });

  it('large number of entries (1000)', () => {
    const rec = new TestSequenceRecorder();
    for (let i = 0; i < 1000; i++) {
      rec.add(entry(`s#${i}`, 'stage', i));
    }
    expect(rec.entryCount).toBe(1000);
    expect(rec.stepCount).toBe(1000);
    expect(rec.getEntriesForStep('s#500')).toHaveLength(1);
    expect(rec.aggregate((sum, e) => sum + e.value, 0)).toBe(499500); // sum 0..999
  });
});

// ============================================================================
// 5. getEntryRanges — precomputed range index
// ============================================================================

describe('SequenceRecorder: getEntryRanges', () => {
  it('returns ranges for each runtimeStageId', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry('a#0', 'step', 2));
    rec.add(entry('b#1', 'stage', 3));

    const ranges = rec.getEntryRanges();
    expect(ranges.get('a#0')).toEqual({ firstIdx: 0, endIdx: 2 });
    expect(ranges.get('b#1')).toEqual({ firstIdx: 2, endIdx: 3 });
  });

  it('trailing keyless entries extend the preceding step range', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry(undefined, 'marker', 99)); // trailing marker

    const ranges = rec.getEntryRanges();
    expect(ranges.get('a#0')).toEqual({ firstIdx: 0, endIdx: 2 }); // includes marker
  });

  it('leading keyless entries are not in any range', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry(undefined, 'marker', 99)); // before any keyed entry
    rec.add(entry('a#0', 'stage', 1));

    const ranges = rec.getEntryRanges();
    expect(ranges.get('a#0')).toEqual({ firstIdx: 1, endIdx: 2 });
    expect(ranges.size).toBe(1);
  });

  it('multiple entries with same runtimeStageId span the full range', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.add(entry('a#0', 'read', 2));
    rec.add(entry('a#0', 'write', 3));
    rec.add(entry(undefined, 'marker', 99));
    rec.add(entry('b#1', 'stage', 4));

    const ranges = rec.getEntryRanges();
    expect(ranges.get('a#0')).toEqual({ firstIdx: 0, endIdx: 4 }); // includes marker
    expect(ranges.get('b#1')).toEqual({ firstIdx: 4, endIdx: 5 });
  });

  it('clear resets ranges', () => {
    const rec = new TestSequenceRecorder();
    rec.add(entry('a#0', 'stage', 1));
    rec.clear();
    expect(rec.getEntryRanges().size).toBe(0);
  });
});

// ============================================================================
// 6. Integration: SequenceRecorder as base for CombinedNarrativeRecorder
// ============================================================================

describe('SequenceRecorder: integration with CombinedNarrativeRecorder', () => {
  // This test imports the real CombinedNarrativeRecorder to verify the inheritance works
  it('CombinedNarrativeRecorder inherits SequenceRecorder methods', async () => {
    const { CombinedNarrativeRecorder } = await import(
      '../../../src/lib/engine/narrative/CombinedNarrativeRecorder.js'
    );
    const rec = new CombinedNarrativeRecorder();

    // Verify inherited methods exist
    expect(typeof rec.getEntries).toBe('function');
    expect(typeof rec.getEntriesForStep).toBe('function');
    expect(typeof rec.getEntriesUpTo).toBe('function');
    expect(typeof rec.aggregate).toBe('function');
    expect(typeof rec.accumulate).toBe('function');
    expect(typeof rec.clear).toBe('function');
    expect(typeof rec.entryCount).toBe('number');
    expect(typeof rec.stepCount).toBe('number');
  });

  it('CombinedNarrativeRecorder is instanceof SequenceRecorder', async () => {
    const { CombinedNarrativeRecorder } = await import(
      '../../../src/lib/engine/narrative/CombinedNarrativeRecorder.js'
    );
    const rec = new CombinedNarrativeRecorder();
    expect(rec).toBeInstanceOf(SequenceRecorder);
  });

  it('aggregate works on CombinedNarrativeRecorder entries', async () => {
    const { CombinedNarrativeRecorder } = await import(
      '../../../src/lib/engine/narrative/CombinedNarrativeRecorder.js'
    );
    const rec = new CombinedNarrativeRecorder();

    rec.onStageExecuted({
      stageName: 'A',
      traversalContext: { stageId: 'a', runtimeStageId: 'a#0', stageName: 'A', depth: 0 },
    });
    rec.onStageExecuted({
      stageName: 'B',
      traversalContext: { stageId: 'b', runtimeStageId: 'b#1', stageName: 'B', depth: 0 },
    });

    // Aggregate: count stage entries
    const stageCount = rec.aggregate((sum, e) => (e.type === 'stage' ? sum + 1 : sum), 0);
    expect(stageCount).toBe(2);

    // Accumulate: count up to slider
    const atA = rec.accumulate((sum, e) => (e.type === 'stage' ? sum + 1 : sum), 0, new Set(['a#0']));
    expect(atA).toBe(1);
  });
});

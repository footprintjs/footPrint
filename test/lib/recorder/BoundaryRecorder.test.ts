/**
 * Unit tests for BoundaryRecorder — 7 patterns covering the consumer circle.
 *
 * Each subflow execution produces an entry/exit pair sharing a runtimeStageId.
 * Together they're the universal "step" downstream layers project (Lens StepGraph,
 * Trace view, custom dashboards). The 7 patterns cover the full surface:
 *
 *   P1  Single subflow                   → 1 entry + 1 exit, payloads attached
 *   P2  Sequential chain (3 subflows)    → 6 boundaries, ordered, distinct ids
 *   P3  Nested subflow (parent → child)  → 4 boundaries, child's path includes parent
 *   P4  Parallel siblings                → siblings under same parent path, all paired
 *   P5  Loop re-entry (same subflowId)   → distinct runtimeStageIds per iteration
 *   P6  In-progress / paused (entry only)→ entry without exit; getBoundary handles gracefully
 *   P7  Integration with FlowChartExecutor → real run; payloads flow from mappers
 *
 * Plus query API + lifecycle.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/index';
import type { FlowSubflowEvent } from '../../../src/lib/engine/narrative/types';
import { BoundaryRecorder, boundaryRecorder } from '../../../src/lib/recorder/BoundaryRecorder';
import { FlowChartExecutor } from '../../../src/lib/runner/index';

// ── Helpers ─────────────────────────────────────────────────────────────

// `subflowId` mirrors the engine's path-prefixed convention.
// Top-level: 'sf-x'. Nested: 'sf-outer/sf-inner'. Tests use the same form.

function entryEvent(
  subflowId: string,
  name: string,
  runtimeStageId: string,
  mappedInput?: Record<string, unknown>,
  description?: string,
): FlowSubflowEvent {
  return {
    name,
    subflowId,
    description,
    mappedInput,
    traversalContext: {
      stageId: subflowId,
      runtimeStageId,
      stageName: name,
      depth: subflowId.split('/').length - 1,
    },
  };
}

function exitEvent(
  subflowId: string,
  name: string,
  runtimeStageId: string,
  outputState?: Record<string, unknown>,
): FlowSubflowEvent {
  return {
    name,
    subflowId,
    outputState,
    traversalContext: {
      stageId: subflowId,
      runtimeStageId,
      stageName: name,
      depth: subflowId.split('/').length - 1,
    },
  };
}

// ── P1: single subflow ──────────────────────────────────────────────────

describe('BoundaryRecorder — P1: single subflow', () => {
  it('emits one entry and one exit, both keyed by the same runtimeStageId', () => {
    const rec = new BoundaryRecorder();
    rec.onSubflowEntry!(entryEvent('sf-only', 'Only', 'only#0', { greeting: 'hello' }));
    rec.onSubflowExit!(exitEvent('sf-only', 'Only', 'only#0', { result: 'done' }));

    const all = rec.getBoundaries();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      runtimeStageId: 'only#0',
      subflowId: 'sf-only',
      localSubflowId: 'sf-only',
      subflowName: 'Only',
      subflowPath: ['sf-only'],
      depth: 0,
      phase: 'entry',
      payload: { greeting: 'hello' },
    });
    expect(all[1]).toMatchObject({ phase: 'exit', payload: { result: 'done' } });

    // getBoundary returns the typed pair.
    const pair = rec.getBoundary('only#0');
    expect(pair.entry?.payload).toEqual({ greeting: 'hello' });
    expect(pair.exit?.payload).toEqual({ result: 'done' });

    // getSteps returns just the entry phase — the timeline projection.
    expect(rec.getSteps()).toHaveLength(1);
    expect(rec.getSteps()[0].subflowId).toBe('sf-only');
  });
});

// ── P2: sequential chain ────────────────────────────────────────────────

describe('BoundaryRecorder — P2: sequential chain', () => {
  it('three top-level subflows produce three entry/exit pairs in execution order', () => {
    const rec = new BoundaryRecorder();
    rec.onSubflowEntry!(entryEvent('sf-a', 'A', 'a#0'));
    rec.onSubflowExit!(exitEvent('sf-a', 'A', 'a#0'));
    rec.onSubflowEntry!(entryEvent('sf-b', 'B', 'b#1'));
    rec.onSubflowExit!(exitEvent('sf-b', 'B', 'b#1'));
    rec.onSubflowEntry!(entryEvent('sf-c', 'C', 'c#2'));
    rec.onSubflowExit!(exitEvent('sf-c', 'C', 'c#2'));

    expect(rec.getBoundaries()).toHaveLength(6);
    expect(rec.getSteps().map((s) => s.subflowId)).toEqual(['sf-a', 'sf-b', 'sf-c']);
    expect(rec.getSteps().every((s) => s.depth === 0)).toBe(true);

    // Each step's entry+exit pair is retrievable by runtimeStageId.
    expect(rec.getBoundary('a#0').entry?.subflowId).toBe('sf-a');
    expect(rec.getBoundary('a#0').exit?.subflowId).toBe('sf-a');
    expect(rec.getBoundary('b#1').entry?.subflowId).toBe('sf-b');
  });
});

// ── P3: nested subflow ──────────────────────────────────────────────────

describe('BoundaryRecorder — P3: nested subflow (parent → child)', () => {
  it("child boundary's subflowPath decomposes the engine's path-prefixed subflowId", () => {
    const rec = new BoundaryRecorder();
    rec.onSubflowEntry!(entryEvent('sf-parent', 'Parent', 'p#0'));
    // Engine emits child subflowId path-prefixed under the parent: 'sf-parent/sf-child'.
    rec.onSubflowEntry!(entryEvent('sf-parent/sf-child', 'Child', 'c#1', { from: 'parent' }));
    rec.onSubflowExit!(exitEvent('sf-parent/sf-child', 'Child', 'c#1', { back: 'to parent' }));
    rec.onSubflowExit!(exitEvent('sf-parent', 'Parent', 'p#0'));

    const child = rec.getBoundary('c#1');
    expect(child.entry?.subflowId).toBe('sf-parent/sf-child');
    expect(child.entry?.localSubflowId).toBe('sf-child');
    expect(child.entry?.subflowPath).toEqual(['sf-parent', 'sf-child']);
    expect(child.entry?.depth).toBe(1);
    expect(child.entry?.payload).toEqual({ from: 'parent' });
    expect(child.exit?.payload).toEqual({ back: 'to parent' });

    const parent = rec.getBoundary('p#0');
    expect(parent.entry?.subflowPath).toEqual(['sf-parent']);
    expect(parent.entry?.depth).toBe(0);
  });
});

// ── P4: parallel siblings ───────────────────────────────────────────────

describe('BoundaryRecorder — P4: parallel siblings', () => {
  it('three sibling subflows under the same parent share a parent path prefix', () => {
    const rec = new BoundaryRecorder();
    rec.onSubflowEntry!(entryEvent('sf-fork', 'Fork', 'f#0'));
    // Three siblings — same parent, distinct runtimeStageIds.
    rec.onSubflowEntry!(entryEvent('sf-fork/sf-alpha', 'Alpha', 'a#1'));
    rec.onSubflowExit!(exitEvent('sf-fork/sf-alpha', 'Alpha', 'a#1'));
    rec.onSubflowEntry!(entryEvent('sf-fork/sf-beta', 'Beta', 'b#2'));
    rec.onSubflowExit!(exitEvent('sf-fork/sf-beta', 'Beta', 'b#2'));
    rec.onSubflowEntry!(entryEvent('sf-fork/sf-gamma', 'Gamma', 'g#3'));
    rec.onSubflowExit!(exitEvent('sf-fork/sf-gamma', 'Gamma', 'g#3'));
    rec.onSubflowExit!(exitEvent('sf-fork', 'Fork', 'f#0'));

    const siblings = rec.getSteps().filter((s) => s.depth === 1 && s.subflowPath[0] === 'sf-fork');
    expect(siblings.map((s) => s.localSubflowId)).toEqual(['sf-alpha', 'sf-beta', 'sf-gamma']);
    expect(siblings.every((s) => s.subflowPath.length === 2)).toBe(true);
    expect(siblings.every((s) => s.subflowPath[0] === 'sf-fork')).toBe(true);
  });
});

// ── P5: loop re-entry ───────────────────────────────────────────────────

describe('BoundaryRecorder — P5: loop re-entry of same subflowId', () => {
  it('each iteration produces a distinct entry/exit pair via runtimeStageId', () => {
    const rec = new BoundaryRecorder();
    // Same subflowId entered three times (e.g., agent ReAct iterations).
    // Each iteration's parent stage has a different executionIndex.
    rec.onSubflowEntry!(entryEvent('sf-iter', 'Iter', 'iter#0'));
    rec.onSubflowExit!(exitEvent('sf-iter', 'Iter', 'iter#0'));
    rec.onSubflowEntry!(entryEvent('sf-iter', 'Iter', 'iter#1'));
    rec.onSubflowExit!(exitEvent('sf-iter', 'Iter', 'iter#1'));
    rec.onSubflowEntry!(entryEvent('sf-iter', 'Iter', 'iter#2'));
    rec.onSubflowExit!(exitEvent('sf-iter', 'Iter', 'iter#2'));

    // Six boundaries, three steps — the runtimeStageId disambiguates iterations.
    expect(rec.getBoundaries()).toHaveLength(6);
    expect(rec.getSteps()).toHaveLength(3);
    expect(rec.getSteps().map((s) => s.runtimeStageId)).toEqual(['iter#0', 'iter#1', 'iter#2']);
    // All carry the same subflowId — only runtimeStageId distinguishes them.
    expect(rec.getSteps().every((s) => s.subflowId === 'sf-iter')).toBe(true);
  });
});

// ── P6: in-progress / paused (entry without matching exit) ──────────────

describe('BoundaryRecorder — P6: entry without matching exit (paused / in-progress)', () => {
  it('getBoundary returns entry with exit=undefined when subflow has not completed', () => {
    const rec = new BoundaryRecorder();
    rec.onSubflowEntry!(entryEvent('sf-paused', 'Paused', 'p#0', { question: 'approve?' }));
    // No matching exit — subflow is paused / in flight / mid-error.

    const pair = rec.getBoundary('p#0');
    expect(pair.entry).toBeDefined();
    expect(pair.exit).toBeUndefined();
    expect(rec.getSteps()).toHaveLength(1); // step still counts in the timeline
  });
});

// ── P7: integration with FlowChartExecutor ──────────────────────────────

describe('BoundaryRecorder — P7: integration with FlowChartExecutor', () => {
  it('captures entry+exit pairs with real mapper payloads on a real chain', async () => {
    interface Inner {
      seed: number;
      doubled?: number;
    }

    const inner = flowChart<Inner>(
      'Double',
      (s) => {
        s.doubled = (s.seed ?? 0) * 2;
      },
      'double',
      undefined,
      'Double: multiply seed by 2',
    ).build();

    interface Outer {
      seed: number;
      doubled?: number;
    }

    const chart = flowChart<Outer>(
      'Start',
      (s) => {
        s.seed = 21;
      },
      'start',
    )
      .addSubFlowChartNext('sf-double', inner, 'Doubling subflow', {
        inputMapper: (parent) => ({ seed: parent.seed }),
        outputMapper: (sub) => ({ doubled: sub.doubled }),
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    const boundaries = boundaryRecorder();
    executor.attachCombinedRecorder(boundaries);

    await executor.run({ input: {} });

    // One subflow → one step → one pair of boundaries.
    expect(boundaries.getSteps()).toHaveLength(1);
    expect(boundaries.getBoundaries()).toHaveLength(2);

    const step = boundaries.getSteps()[0];
    expect(step.subflowId).toBe('sf-double');
    expect(step.subflowPath).toEqual(['sf-double']);
    // inputMapper payload arrives as the entry boundary's payload.
    expect(step.payload).toMatchObject({ seed: 21 });

    // exit boundary carries the subflow's final shared state.
    const pair = boundaries.getBoundary(step.runtimeStageId);
    expect(pair.exit?.payload).toBeDefined();
    expect(pair.exit?.payload?.doubled).toBe(42);

    // Description from the subflow's root stage flows through.
    expect(step.description).toBe('Double: multiply seed by 2');
  });

  it('captures nested subflow boundaries with full subflowPath', async () => {
    // Each subflow writes a DISTINCT key (TypedScope marks inputMapper outputs
    // readonly inside the subflow — writing to the same key would error).
    interface InnerState {
      seed: number;
      incremented?: number;
    }
    const innermost = flowChart<InnerState>(
      'Innermost',
      (s) => {
        s.incremented = (s.seed ?? 0) + 1;
      },
      'inc',
    ).build();

    interface MidState {
      from: number;
      mid?: number;
      incremented?: number;
    }
    const mid = flowChart<MidState>(
      'Mid',
      (s) => {
        s.mid = s.from;
      },
      'set-mid',
    )
      .addSubFlowChartNext('sf-inner', innermost, 'Inner', {
        inputMapper: (p) => ({ seed: p.from }),
        outputMapper: (s) => ({ incremented: s.incremented }),
      })
      .build();

    interface RootState {
      n: number;
      mid?: number;
      incremented?: number;
    }
    const root = flowChart<RootState>(
      'Root',
      (s) => {
        s.n = 5;
      },
      'root',
    )
      .addSubFlowChartNext('sf-mid', mid, 'Mid', {
        inputMapper: (p) => ({ from: p.n }),
        outputMapper: (s) => ({ mid: s.mid, incremented: s.incremented }),
      })
      .build();

    const executor = new FlowChartExecutor(root);
    const boundaries = boundaryRecorder();
    executor.attachCombinedRecorder(boundaries);
    await executor.run({ input: {} });

    const steps = boundaries.getSteps();
    expect(steps).toHaveLength(2);
    expect(steps[0].subflowPath).toEqual(['sf-mid']);
    expect(steps[0].depth).toBe(0);
    expect(steps[1].subflowPath).toEqual(['sf-mid', 'sf-inner']);
    expect(steps[1].depth).toBe(1);

    // Inner subflow's entry payload comes from its parent's inputMapper.
    expect(steps[1].payload).toMatchObject({ seed: 5 });
  });
});

// ── Query API ───────────────────────────────────────────────────────────

describe('BoundaryRecorder — query API', () => {
  it('getEntriesForStep returns both phases for the same runtimeStageId', () => {
    const rec = new BoundaryRecorder();
    rec.onSubflowEntry!(entryEvent('sf-x', 'X', 'x#0'));
    rec.onSubflowExit!(exitEvent('sf-x', 'X', 'x#0'));
    rec.onSubflowEntry!(entryEvent('sf-y', 'Y', 'y#1'));
    rec.onSubflowExit!(exitEvent('sf-y', 'Y', 'y#1'));

    expect(rec.getEntriesForStep('x#0').map((b) => b.phase)).toEqual(['entry', 'exit']);
    expect(rec.getEntriesForStep('y#1')).toHaveLength(2);
    expect(rec.getEntriesForStep('nope')).toEqual([]);
  });

  it('getEntryRanges provides O(1) per-step range lookup for time-travel UIs', () => {
    const rec = new BoundaryRecorder();
    rec.onSubflowEntry!(entryEvent('sf-a', 'A', 'a#0'));
    rec.onSubflowExit!(exitEvent('sf-a', 'A', 'a#0'));
    rec.onSubflowEntry!(entryEvent('sf-b', 'B', 'b#1'));
    rec.onSubflowExit!(exitEvent('sf-b', 'B', 'b#1'));

    const ranges = rec.getEntryRanges();
    expect(ranges.get('a#0')).toEqual({ firstIdx: 0, endIdx: 2 });
    expect(ranges.get('b#1')).toEqual({ firstIdx: 2, endIdx: 4 });
  });

  it('toSnapshot returns a standard bundle shape', () => {
    const rec = new BoundaryRecorder();
    rec.onSubflowEntry!(entryEvent('sf-x', 'X', 'x#0'));
    const snap = rec.toSnapshot();
    expect(snap.name).toBe('Boundaries');
    expect(snap.preferredOperation).toBe('translate');
    expect(Array.isArray(snap.data)).toBe(true);
    expect((snap.data as { phase: string }[])[0].phase).toBe('entry');
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────

describe('BoundaryRecorder — lifecycle', () => {
  it('clear() resets all state', () => {
    const rec = new BoundaryRecorder();
    rec.onSubflowEntry!(entryEvent('sf-x', 'X', 'x#0'));
    rec.onSubflowExit!(exitEvent('sf-x', 'X', 'x#0'));
    expect(rec.getBoundaries()).toHaveLength(2);

    rec.clear();
    expect(rec.getBoundaries()).toEqual([]);
    expect(rec.getSteps()).toEqual([]);
    expect(rec.getBoundary('x#0').entry).toBeUndefined();
  });

  it('factory assigns unique auto-incremented ids', () => {
    const a = boundaryRecorder();
    const b = boundaryRecorder();
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^boundaries-\d+$/);
  });

  it('factory honors explicit id', () => {
    expect(boundaryRecorder({ id: 'my-boundaries' }).id).toBe('my-boundaries');
  });

  it('ignores subflow events without a subflowId (defensive)', () => {
    const rec = new BoundaryRecorder();
    rec.onSubflowEntry!({ name: 'Anon' });
    rec.onSubflowExit!({ name: 'Anon' });
    expect(rec.getBoundaries()).toEqual([]);
  });
});

/**
 * Unit tests for InOutRecorder — 7 patterns covering the consumer circle.
 *
 * Every chart execution produces an entry/exit pair sharing a runtimeStageId.
 * The top-level run is bracketed by `onRunStart`/`onRunEnd` (synthetic
 * `__root__` boundary at depth 0); subflows nest under it (depth 1+).
 *
 *   P1  Top-level run (root entry/exit) → __root__ pair, depth 0, isRoot
 *   P2  Single subflow                   → entry+exit at depth 1, path nested under root
 *   P3  Sequential chain (3 subflows)    → 3 sibling subflow pairs, all depth 1
 *   P4  Nested subflow (parent → child)  → child's path = ['__root__', parent, child]
 *   P5  Loop re-entry (same subflowId)   → distinct runtimeStageIds per iteration
 *   P6  In-progress / paused (entry only)→ entry without exit; getBoundary handles gracefully
 *   P7  Integration with FlowChartExecutor → real run, root + subflow chain end-to-end
 *
 * Plus query API + lifecycle.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/index';
import type { FlowRunEvent, FlowSubflowEvent } from '../../../src/lib/engine/narrative/types';
import {
  InOutRecorder,
  inOutRecorder,
  ROOT_RUNTIME_STAGE_ID,
  ROOT_SUBFLOW_ID,
} from '../../../src/lib/recorder/InOutRecorder';
import { FlowChartExecutor } from '../../../src/lib/runner/index';

// ── Helpers ─────────────────────────────────────────────────────────────

function runEvent(payload?: unknown): FlowRunEvent {
  return { payload };
}

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

// ── P1: top-level run boundary ──────────────────────────────────────────

describe('InOutRecorder — P1: top-level run boundary', () => {
  it('emits __root__ entry/exit with isRoot=true on onRunStart/onRunEnd', () => {
    const rec = new InOutRecorder();
    rec.onRunStart!(runEvent({ request: 'analyze' }));
    rec.onRunEnd!(runEvent({ result: 'done' }));

    const root = rec.getRootBoundary();
    expect(root.entry).toMatchObject({
      runtimeStageId: ROOT_RUNTIME_STAGE_ID,
      subflowId: ROOT_SUBFLOW_ID,
      subflowPath: [ROOT_SUBFLOW_ID],
      depth: 0,
      phase: 'entry',
      payload: { request: 'analyze' },
      isRoot: true,
    });
    expect(root.exit?.payload).toEqual({ result: 'done' });
    expect(root.exit?.isRoot).toBe(true);

    // Both halves are present in the flat stream.
    expect(rec.getBoundaries()).toHaveLength(2);
    expect(rec.getSteps()).toHaveLength(1);
    expect(rec.getSteps()[0].subflowId).toBe(ROOT_SUBFLOW_ID);
  });
});

// ── P2: single subflow under root ───────────────────────────────────────

describe('InOutRecorder — P2: single subflow under root', () => {
  it('subflow boundary nests under __root__ in the path tree', () => {
    const rec = new InOutRecorder();
    rec.onRunStart!(runEvent({ in: 'top' }));
    rec.onSubflowEntry!(entryEvent('sf-task', 'Task', 'task#0', { greeting: 'hello' }));
    rec.onSubflowExit!(exitEvent('sf-task', 'Task', 'task#0', { result: 'done' }));
    rec.onRunEnd!(runEvent({ out: 'top-result' }));

    const all = rec.getBoundaries();
    // Root entry, subflow entry, subflow exit, root exit.
    expect(all).toHaveLength(4);
    expect(all.map((b) => b.phase)).toEqual(['entry', 'entry', 'exit', 'exit']);

    const sub = rec.getBoundary('task#0');
    expect(sub.entry).toMatchObject({
      runtimeStageId: 'task#0',
      subflowId: 'sf-task',
      localSubflowId: 'sf-task',
      subflowPath: [ROOT_SUBFLOW_ID, 'sf-task'],
      depth: 1,
      phase: 'entry',
      payload: { greeting: 'hello' },
      isRoot: false,
    });
    expect(sub.exit?.payload).toEqual({ result: 'done' });
  });
});

// ── P3: sequential chain ────────────────────────────────────────────────

describe('InOutRecorder — P3: sequential chain', () => {
  it('three sibling subflows under root produce three entry/exit pairs at depth 1', () => {
    const rec = new InOutRecorder();
    rec.onRunStart!(runEvent({}));
    rec.onSubflowEntry!(entryEvent('sf-a', 'A', 'a#0'));
    rec.onSubflowExit!(exitEvent('sf-a', 'A', 'a#0'));
    rec.onSubflowEntry!(entryEvent('sf-b', 'B', 'b#1'));
    rec.onSubflowExit!(exitEvent('sf-b', 'B', 'b#1'));
    rec.onSubflowEntry!(entryEvent('sf-c', 'C', 'c#2'));
    rec.onSubflowExit!(exitEvent('sf-c', 'C', 'c#2'));
    rec.onRunEnd!(runEvent({}));

    // Steps: __root__, sf-a, sf-b, sf-c.
    const steps = rec.getSteps();
    expect(steps.map((s) => s.subflowId)).toEqual([ROOT_SUBFLOW_ID, 'sf-a', 'sf-b', 'sf-c']);
    expect(steps.slice(1).every((s) => s.depth === 1)).toBe(true);
    expect(steps.slice(1).every((s) => s.subflowPath[0] === ROOT_SUBFLOW_ID)).toBe(true);
  });
});

// ── P4: nested subflow ──────────────────────────────────────────────────

describe('InOutRecorder — P4: nested subflow (parent → child)', () => {
  it("child's subflowPath is ['__root__', parent, child]", () => {
    const rec = new InOutRecorder();
    rec.onRunStart!(runEvent({}));
    rec.onSubflowEntry!(entryEvent('sf-parent', 'Parent', 'p#0'));
    // Engine emits child subflowId path-prefixed under the parent.
    rec.onSubflowEntry!(entryEvent('sf-parent/sf-child', 'Child', 'c#1', { from: 'parent' }));
    rec.onSubflowExit!(exitEvent('sf-parent/sf-child', 'Child', 'c#1', { back: 'to parent' }));
    rec.onSubflowExit!(exitEvent('sf-parent', 'Parent', 'p#0'));
    rec.onRunEnd!(runEvent({}));

    const child = rec.getBoundary('c#1');
    expect(child.entry?.subflowId).toBe('sf-parent/sf-child');
    expect(child.entry?.localSubflowId).toBe('sf-child');
    expect(child.entry?.subflowPath).toEqual([ROOT_SUBFLOW_ID, 'sf-parent', 'sf-child']);
    expect(child.entry?.depth).toBe(2);
    expect(child.entry?.payload).toEqual({ from: 'parent' });
    expect(child.exit?.payload).toEqual({ back: 'to parent' });

    const parent = rec.getBoundary('p#0');
    expect(parent.entry?.subflowPath).toEqual([ROOT_SUBFLOW_ID, 'sf-parent']);
    expect(parent.entry?.depth).toBe(1);
  });
});

// ── P5: loop re-entry ───────────────────────────────────────────────────

describe('InOutRecorder — P5: loop re-entry of same subflowId', () => {
  it('each iteration produces a distinct entry/exit pair via runtimeStageId', () => {
    const rec = new InOutRecorder();
    rec.onSubflowEntry!(entryEvent('sf-iter', 'Iter', 'iter#0'));
    rec.onSubflowExit!(exitEvent('sf-iter', 'Iter', 'iter#0'));
    rec.onSubflowEntry!(entryEvent('sf-iter', 'Iter', 'iter#1'));
    rec.onSubflowExit!(exitEvent('sf-iter', 'Iter', 'iter#1'));
    rec.onSubflowEntry!(entryEvent('sf-iter', 'Iter', 'iter#2'));
    rec.onSubflowExit!(exitEvent('sf-iter', 'Iter', 'iter#2'));

    const subflowSteps = rec.getSteps().filter((s) => !s.isRoot);
    expect(subflowSteps).toHaveLength(3);
    expect(subflowSteps.map((s) => s.runtimeStageId)).toEqual(['iter#0', 'iter#1', 'iter#2']);
    expect(subflowSteps.every((s) => s.subflowId === 'sf-iter')).toBe(true);
  });
});

// ── P6: in-progress / paused subflow ────────────────────────────────────

describe('InOutRecorder — P6: entry without matching exit', () => {
  it('getBoundary returns entry with exit=undefined when subflow has not completed', () => {
    const rec = new InOutRecorder();
    rec.onSubflowEntry!(entryEvent('sf-paused', 'Paused', 'p#0', { question: 'approve?' }));

    const pair = rec.getBoundary('p#0');
    expect(pair.entry).toBeDefined();
    expect(pair.exit).toBeUndefined();
  });

  it('paused root: onRunStart fired, onRunEnd never fired', () => {
    const rec = new InOutRecorder();
    rec.onRunStart!(runEvent({ q: 'pause please' }));
    // No matching onRunEnd — engine re-threw PauseSignal before run completed.

    const root = rec.getRootBoundary();
    expect(root.entry).toBeDefined();
    expect(root.exit).toBeUndefined();
  });
});

// ── P7: integration with FlowChartExecutor ──────────────────────────────

describe('InOutRecorder — P7: integration with FlowChartExecutor', () => {
  it('captures root run + subflow entry/exit in execution order with real payloads', async () => {
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
    const inOut = inOutRecorder();
    executor.attachCombinedRecorder(inOut);

    await executor.run({ input: {} });

    const steps = inOut.getSteps();
    // Steps: root (depth 0), sf-double (depth 1).
    expect(steps).toHaveLength(2);
    expect(steps[0].isRoot).toBe(true);
    expect(steps[0].depth).toBe(0);
    expect(steps[1].subflowId).toBe('sf-double');
    expect(steps[1].depth).toBe(1);
    expect(steps[1].payload).toMatchObject({ seed: 21 });
    expect(steps[1].description).toBe('Double: multiply seed by 2');

    // Root pair brackets the run.
    const root = inOut.getRootBoundary();
    expect(root.entry).toBeDefined();
    expect(root.exit).toBeDefined();

    // Subflow pair has both halves.
    const sub = inOut.getBoundary(steps[1].runtimeStageId);
    expect(sub.exit?.payload).toMatchObject({ doubled: 42 });
  });

  it('captures nested subflow boundaries with full subflowPath', async () => {
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
    const inOut = inOutRecorder();
    executor.attachCombinedRecorder(inOut);
    await executor.run({ input: {} });

    const steps = inOut.getSteps();
    // Root + sf-mid + sf-mid/sf-inner = 3 steps.
    expect(steps).toHaveLength(3);
    expect(steps[0].isRoot).toBe(true);
    expect(steps[1].subflowPath).toEqual([ROOT_SUBFLOW_ID, 'sf-mid']);
    expect(steps[1].depth).toBe(1);
    expect(steps[2].subflowPath).toEqual([ROOT_SUBFLOW_ID, 'sf-mid', 'sf-inner']);
    expect(steps[2].depth).toBe(2);
  });
});

// ── Query API ───────────────────────────────────────────────────────────

describe('InOutRecorder — query API', () => {
  it('getEntriesForStep returns both phases for the same runtimeStageId', () => {
    const rec = new InOutRecorder();
    rec.onSubflowEntry!(entryEvent('sf-x', 'X', 'x#0'));
    rec.onSubflowExit!(exitEvent('sf-x', 'X', 'x#0'));
    expect(rec.getEntriesForStep('x#0').map((b) => b.phase)).toEqual(['entry', 'exit']);
  });

  it('getRootBoundary returns root pair', () => {
    const rec = new InOutRecorder();
    rec.onRunStart!(runEvent({ a: 1 }));
    rec.onRunEnd!(runEvent({ a: 2 }));
    const root = rec.getRootBoundary();
    expect(root.entry?.payload).toEqual({ a: 1 });
    expect(root.exit?.payload).toEqual({ a: 2 });
  });

  it('toSnapshot returns standard bundle shape', () => {
    const rec = new InOutRecorder();
    rec.onRunStart!(runEvent({}));
    const snap = rec.toSnapshot();
    expect(snap.name).toBe('InOut');
    expect(snap.preferredOperation).toBe('translate');
    expect(Array.isArray(snap.data)).toBe(true);
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────

describe('InOutRecorder — lifecycle', () => {
  it('clear() resets all state', () => {
    const rec = new InOutRecorder();
    rec.onRunStart!(runEvent({}));
    rec.onSubflowEntry!(entryEvent('sf-x', 'X', 'x#0'));
    rec.onSubflowExit!(exitEvent('sf-x', 'X', 'x#0'));
    rec.onRunEnd!(runEvent({}));
    expect(rec.getBoundaries()).toHaveLength(4);

    rec.clear();
    expect(rec.getBoundaries()).toEqual([]);
    expect(rec.getRootBoundary().entry).toBeUndefined();
  });

  it('factory assigns unique auto-incremented ids', () => {
    const a = inOutRecorder();
    const b = inOutRecorder();
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^inout-\d+$/);
  });

  it('factory honors explicit id', () => {
    expect(inOutRecorder({ id: 'my-inout' }).id).toBe('my-inout');
  });

  it('ignores subflow events without a subflowId (defensive)', () => {
    const rec = new InOutRecorder();
    rec.onSubflowEntry!({ name: 'Anon' });
    rec.onSubflowExit!({ name: 'Anon' });
    expect(rec.getBoundaries()).toEqual([]);
  });
});

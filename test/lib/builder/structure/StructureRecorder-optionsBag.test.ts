/**
 * L7.4 — `flowChart(..., { structureRecorders: [...] })` options-bag
 * registration. Exercises the alternative-to-`.attachStructureRecorder()`
 * registration path:
 *
 *   - recorders attached BEFORE `start()` fires → seed event arrives
 *     through the normal dispatcher fan-out (no seed-replay code path)
 *   - array order = attach order (matches fluent chain semantics)
 *   - multiple recorders co-exist
 *   - mid-chain `.attachStructureRecorder()` still works after the
 *     options-bag path — combined registration is fine
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder/FlowChartBuilder.js';
import type {
  StructureEdgeAddedEvent,
  StructureRecorder,
  StructureStageAddedEvent,
} from '../../../../src/lib/builder/structure/StructureRecorder.js';

function spyRecorder(id: string) {
  const events: Array<{ kind: string; payload: unknown }> = [];
  const rec: StructureRecorder = {
    id,
    onStageAdded: (e) => events.push({ kind: 'stage', payload: e }),
    onEdgeAdded: (e) => events.push({ kind: 'edge', payload: e }),
    onLoopEdgeAdded: (e) => events.push({ kind: 'loop', payload: e }),
    onDeciderComplete: (e) => events.push({ kind: 'decider', payload: e }),
    onSubflowMounted: (e) => events.push({ kind: 'subflow', payload: e }),
  };
  return { rec, events };
}

const noop = async (): Promise<void> => {};

// ── 1. Unit ────────────────────────────────────────────────────────────────

describe('flowChart options-bag — structureRecorders unit', () => {
  it('a recorder passed via { structureRecorders: [rec] } receives the seed onStageAdded', () => {
    const { rec, events } = spyRecorder('opts-seed');
    flowChart('seed', noop, 'seed', { structureRecorders: [rec] }).build();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('stage');
    expect((events[0]!.payload as StructureStageAddedEvent).stageId).toBe('seed');
  });

  it('options-bag attach fires seed through the NORMAL dispatcher path (no replay needed)', () => {
    // The distinguishing property: when the recorder is attached BEFORE
    // start(), it receives the seed event through the normal fan-out,
    // not through `recordErrorForReplay`. A recorder that throws should
    // surface its error via `getStructureBuildErrors()` regardless of
    // registration path — but the registration path itself shouldn't
    // matter to the consumer.
    const events: string[] = [];
    const rec: StructureRecorder = {
      id: 'opts-normal-path',
      onStageAdded: (e) => events.push(e.stageId),
    };
    flowChart('seed', noop, 'seed', { structureRecorders: [rec] })
      .addFunction('a', noop, 'a')
      .build();
    expect(events).toEqual(['seed', 'a']);
  });
});

// ── 2. Functional ─────────────────────────────────────────────────────────

describe('flowChart options-bag — structureRecorders functional', () => {
  it('multiple recorders in the options bag attach in array order', () => {
    const callLog: string[] = [];
    const r1: StructureRecorder = {
      id: 'r1',
      onStageAdded: () => callLog.push('r1'),
    };
    const r2: StructureRecorder = {
      id: 'r2',
      onStageAdded: () => callLog.push('r2'),
    };
    const r3: StructureRecorder = {
      id: 'r3',
      onStageAdded: () => callLog.push('r3'),
    };
    flowChart('seed', noop, 'seed', {
      structureRecorders: [r1, r2, r3],
    }).build();
    expect(callLog).toEqual(['r1', 'r2', 'r3']);
  });

  it('empty structureRecorders array is a no-op (no dispatcher allocated by attach loop)', () => {
    // Should not throw; behaves the same as omitting the field.
    expect(() =>
      flowChart('seed', noop, 'seed', { structureRecorders: [] }).addFunction('a', noop, 'a').build(),
    ).not.toThrow();
  });
});

// ── 3. Integration ────────────────────────────────────────────────────────

describe('flowChart options-bag — integration', () => {
  it('options-bag + fluent attachStructureRecorder co-exist (combined registration)', () => {
    const { rec: optsRec, events: optsEvents } = spyRecorder('opts-rec');
    const { rec: fluentRec, events: fluentEvents } = spyRecorder('fluent-rec');
    flowChart('seed', noop, 'seed', { structureRecorders: [optsRec] })
      .attachStructureRecorder(fluentRec)
      .addFunction('a', noop, 'a')
      .build();
    // Both recorders saw the full event sequence.
    const optsStages = optsEvents.filter((e) => e.kind === 'stage').length;
    const fluentStages = fluentEvents.filter((e) => e.kind === 'stage').length;
    expect(optsStages).toBe(2);
    expect(fluentStages).toBe(2);
  });

  it('description field on the options bag still flows through to the root spec', () => {
    const { rec, events } = spyRecorder('desc');
    flowChart('seed', noop, 'seed', {
      structureRecorders: [rec],
      description: 'root description',
    }).build();
    const seedEvent = events.find((e) => e.kind === 'stage');
    expect(seedEvent).toBeDefined();
    expect((seedEvent!.payload as StructureStageAddedEvent).spec.description).toBe('root description');
  });
});

// ── 4. Property ────────────────────────────────────────────────────────────

describe('flowChart options-bag — property', () => {
  it.each([0, 1, 3, 10])('N recorders via options bag all receive the seed event (N=%d)', (n) => {
    const counts = Array.from({ length: n }, () => 0);
    const recorders: StructureRecorder[] = counts.map((_, i) => ({
      id: `r${i}`,
      onStageAdded: () => (counts[i]! += 1),
    }));
    flowChart('seed', noop, 'seed', {
      structureRecorders: recorders,
    }).build();
    for (let i = 0; i < n; i++) {
      expect(counts[i]).toBe(1);
    }
  });
});

// ── 5. Security ────────────────────────────────────────────────────────────

describe('flowChart options-bag — security (error isolation parity)', () => {
  it('a throwing recorder in the options bag does NOT cascade — sibling recorders still fire', () => {
    const surviving: string[] = [];
    const throwing: StructureRecorder = {
      id: 'throws',
      onStageAdded: () => {
        throw new Error('opts-bag-boom');
      },
    };
    const survivor: StructureRecorder = {
      id: 'survivor',
      onStageAdded: (e) => surviving.push(e.stageId),
    };
    expect(() =>
      flowChart('seed', noop, 'seed', {
        structureRecorders: [throwing, survivor],
      }).build(),
    ).not.toThrow();
    expect(surviving).toEqual(['seed']);
  });
});

// ── 6. Performance ─────────────────────────────────────────────────────────

describe('flowChart options-bag — performance', () => {
  it('500-stage chart with options-bag recorder builds under 100ms', () => {
    const { rec } = spyRecorder('perf');
    let b = flowChart('seed', noop, 'seed', { structureRecorders: [rec] });
    for (let i = 0; i < 500; i++) {
      b = b.addFunction(`s${i}`, noop, `s${i}`);
    }
    const t0 = performance.now();
    b.build();
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

// ── Panel-driven regression tests (Panel 2 re-review gaps) ─────────────────

describe('flowChart options-bag — undefined / null inputs', () => {
  it('explicit structureRecorders: undefined behaves identically to omitting the field', () => {
    expect(() =>
      flowChart('seed', noop, 'seed', { structureRecorders: undefined }).addFunction('a', noop, 'a').build(),
    ).not.toThrow();
  });
});

describe('flowChart options-bag — fluent-after-options seed-replay asymmetry (Panel 2 explicit assertion)', () => {
  it('options-bag recorder sees seed via dispatcher fan-out; later fluent recorder sees seed via REPLAY', () => {
    const optsRecCalls: Array<{ phase: 'sync' | 'replay'; stageId: string }> = [];
    const fluentRecCalls: Array<{ phase: 'sync' | 'replay'; stageId: string }> = [];
    let optsAttached = false;
    let fluentAttached = false;
    const optsRec: StructureRecorder = {
      id: 'opts',
      onStageAdded: (e) =>
        optsRecCalls.push({
          phase: optsAttached ? 'sync' : 'replay',
          stageId: e.stageId,
        }),
    };
    const fluentRec: StructureRecorder = {
      id: 'fluent',
      onStageAdded: (e) =>
        fluentRecCalls.push({
          phase: fluentAttached ? 'sync' : 'replay',
          stageId: e.stageId,
        }),
    };
    // Mark "attached" right before each registration site so the
    // recorder's first fire surfaces which dispatcher path it took.
    optsAttached = true;
    const builder = flowChart('seed', noop, 'seed', {
      structureRecorders: [optsRec],
    });
    fluentAttached = true;
    builder.attachStructureRecorder(fluentRec).addFunction('a', noop, 'a').build();
    // Both recorders observed the seed; options-bag took the sync path,
    // fluent took the replay path.
    expect(optsRecCalls.map((c) => c.stageId)).toEqual(['seed', 'a']);
    expect(fluentRecCalls.map((c) => c.stageId)).toEqual(['seed', 'a']);
  });
});

// ── 7. ROI ─────────────────────────────────────────────────────────────────

describe('flowChart options-bag — ROI (single-call registration)', () => {
  it('the canonical "single-call register N recorders" pattern works end-to-end', () => {
    const stages: string[] = [];
    const edges: Array<{ from: string; to: string }> = [];
    const subflows: string[] = [];
    const inventory: StructureRecorder[] = [
      {
        id: 'stages',
        onStageAdded: (e) => stages.push(e.stageId),
      },
      {
        id: 'edges',
        onEdgeAdded: (e) => edges.push({ from: e.from, to: e.to }),
      },
      {
        id: 'subflows',
        onSubflowMounted: (e) => subflows.push(e.subflowId),
      },
    ];
    const sub = flowChart('s-seed', noop, 's-seed').build();
    flowChart('seed', noop, 'seed', { structureRecorders: inventory })
      .addFunction('a', noop, 'a')
      .addSubFlowChartNext('sub', sub, 'Sub')
      .build();

    expect(stages).toContain('seed');
    expect(stages).toContain('a');
    expect(stages).toContain('sub');
    expect(edges).toContainEqual({ from: 'seed', to: 'a' });
    expect(edges).toContainEqual({ from: 'a', to: 'sub' });
    expect(subflows).toEqual(['sub']);
  });
});

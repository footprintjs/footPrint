/**
 * L7.2 — `StructureRecorderDispatcher` — 7-pattern test matrix.
 *
 * Covers: attach/detach, multi-recorder fan-out, error isolation
 * (both dev-warn AND structured accumulator), spec freezing on
 * dispatch, and the zero-allocation fast path when no recorders are
 * attached. End-to-end integration with the deferred-flush state
 * machine is L7.3 — tested separately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  StructureEdgeAddedEvent,
  StructureRecorder,
  StructureStageAddedEvent,
} from '../../../../src/lib/builder/structure/StructureRecorder.js';
import { StructureRecorderDispatcher } from '../../../../src/lib/builder/structure/StructureRecorderDispatcher.js';
import type { FlowChartSpec } from '../../../../src/lib/builder/types.js';
import { disableDevMode, enableDevMode } from '../../../../src/lib/scope/detectCircular.js';

const sampleSpec: FlowChartSpec = { id: 'a', name: 'A', type: 'stage' };

const stageEvt = (overrides?: Partial<StructureStageAddedEvent>): StructureStageAddedEvent => ({
  stageId: 'a',
  name: 'A',
  type: 'stage',
  spec: sampleSpec,
  ...overrides,
});

const edgeEvt = (overrides?: Partial<StructureEdgeAddedEvent>): StructureEdgeAddedEvent => ({
  from: 'a',
  to: 'b',
  kind: 'next',
  ...overrides,
});

// ── 1. Unit ────────────────────────────────────────────────────────────────

describe('StructureRecorderDispatcher — unit', () => {
  it('attach adds a recorder; getRecorders reflects it', () => {
    const d = new StructureRecorderDispatcher();
    const rec: StructureRecorder = { id: 'r1' };
    d.attach(rec);
    expect(d.getRecorders()).toEqual([rec]);
  });

  it('detach removes recorders matching the id', () => {
    const d = new StructureRecorderDispatcher();
    d.attach({ id: 'r1' });
    d.attach({ id: 'r2' });
    d.attach({ id: 'r1' }); // dupe id allowed
    d.detach('r1');
    expect(d.getRecorders()).toHaveLength(1);
    expect(d.getRecorders()[0]!.id).toBe('r2');
  });

  it('getRecorderById finds the first match', () => {
    const d = new StructureRecorderDispatcher();
    const target: StructureRecorder = { id: 'target' };
    d.attach({ id: 'other' });
    d.attach(target);
    expect(d.getRecorderById('target')).toBe(target);
    expect(d.getRecorderById('nonexistent')).toBeUndefined();
  });

  it('fireStageAdded with no recorders is a no-op (fast path)', () => {
    const d = new StructureRecorderDispatcher();
    expect(() => d.fireStageAdded(stageEvt())).not.toThrow();
    expect(d.getErrors()).toEqual([]);
  });
});

// ── 2. Functional ─────────────────────────────────────────────────────────

describe('StructureRecorderDispatcher — functional', () => {
  it('fireStageAdded dispatches to every attached recorder in attach order', () => {
    const d = new StructureRecorderDispatcher();
    const calls: string[] = [];
    d.attach({ id: 'r1', onStageAdded: () => calls.push('r1') });
    d.attach({ id: 'r2', onStageAdded: () => calls.push('r2') });
    d.attach({ id: 'r3', onStageAdded: () => calls.push('r3') });
    d.fireStageAdded(stageEvt());
    expect(calls).toEqual(['r1', 'r2', 'r3']);
  });

  it('each of the 5 fire* methods routes to its corresponding handler', () => {
    const d = new StructureRecorderDispatcher();
    const seen: string[] = [];
    d.attach({
      id: 'all',
      onStageAdded: () => seen.push('stage'),
      onEdgeAdded: () => seen.push('edge'),
      onLoopEdgeAdded: () => seen.push('loop'),
      onDeciderComplete: () => seen.push('decider'),
      onSubflowMounted: () => seen.push('subflow'),
    });
    d.fireStageAdded(stageEvt());
    d.fireEdgeAdded(edgeEvt());
    d.fireLoopEdgeAdded({ from: 'a', to: 'seed' });
    d.fireDeciderComplete({ decider: 'd', type: 'decider', branchIds: [] });
    d.fireSubflowMounted({
      subflowId: 'sf',
      subflowName: 'SF',
      rootStageId: 'sf',
    });
    expect(seen).toEqual(['stage', 'edge', 'loop', 'decider', 'subflow']);
  });

  it('recorders with no handler for an event are skipped silently', () => {
    const d = new StructureRecorderDispatcher();
    let count = 0;
    d.attach({ id: 'minimal' }); // no handlers
    d.attach({ id: 'stage-only', onStageAdded: () => (count += 1) });
    d.fireStageAdded(stageEvt());
    d.fireEdgeAdded(edgeEvt());
    expect(count).toBe(1);
  });
});

// ── 3. Integration ────────────────────────────────────────────────────────

describe('StructureRecorderDispatcher — integration (multi-handler accumulator)', () => {
  it('two recorders building disjoint accumulators co-exist cleanly', () => {
    const d = new StructureRecorderDispatcher();
    const nodes: string[] = [];
    const edges: string[] = [];
    d.attach({ id: 'nodes', onStageAdded: (e) => nodes.push(e.stageId) });
    d.attach({
      id: 'edges',
      onEdgeAdded: (e) => edges.push(`${e.from}->${e.to}`),
    });
    d.fireStageAdded(stageEvt({ stageId: 'a' }));
    d.fireStageAdded(stageEvt({ stageId: 'b' }));
    d.fireEdgeAdded(edgeEvt({ from: 'a', to: 'b' }));
    expect(nodes).toEqual(['a', 'b']);
    expect(edges).toEqual(['a->b']);
  });
});

// ── 4. Property ────────────────────────────────────────────────────────────

describe('StructureRecorderDispatcher — property', () => {
  it.each([0, 1, 3, 10, 100])('N recorders all receive the event (N=%d)', (n) => {
    const d = new StructureRecorderDispatcher();
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      d.attach({ id: `r${i}`, onStageAdded: (e) => seen.add(`${i}:${e.stageId}`) });
    }
    d.fireStageAdded(stageEvt());
    expect(seen.size).toBe(n);
  });
});

// ── Panel-driven regression tests (post 7-panel review on L7.1+L7.2) ───────

describe('StructureRecorderDispatcher — getErrors defensive copy (Panel 7 gap)', () => {
  it('mutating the array returned by getErrors() does NOT affect subsequent calls', () => {
    const d = new StructureRecorderDispatcher();
    d.attach({
      id: 'r',
      onStageAdded: () => {
        throw new Error('boom');
      },
    });
    d.fireStageAdded(stageEvt());
    const first = d.getErrors();
    expect(first).toHaveLength(1);
    // Mutate the returned array — should NOT propagate to the
    // dispatcher's internal state.
    first.push({ recorderId: 'fake', method: 'fake', message: 'fake', error: null });
    first.pop();
    first.length = 0; // truncate aggressively
    // Subsequent call returns a fresh defensive copy.
    const second = d.getErrors();
    expect(second).toHaveLength(1);
    expect(second[0]!.message).toBe('boom');
  });
});

describe('StructureRecorderDispatcher — no-freeze contract (handler mutation is documented UB)', () => {
  // ── Why no freeze? ────────────────────────────────────────────────
  // `onStageAdded` fires IMMEDIATELY when the builder adds a spec
  // node — BEFORE the builder wires `.next`/`.children`/`.loopTarget`
  // on that same node in the next addX call. If the dispatcher froze
  // the spec here, the builder's subsequent mutation would throw
  // `TypeError: Cannot add property next, object is not extensible`.
  //
  // The honest contract: spec mutation by handlers is DOCUMENTED
  // undefined behavior (see StructureRecorder JSDoc + readonly markers
  // on the event payload interface). The type system signals intent;
  // runtime enforcement would break the builder.
  // ─────────────────────────────────────────────────────────────────

  it('spec is NOT frozen at dispatch — builder needs to mutate .next later', () => {
    const d = new StructureRecorderDispatcher();
    const spec: FlowChartSpec = { id: 'a', name: 'A', type: 'stage' };
    d.attach({ id: 'observer', onStageAdded: () => {} });
    d.fireStageAdded({ stageId: 'a', name: 'A', type: 'stage', spec });
    // Spec must remain extensible so the builder can later assign
    // `spec.next = <nextSpec>` when the chain continues.
    expect(Object.isFrozen(spec)).toBe(false);
    expect(Object.isExtensible(spec)).toBe(true);
  });

  it('handler mutation of spec succeeds at runtime (UB but does not throw)', () => {
    const d = new StructureRecorderDispatcher();
    const spec: FlowChartSpec = { id: 'a', name: 'A', type: 'stage' };
    d.attach({
      id: 'mutator',
      onStageAdded: (e) => {
        // Documented as undefined behavior in the StructureRecorder
        // type's JSDoc + readonly markers. The library does NOT
        // runtime-enforce — TypeScript signals intent at author time.
        (e.spec as { id: string }).id = 'MUTATED';
      },
    });
    d.fireStageAdded({ stageId: 'a', name: 'A', type: 'stage', spec });
    // The mutation went through; the dispatcher did not block it.
    // Real consumers should respect the readonly markers and not do this.
    expect(spec.id).toBe('MUTATED');
  });

  it('handler that mutates spec does NOT surface as a build error', () => {
    // The mutation succeeds (no throw) so it does NOT land in
    // getErrors(). Only handler exceptions accumulate there.
    const d = new StructureRecorderDispatcher();
    const spec: FlowChartSpec = { id: 'a', name: 'A', type: 'stage' };
    d.attach({
      id: 'mutator',
      onStageAdded: (e) => {
        (e.spec as { id: string }).id = 'X';
      },
    });
    d.fireStageAdded({ stageId: 'a', name: 'A', type: 'stage', spec });
    expect(d.getErrors()).toEqual([]);
  });
});

// ── 5. Security ────────────────────────────────────────────────────────────

describe('StructureRecorderDispatcher — security (error isolation + spec freeze)', () => {
  it('a throwing recorder does NOT cascade — sibling recorders still fire', () => {
    const d = new StructureRecorderDispatcher();
    const surviving: string[] = [];
    d.attach({
      id: 'r-throws',
      onStageAdded: () => {
        throw new Error('boom');
      },
    });
    d.attach({ id: 'r-survives', onStageAdded: (e) => surviving.push(e.stageId) });
    expect(() => d.fireStageAdded(stageEvt())).not.toThrow();
    expect(surviving).toEqual(['a']);
  });

  it('throws are accumulated on getErrors() for post-build inspection', () => {
    const d = new StructureRecorderDispatcher();
    d.attach({
      id: 'r1',
      onStageAdded: () => {
        throw new Error('boom');
      },
    });
    d.fireStageAdded(stageEvt());
    const errs = d.getErrors();
    expect(errs).toHaveLength(1);
    expect(errs[0]!.recorderId).toBe('r1');
    expect(errs[0]!.method).toBe('onStageAdded');
    expect(errs[0]!.message).toBe('boom');
  });

  it('non-Error throws are stringified into the accumulator', () => {
    const d = new StructureRecorderDispatcher();
    d.attach({
      id: 'r',
      onStageAdded: () => {
        // eslint-disable-next-line no-throw-literal
        throw 'string thrown';
      },
    });
    d.fireStageAdded(stageEvt());
    expect(d.getErrors()[0]!.message).toBe('string thrown');
  });

  describe('dev-mode warning', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      enableDevMode();
    });
    afterEach(() => {
      warnSpy.mockRestore();
      disableDevMode();
    });

    it('dev-mode logs a warning when a recorder throws', () => {
      const d = new StructureRecorderDispatcher();
      d.attach({
        id: 'noisy',
        onStageAdded: () => {
          throw new Error('boom');
        },
      });
      d.fireStageAdded(stageEvt());
      expect(warnSpy).toHaveBeenCalledOnce();
      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain('noisy');
      expect(message).toContain('onStageAdded');
    });

    it('production mode (dev OFF) does NOT log to console', () => {
      disableDevMode();
      const d = new StructureRecorderDispatcher();
      d.attach({
        id: 'silent',
        onStageAdded: () => {
          throw new Error('quiet');
        },
      });
      d.fireStageAdded(stageEvt());
      expect(warnSpy).not.toHaveBeenCalled();
      // BUT errors still accumulate even in production mode.
      expect(d.getErrors()).toHaveLength(1);
    });
  });

  it('dispatch of the same spec ref multiple times is safe (idempotent)', () => {
    const d = new StructureRecorderDispatcher();
    const seen: number[] = [];
    d.attach({ id: 'r', onStageAdded: () => seen.push(seen.length) });
    const sharedSpec: FlowChartSpec = { id: 's', name: 'S', type: 'stage' };
    d.fireStageAdded({ stageId: 's', name: 'S', type: 'stage', spec: sharedSpec });
    d.fireStageAdded({ stageId: 's', name: 'S', type: 'stage', spec: sharedSpec });
    expect(seen).toEqual([0, 1]);
    // Spec remains extensible across multiple dispatches.
    expect(Object.isExtensible(sharedSpec)).toBe(true);
  });
});

// ── 6. Performance ─────────────────────────────────────────────────────────

describe('StructureRecorderDispatcher — performance', () => {
  it('zero-recorder fast path: 10000 fireStageAdded calls under 30ms', () => {
    const d = new StructureRecorderDispatcher();
    const event = stageEvt();
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) d.fireStageAdded(event);
    expect(performance.now() - t0).toBeLessThan(30);
  });

  it('5 recorders × 1000 fireStageAdded under 50ms', () => {
    const d = new StructureRecorderDispatcher();
    for (let i = 0; i < 5; i++) {
      d.attach({ id: `r${i}`, onStageAdded: () => {} });
    }
    const event = stageEvt();
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) d.fireStageAdded(event);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

// ── 7. ROI ─────────────────────────────────────────────────────────────────

describe('StructureRecorderDispatcher — ROI', () => {
  it('one dispatcher fans out every build-phase event to every recorder, no per-event registration', () => {
    const d = new StructureRecorderDispatcher();
    const events: string[] = [];
    const universal: StructureRecorder = {
      id: 'universal',
      onStageAdded: () => events.push('stage'),
      onEdgeAdded: () => events.push('edge'),
      onLoopEdgeAdded: () => events.push('loop'),
      onDeciderComplete: () => events.push('decider'),
      onSubflowMounted: () => events.push('subflow'),
    };
    d.attach(universal);
    d.fireStageAdded(stageEvt());
    d.fireEdgeAdded(edgeEvt());
    d.fireLoopEdgeAdded({ from: 'a', to: 'seed' });
    d.fireDeciderComplete({ decider: 'd', type: 'decider', branchIds: [] });
    d.fireSubflowMounted({
      subflowId: 'sf',
      subflowName: 'SF',
      rootStageId: 'sf',
    });
    expect(events).toEqual(['stage', 'edge', 'loop', 'decider', 'subflow']);
  });
});

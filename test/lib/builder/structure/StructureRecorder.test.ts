/**
 * L7.1 — `StructureRecorder` interface surface tests.
 *
 * Scope: prove the type compiles cleanly under expected consumer
 * shapes, the events are constructible, and the interface admits all
 * the optional-method patterns we expect. Dispatcher behavior +
 * end-to-end wiring through the builder are L7.2 / L7.3 — tested in
 * their own files.
 */

import { describe, expect, it } from 'vitest';

import type {
  StructureDeciderCompleteEvent,
  StructureEdgeAddedEvent,
  StructureEdgeKind,
  StructureLoopEdgeAddedEvent,
  StructureRecorder,
  StructureStageAddedEvent,
  StructureSubflowMountedEvent,
} from '../../../../src/lib/builder/structure/StructureRecorder.js';
import type { FlowChartSpec } from '../../../../src/lib/builder/types.js';

// Reusable canned spec node — tests treat it as opaque payload data.
const cannedSpec: FlowChartSpec = { id: 'x', name: 'X', type: 'stage' };

// ── 1. Unit ────────────────────────────────────────────────────────────────

describe('StructureRecorder — unit (type construction)', () => {
  it('every event payload is constructible with required + optional fields', () => {
    const stageAdded: StructureStageAddedEvent = {
      stageId: 'a',
      name: 'A',
      type: 'stage',
      spec: cannedSpec,
    };
    const edgeAdded: StructureEdgeAddedEvent = {
      from: 'a',
      to: 'b',
      kind: 'next',
    };
    const loopAdded: StructureLoopEdgeAddedEvent = { from: 'a', to: 'seed' };
    const deciderComplete: StructureDeciderCompleteEvent = {
      decider: 'route',
      type: 'decider',
      branchIds: ['low', 'high'],
    };
    const subflowMounted: StructureSubflowMountedEvent = {
      subflowId: 'sf-tools',
      subflowName: 'Tools',
      rootStageId: 'tools-mount',
    };
    // Smoke — values present.
    expect(stageAdded.stageId).toBe('a');
    expect(edgeAdded.kind).toBe('next');
    expect(loopAdded.to).toBe('seed');
    expect(deciderComplete.branchIds).toEqual(['low', 'high']);
    expect(subflowMounted.subflowId).toBe('sf-tools');
  });

  it('a recorder implementing zero methods is a valid StructureRecorder', () => {
    const minimal: StructureRecorder = { id: 'minimal' };
    expect(minimal.id).toBe('minimal');
    // Optional methods all undefined — fine.
    expect(minimal.onStageAdded).toBeUndefined();
    expect(minimal.onEdgeAdded).toBeUndefined();
  });

  it('a recorder implementing a single method is a valid StructureRecorder', () => {
    const ids: string[] = [];
    const rec: StructureRecorder = {
      id: 'stage-only',
      onStageAdded: (e) => ids.push(e.stageId),
    };
    rec.onStageAdded!({ stageId: 'a', name: 'A', type: 'stage', spec: cannedSpec });
    expect(ids).toEqual(['a']);
  });
});

// ── 2. Functional ─────────────────────────────────────────────────────────

describe('StructureRecorder — functional', () => {
  it('a recorder implementing ALL methods is a valid StructureRecorder', () => {
    const calls: string[] = [];
    const rec: StructureRecorder = {
      id: 'full',
      onStageAdded: () => calls.push('stage'),
      onEdgeAdded: () => calls.push('edge'),
      onLoopEdgeAdded: () => calls.push('loop'),
      onDeciderComplete: () => calls.push('decider'),
      onSubflowMounted: () => calls.push('subflow'),
    };
    rec.onStageAdded!({ stageId: 'a', name: 'A', type: 'stage', spec: cannedSpec });
    rec.onEdgeAdded!({ from: 'a', to: 'b', kind: 'next' });
    rec.onLoopEdgeAdded!({ from: 'a', to: 'seed' });
    rec.onDeciderComplete!({ decider: 'd', type: 'decider', branchIds: [] });
    rec.onSubflowMounted!({
      subflowId: 'sf',
      subflowName: 'SF',
      rootStageId: 'r',
    });
    expect(calls).toEqual(['stage', 'edge', 'loop', 'decider', 'subflow']);
  });

  it('StructureEdgeKind admits the 3 canonical structural edge kinds', () => {
    // subflow-entry was removed in L7.2.5 (YAGNI — subflow mounts use
    // the lifecycle event onSubflowMounted, not an edge event).
    const kinds: StructureEdgeKind[] = ['next', 'fork-branch', 'decision-branch'];
    expect(kinds).toHaveLength(3);
  });

  it('StructureStageAddedEvent.spec is typed as FlowChartSpec (full structural fields visible)', () => {
    let seenChildren: FlowChartSpec[] | undefined;
    const rec: StructureRecorder = {
      id: 'inspect-spec',
      onStageAdded: (e) => {
        // The point of `spec` on the event: handlers that want richer
        // detail than the discriminator fields can read it.
        seenChildren = e.spec.children;
      },
    };
    rec.onStageAdded!({
      stageId: 'fork',
      name: 'fork',
      type: 'fork',
      spec: { id: 'fork', name: 'fork', type: 'fork', children: [cannedSpec] },
    });
    expect(seenChildren).toEqual([cannedSpec]);
  });
});

// ── 3. Integration ────────────────────────────────────────────────────────

describe('StructureRecorder — integration (consumer patterns)', () => {
  it('consumer can accumulate nodes + edges into their own maps', () => {
    const nodes = new Map<string, { id: string; label: string }>();
    const edges: { from: string; to: string }[] = [];

    const rec: StructureRecorder = {
      id: 'xyflow-builder',
      onStageAdded: (e) => nodes.set(e.stageId, { id: e.stageId, label: e.name }),
      onEdgeAdded: (e) => edges.push({ from: e.from, to: e.to }),
    };

    // Simulate the dispatcher invoking the recorder (real wiring in L7.3).
    rec.onStageAdded!({ stageId: 'seed', name: 'Seed', type: 'stage', spec: cannedSpec });
    rec.onStageAdded!({ stageId: 'a', name: 'A', type: 'stage', spec: cannedSpec });
    rec.onEdgeAdded!({ from: 'seed', to: 'a', kind: 'next' });

    expect(nodes.size).toBe(2);
    expect(nodes.get('seed')!.label).toBe('Seed');
    expect(edges).toEqual([{ from: 'seed', to: 'a' }]);
  });

  it('multiple recorders co-exist (each owns its own state)', () => {
    const nodeRec: StructureRecorder = {
      id: 'nodes',
      onStageAdded: () => {},
    };
    const edgeRec: StructureRecorder = {
      id: 'edges',
      onEdgeAdded: () => {},
    };
    expect(nodeRec.id).not.toBe(edgeRec.id);
  });
});

// ── 4. Property ────────────────────────────────────────────────────────────

describe('StructureRecorder — property', () => {
  it.each(['next', 'fork-branch', 'decision-branch'] as const)(
    'every StructureEdgeKind is a valid edge payload (kind=%s)',
    (kind) => {
      const event: StructureEdgeAddedEvent = { from: 'a', to: 'b', kind };
      expect(event.kind).toBe(kind);
    },
  );

  it('a recorder with NO handlers is harmless when registered', () => {
    const rec: StructureRecorder = { id: 'no-op' };
    // No calls; no errors. The dispatcher (L7.2) will simply find no
    // methods to invoke.
    expect(Object.keys(rec)).toEqual(['id']);
  });
});

// ── 5. Security ────────────────────────────────────────────────────────────

describe('StructureRecorder — security (interface-level)', () => {
  it('event payloads are readonly at the type level', () => {
    // The interface marks every field as `readonly`. TypeScript
    // refuses reassignment at compile time; here we verify the
    // field is structurally present.
    const event: StructureStageAddedEvent = {
      stageId: 'a',
      name: 'A',
      type: 'stage',
      spec: cannedSpec,
    };
    // @ts-expect-error — readonly field must NOT be reassignable
    event.stageId = 'b';
    // The line above is a compile-time check; at runtime the
    // assignment succeeds. Spec freezing at dispatch time (L7.2)
    // is the RUNTIME enforcement; readonly is the AUTHOR-INTENT
    // signal.
    expect(true).toBe(true);
  });
});

// ── 6. Performance ─────────────────────────────────────────────────────────

describe('StructureRecorder — performance (interface only)', () => {
  it('constructing 10000 event payloads under 20ms', () => {
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) {
      const _e: StructureStageAddedEvent = {
        stageId: `s${i}`,
        name: `S${i}`,
        type: 'stage',
        spec: cannedSpec,
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const consume = _e;
      if (consume === null) throw new Error('unreachable');
    }
    expect(performance.now() - t0).toBeLessThan(20);
  });
});

// ── 7. ROI ─────────────────────────────────────────────────────────────────

describe('StructureRecorder — ROI (one observer interface covers every build event)', () => {
  it('all five build-phase events are sub-interfaces of one StructureRecorder', () => {
    // The whole point of the unification: consumer registers ONE
    // recorder and can opt into any subset of the five events. No
    // separate registration site per event kind.
    const rec: StructureRecorder = {
      id: 'all-five',
      onStageAdded: () => {},
      onEdgeAdded: () => {},
      onLoopEdgeAdded: () => {},
      onDeciderComplete: () => {},
      onSubflowMounted: () => {},
    };
    expect(typeof rec.onStageAdded).toBe('function');
    expect(typeof rec.onEdgeAdded).toBe('function');
    expect(typeof rec.onLoopEdgeAdded).toBe('function');
    expect(typeof rec.onDeciderComplete).toBe('function');
    expect(typeof rec.onSubflowMounted).toBe('function');
  });
});

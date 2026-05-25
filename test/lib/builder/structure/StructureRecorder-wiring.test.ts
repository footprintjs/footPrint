/**
 * L7.3 — Integration tests for `StructureRecorder` wired into
 * `FlowChartBuilder` via `attachStructureRecorder`.
 *
 * Each test attaches a recorder, runs a real builder chain, and
 * asserts the recorder received the expected event SEQUENCE +
 * payloads. Catches:
 *
 *   - missing wiring (a builder method that doesn't fire)
 *   - wrong event order (endpoints announced AFTER edges)
 *   - wrong edge kinds (linear vs fork-branch vs decision-branch)
 *   - missing decider/subflow lifecycle events
 *   - the `.build()` seal — post-build attach throws
 */

import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartBuilder } from '../../../../src/lib/builder/FlowChartBuilder.js';
import type {
  StructureDeciderCompleteEvent,
  StructureEdgeAddedEvent,
  StructureLoopEdgeAddedEvent,
  StructureRecorder,
  StructureStageAddedEvent,
  StructureSubflowMountedEvent,
} from '../../../../src/lib/builder/structure/StructureRecorder.js';

/** Mini-spy recorder that records every event in arrival order. */
function spyRecorder() {
  const events: Array<{ kind: string; payload: unknown }> = [];
  const rec: StructureRecorder = {
    id: 'spy',
    onStageAdded: (e) => events.push({ kind: 'stage', payload: e }),
    onEdgeAdded: (e) => events.push({ kind: 'edge', payload: e }),
    onLoopEdgeAdded: (e) => events.push({ kind: 'loop', payload: e }),
    onDeciderComplete: (e) => events.push({ kind: 'decider', payload: e }),
    onSubflowMounted: (e) => events.push({ kind: 'subflow', payload: e }),
  };
  return { rec, events };
}

const noop = async (): Promise<void> => {};

// ── 1. Unit — single-stage seed ────────────────────────────────────────────

describe('StructureRecorder wiring — unit', () => {
  it('seed-only chart: fires onStageAdded once, no edges', () => {
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed').attachStructureRecorder(rec).build();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('stage');
    expect((events[0]!.payload as StructureStageAddedEvent).stageId).toBe('seed');
  });

  it('attachStructureRecorder is fluent (returns the builder)', () => {
    const { rec } = spyRecorder();
    const builder = flowChart('seed', noop, 'seed');
    const result = builder.attachStructureRecorder(rec);
    expect(result).toBe(builder);
  });
});

// ── 2. Functional — linear chain ───────────────────────────────────────────

describe('StructureRecorder wiring — linear chain', () => {
  it('fires stage+edge per addFunction in correct order', () => {
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addFunction('a', noop, 'a')
      .addFunction('b', noop, 'b')
      .build();

    // Order: seed(stage), a(stage), seed→a(edge), b(stage), a→b(edge)
    expect(events.map((e) => e.kind)).toEqual([
      'stage', // seed
      'stage', // a
      'edge', // seed→a
      'stage', // b
      'edge', // a→b
    ]);

    const edges = events.filter((e) => e.kind === 'edge').map((e) => e.payload as StructureEdgeAddedEvent);
    expect(edges).toEqual([
      { from: 'seed', to: 'a', kind: 'next' },
      { from: 'a', to: 'b', kind: 'next' },
    ]);
  });

  it('endpoint rule: every onEdgeAdded fires AFTER both endpoints onStageAdded', () => {
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addFunction('a', noop, 'a')
      .addFunction('b', noop, 'b')
      .addFunction('c', noop, 'c')
      .build();

    const stageSeenAt = new Map<string, number>();
    events.forEach((e, idx) => {
      if (e.kind === 'stage') {
        stageSeenAt.set((e.payload as StructureStageAddedEvent).stageId, idx);
      }
    });
    events.forEach((e, idx) => {
      if (e.kind === 'edge') {
        const edge = e.payload as StructureEdgeAddedEvent;
        expect(stageSeenAt.get(edge.from)).toBeLessThan(idx);
        expect(stageSeenAt.get(edge.to)).toBeLessThan(idx);
      }
    });
  });
});

// ── 3. Integration — decider, fork, loop, subflow ──────────────────────────

describe('StructureRecorder wiring — decider sub-builder', () => {
  it('decider + branches fire stage + decision-branch edges + onDeciderComplete', () => {
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addDeciderFunction('route', () => 'low', 'route')
      .addFunctionBranch('low', 'low', noop)
      .addFunctionBranch('high', 'high', noop)
      .setDefault('low')
      .end()
      .build();

    const stages = events.filter((e) => e.kind === 'stage').map((e) => (e.payload as StructureStageAddedEvent).stageId);
    expect(stages).toEqual(['seed', 'route', 'low', 'high']);

    const edges = events.filter((e) => e.kind === 'edge').map((e) => e.payload as StructureEdgeAddedEvent);
    // seed→route (next) + route→low (decision-branch low) + route→high (decision-branch high)
    expect(edges).toEqual([
      { from: 'seed', to: 'route', kind: 'next' },
      { from: 'route', to: 'low', kind: 'decision-branch', label: 'low' },
      { from: 'route', to: 'high', kind: 'decision-branch', label: 'high' },
    ]);

    const deciderEvents = events
      .filter((e) => e.kind === 'decider')
      .map((e) => e.payload as StructureDeciderCompleteEvent);
    expect(deciderEvents).toEqual([
      {
        decider: 'route',
        type: 'decider',
        branchIds: ['low', 'high'],
        defaultBranch: 'low',
      },
    ]);
  });

  it('decider onDeciderComplete fires AFTER every branch onStageAdded', () => {
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addDeciderFunction('route', () => 'a', 'route')
      .addFunctionBranch('a', 'a', noop)
      .addFunctionBranch('b', 'b', noop)
      .end()
      .build();

    const branchStageIndices = events
      .map((e, i) =>
        e.kind === 'stage' && ['a', 'b'].includes((e.payload as StructureStageAddedEvent).stageId) ? i : -1,
      )
      .filter((i) => i >= 0);
    const deciderCompleteIdx = events.findIndex((e) => e.kind === 'decider');
    for (const branchIdx of branchStageIndices) {
      expect(branchIdx).toBeLessThan(deciderCompleteIdx);
    }
  });
});

describe('StructureRecorder wiring — fork (addListOfFunction)', () => {
  it('parallel children fire stage + fork-branch edge per child', () => {
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addListOfFunction([
        { id: 'p1', name: 'p1', fn: noop },
        { id: 'p2', name: 'p2', fn: noop },
        { id: 'p3', name: 'p3', fn: noop },
      ])
      .build();

    const stages = events.filter((e) => e.kind === 'stage').map((e) => (e.payload as StructureStageAddedEvent).stageId);
    expect(stages).toEqual(['seed', 'p1', 'p2', 'p3']);

    const forkEdges = events
      .filter((e) => e.kind === 'edge' && (e.payload as StructureEdgeAddedEvent).kind === 'fork-branch')
      .map((e) => e.payload as StructureEdgeAddedEvent);
    expect(forkEdges).toEqual([
      { from: 'seed', to: 'p1', kind: 'fork-branch' },
      { from: 'seed', to: 'p2', kind: 'fork-branch' },
      { from: 'seed', to: 'p3', kind: 'fork-branch' },
    ]);
  });
});

describe('StructureRecorder wiring — loopTo', () => {
  it('loopTo fires onLoopEdgeAdded with correct from/to', () => {
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed').attachStructureRecorder(rec).addFunction('a', noop, 'a').loopTo('seed').build();

    const loopEvents = events.filter((e) => e.kind === 'loop').map((e) => e.payload as StructureLoopEdgeAddedEvent);
    expect(loopEvents).toEqual([{ from: 'a', to: 'seed' }]);
  });
});

describe('StructureRecorder wiring — subflow mount', () => {
  it('addSubFlowChartNext fires stage + next edge + onSubflowMounted', () => {
    const subflow = flowChart('inner-seed', noop, 'inner-seed').build();
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addSubFlowChartNext('sub-1', subflow, 'My Subflow')
      .build();

    const subflowEvents = events
      .filter((e) => e.kind === 'subflow')
      .map((e) => e.payload as StructureSubflowMountedEvent);
    expect(subflowEvents).toHaveLength(1);
    const mount = subflowEvents[0]!;
    expect(mount.subflowId).toBe('sub-1');
    expect(mount.subflowName).toBe('My Subflow');
    expect(mount.rootStageId).toBe('sub-1');
    expect(mount.subflowPath).toBe('sub-1');
    expect(mount.subflowSpec).toBeDefined();
    expect(mount.subflowSpec!.id).toBe('inner-seed');
    // Reference equality: the spec on the event is the SAME object as
    // the consumer's built subflow's buildTimeStructure.
    expect(mount.subflowSpec).toBe(subflow.buildTimeStructure);

    // Mount-only: parent recorder does NOT receive inner-seed events.
    // Subflow's own 'inner-seed' stage was emitted during the SUBFLOW's
    // own .build(), to a DIFFERENT recorder (or none here). Parent
    // recorder only sees the mount node + lifecycle.
    const innerSeedStages = events.filter(
      (e) => e.kind === 'stage' && (e.payload as StructureStageAddedEvent).stageId === 'inner-seed',
    );
    expect(innerSeedStages).toHaveLength(0);
  });
});

// ── 4. Property — N-step chains, M-branch deciders ────────────────────────

describe('StructureRecorder wiring — property', () => {
  it.each([1, 5, 25])('N-step linear chain fires N+1 stage events and N edge events (N=%d)', (n) => {
    const { rec, events } = spyRecorder();
    let b = flowChart('seed', noop, 'seed').attachStructureRecorder(rec);
    for (let i = 0; i < n; i++) {
      b = b.addFunction(`s${i}`, noop, `s${i}`);
    }
    b.build();
    const stages = events.filter((e) => e.kind === 'stage');
    const edges = events.filter((e) => e.kind === 'edge');
    expect(stages).toHaveLength(n + 1);
    expect(edges).toHaveLength(n);
  });
});

// ── 5. Security — seal post-build ──────────────────────────────────────────

describe('StructureRecorder wiring — seal-after-build (Panel 2)', () => {
  it('attachStructureRecorder AFTER .build() throws', () => {
    const builder = flowChart('seed', noop, 'seed');
    builder.build();
    const { rec } = spyRecorder();
    expect(() => builder.attachStructureRecorder(rec)).toThrowError(/sealed/);
  });

  it('attach BEFORE build is fine, even after some chain ops', () => {
    const { rec, events } = spyRecorder();
    expect(() =>
      flowChart('seed', noop, 'seed')
        .addFunction('a', noop, 'a')
        .attachStructureRecorder(rec)
        .addFunction('b', noop, 'b')
        .build(),
    ).not.toThrow();
    // Recorder attached MID-chain misses earlier events but
    // captures the rest — this is the intended trade-off (the seal
    // is post-build only, not mid-build).
    const stages = events.filter((e) => e.kind === 'stage').map((e) => (e.payload as StructureStageAddedEvent).stageId);
    expect(stages).toContain('b');
  });
});

// ── 6. Performance ─────────────────────────────────────────────────────────

describe('StructureRecorder wiring — performance', () => {
  it('500-stage chain with attached recorder builds under 100ms', () => {
    const { rec } = spyRecorder();
    let b = flowChart('seed', noop, 'seed').attachStructureRecorder(rec);
    for (let i = 0; i < 500; i++) {
      b = b.addFunction(`s${i}`, noop, `s${i}`);
    }
    const t0 = performance.now();
    b.build();
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

// ── 7. ROI ─────────────────────────────────────────────────────────────────

describe('StructureRecorder wiring — ROI (one recorder captures every primitive)', () => {
  it('a single recorder captures all 5 event kinds across a realistic chart', () => {
    const subflow = flowChart('s-seed', noop, 's-seed').build();
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addFunction('a', noop, 'a')
      .addDeciderFunction('route', () => 'low', 'route')
      .addFunctionBranch('low', 'low', noop)
      .addFunctionBranch('high', 'high', noop)
      .end()
      .addSubFlowChartNext('sub', subflow, 'Sub')
      .loopTo('seed')
      .build();

    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds).toEqual(new Set(['stage', 'edge', 'loop', 'decider', 'subflow']));
  });

  it('a 5-handler recorder + a 1-handler recorder coexist without interference', () => {
    const log: string[] = [];
    const full: StructureRecorder = {
      id: 'full',
      onStageAdded: () => log.push('full-stage'),
      onEdgeAdded: () => log.push('full-edge'),
    };
    const partial: StructureRecorder = {
      id: 'partial',
      onStageAdded: () => log.push('partial-stage'),
    };
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(full)
      .attachStructureRecorder(partial)
      .addFunction('a', noop, 'a')
      .build();
    // Both 'full-stage' and 'partial-stage' appear; only 'full-edge'
    // for the edge event.
    expect(log.filter((s) => s === 'full-stage')).toHaveLength(2);
    expect(log.filter((s) => s === 'partial-stage')).toHaveLength(2);
    expect(log.filter((s) => s === 'full-edge')).toHaveLength(1);
  });
});

// ── Side check: FlowChartBuilder direct construction also works ────────────

describe('StructureRecorder wiring — direct builder construction', () => {
  it('new FlowChartBuilder() + attachStructureRecorder works', () => {
    const { rec, events } = spyRecorder();
    new FlowChartBuilder().attachStructureRecorder(rec).start('seed', noop, 'seed').addFunction('a', noop, 'a').build();
    expect(events.map((e) => e.kind)).toContain('stage');
    expect(events.map((e) => e.kind)).toContain('edge');
  });
});

// ── Panel-driven gap coverage (Panel 7 audit + Panel 3 BUG4) ───────────────

describe('StructureRecorder wiring — isPausable propagation (Panel 3 BUG4)', () => {
  it('addPausableFunction fires onStageAdded with isPausable:true', async () => {
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addPausableFunction('pausable', { execute: async () => undefined, resume: async () => undefined }, 'pausable')
      .build();
    const pausableStage = events.find(
      (e) => e.kind === 'stage' && (e.payload as StructureStageAddedEvent).stageId === 'pausable',
    );
    expect(pausableStage).toBeDefined();
    expect((pausableStage!.payload as StructureStageAddedEvent).isPausable).toBe(true);
  });

  it('plain addFunction omits isPausable from the event payload', () => {
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed').attachStructureRecorder(rec).addFunction('a', noop, 'a').build();
    const aStage = events.find((e) => e.kind === 'stage' && (e.payload as StructureStageAddedEvent).stageId === 'a');
    expect(aStage).toBeDefined();
    expect((aStage!.payload as StructureStageAddedEvent).isPausable).toBeUndefined();
  });
});

describe('StructureRecorder wiring — selector branch wiring (Panel 7 gap)', () => {
  it('addSelectorFunction + addFunctionBranch fires stages + decision-branch edges + onDeciderComplete', () => {
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addSelectorFunction('pick', () => ['a'], 'pick')
      .addFunctionBranch('a', 'A', noop)
      .addFunctionBranch('b', 'B', noop)
      .end()
      .build();

    const stages = events.filter((e) => e.kind === 'stage').map((e) => (e.payload as StructureStageAddedEvent).stageId);
    expect(stages).toEqual(['seed', 'pick', 'a', 'b']);

    const branchEdges = events
      .filter((e) => e.kind === 'edge')
      .map((e) => e.payload as StructureEdgeAddedEvent)
      .filter((e) => e.kind === 'decision-branch');
    expect(branchEdges.map((e) => `${e.from}->${e.to}`)).toEqual(['pick->a', 'pick->b']);

    const dc = events.find((e) => e.kind === 'decider');
    expect(dc).toBeDefined();
    const dcPayload = dc!.payload as StructureDeciderCompleteEvent;
    expect(dcPayload.type).toBe('selector');
    expect(dcPayload.branchIds).toEqual(['a', 'b']);
    expect(dcPayload.defaultBranch).toBeUndefined();
  });
});

describe('StructureRecorder wiring — lazy subflow mount (Panel 7 gap)', () => {
  it('addLazySubFlowChartNext fires onSubflowMounted with isLazy:true', () => {
    const { rec, events } = spyRecorder();
    const subflowFactory = () => flowChart('s-seed', noop, 's-seed').build();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addLazySubFlowChartNext('lazy', subflowFactory, 'Lazy')
      .build();
    const mount = events.find((e) => e.kind === 'subflow');
    expect(mount).toBeDefined();
    const payload = mount!.payload as StructureSubflowMountedEvent;
    expect(payload.subflowId).toBe('lazy');
    expect(payload.isLazy).toBe(true);
  });

  // Proposal #001 — lazy mounts must NOT carry a `subflowSpec` (the
  // resolver hasn't run yet, so no spec exists at build time). The
  // `subflowPath` field still resolves to the local mount id.
  it('lazy mount payload — subflowSpec is undefined, subflowPath is set', () => {
    const { rec, events } = spyRecorder();
    const subflowFactory = () => flowChart('s-seed', noop, 's-seed').build();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addLazySubFlowChartNext('lazy', subflowFactory, 'Lazy')
      .build();
    const mount = events.find((e) => e.kind === 'subflow');
    const payload = mount!.payload as StructureSubflowMountedEvent;
    expect(payload.subflowSpec).toBeUndefined();
    expect(payload.subflowPath).toBe('lazy');
  });
});

describe('StructureRecorder wiring — proposal #001 mount-event payload coverage', () => {
  // Reference-equality guarantee: `event.subflowSpec === subflow.buildTimeStructure`
  // for EVERY eager mount-site (4 paths into `_fireSubflowMounted`).
  // Auditor finding: only one of 4 sites was asserted.

  it('addSubFlowChartNext (linear) — subflowSpec reference equals subflow.buildTimeStructure', () => {
    const subflow = flowChart('inner', noop, 'inner').build();
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed').attachStructureRecorder(rec).addSubFlowChartNext('sub', subflow, 'Sub').build();
    const mount = events.find((e) => e.kind === 'subflow')!;
    const payload = mount.payload as StructureSubflowMountedEvent;
    expect(payload.subflowSpec).toBe(subflow.buildTimeStructure);
    expect(payload.subflowPath).toBe('sub');
  });

  it('addSubFlowChart (fork-as-subflow parallel) — subflowSpec reference equality', () => {
    const subflow = flowChart('inner', noop, 'inner').build();
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addSubFlowChart('parallelSub', subflow, 'ParallelSub')
      .build();
    const mount = events.find((e) => e.kind === 'subflow')!;
    const payload = mount.payload as StructureSubflowMountedEvent;
    expect(payload.subflowSpec).toBe(subflow.buildTimeStructure);
    expect(payload.subflowPath).toBe('parallelSub');
  });

  it('addSubFlowChartBranch (decider branch) — subflowSpec reference equality', () => {
    const subflow = flowChart('inner', noop, 'inner').build();
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addDeciderFunction('Decide', () => 'high', 'decide')
      .addSubFlowChartBranch('high', subflow, 'HighSub')
      .addFunctionBranch('low', 'Low', noop)
      .setDefault('low')
      .end()
      .build();
    const mount = events.find((e) => e.kind === 'subflow')!;
    const payload = mount.payload as StructureSubflowMountedEvent;
    expect(payload.subflowSpec).toBe(subflow.buildTimeStructure);
    expect(payload.subflowPath).toBe('high');
  });

  it('addSubFlowChartBranch (selector branch) — subflowSpec reference equality', () => {
    const subflow = flowChart('inner', noop, 'inner').build();
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addSelectorFunction('Pick', () => ['fast'], 'pick')
      .addSubFlowChartBranch('fast', subflow, 'FastSub')
      .addFunctionBranch('slow', 'Slow', noop)
      .end()
      .build();
    const mount = events.find((e) => e.kind === 'subflow')!;
    const payload = mount.payload as StructureSubflowMountedEvent;
    expect(payload.subflowSpec).toBe(subflow.buildTimeStructure);
    expect(payload.subflowPath).toBe('fast');
  });
});

describe('StructureRecorder wiring — getStructureBuildErrors accessor (Panel 7 gap)', () => {
  it('getStructureBuildErrors returns [] when no recorders attached', () => {
    const builder = flowChart('seed', noop, 'seed').addFunction('a', noop, 'a');
    builder.build();
    expect(builder.getStructureBuildErrors()).toEqual([]);
  });

  it('getStructureBuildErrors returns a defensive copy (mutation does not propagate)', () => {
    const throwing: StructureRecorder = {
      id: 'throws',
      onStageAdded: () => {
        throw new Error('boom');
      },
    };
    const builder = flowChart('seed', noop, 'seed').attachStructureRecorder(throwing);
    builder.build();
    const first = builder.getStructureBuildErrors();
    expect(first.length).toBeGreaterThan(0);
    first.length = 0; // truncate aggressively
    const second = builder.getStructureBuildErrors();
    expect(second.length).toBeGreaterThan(0);
  });

  it('recorder throwing during seed replay accumulates the error', () => {
    const throwing: StructureRecorder = {
      id: 'replay-throws',
      onStageAdded: () => {
        throw new Error('seed-replay-boom');
      },
    };
    // attachStructureRecorder fires the seed replay synchronously; the
    // throw must accumulate even though .build() is never called yet.
    const builder = flowChart('seed', noop, 'seed').attachStructureRecorder(throwing);
    const errs = builder.getStructureBuildErrors();
    expect(errs).toHaveLength(1);
    expect(errs[0]!.recorderId).toBe('replay-throws');
    expect(errs[0]!.method).toBe('onStageAdded');
    expect(errs[0]!.message).toBe('seed-replay-boom');
  });
});

describe('StructureRecorder wiring — sealed-attach error message (Panel 6 gap)', () => {
  it('post-build attach error message names the recorder + the fix', () => {
    const builder = flowChart('seed', noop, 'seed');
    builder.build();
    try {
      builder.attachStructureRecorder({ id: 'late' });
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('late'); // recorder id surfaced
      expect(msg).toContain('Attach BEFORE .build()'); // actionable guidance
    }
  });
});

describe('StructureRecorder wiring — fork convergence (post-fork next fan-out)', () => {
  it('addFunction after addListOfFunction fires ONE next edge PER fork child (not one from fork parent)', () => {
    // Reproduces the playground bug: visualizers got `LoadOrder → FinalizeOrder`
    // as a single edge from the fork parent, when semantically each fork
    // child independently feeds FinalizeOrder after parallel convergence.
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addListOfFunction([
        { id: 'a', name: 'A', fn: noop },
        { id: 'b', name: 'B', fn: noop },
      ])
      .addFunction('after', noop, 'after')
      .build();

    const nextEdges = events
      .filter((e) => e.kind === 'edge')
      .map((e) => e.payload as StructureEdgeAddedEvent)
      .filter((e) => e.kind === 'next' && e.to === 'after');

    // Two convergence edges, one per fork child — NOT one from 'seed' (the parent).
    expect(nextEdges).toHaveLength(2);
    const sources = nextEdges.map((e) => e.from).sort();
    expect(sources).toEqual(['a', 'b']);
  });

  it('plain addFunction (no preceding fork) still fires ONE next edge from cursor', () => {
    // Regression guard — convergence expansion must only kick in when
    // the parent has branch children. Plain linear chains stay linear.
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addFunction('a', noop, 'a')
      .addFunction('b', noop, 'b')
      .build();

    const nextEdges = events
      .filter((e) => e.kind === 'edge')
      .map((e) => e.payload as StructureEdgeAddedEvent)
      .filter((e) => e.kind === 'next');

    expect(nextEdges).toEqual([
      { from: 'seed', to: 'a', kind: 'next' },
      { from: 'a', to: 'b', kind: 'next' },
    ]);
  });

  it('addFunction after a decider with branches fires ONE next edge per branch (convergence)', () => {
    // Same fan-out applies to deciders/selectors when the chain
    // continues post-`.end()`. Structurally, every branch is a
    // potential "tail" that feeds the next stage.
    const { rec, events } = spyRecorder();
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addDeciderFunction('route', () => 'low', 'route')
      .addFunctionBranch('low', 'low', noop)
      .addFunctionBranch('high', 'high', noop)
      .end()
      .addFunction('after', noop, 'after')
      .build();

    const nextEdgesToAfter = events
      .filter((e) => e.kind === 'edge')
      .map((e) => e.payload as StructureEdgeAddedEvent)
      .filter((e) => e.kind === 'next' && e.to === 'after');

    expect(nextEdgesToAfter.map((e) => e.from).sort()).toEqual(['high', 'low']);
  });
});

describe('StructureRecorder wiring — addStreamingFunction (Panel 7 gap)', () => {
  it('fires onStageAdded(type:stage) + next edge', () => {
    const { rec, events } = spyRecorder();
    const streamFn = async function* () {
      yield 'chunk';
    };
    flowChart('seed', noop, 'seed')
      .attachStructureRecorder(rec)
      .addStreamingFunction('stream', streamFn as any, 'stream')
      .build();
    const streamStage = events.find(
      (e) => e.kind === 'stage' && (e.payload as StructureStageAddedEvent).stageId === 'stream',
    );
    expect(streamStage).toBeDefined();
    const seedToStream = events.find(
      (e) =>
        e.kind === 'edge' &&
        (e.payload as StructureEdgeAddedEvent).from === 'seed' &&
        (e.payload as StructureEdgeAddedEvent).to === 'stream',
    );
    expect(seedToStream).toBeDefined();
    expect((seedToStream!.payload as StructureEdgeAddedEvent).kind).toBe('next');
  });
});

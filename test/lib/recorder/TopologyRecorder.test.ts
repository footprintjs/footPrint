/**
 * Unit tests for TopologyRecorder — widened to cover all three node kinds.
 *
 * Composition matrix:
 *   P1  Single subflow                      → 1 node, 0 edges
 *   P2  Sequential chain of subflows        → linear 'next' edges
 *   P3a Fork of subflows                    → N fork-branch + N subflow children
 *   P3b Fork of plain stages                → N fork-branch, no children
 *   P4a Conditional to a subflow            → decision-branch + subflow child
 *   P4b Conditional to a plain stage        → decision-branch only
 *   P5  Nested + loop                       → deep nesting + self-edge
 *
 * Plus lifecycle + re-entry + integration against FlowChartExecutor.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/index';
import type {
  FlowDecisionEvent,
  FlowForkEvent,
  FlowLoopEvent,
  FlowSubflowEvent,
} from '../../../src/lib/engine/narrative/types';
import { TopologyRecorder, topologyRecorder } from '../../../src/lib/recorder/TopologyRecorder';
import { FlowChartExecutor } from '../../../src/lib/runner/index';

// ── Helpers ─────────────────────────────────────────────────────────────

const entry = (subflowId: string, name: string, runtimeStageId: string): FlowSubflowEvent => ({
  name,
  subflowId,
  traversalContext: { stageId: subflowId, runtimeStageId, stageName: name, depth: 0 },
});

const fork = (parent: string, children: string[], runtimeStageId: string): FlowForkEvent => ({
  parent,
  children,
  traversalContext: { stageId: parent, runtimeStageId, stageName: parent, depth: 0 },
});

const decision = (decider: string, chosen: string, runtimeStageId: string, rationale?: string): FlowDecisionEvent => ({
  decider,
  chosen,
  rationale,
  traversalContext: { stageId: decider, runtimeStageId, stageName: decider, depth: 0 },
});

const loop = (target: string, iteration: number, runtimeStageId: string): FlowLoopEvent => ({
  target,
  iteration,
  traversalContext: { stageId: target, runtimeStageId, stageName: target, depth: 0 },
});

// ── P1: single subflow ─────────────────────────────────────────────────

describe('TopologyRecorder — P1: single subflow', () => {
  it('one root node with no parent, no edges', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-only', 'Only', 'only#0'));
    topo.onSubflowExit!(entry('sf-only', 'Only', 'only#9'));

    const t = topo.getTopology();
    expect(t.nodes).toHaveLength(1);
    expect(t.nodes[0]).toMatchObject({
      id: 'sf-only',
      kind: 'subflow',
      incomingKind: 'root',
      depth: 0,
      enteredAt: 'only#0',
      exitedAt: 'only#9',
    });
    expect(t.edges).toEqual([]);
    expect(t.rootId).toBe('sf-only');
    expect(t.activeNodeId).toBeNull();
  });
});

// ── P2: sequential chain ───────────────────────────────────────────────

describe('TopologyRecorder — P2: sequential chain', () => {
  it('nested subflows produce next-edges with correct depth', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-a', 'A', 'a#0'));
    topo.onSubflowEntry!(entry('sf-b', 'B', 'b#1'));
    topo.onSubflowEntry!(entry('sf-c', 'C', 'c#2'));

    const t = topo.getTopology();
    expect(t.nodes.map((n) => n.depth)).toEqual([0, 1, 2]);
    expect(t.nodes.map((n) => n.incomingKind)).toEqual(['root', 'next', 'next']);
    expect(t.edges).toEqual([
      { from: 'sf-a', to: 'sf-b', kind: 'next', at: 'b#1' },
      { from: 'sf-b', to: 'sf-c', kind: 'next', at: 'c#2' },
    ]);
  });
});

// ── P3a: fork of subflows ──────────────────────────────────────────────

describe('TopologyRecorder — P3a: fork of subflows', () => {
  it('creates fork-branch synthetic nodes + subflow children nested under each', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-parent', 'Parent', 'p#0'));
    topo.onFork!(fork('Parent', ['Alpha', 'Beta', 'Gamma'], 'p#1'));
    // Each parallel branch is also a subflow:
    topo.onSubflowEntry!(entry('sf-alpha', 'Alpha', 'a#2'));
    topo.onSubflowExit!(entry('sf-alpha', 'Alpha', 'a#3'));
    topo.onSubflowEntry!(entry('sf-beta', 'Beta', 'b#4'));
    topo.onSubflowExit!(entry('sf-beta', 'Beta', 'b#5'));
    topo.onSubflowEntry!(entry('sf-gamma', 'Gamma', 'g#6'));
    topo.onSubflowExit!(entry('sf-gamma', 'Gamma', 'g#7'));

    const t = topo.getTopology();
    const forkBranches = t.nodes.filter((n) => n.kind === 'fork-branch');
    const subflows = t.nodes.filter((n) => n.kind === 'subflow');

    expect(forkBranches.map((n) => n.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(forkBranches.every((b) => b.parentId === 'sf-parent')).toBe(true);
    expect(forkBranches.every((b) => b.metadata?.forkParent === 'Parent')).toBe(true);

    // Each subflow nested under its matching fork-branch (not directly under sf-parent).
    const alphaBranch = forkBranches.find((n) => n.name === 'Alpha')!;
    const alphaSf = subflows.find((n) => n.id === 'sf-alpha')!;
    expect(alphaSf.parentId).toBe(alphaBranch.id);
    expect(alphaSf.incomingKind).toBe('next'); // child of its fork-branch parent
    expect(alphaSf.depth).toBe(alphaBranch.depth + 1);

    // getParallelSiblings on any fork-branch returns all three.
    expect(topo.getParallelSiblings(alphaBranch.id).map((n) => n.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});

// ── P3b: fork of plain stages ──────────────────────────────────────────

describe('TopologyRecorder — P3b: fork of plain stages (no subflow children)', () => {
  it('creates fork-branch nodes with no subflow descendants', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-parent', 'Parent', 'p#0'));
    topo.onFork!(fork('Parent', ['ProcA', 'ProcB'], 'p#1'));
    // No subflow entries — the children are plain stages.
    topo.onSubflowExit!(entry('sf-parent', 'Parent', 'p#9'));

    const t = topo.getTopology();
    const forkBranches = t.nodes.filter((n) => n.kind === 'fork-branch');
    expect(forkBranches.map((n) => n.name)).toEqual(['ProcA', 'ProcB']);
    expect(forkBranches.every((b) => b.parentId === 'sf-parent')).toBe(true);

    // No subflow children under fork-branches.
    expect(topo.getChildren(forkBranches[0].id)).toEqual([]);
    expect(topo.getChildren(forkBranches[1].id)).toEqual([]);

    // Graph still correctly encodes the fork topology.
    expect(t.edges.filter((e) => e.kind === 'fork-branch')).toHaveLength(2);
  });
});

// ── P4a: conditional → subflow ─────────────────────────────────────────

describe('TopologyRecorder — P4a: conditional → subflow', () => {
  it('creates decision-branch + subflow child with decider metadata', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-root', 'Root', 'r#0'));
    topo.onDecision!(decision('RouteRisk', 'HighRisk', 'r#1', 'credit_score < 600'));
    topo.onSubflowEntry!(entry('sf-high', 'HighRisk', 'h#2'));

    const t = topo.getTopology();
    const decBranch = t.nodes.find((n) => n.kind === 'decision-branch')!;
    const sfHigh = t.nodes.find((n) => n.id === 'sf-high')!;

    expect(decBranch).toMatchObject({
      kind: 'decision-branch',
      name: 'HighRisk',
      incomingKind: 'decision-branch',
      parentId: 'sf-root',
    });
    expect(decBranch.metadata).toMatchObject({
      decider: 'RouteRisk',
      rationale: 'credit_score < 600',
    });
    expect(sfHigh.parentId).toBe(decBranch.id);
  });
});

// ── P4b: conditional → plain stage ─────────────────────────────────────

describe('TopologyRecorder — P4b: conditional → plain stage', () => {
  it('creates decision-branch node only (no subflow child)', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-root', 'Root', 'r#0'));
    topo.onDecision!(decision('Route', 'ApproveInstant', 'r#1'));
    // No matching subflow entry — the branch target is a plain stage.

    const t = topo.getTopology();
    const decBranch = t.nodes.find((n) => n.kind === 'decision-branch')!;
    expect(decBranch.name).toBe('ApproveInstant');
    expect(topo.getChildren(decBranch.id)).toEqual([]);
  });

  it('pending decision clears on subflow exit so it does not leak across scopes', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-root', 'Root', 'r#0'));
    topo.onDecision!(decision('Route', 'Approve', 'r#1'));
    topo.onSubflowExit!(entry('sf-root', 'Root', 'r#9')); // scope ends, decision went to plain stage
    topo.onSubflowEntry!(entry('sf-next', 'Approve', 'n#10')); // name collision, but different scope

    const sfNext = topo.getTopology().nodes.find((n) => n.id === 'sf-next')!;
    // Should be a fresh root-level subflow, NOT attached to the prior decision.
    expect(sfNext.parentId).toBeUndefined();
    expect(sfNext.incomingKind).toBe('root');
  });
});

// ── P5: nested + loop ──────────────────────────────────────────────────

describe('TopologyRecorder — P5: nested + loop', () => {
  it('deep nesting and self-edge from onLoop', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-outer', 'Outer', 'o#0'));
    topo.onSubflowEntry!(entry('sf-mid', 'Mid', 'm#1'));
    topo.onSubflowEntry!(entry('sf-inner', 'Inner', 'i#2'));
    topo.onLoop!(loop('target', 1, 'i#3'));
    topo.onSubflowExit!(entry('sf-inner', 'Inner', 'i#4'));

    const t = topo.getTopology();
    expect(t.nodes.map((n) => n.depth)).toEqual([0, 1, 2]);
    expect(t.edges.filter((e) => e.kind === 'loop-iteration')).toEqual([
      { from: 'sf-inner', to: 'sf-inner', kind: 'loop-iteration', at: 'i#3' },
    ]);
  });

  it('re-entering the same subflow id disambiguates with #n suffix', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-agent', 'Agent', 'a#0'));
    topo.onSubflowExit!(entry('sf-agent', 'Agent', 'a#1'));
    topo.onSubflowEntry!(entry('sf-agent', 'Agent', 'a#2'));

    expect(topo.getTopology().nodes.map((n) => n.id)).toEqual(['sf-agent', 'sf-agent#1']);
  });
});

// ── Query API ──────────────────────────────────────────────────────────

describe('TopologyRecorder — query API', () => {
  it('getByKind and getSubflowNodes filter correctly', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-root', 'Root', 'r#0'));
    topo.onFork!(fork('Root', ['A', 'B'], 'r#1'));
    topo.onSubflowEntry!(entry('sf-a', 'A', 'a#2'));
    topo.onSubflowExit!(entry('sf-a', 'A', 'a#3'));

    expect(topo.getByKind('subflow').map((n) => n.id)).toEqual(['sf-root', 'sf-a']);
    expect(topo.getByKind('fork-branch')).toHaveLength(2);
    expect(topo.getSubflowNodes().map((n) => n.id)).toEqual(['sf-root', 'sf-a']);
  });
});

// ── Lifecycle ──────────────────────────────────────────────────────────

describe('TopologyRecorder — lifecycle', () => {
  it('clear() resets all state for the next run', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-x', 'X', 'x#0'));
    topo.onFork!(fork('X', ['Y'], 'x#1'));
    expect(topo.getTopology().nodes.length).toBeGreaterThan(0);

    topo.clear();
    const t = topo.getTopology();
    expect(t.nodes).toEqual([]);
    expect(t.edges).toEqual([]);
    expect(t.activeNodeId).toBeNull();
    expect(t.rootId).toBeNull();
  });

  it('factory assigns unique auto-incremented ids', () => {
    const a = topologyRecorder();
    const b = topologyRecorder();
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^topology-\d+$/);
  });

  it('factory honors explicit id', () => {
    expect(topologyRecorder({ id: 'my-topo' }).id).toBe('my-topo');
  });

  it('toSnapshot returns standard shape', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!(entry('sf-x', 'X', 'x#0'));
    const snap = topo.toSnapshot();
    expect(snap.name).toBe('Topology');
    expect(snap.preferredOperation).toBe('translate');
    expect((snap.data as { nodes: unknown[] }).nodes).toHaveLength(1);
  });

  it('ignores onSubflowEntry without a subflowId', () => {
    const topo = new TopologyRecorder();
    topo.onSubflowEntry!({ name: 'Anon' });
    expect(topo.getTopology().nodes).toEqual([]);
  });
});

// ── Integration ────────────────────────────────────────────────────────

describe('TopologyRecorder — integration with FlowChartExecutor', () => {
  it('records subflows via attachCombinedRecorder on a real sequential chain', async () => {
    interface State {
      steps: string[];
    }

    const a = flowChart<State>(
      'A',
      (s) => {
        s.$batchArray('steps', (arr) => arr.push('a'));
      },
      'a',
    ).build();
    const b = flowChart<State>(
      'B',
      (s) => {
        s.$batchArray('steps', (arr) => arr.push('b'));
      },
      'b',
    ).build();

    const chart = flowChart<State>(
      'Start',
      (s) => {
        if (!s.steps) s.steps = [];
      },
      'start',
    )
      .addSubFlowChartNext('sf-a', a, 'Phase A')
      .addSubFlowChartNext('sf-b', b, 'Phase B')
      .build();

    const executor = new FlowChartExecutor(chart);
    const topo = topologyRecorder();
    executor.attachCombinedRecorder(topo);

    await executor.run({ input: {} });

    const ids = topo.getSubflowNodes().map((n) => n.id);
    expect(ids).toEqual(['sf-a', 'sf-b']);
  });
});

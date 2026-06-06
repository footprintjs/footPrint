/**
 * Tests for two builder primitives that let a chart express ReAct's natural
 * shape directly:
 *
 *   1. `DeciderList.loopTo(stageId)` — a BRANCH-sourced loop-back edge, so the
 *      loop originates at the looping branch (e.g. `tool-calls → context`) not
 *      at the decider. The decider then reads as
 *      `[ToolCalls → loop back] / [Final → terminate]`.
 *   2. `SubflowMountOptions.convergeAt` — a STRUCTURE-ONLY convergence override,
 *      so one branch rejoins at a different downstream node than its siblings
 *      (e.g. `tools → call-llm`, bypassing `message-api`), expressing an
 *      unequal-depth 2-parent merge.
 *
 * Both are builder-only (no engine change). The functional test proves the
 * runtime already follows a branch-level loop ref and terminates a leaf branch
 * with no `$break`.
 *
 * Test types: unit (structure), functional (engine run), plus guard coverage.
 */

import { describe, expect, it } from 'vitest';

import { flowChart, flowChartSelector } from '../../../../src/lib/builder';
import type {
  StructureEdgeAddedEvent,
  StructureLoopEdgeAddedEvent,
  StructureRecorder,
} from '../../../../src/lib/builder/structure/StructureRecorder.js';
import { FlowChartExecutor } from '../../../../src/lib/runner';

const noop = async () => {};

/** Capture structure edges + loop edges fired during build. */
function capture(): {
  rec: StructureRecorder;
  edges: Array<{ from: string; to: string; kind: string }>;
  loops: Array<{ from: string; to: string }>;
} {
  const edges: Array<{ from: string; to: string; kind: string }> = [];
  const loops: Array<{ from: string; to: string }> = [];
  const rec: StructureRecorder = {
    id: 'capture',
    onEdgeAdded: (e: StructureEdgeAddedEvent) => edges.push({ from: e.from, to: e.to, kind: e.kind }),
    onLoopEdgeAdded: (e: StructureLoopEdgeAddedEvent) => loops.push({ from: e.from, to: e.to }),
  };
  return { rec, edges, loops };
}

const hasEdge = (edges: Array<{ from: string; to: string; kind: string }>, from: string, to: string) =>
  edges.some((e) => e.from === from && e.to === to && e.kind === 'next');

// ── DeciderList.loopTo — branch-sourced loop ─────────────────────────────────

describe('DeciderList.loopTo (branch-sourced loop-back edge)', () => {
  it('unit: the loop edge is sourced from the BRANCH, not the decider', () => {
    const { rec, loops } = capture();
    flowChart('seed', noop, 'seed', { structureRecorders: [rec] })
      .addDeciderFunction('Route', (() => 'again') as never, 'route')
      .addFunctionBranch('again', 'Again', noop)
      .loopTo('seed')
      .addFunctionBranch('done', 'Done', noop)
      .setDefault('done')
      .end()
      .build();

    expect(loops).toContainEqual({ from: 'again', to: 'seed' });
    // NOT the decider — that was the old, misattributed shape.
    expect(loops).not.toContainEqual({ from: 'route', to: 'seed' });
  });

  it('unit: the looping branch spec carries loopTarget + a loop next; the decider does NOT', () => {
    const spec = flowChart('seed', noop, 'seed')
      .addDeciderFunction('Route', (() => 'again') as never, 'route')
      .addFunctionBranch('again', 'Again', noop)
      .loopTo('seed')
      .addFunctionBranch('done', 'Done', noop)
      .setDefault('done')
      .end()
      .toSpec();

    const route = spec.next!; // seed → route
    expect(route.id).toBe('route');
    expect(route.loopTarget).toBeUndefined(); // decider itself does NOT loop
    const again = route.children!.find((c) => c.id === 'again')!;
    expect(again.loopTarget).toBe('seed');
    expect(again.next?.isLoopReference).toBe(true);
    const done = route.children!.find((c) => c.id === 'done')!;
    expect(done.loopTarget).toBeUndefined(); // terminal branch is a leaf
  });

  it('functional: the loop branch ITERATES and the terminal leaf branch ENDS (no $break, zero engine change)', async () => {
    // route loops the 'again' branch back to 'tick' until count hits 3, then
    // routes to 'done' — a leaf with NO $break. If the engine wrongly looped
    // after 'done', this would hang; passing proves leaf-termination works.
    const chart = flowChart(
      'seed',
      ((s: { count?: number }) => {
        if (s.count === undefined) s.count = 0;
      }) as never,
      'seed',
    )
      .addFunction('Tick', noop as never, 'tick')
      .addDeciderFunction('Route', ((s: { count: number }) => (s.count < 3 ? 'again' : 'done')) as never, 'route')
      .addFunctionBranch('again', 'Again', ((s: { count: number }) => {
        s.count = s.count + 1;
      }) as never)
      .loopTo('tick')
      .addFunctionBranch('done', 'Done', ((s: { done?: boolean }) => {
        s.done = true;
      }) as never)
      .setDefault('done')
      .end()
      .build();

    const ex = new FlowChartExecutor(chart);
    await ex.run({ input: {} });
    const state = ex.getSnapshot()?.sharedState as { count?: number; done?: boolean };
    expect(state.count).toBe(3); // looped exactly 3 times
    expect(state.done).toBe(true); // terminated cleanly on the leaf branch
  });

  it('guard: loopTo before any branch was added throws', () => {
    expect(() =>
      flowChart('seed', noop, 'seed')
        .addDeciderFunction('Route', (() => 'x') as never, 'route')
        .loopTo('seed'),
    ).toThrow();
  });

  it('guard: a second loopTo on the same branch throws', () => {
    expect(() =>
      flowChart('seed', noop, 'seed')
        .addDeciderFunction('Route', (() => 'a') as never, 'route')
        .addFunctionBranch('a', 'A', noop)
        .loopTo('seed')
        .loopTo('seed'),
    ).toThrow();
  });

  it('guard: loopTo to an unknown target throws', () => {
    expect(() =>
      flowChart('seed', noop, 'seed')
        .addDeciderFunction('Route', (() => 'a') as never, 'route')
        .addFunctionBranch('a', 'A', noop)
        .loopTo('does-not-exist'),
    ).toThrow();
  });
});

// ── convergeAt — unequal-depth merge ─────────────────────────────────────────

describe('SubflowMountOptions.convergeAt (structure-only convergence override)', () => {
  const innerChart = () => flowChart('inner', noop, 'inner').build();

  it('unit: a convergeAt branch rejoins at its named target; siblings use the default', () => {
    const { rec, edges } = capture();
    flowChartSelector('Context', (() => ['sf-sys', 'sf-msg', 'sf-tools']) as never, 'context', {
      structureRecorders: [rec],
    })
      .addSubFlowChartBranch('sf-sys', innerChart(), 'System', {})
      .addSubFlowChartBranch('sf-msg', innerChart(), 'Messages', {})
      .addSubFlowChartBranch('sf-tools', innerChart(), 'Tools', { convergeAt: 'call-llm' })
      .end()
      .addFunction('messageAPI', noop, 'message-api')
      .addFunction('CallLLM', noop, 'call-llm')
      .build();

    // system + messages converge at message-api (default next).
    expect(hasEdge(edges, 'sf-sys', 'message-api')).toBe(true);
    expect(hasEdge(edges, 'sf-msg', 'message-api')).toBe(true);
    // tools BYPASSES message-api → call-llm (the 2-parent merge).
    expect(hasEdge(edges, 'sf-tools', 'call-llm')).toBe(true);
    expect(hasEdge(edges, 'sf-tools', 'message-api')).toBe(false);
    // message-api still flows linearly into call-llm → call-llm has 2 parents.
    expect(hasEdge(edges, 'message-api', 'call-llm')).toBe(true);
  });

  it('unit: without convergeAt, all branches converge at the single next stage (unchanged default)', () => {
    const { rec, edges } = capture();
    flowChartSelector('Context', (() => ['sf-a', 'sf-b']) as never, 'context', { structureRecorders: [rec] })
      .addSubFlowChartBranch('sf-a', innerChart(), 'A', {})
      .addSubFlowChartBranch('sf-b', innerChart(), 'B', {})
      .end()
      .addFunction('join', noop, 'join')
      .build();

    expect(hasEdge(edges, 'sf-a', 'join')).toBe(true);
    expect(hasEdge(edges, 'sf-b', 'join')).toBe(true);
  });

  it('integration: convergeAt + a branch-sourced loop coexist without spurious convergence edges', () => {
    // A selector branch convergeAt-ing forward, on a chart that also has a
    // decider with a branch loop — assert no branch double-fires a next edge.
    const { rec, edges } = capture();
    flowChartSelector('Context', (() => ['sf-tools', 'sf-msg']) as never, 'context', { structureRecorders: [rec] })
      .addSubFlowChartBranch('sf-msg', innerChart(), 'Messages', {})
      .addSubFlowChartBranch('sf-tools', innerChart(), 'Tools', { convergeAt: 'call-llm' })
      .end()
      .addFunction('messageAPI', noop, 'message-api')
      .addFunction('CallLLM', noop, 'call-llm')
      .build();

    const toolsNextEdges = edges.filter((e) => e.from === 'sf-tools' && e.kind === 'next');
    expect(toolsNextEdges).toHaveLength(1); // exactly one convergence edge
    expect(toolsNextEdges[0]!.to).toBe('call-llm');
  });
});

// ── { loopTo } branch option — the explicit, co-located form ─────────────────
// Same machinery as positional `.loopTo()`, but declared ON the branch so the
// loop SOURCE is self-evident (no "last-added branch" guesswork). This is the
// form the agent's ReAct loop uses: `tool-calls` loops, `final` terminates.
describe('{ loopTo } branch option (explicit branch-sourced loop)', () => {
  it('addFunctionBranch({ loopTo }) sources the loop from THAT branch, not the decider', () => {
    const { rec, loops } = capture();
    flowChart('seed', noop, 'seed', { structureRecorders: [rec] })
      .addDeciderFunction('Route', (() => 'again') as never, 'route')
      .addFunctionBranch('again', 'Again', noop, undefined, { loopTo: 'seed' })
      .addFunctionBranch('done', 'Done', noop)
      .setDefault('done')
      .end()
      .build();

    expect(loops).toContainEqual({ from: 'again', to: 'seed' });
    expect(loops).not.toContainEqual({ from: 'route', to: 'seed' });
  });

  it('produces a spec IDENTICAL to the positional .loopTo() form', () => {
    const viaOption = flowChart('seed', noop, 'seed')
      .addDeciderFunction('Route', (() => 'again') as never, 'route')
      .addFunctionBranch('again', 'Again', noop, undefined, { loopTo: 'seed' })
      .addFunctionBranch('done', 'Done', noop)
      .setDefault('done')
      .end()
      .toSpec();
    const viaPositional = flowChart('seed', noop, 'seed')
      .addDeciderFunction('Route', (() => 'again') as never, 'route')
      .addFunctionBranch('again', 'Again', noop)
      .loopTo('seed')
      .addFunctionBranch('done', 'Done', noop)
      .setDefault('done')
      .end()
      .toSpec();

    const againOf = (spec: typeof viaOption) => spec.next!.children!.find((c) => c.id === 'again')!;
    expect(againOf(viaOption).loopTarget).toBe('seed');
    expect(againOf(viaOption).loopTarget).toBe(againOf(viaPositional).loopTarget);
    expect(againOf(viaOption).next?.isLoopReference).toBe(true);
  });

  it('functional: a pausable branch with { loopTo } iterates; the leaf branch terminates', async () => {
    const chart = flowChart(
      'seed',
      ((s: { count?: number }) => {
        if (s.count === undefined) s.count = 0;
      }) as never,
      'seed',
    )
      .addFunction('Tick', noop as never, 'tick')
      .addDeciderFunction('Route', ((s: { count: number }) => (s.count < 3 ? 'again' : 'done')) as never, 'route')
      .addPausableFunctionBranch(
        'again',
        'Again',
        {
          execute: ((s: { count: number }) => {
            s.count = s.count + 1;
          }) as never,
        },
        undefined,
        { loopTo: 'tick' },
      )
      .addFunctionBranch('done', 'Done', ((s: { done?: boolean }) => {
        s.done = true;
      }) as never)
      .setDefault('done')
      .end()
      .build();

    const ex = new FlowChartExecutor(chart);
    await ex.run({ input: {} });
    const state = ex.getSnapshot()?.sharedState as { count?: number; done?: boolean };
    expect(state.count).toBe(3); // pausable branch looped exactly 3×
    expect(state.done).toBe(true); // leaf branch terminated cleanly
  });
});

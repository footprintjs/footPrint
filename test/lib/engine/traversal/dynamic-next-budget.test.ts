/**
 * Regression — fn-bearing dynamic-next chains are bounded.
 *
 * Loop edges (`loopTo` / dynamic next BY REFERENCE) were always counted by
 * the ContinuationResolver's per-node iteration counter and erred at
 * `maxIterations` (default 1000). FRESH function-bearing dynamic `next`
 * nodes bypassed that counter (no back-edge, often no stable id) — a stage
 * that kept returning a fn-bearing dynamic next ran FOREVER on the flat
 * trampoline (post-#15 there is no stack overflow to brake it either;
 * reproduced: 5000 hops with no budget while the loopTo twin erred at 1001).
 *
 * Fix: a run-total dynamic-hop counter in `ContinuationResolver.resolveTarget`
 * under the SAME `maxIterations` budget (default 1000, tunable via
 * `RunOptions.maxIterations`), erring in the same style as the loop guard.
 */
import { vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { ContinuationResolver } from '../../../../src/lib/engine/handlers/ContinuationResolver';
import { NodeResolver } from '../../../../src/lib/engine/handlers/NodeResolver';
import { NullControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/NullControlFlowNarrativeGenerator';
import type { HandlerDeps } from '../../../../src/lib/engine/types';

// ─── Scenario helpers ───

/** A self-perpetuating fn-bearing dynamic-next chain, stopping after `stopAt` hops. */
function runawayChart(stopAt: number, counter: { hops: number }) {
  const makeDynamic = (): any => ({
    name: 'dyn',
    id: 'dyn',
    fn: async () => {
      counter.hops++;
      if (counter.hops >= stopAt) return; // terminates a LEGITIMATE chain
      return { name: 'dyn-cont', next: makeDynamic() };
    },
  });

  return flowChart<any>('Start', async () => ({ name: 'start-cont', next: makeDynamic() }), 'start').build();
}

describe('Dynamic-next budget — scenario: runaway fn-bearing chain errors instead of running forever', () => {
  it('errs at the DEFAULT 1000 budget with a clear message naming the stage', async () => {
    const counter = { hops: 0 };
    const chart = runawayChart(Number.POSITIVE_INFINITY, counter);

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow(
      /Maximum dynamic-next continuations \(1000\) exceeded at stage 'dyn' \(dynamic target 'dyn'\)/,
    );
    // Exactly the budget's worth of hops ran — then the guard fired.
    expect(counter.hops).toBe(1000);
  }, 60_000);

  it('RunOptions.maxIterations tunes the budget (same knob as loop edges)', async () => {
    const counter = { hops: 0 };
    const chart = runawayChart(Number.POSITIVE_INFINITY, counter);

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ maxIterations: 25 })).rejects.toThrow(
      /Maximum dynamic-next continuations \(25\) exceeded/,
    );
    expect(counter.hops).toBe(25);
  });
});

describe('Dynamic-next budget — scenario: legitimate chains are unaffected', () => {
  it('a chain under the default budget completes normally', async () => {
    const counter = { hops: 0 };
    const chart = runawayChart(500, counter);

    await new FlowChartExecutor(chart).run();
    expect(counter.hops).toBe(500);
  }, 60_000);

  it('a LONG chain completes when maxIterations is raised (flat trampoline, no stack growth)', async () => {
    const counter = { hops: 0 };
    const chart = runawayChart(2500, counter);

    const executor = new FlowChartExecutor(chart);
    await executor.run({ maxIterations: 3000 });
    expect(counter.hops).toBe(2500);
  }, 60_000);

  it('dynamic next BY REFERENCE (string id) still uses the per-node loop counter, not the dynamic-hop budget', async () => {
    // A reference-style dynamic next back to an existing node is a loop
    // edge — its error message stays the loop one.
    let spins = 0;
    const chart = flowChart<any>(
      'Spin',
      async () => {
        spins++;
        return { name: 'again', next: 'spin' };
      },
      'spin',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ maxIterations: 10 })).rejects.toThrow(
      /Maximum loop iterations \(10\) exceeded for node 'spin'/,
    );
    expect(spins).toBe(11); // first pass + 10 loop-backs
  });
});

// ─── Unit: ContinuationResolver.resolveTarget fn-bearing branch ───

function makeDeps(root: StageNode): HandlerDeps {
  return {
    stageMap: new Map(),
    root,
    executionRuntime: {} as any,
    scopeFactory: () => ({}),
    scopeProtectionMode: 'error',
    narrativeGenerator: new NullControlFlowNarrativeGenerator(),
    logger: { info: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
  };
}

function makeContext(): any {
  return {
    addLog: vi.fn(),
    addFlowDebugMessage: vi.fn(),
    createNext: vi.fn().mockReturnValue({ addLog: vi.fn(), addFlowDebugMessage: vi.fn(), createNext: vi.fn() }),
    stageName: 'test',
  };
}

describe('Dynamic-next budget — unit: resolveTarget counts fn-bearing hops against maxIterations', () => {
  it('allows exactly maxIterations fn-bearing hops, then throws naming the producing stage', () => {
    const root: StageNode = { name: 'root', id: 'root' };
    const deps = makeDeps(root);
    const resolver = new ContinuationResolver(deps, new NodeResolver(deps), undefined, 3);

    const producer: StageNode = { name: 'Producer', id: 'producer' };
    const fnNode: StageNode = { name: 'fresh', fn: async () => {} };

    for (let i = 0; i < 3; i++) {
      const target = resolver.resolveTarget(fnNode, producer, makeContext(), 'main');
      expect(target.node).toBe(fnNode);
    }
    expect(() => resolver.resolveTarget(fnNode, producer, makeContext(), 'main')).toThrow(
      "Maximum dynamic-next continuations (3) exceeded at stage 'producer' (dynamic target 'fresh'). " +
        'Set maxIterations to increase the limit.',
    );
  });

  it('falls back to the stage NAME when the producing stage has no id', () => {
    const root: StageNode = { name: 'root', id: 'root' };
    const deps = makeDeps(root);
    const resolver = new ContinuationResolver(deps, new NodeResolver(deps), undefined, 1);

    const producer: StageNode = { name: 'Anonymous' };
    const fnNode: StageNode = { name: 'fresh', fn: async () => {} };

    resolver.resolveTarget(fnNode, producer, makeContext(), 'main');
    expect(() => resolver.resolveTarget(fnNode, producer, makeContext(), 'main')).toThrow(
      /exceeded at stage 'Anonymous'/,
    );
  });

  it('fn-bearing hops do NOT consume the per-node loop counters (independent budgets)', () => {
    const root: StageNode = { name: 'root', id: 'root' };
    const deps = makeDeps(root);
    const resolver = new ContinuationResolver(deps, new NodeResolver(deps), undefined, 2);

    const producer: StageNode = { name: 'Producer', id: 'producer' };
    const fnNode: StageNode = { name: 'fresh', fn: async () => {} };

    resolver.resolveTarget(fnNode, producer, makeContext(), 'main');
    resolver.resolveTarget(fnNode, producer, makeContext(), 'main');

    // The per-node iteration counter is untouched by the dynamic hops above.
    expect(resolver.getAndIncrementIteration('some-node')).toBe(0);
    expect(resolver.getAndIncrementIteration('some-node')).toBe(1);
  });
});

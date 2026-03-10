import { vi } from 'vitest';

/**
 * Property test: Iteration limit prevents infinite loops.
 *
 * The ContinuationResolver must enforce a maximum iteration count
 * for any node, preventing runaway loops regardless of user code.
 */
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { ContinuationResolver, DEFAULT_MAX_ITERATIONS } from '../../../../src/lib/engine/handlers/ContinuationResolver';
import { NodeResolver } from '../../../../src/lib/engine/handlers/NodeResolver';
import { NullControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/NullControlFlowNarrativeGenerator';
import type { HandlerDeps } from '../../../../src/lib/engine/types';

function makeDeps(root: StageNode): HandlerDeps {
  return {
    stageMap: new Map(),
    root,
    executionRuntime: {},
    ScopeFactory: () => ({}),
    scopeProtectionMode: 'error',
    narrativeGenerator: new NullControlFlowNarrativeGenerator(),
    logger: { info: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
  };
}

describe('Property: Iteration Limit', () => {
  it('allows exactly maxIterations visits before throwing', () => {
    const root: StageNode = { name: 'root', id: 'root' };
    const deps = makeDeps(root);
    const resolver = new ContinuationResolver(deps, new NodeResolver(deps), undefined, 5);

    // 5 visits should succeed
    for (let i = 0; i < 5; i++) {
      expect(resolver.getAndIncrementIteration('loop-node')).toBe(i);
    }

    // 6th visit throws
    expect(() => resolver.getAndIncrementIteration('loop-node')).toThrow('Maximum loop iterations (5) exceeded');
  });

  it('enforces limit per-node independently', () => {
    const root: StageNode = { name: 'root', id: 'root' };
    const deps = makeDeps(root);
    const resolver = new ContinuationResolver(deps, new NodeResolver(deps), undefined, 2);

    // nodeA: 2 visits ok
    resolver.getAndIncrementIteration('nodeA');
    resolver.getAndIncrementIteration('nodeA');
    expect(() => resolver.getAndIncrementIteration('nodeA')).toThrow();

    // nodeB is independent — still has 2 visits available
    resolver.getAndIncrementIteration('nodeB');
    resolver.getAndIncrementIteration('nodeB');
    expect(() => resolver.getAndIncrementIteration('nodeB')).toThrow();
  });

  it('default limit is 1000', () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(1000);
  });
});

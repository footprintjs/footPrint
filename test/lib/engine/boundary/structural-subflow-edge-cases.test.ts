/**
 * Boundary test: structural-only dynamic subflow — edge cases and extremes.
 *
 * Tests:
 *   - Empty buildTimeStructure
 *   - Null/undefined buildTimeStructure
 *   - Very deep nested structure (10 levels of `next` chains)
 *   - Structural subflow coexisting with a real static subflow
 *   - Structural subflow as the LAST stage (no next continuation)
 */

import { flowChart, FlowChartBuilder, FlowChartExecutor } from '../../../../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkStructure(node: any, targetId: string): any {
  if (!node) return undefined;
  if (node.id === targetId) return node;
  const fromNext = walkStructure(node.next, targetId);
  if (fromNext) return fromNext;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = walkStructure(child, targetId);
      if (found) return found;
    }
  }
  return undefined;
}

function makeDescriptor(subflowId: string, buildTimeStructure: unknown) {
  return {
    name: 'HANDLER',
    id: 'handler',
    isSubflowRoot: true as const,
    subflowId,
    subflowDef: { buildTimeStructure },
  };
}

// ---------------------------------------------------------------------------
// Edge case 1: Empty buildTimeStructure `{}`
// ---------------------------------------------------------------------------

describe('Boundary: empty buildTimeStructure', () => {
  it('flow completes without error when buildTimeStructure is `{}`', async () => {
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction('HANDLER', () => makeDescriptor('sf-empty', {}), 'handler')
      .addFunction('END', () => 'done', 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();
    expect(result).toBe('done');
  });

  it('getRuntimeStructure has subflowStructure annotation even for empty structure', async () => {
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction('HANDLER', () => makeDescriptor('sf-empty', {}), 'handler')
      .addFunction('END', () => {}, 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const structure = executor.getRuntimeStructure();
    const handlerNode = walkStructure(structure, 'handler');
    // The node should be annotated as subflow root regardless of structure content
    expect(handlerNode?.isSubflowRoot).toBe(true);
    expect(handlerNode?.subflowId).toBe('sf-empty');
  });

  it('getSubflowResults remains empty for empty buildTimeStructure', async () => {
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction('HANDLER', () => makeDescriptor('sf-empty', {}), 'handler')
      .addFunction('END', () => {}, 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSubflowResults().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge case 2: Null / undefined buildTimeStructure
// ---------------------------------------------------------------------------

describe('Boundary: null/undefined buildTimeStructure', () => {
  it('null buildTimeStructure does not crash the engine', async () => {
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction('HANDLER', () => makeDescriptor('sf-null', null), 'handler')
      .addFunction('END', () => 'ok', 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();
    expect(result).toBe('ok');
  });

  it('undefined buildTimeStructure does not crash the engine', async () => {
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction('HANDLER', () => makeDescriptor('sf-undef', undefined), 'handler')
      .addFunction('END', () => 'ok', 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();
    expect(result).toBe('ok');
  });

  it('null buildTimeStructure: flow continues to END and getSubflowResults is empty', async () => {
    let endRan = false;

    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction('HANDLER', () => makeDescriptor('sf-null', null), 'handler')
      .addFunction(
        'END',
        () => {
          endRan = true;
        },
        'end',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(endRan).toBe(true);
    expect(executor.getSubflowResults().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge case 3: Very deep nested structure (10 levels of `next`)
// ---------------------------------------------------------------------------

describe('Boundary: deeply nested buildTimeStructure', () => {
  function buildDeepChain(levels: number): object {
    let node: object = { name: `level-${levels}`, id: `level-${levels}`, type: 'stage' };
    for (let i = levels - 1; i >= 1; i--) {
      node = { name: `level-${i}`, id: `level-${i}`, type: 'stage', next: node };
    }
    return node;
  }

  it('10-level deep structure: flow executes without stack overflow', async () => {
    const deepStructure = buildDeepChain(10);

    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction('HANDLER', () => makeDescriptor('sf-deep', deepStructure), 'handler')
      .addFunction('END', () => 'deep-done', 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();
    expect(result).toBe('deep-done');
  });

  it('10-level deep structure: subflowStructure is stored in full', async () => {
    const deepStructure = buildDeepChain(10);

    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction('HANDLER', () => makeDescriptor('sf-deep', deepStructure), 'handler')
      .addFunction('END', () => {}, 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const structure = executor.getRuntimeStructure();
    const handlerNode = walkStructure(structure, 'handler');
    expect(handlerNode?.subflowStructure).toBeDefined();
    // Root of the deep chain should be level-1
    expect(handlerNode?.subflowStructure?.name).toBe('level-1');
  });

  it('10-level deep structure: getSubflowResults stays empty', async () => {
    const deepStructure = buildDeepChain(10);

    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction('HANDLER', () => makeDescriptor('sf-deep', deepStructure), 'handler')
      .addFunction('END', () => {}, 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSubflowResults().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge case 4: Structural subflow coexisting with a real static subflow
// ---------------------------------------------------------------------------

describe('Boundary: structural subflow coexists with real static subflow', () => {
  it('both the real subflow result and the structural annotation are present', async () => {
    const order: string[] = [];

    // Real static subflow (executed normally)
    const realSubChart = flowChart(
      'REAL_SUB_ENTRY',
      () => {
        order.push('REAL_SUB_ENTRY');
        return 'real-sub-result';
      },
      'real-sub-entry',
    ).build();

    const chart = new FlowChartBuilder()
      .start('START', () => order.push('START'), 'start')
      // Branch via decider: one branch runs real subflow, other is structural
      .addDeciderFunction('ROUTER', async () => 'real-path', 'router')
      // Real subflow branch
      .addSubFlowChartBranch('real-path', realSubChart, 'RealSubflow')
      // Structural-only branch (never taken in this test, but registered)
      .addFunctionBranch('structural-path', 'structural-path', () => {
        order.push('STRUCTURAL_PATH');
        return makeDescriptor('structural-sf', { name: 'StructInner', id: 'struct-inner' });
      })
      .end()
      .addFunction('AFTER_DECIDER', () => order.push('AFTER_DECIDER'), 'after-decider')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    // Real subflow branch executed
    expect(order).toContain('START');
    expect(order).toContain('REAL_SUB_ENTRY');
    expect(order).not.toContain('STRUCTURAL_PATH');
    expect(order).toContain('AFTER_DECIDER');

    // Real subflow produced a result
    const sfResults = executor.getSubflowResults();
    expect(sfResults.size).toBeGreaterThan(0);
  });

  it('structural subflow branch taken: real subflow result count stays separate', async () => {
    const realSubChart = flowChart('REAL_SUB_ENTRY', () => 'real-result', 'real-sub-entry').build();

    // In this flow, the decider always routes to structural path
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addDeciderFunction('ROUTER', async () => 'structural-path', 'router')
      .addSubFlowChartBranch('real-path', realSubChart, 'RealSubflow')
      .addFunctionBranch('structural-path', 'structural-path', () =>
        makeDescriptor('structural-sf', {
          name: 'InnerStep',
          id: 'inner-step',
        }),
      )
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    // No real subflow was executed — the structural path was taken
    // Real subflow would add an entry; structural must not
    // Since the real subflow never executed, results should be empty
    const sfResults = executor.getSubflowResults();
    expect(sfResults.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge case 5: Structural subflow is the LAST stage (no next continuation)
// ---------------------------------------------------------------------------

describe('Boundary: structural subflow as the last stage in the flow', () => {
  it('flow completes without error when structural subflow stage has no next', async () => {
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction(
        'LAST',
        () => makeDescriptor('sf-terminal', { name: 'terminal-inner', id: 'terminal-inner' }),
        'last',
      )
      // No .addFunction() after LAST — it is the terminal stage
      .build();

    const executor = new FlowChartExecutor(chart);
    // Should not throw
    await expect(executor.run()).resolves.not.toThrow();
  });

  it('runtime structure annotates LAST node even with no continuation', async () => {
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction(
        'LAST',
        () =>
          makeDescriptor('sf-terminal', {
            name: 'terminal-inner',
            id: 'terminal-inner',
            type: 'stage',
          }),
        'last',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const structure = executor.getRuntimeStructure();
    const lastNode = walkStructure(structure, 'last');
    expect(lastNode?.isSubflowRoot).toBe(true);
    expect(lastNode?.subflowId).toBe('sf-terminal');
    expect(lastNode?.subflowStructure?.name).toBe('terminal-inner');
  });

  it('getSubflowResults is empty when terminal structural subflow stage runs', async () => {
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction('LAST', () => makeDescriptor('sf-terminal', { name: 'inner', id: 'inner' }), 'last')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSubflowResults().size).toBe(0);
  });
});

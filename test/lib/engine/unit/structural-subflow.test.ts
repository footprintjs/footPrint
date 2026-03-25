/**
 * Unit test: structural-only dynamic subflow mechanics.
 *
 * When a stage returns a StageNode with `isSubflowRoot: true` plus
 * `subflowDef.buildTimeStructure` but NO `subflowDef.root`, the engine
 * must:
 *   1. Recognise the return as a valid StageNode continuation.
 *   2. Annotate the node in the runtime structure (isSubflowRoot, subflowId,
 *      subflowStructure) without executing any subflow stages.
 *   3. Continue to the next static stage after the structural subflow stage.
 */

import { FlowChartBuilder, FlowChartExecutor } from '../../../../src/index';
import { isStageNodeReturn } from '../../../../src/lib/engine/graph/StageNode';

// ---------------------------------------------------------------------------
// isStageNodeReturn detection
// ---------------------------------------------------------------------------

describe('Unit: isStageNodeReturn — structural subflow detection', () => {
  it('recognises a full structural subflow descriptor as a StageNode return', () => {
    const descriptor = {
      name: 'HANDLER',
      id: 'handler',
      isSubflowRoot: true,
      subflowId: 'inner-flow',
      subflowDef: {
        buildTimeStructure: {
          name: 'Step-A',
          id: 'step-a',
          type: 'stage',
          next: { name: 'Step-B', id: 'step-b', type: 'stage' },
        },
      },
    };
    expect(isStageNodeReturn(descriptor)).toBe(true);
  });

  it('recognises structural subflow with no extra continuation properties', () => {
    // Only isSubflowRoot makes it a continuation — no next/children required.
    const descriptor = {
      name: 'HANDLER',
      id: 'handler',
      isSubflowRoot: true,
      subflowId: 'sf',
      subflowDef: { buildTimeStructure: { name: 'inner', id: 'inner' } },
    };
    expect(isStageNodeReturn(descriptor)).toBe(true);
  });

  it('is rejected when isSubflowRoot is false and no other continuation exists', () => {
    expect(
      isStageNodeReturn({
        name: 'HANDLER',
        id: 'handler',
        isSubflowRoot: false,
        subflowDef: { buildTimeStructure: { name: 'x', id: 'x' } },
      }),
    ).toBe(false);
  });

  it('is rejected for a plain object with only name (no continuation)', () => {
    expect(isStageNodeReturn({ name: 'HANDLER', id: 'handler' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end mechanics via FlowChartExecutor
// ---------------------------------------------------------------------------

describe('Unit: structural subflow — flow continuation mechanics', () => {
  const buildTimeStructure = {
    name: 'Step-A',
    id: 'step-a',
    type: 'stage' as const,
    next: { name: 'Step-B', id: 'step-b', type: 'stage' as const },
  };

  function buildFlow(afterHook?: () => void) {
    return new FlowChartBuilder()
      .start(
        'REQUEST_START',
        (scope: any) => {
          scope.started = true;
        },
        'request-start',
        'Initialise the request',
      )
      .addFunction(
        'HANDLER',
        (scope: any) => {
          scope.handled = true;
          // Return a structural-only subflow descriptor — no root
          return {
            name: 'HANDLER',
            id: 'handler',
            isSubflowRoot: true,
            subflowId: 'inner-flow',
            subflowName: 'Inner Flow',
            subflowDef: { buildTimeStructure },
          };
        },
        'handler',
        'Handle the request and annotate with pre-executed subflow',
      )
      .addFunction(
        'RESPONSE',
        (scope: any) => {
          afterHook?.();
          scope.responded = true;
          return 'done';
        },
        'response',
        'Return the response',
      )
      .build();
  }

  it('flow does not hang — all three stages execute', async () => {
    const order: string[] = [];

    const chart = new FlowChartBuilder()
      .start('REQUEST_START', () => order.push('REQUEST_START'), 'request-start')
      .addFunction(
        'HANDLER',
        () => {
          order.push('HANDLER');
          return {
            name: 'HANDLER',
            id: 'handler',
            isSubflowRoot: true,
            subflowId: 'inner-flow',
            subflowDef: { buildTimeStructure },
          };
        },
        'handler',
      )
      .addFunction('RESPONSE', () => order.push('RESPONSE'), 'response')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(order).toEqual(['REQUEST_START', 'HANDLER', 'RESPONSE']);
  });

  it('RESPONSE stage (after structural subflow) executes normally', async () => {
    let responseRan = false;
    const chart = buildFlow(() => {
      responseRan = true;
    });

    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();

    expect(responseRan).toBe(true);
    expect(result).toBe('done');
  });

  it('getRuntimeStructure annotates HANDLER node with isSubflowRoot and subflowId', async () => {
    const chart = buildFlow();
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const structure = executor.getRuntimeStructure();
    expect(structure).toBeDefined();

    // Walk the structure to find the HANDLER node
    function findNode(node: any, id: string): any {
      if (!node) return undefined;
      if (node.id === id) return node;
      return findNode(node.next, id) ?? findNode(node.children, id);
    }

    const handlerNode = findNode(structure, 'handler');
    expect(handlerNode).toBeDefined();
    expect(handlerNode.isSubflowRoot).toBe(true);
    expect(handlerNode.subflowId).toBe('inner-flow');
  });

  it('getRuntimeStructure attaches subflowStructure onto the HANDLER node', async () => {
    const chart = buildFlow();
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const structure = executor.getRuntimeStructure();

    function findNode(node: any, id: string): any {
      if (!node) return undefined;
      if (node.id === id) return node;
      return findNode(node.next, id) ?? findNode(node.children, id);
    }

    const handlerNode = findNode(structure, 'handler');
    expect(handlerNode?.subflowStructure).toBeDefined();
    // The buildTimeStructure content should be present
    expect(handlerNode.subflowStructure.name).toBe('Step-A');
  });

  it('scope values from all stages are accessible after the run', async () => {
    const chart = buildFlow();
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot?.sharedState?.started).toBe(true);
    expect(snapshot?.sharedState?.handled).toBe(true);
    expect(snapshot?.sharedState?.responded).toBe(true);
  });
});

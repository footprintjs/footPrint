/**
 * Scenario test: structural-only dynamic subflow — realistic end-to-end flows.
 *
 * Covers:
 *   - Request wrapper with structural subflow annotation
 *   - Multiple independent runs of the same flow (execution isolation)
 *   - Structural subflow combined with scope data mutations
 */

import { FlowChartBuilder, FlowChartExecutor } from '../../../../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStructuralSubflowDescriptor(subflowId: string, subflowName: string, buildTimeStructure: unknown) {
  return {
    name: 'HANDLER',
    id: 'handler',
    isSubflowRoot: true as const,
    subflowId,
    subflowName,
    subflowDef: { buildTimeStructure },
  };
}

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

// ---------------------------------------------------------------------------
// Scenario 1: REQUEST_START → HANDLER (structural subflow) → RESPONSE
// ---------------------------------------------------------------------------

describe('Scenario: Request wrapper with structural subflow', () => {
  const innerStructure = {
    name: 'Validate',
    id: 'validate',
    type: 'stage' as const,
    next: {
      name: 'Persist',
      id: 'persist',
      type: 'stage' as const,
    },
  };

  function buildRequestFlow() {
    return new FlowChartBuilder()
      .start(
        'REQUEST_START',
        (scope: any) => {
          scope.setValue('requestId', 'req-001');
        },
        'request-start',
        'Accept and record the incoming request',
      )
      .addFunction(
        'HANDLER',
        (scope: any) => {
          scope.setValue('handlerRan', true);
          return makeStructuralSubflowDescriptor('create-grade-flow', 'Create Grade Flow', innerStructure);
        },
        'handler',
        'Delegate to pre-executed subflow and annotate for tracing',
      )
      .addFunction(
        'RESPONSE',
        (scope: any) => {
          scope.setValue('responseBuilt', true);
          return { status: 200, body: 'ok' };
        },
        'response',
        'Build and return HTTP response',
      )
      .build();
  }

  it('all three stages execute in order', async () => {
    const order: string[] = [];

    const chart = new FlowChartBuilder()
      .start('REQUEST_START', () => order.push('REQUEST_START'), 'request-start')
      .addFunction(
        'HANDLER',
        () => {
          order.push('HANDLER');
          return makeStructuralSubflowDescriptor('sf', 'SF', innerStructure);
        },
        'handler',
      )
      .addFunction('RESPONSE', () => order.push('RESPONSE'), 'response')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(order).toEqual(['REQUEST_START', 'HANDLER', 'RESPONSE']);
  });

  it('runtime structure has subflow annotation on HANDLER node', async () => {
    const chart = buildRequestFlow();
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const structure = executor.getRuntimeStructure();
    expect(structure).toBeDefined();

    const handlerNode = walkStructure(structure, 'handler');
    expect(handlerNode).toBeDefined();
    expect(handlerNode.isSubflowRoot).toBe(true);
    expect(handlerNode.subflowId).toBe('create-grade-flow');
    expect(handlerNode.subflowStructure).toBeDefined();
    expect(handlerNode.subflowStructure.name).toBe('Validate');
  });

  it('scope values from all stages are accessible after the run', async () => {
    const chart = buildRequestFlow();
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot?.sharedState?.requestId).toBe('req-001');
    expect(snapshot?.sharedState?.handlerRan).toBe(true);
    expect(snapshot?.sharedState?.responseBuilt).toBe(true);
  });

  it('final return value is from RESPONSE stage', async () => {
    const chart = buildRequestFlow();
    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();

    expect(result).toEqual({ status: 200, body: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Multiple requests reuse same flow — each run gets own annotation
// ---------------------------------------------------------------------------

describe('Scenario: Multiple requests reuse same flow', () => {
  const structureA = { name: 'Inner-A', id: 'inner-a', type: 'stage' as const };
  const structureB = { name: 'Inner-B', id: 'inner-b', type: 'stage' as const };

  it('each execution produces an independent runtime structure annotation', async () => {
    function buildChart(subflowId: string, structure: unknown) {
      return new FlowChartBuilder()
        .start('START', (scope: any) => scope.setValue('run', subflowId), 'start')
        .addFunction('HANDLER', () => makeStructuralSubflowDescriptor(subflowId, subflowId, structure), 'handler')
        .addFunction('DONE', () => 'done', 'done')
        .build();
    }

    const chartA = buildChart('flow-a', structureA);
    const chartB = buildChart('flow-b', structureB);

    const execA = new FlowChartExecutor(chartA);
    const execB = new FlowChartExecutor(chartB);

    await execA.run();
    await execB.run();

    const structA = execA.getRuntimeStructure();
    const structB = execB.getRuntimeStructure();

    const handlerA = walkStructure(structA, 'handler');
    const handlerB = walkStructure(structB, 'handler');

    expect(handlerA?.subflowId).toBe('flow-a');
    expect(handlerB?.subflowId).toBe('flow-b');

    // The two annotations are independent — mutating one does not affect the other
    expect(handlerA?.subflowStructure?.name).toBe('Inner-A');
    expect(handlerB?.subflowStructure?.name).toBe('Inner-B');
  });

  it('sequential runs each produce independent snapshots when each uses a fresh chart', async () => {
    // NOTE: The engine mutates StageNode objects in Phase 4 (attaches isSubflowRoot,
    // subflowId to the node). Sharing the same chart object across executors is
    // therefore unsafe once the first run has completed. Each executor should be
    // built from its own chart to guarantee isolation.
    function buildFreshChart() {
      return new FlowChartBuilder()
        .start('START', (scope: any) => scope.setValue('data', 'initial'), 'start')
        .addFunction(
          'HANDLER',
          () =>
            makeStructuralSubflowDescriptor('reused-flow', 'Reused', {
              name: 'inner',
              id: 'inner',
            }),
          'handler',
        )
        .addFunction('DONE', (scope: any) => scope.setValue('done', true), 'done')
        .build();
    }

    const exec1 = new FlowChartExecutor(buildFreshChart());
    await exec1.run();
    const snap1 = exec1.getSnapshot();

    const exec2 = new FlowChartExecutor(buildFreshChart());
    await exec2.run();
    const snap2 = exec2.getSnapshot();

    // Both runs completed and have their own state
    expect(snap1?.sharedState?.done).toBe(true);
    expect(snap2?.sharedState?.done).toBe(true);

    // Snapshots are independent objects
    expect(snap1).not.toBe(snap2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Structural subflow with scope data — both annotation and scope preserved
// ---------------------------------------------------------------------------

describe('Scenario: Structural subflow with scope data', () => {
  it('scope values set inside HANDLER stage are preserved alongside structural annotation', async () => {
    const computedResult = { gradeId: 'grade-42', score: 95 };

    const chart = new FlowChartBuilder()
      .start('START', (scope: any) => scope.setValue('phase', 'start'), 'start')
      .addFunction(
        'HANDLER',
        (scope: any) => {
          // Simulates: subflow already ran externally; we have its result
          scope.setValue('gradeResult', computedResult);
          scope.setValue('phase', 'handled');

          return makeStructuralSubflowDescriptor('grade-creation-flow', 'Grade Creation', {
            name: 'Validate Input',
            id: 'validate-input',
            type: 'stage' as const,
            next: {
              name: 'Write Grade',
              id: 'write-grade',
              type: 'stage' as const,
            },
          });
        },
        'handler',
        'Run pre-executed grade creation and annotate',
      )
      .addFunction(
        'RESPONSE',
        (scope: any) => {
          scope.setValue('phase', 'responded');
          return scope.getValue('gradeResult');
        },
        'response',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();

    // Scope data from HANDLER is preserved
    expect(result).toEqual(computedResult);

    const snapshot = executor.getSnapshot();
    expect(snapshot?.sharedState?.gradeResult).toEqual(computedResult);
    expect(snapshot?.sharedState?.phase).toBe('responded');

    // Structural annotation is also present
    const structure = executor.getRuntimeStructure();
    const handlerNode = walkStructure(structure, 'handler');
    expect(handlerNode?.isSubflowRoot).toBe(true);
    expect(handlerNode?.subflowId).toBe('grade-creation-flow');
    expect(handlerNode?.subflowStructure?.name).toBe('Validate Input');
  });

  it('structural annotation does not clear scope values set before HANDLER returns', async () => {
    const sideEffects: string[] = [];

    const chart = new FlowChartBuilder()
      .start(
        'INIT',
        (scope: any) => {
          sideEffects.push('init');
          scope.setValue('token', 'abc-123');
        },
        'init',
      )
      .addFunction(
        'HANDLER',
        (scope: any) => {
          sideEffects.push('handler');
          scope.setValue('token', scope.getValue('token') + '-processed');
          return makeStructuralSubflowDescriptor('sf', 'SF', { name: 'x', id: 'x' });
        },
        'handler',
      )
      .addFunction(
        'VERIFY',
        (scope: any) => {
          sideEffects.push('verify');
          return scope.getValue('token');
        },
        'verify',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();

    expect(sideEffects).toEqual(['init', 'handler', 'verify']);
    expect(result).toBe('abc-123-processed');
  });
});

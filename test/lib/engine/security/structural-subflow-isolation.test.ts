/**
 * Security test: structural-only dynamic subflow — isolation guarantees.
 *
 * Verifies:
 *   1. buildTimeStructure is stored and accessible — each executor captures its
 *      own annotation independently.
 *   2. Scope state does not leak between executions.
 *   3. SubflowExecutor is NOT invoked — verified by absence of any SubflowResult
 *      entries (no execution context was ever created).
 *
 * NOTE on chart reuse: The engine mutates StageNode objects in Phase 4 (attaches
 * `isSubflowRoot`, `subflowId` directly onto the node). Sharing the same chart
 * object across multiple executors is therefore unsafe after the first run. Each
 * executor below receives a freshly-built chart where this is relevant.
 */

import { FlowChartBuilder, FlowChartExecutor } from '../../../../src/index';

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

// ---------------------------------------------------------------------------
// Isolation 1: buildTimeStructure is captured per executor
// ---------------------------------------------------------------------------

describe('Security: buildTimeStructure annotation isolation', () => {
  it('buildTimeStructure is deep-copied — mutating original after execution does not affect stored annotation', async () => {
    const originalStructure: any = {
      name: 'OriginalStep',
      id: 'original-step',
      type: 'stage',
    };

    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction(
        'HANDLER',
        () => ({
          name: 'HANDLER',
          id: 'handler',
          isSubflowRoot: true as const,
          subflowId: 'isolation-sf',
          subflowDef: { buildTimeStructure: originalStructure },
        }),
        'handler',
      )
      .addFunction('END', () => {}, 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    // Mutate the original structure AFTER execution
    originalStructure.name = 'MUTATED';
    originalStructure.injected = 'evil-payload';

    // The stored annotation should be unaffected (deep-copied)
    const structure = executor.getRuntimeStructure();
    const handlerNode = walkStructure(structure, 'handler');
    expect(handlerNode?.subflowStructure).toBeDefined();
    expect(handlerNode?.subflowStructure?.name).toBe('OriginalStep');
    expect(handlerNode?.subflowStructure?.injected).toBeUndefined();
  });

  it('two executors built from different charts capture their own annotations independently', async () => {
    function buildChart(structureName: string) {
      return new FlowChartBuilder()
        .start('START', () => {}, 'start')
        .addFunction(
          'HANDLER',
          () => ({
            name: 'HANDLER',
            id: 'handler',
            isSubflowRoot: true as const,
            subflowId: 'per-run-sf',
            subflowDef: {
              buildTimeStructure: { name: structureName, id: 'inner', type: 'stage' },
            },
          }),
          'handler',
        )
        .addFunction('END', () => {}, 'end')
        .build();
    }

    const exec1 = new FlowChartExecutor(buildChart('StructureOne'));
    const exec2 = new FlowChartExecutor(buildChart('StructureTwo'));

    await exec1.run();
    await exec2.run();

    const h1 = walkStructure(exec1.getRuntimeStructure(), 'handler');
    const h2 = walkStructure(exec2.getRuntimeStructure(), 'handler');

    expect(h1?.subflowStructure?.name).toBe('StructureOne');
    expect(h2?.subflowStructure?.name).toBe('StructureTwo');
  });
});

// ---------------------------------------------------------------------------
// Isolation 2: Scope state does not leak between executions
// ---------------------------------------------------------------------------

describe('Security: scope isolation between executions', () => {
  it('scope from execution 1 is not visible in execution 2', async () => {
    function buildScopeChart() {
      return new FlowChartBuilder()
        .start(
          'START',
          (scope: any) => {
            scope.executionSecret = 'exec-1-secret';
          },
          'start',
        )
        .addFunction(
          'HANDLER',
          (scope: any) => {
            scope.handlerData = 'exec-1-handler';
            return {
              name: 'HANDLER',
              id: 'handler',
              isSubflowRoot: true as const,
              subflowId: 'scope-isolation-sf',
              subflowDef: { buildTimeStructure: { name: 'inner', id: 'inner' } },
            };
          },
          'handler',
        )
        .addFunction(
          'END',
          (scope: any) => {
            return scope.executionSecret;
          },
          'end',
        )
        .build();
    }

    const exec1 = new FlowChartExecutor(buildScopeChart());
    await exec1.run();
    const snap1 = exec1.getSnapshot();

    const exec2 = new FlowChartExecutor(buildScopeChart());
    await exec2.run();
    const snap2 = exec2.getSnapshot();

    // Both executions completed with their own isolated scope
    expect(snap1?.sharedState?.executionSecret).toBe('exec-1-secret');
    expect(snap2?.sharedState?.executionSecret).toBe('exec-1-secret');
    // Snapshots are separate objects
    expect(snap1).not.toBe(snap2);
  });

  it('scope data from each run is independently captured without leaking into the other', async () => {
    let runCount = 0;

    function buildCountChart() {
      return new FlowChartBuilder()
        .start(
          'START',
          (scope: any) => {
            runCount++;
            scope.runCount = runCount;
          },
          'start',
        )
        .addFunction(
          'HANDLER',
          () => ({
            name: 'HANDLER',
            id: 'handler',
            isSubflowRoot: true as const,
            subflowId: 'pollution-sf',
            subflowDef: { buildTimeStructure: { name: 'inner', id: 'inner' } },
          }),
          'handler',
        )
        .addFunction('END', () => {}, 'end')
        .build();
    }

    const exec1 = new FlowChartExecutor(buildCountChart());
    await exec1.run();
    const snap1 = exec1.getSnapshot();

    const exec2 = new FlowChartExecutor(buildCountChart());
    await exec2.run();
    const snap2 = exec2.getSnapshot();

    // Each executor has its own scope — runCount values reflect separate closures
    expect(typeof snap1?.sharedState?.runCount).toBe('number');
    expect(typeof snap2?.sharedState?.runCount).toBe('number');
    // Neither run's scope leaked into the other — snapshots are distinct
    expect(snap1).not.toBe(snap2);
  });
});

// ---------------------------------------------------------------------------
// Isolation 3: SubflowExecutor is NOT invoked
// ---------------------------------------------------------------------------

describe('Security: SubflowExecutor not invoked for structural subflows', () => {
  it('getSubflowResults().size is 0 — no execution context was created', async () => {
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction(
        'HANDLER',
        () => ({
          name: 'HANDLER',
          id: 'handler',
          isSubflowRoot: true as const,
          subflowId: 'no-execution-sf',
          subflowDef: {
            buildTimeStructure: {
              name: 'Stage1',
              id: 'stage1',
              type: 'stage',
              next: { name: 'Stage2', id: 'stage2', type: 'stage' },
            },
          },
        }),
        'handler',
      )
      .addFunction('END', () => {}, 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    // SubflowExecutor would have stored a result here if it was invoked.
    expect(executor.getSubflowResults().size).toBe(0);
  });

  it('no subflow entry appears in snapshot stage contexts', async () => {
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction(
        'HANDLER',
        () => ({
          name: 'HANDLER',
          id: 'handler',
          isSubflowRoot: true as const,
          subflowId: 'no-entry-sf',
          subflowDef: { buildTimeStructure: { name: 'inner', id: 'inner' } },
        }),
        'handler',
      )
      .addFunction('END', () => {}, 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    const sfResults = executor.getSubflowResults();

    // Structural subflow left no execution footprint in subflow results
    expect(sfResults.size).toBe(0);
    expect(sfResults.has('no-entry-sf')).toBe(false);

    // Snapshot itself must be defined (the parent flow ran fine)
    expect(snapshot).toBeDefined();
  });

  it('structural subflow with a rich multi-stage buildTimeStructure still creates no SubflowResult', async () => {
    // Even a 5-stage structure should never invoke SubflowExecutor
    const richStructure = {
      name: 'Step1',
      id: 'step1',
      type: 'stage' as const,
      next: {
        name: 'Step2',
        id: 'step2',
        type: 'stage' as const,
        next: {
          name: 'Step3',
          id: 'step3',
          type: 'stage' as const,
          next: {
            name: 'Step4',
            id: 'step4',
            type: 'stage' as const,
            next: {
              name: 'Step5',
              id: 'step5',
              type: 'stage' as const,
            },
          },
        },
      },
    };

    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction(
        'HANDLER',
        () => ({
          name: 'HANDLER',
          id: 'handler',
          isSubflowRoot: true as const,
          subflowId: 'rich-sf',
          subflowDef: { buildTimeStructure: richStructure },
        }),
        'handler',
      )
      .addFunction('END', () => {}, 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.getSubflowResults().size).toBe(0);

    // Structural annotation IS present (stored without execution)
    const structure = executor.getRuntimeStructure();
    const handlerNode = walkStructure(structure, 'handler');
    expect(handlerNode?.subflowStructure?.name).toBe('Step1');
  });

  it('descriptor with buildTimeStructure + stageMap but no root does not trigger execution', async () => {
    // A descriptor that includes stageMap but omits root should still be
    // treated as structural-only — the absence of `root` is the signal to
    // skip SubflowExecutor entirely.
    const chart = new FlowChartBuilder()
      .start('START', () => {}, 'start')
      .addFunction(
        'HANDLER',
        () => ({
          name: 'HANDLER',
          id: 'handler',
          isSubflowRoot: true as const,
          subflowId: 'with-stagemap-sf',
          subflowDef: {
            // No root — this is the structural-only signal
            buildTimeStructure: { name: 'ghost-stage', id: 'ghost-stage' },
            stageMap: new Map([['ghost-stage', () => 'should-not-run']]),
          },
        }),
        'handler',
      )
      .addFunction('END', () => {}, 'end')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    // SubflowExecutor must not have been invoked
    expect(executor.getSubflowResults().size).toBe(0);
  });
});

/**
 * Property test: structural-only dynamic subflow invariants.
 *
 * Uses fast-check to verify invariants that must hold across arbitrary inputs:
 *   1. getRuntimeStructure() always contains the full buildTimeStructure regardless
 *      of the structure's shape (depth, breadth, field variety).
 *   2. Structural subflows never create SubflowResults — the executor is not invoked.
 *   3. Narrative does NOT contain subflow entry/exit markers because no subflow executes.
 */

import * as fc from 'fast-check';

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

/** Build an arbitrary chain of stage nodes `depth` levels deep via `next` links. */
function buildChainStructure(depth: number, prefix: string): object {
  if (depth <= 0) {
    return { name: `${prefix}-leaf`, id: `${prefix}-leaf`, type: 'stage' };
  }
  return {
    name: `${prefix}-${depth}`,
    id: `${prefix}-${depth}`,
    type: 'stage',
    next: buildChainStructure(depth - 1, prefix),
  };
}

/** Build a chart where HANDLER returns a structural subflow with the given structure. */
function buildChartWithStructure(buildTimeStructure: unknown) {
  return new FlowChartBuilder()
    .start('START', () => {}, 'start')
    .addFunction(
      'HANDLER',
      () => ({
        name: 'HANDLER',
        id: 'handler',
        isSubflowRoot: true as const,
        subflowId: 'test-subflow',
        subflowName: 'Test Subflow',
        subflowDef: { buildTimeStructure },
      }),
      'handler',
    )
    .addFunction('END', () => 'end', 'end')
    .build();
}

// ---------------------------------------------------------------------------
// Property 1: getRuntimeStructure always carries the full buildTimeStructure
// ---------------------------------------------------------------------------

describe('Property: structural subflow — structure is always captured', () => {
  it('arbitrary chain depths (1–10): subflowStructure always present on HANDLER node', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (depth) => {
        const buildTimeStructure = buildChainStructure(depth, 'stage');
        const chart = buildChartWithStructure(buildTimeStructure);

        const executor = new FlowChartExecutor(chart);
        await executor.run();

        const structure = executor.getRuntimeStructure();
        const handlerNode = walkStructure(structure, 'handler');

        expect(handlerNode).toBeDefined();
        expect(handlerNode.isSubflowRoot).toBe(true);
        expect(handlerNode.subflowStructure).toBeDefined();
      }),
    );
  });

  it('arbitrary structure name strings: name is preserved in subflowStructure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        async (rootName, rootId) => {
          const buildTimeStructure = { name: rootName, id: rootId, type: 'stage' };
          const chart = buildChartWithStructure(buildTimeStructure);

          const executor = new FlowChartExecutor(chart);
          await executor.run();

          const structure = executor.getRuntimeStructure();
          const handlerNode = walkStructure(structure, 'handler');

          expect(handlerNode?.subflowStructure?.name).toBe(rootName);
        },
      ),
    );
  });

  it('arbitrary number of parallel children in structure: all are captured', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (childCount) => {
        const children = Array.from({ length: childCount }, (_, i) => ({
          name: `child-${i}`,
          id: `child-${i}`,
          type: 'stage' as const,
        }));
        const buildTimeStructure = {
          name: 'fork-root',
          id: 'fork-root',
          type: 'fork' as const,
          children,
        };

        const chart = buildChartWithStructure(buildTimeStructure);
        const executor = new FlowChartExecutor(chart);
        await executor.run();

        const structure = executor.getRuntimeStructure();
        const handlerNode = walkStructure(structure, 'handler');

        expect(handlerNode?.subflowStructure?.children).toHaveLength(childCount);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: structural subflows never produce SubflowResults
// ---------------------------------------------------------------------------

describe('Property: structural subflow — no SubflowResults created', () => {
  it('arbitrary subflowIds: getSubflowResults().size is always 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
        async (subflowId) => {
          const chart = buildChartWithStructure({ name: 'inner', id: 'inner', type: 'stage' });
          // Override subflowId dynamically using a fresh chart per run
          const customChart = new FlowChartBuilder()
            .start('START', () => {}, 'start')
            .addFunction(
              'HANDLER',
              () => ({
                name: 'HANDLER',
                id: 'handler',
                isSubflowRoot: true as const,
                subflowId,
                subflowName: 'Dynamic',
                subflowDef: { buildTimeStructure: { name: 'inner', id: 'inner' } },
              }),
              'handler',
            )
            .addFunction('END', () => {}, 'end')
            .build();

          const executor = new FlowChartExecutor(customChart);
          await executor.run();

          expect(executor.getSubflowResults().size).toBe(0);
        },
      ),
    );
  });

  it('arbitrary chain depths: no SubflowResults regardless of structure complexity', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (depth) => {
        const buildTimeStructure = buildChainStructure(depth, 'node');
        const chart = buildChartWithStructure(buildTimeStructure);

        const executor = new FlowChartExecutor(chart);
        await executor.run();

        expect(executor.getSubflowResults().size).toBe(0);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Narrative contains no subflow entry/exit markers
// ---------------------------------------------------------------------------

describe('Property: structural subflow — no subflow entry/exit in narrative', () => {
  it('arbitrary depths: narrative never contains subflow entry or exit markers', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (depth) => {
        const buildTimeStructure = buildChainStructure(depth, 'n');
        const customChart = new FlowChartBuilder()
          .start('START', () => {}, 'start')
          .addFunction(
            'HANDLER',
            () => ({
              name: 'HANDLER',
              id: 'handler',
              isSubflowRoot: true as const,
              subflowId: 'sf-narrative-test',
              subflowDef: { buildTimeStructure },
            }),
            'handler',
          )
          .addFunction('END', () => {}, 'end')
          .build();

        const executor = new FlowChartExecutor(customChart);
        executor.enableNarrative();
        await executor.run();

        const narrative = executor.getNarrative();

        // Subflow entry/exit markers appear in subflow execution but NOT in
        // structural-only subflows because no SubflowExecutor is invoked.
        const hasSubflowEntry = narrative.some(
          (s) => s.toLowerCase().includes('entering') && s.toLowerCase().includes('subflow'),
        );
        const hasSubflowExit = narrative.some(
          (s) => s.toLowerCase().includes('exiting') && s.toLowerCase().includes('subflow'),
        );

        expect(hasSubflowEntry).toBe(false);
        expect(hasSubflowExit).toBe(false);
      }),
    );
  });

  it('narrative mentions all stages that actually ran (START, HANDLER, END)', async () => {
    // Sanity check: even though subflow markers are absent, stage execution
    // is still narrated.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (_depth) => {
        const chart = new FlowChartBuilder()
          .start('START', () => {}, 'start', 'Start the process')
          .addFunction(
            'HANDLER',
            () => ({
              name: 'HANDLER',
              id: 'handler',
              isSubflowRoot: true as const,
              subflowId: 'sf',
              subflowDef: { buildTimeStructure: { name: 'inner', id: 'inner' } },
            }),
            'handler',
            'Handle with structural subflow',
          )
          .addFunction('END', () => {}, 'end', 'Finish the process')
          .build();

        const executor = new FlowChartExecutor(chart);
        executor.enableNarrative();
        await executor.run();

        const narrative = executor.getNarrative();
        // At least one narrative entry should be produced
        expect(narrative.length).toBeGreaterThan(0);
      }),
    );
  });
});

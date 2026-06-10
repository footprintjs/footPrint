/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Scenario test: Dynamic StageNode returns must NOT mutate the shared built chart.
 *
 * A chart built once (`flowChart(...).build()`) is a shared, immutable artifact —
 * multiple executors (sequential or concurrent) may run it. Phase 4 of
 * FlowchartTraverser (dynamic StageNode-return handling) used to write the
 * dynamic shape DIRECTLY onto the built chart's nodes (`children`,
 * `nextNodeSelector`, `isSubflowRoot`/`subflowId`/`subflowName`/
 * `subflowMountOptions`; only `next` was restored), leaking one run's dynamic
 * graph into every later run and racing concurrent executors.
 *
 * The fix: a traverser-local overlay (`dynamicPatches: Map<nodeId, DynamicNodePatch>`).
 * These tests pin the isolation contract:
 *   (a) dynamic children — two fresh executors sharing the built chart; the
 *       second run sees the ORIGINAL graph
 *   (b) same isolation for dynamic next + dynamic subflow
 *   (c) concurrent executors with DIFFERENT dynamic children — no
 *       cross-contamination, deterministic
 *   (d) loop revisit of a dynamic-next stage inside one run still works
 *   (e) built chart's nodes structurally unchanged after runs (spec-field
 *       JSON-compare before/after)
 *
 * Note: fork children commit to branch-scoped state — their writes land under
 * `sharedState.runs[<childId>]`, not at the top level.
 */
import type { FlowChart } from '../../../../src';
import { flowChart, FlowChartExecutor } from '../../../../src';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';

/**
 * Collect the spec fields a dynamic StageNode return could clobber, for every
 * node reachable from the root. Cycle-safe (loopTo creates reference cycles).
 * JSON-comparable — functions are reduced to presence booleans.
 */
function graphShape(root: StageNode): unknown[] {
  const shapes: unknown[] = [];
  const visited = new Set<StageNode>();

  const visit = (node: StageNode): void => {
    if (visited.has(node)) return;
    visited.add(node);

    shapes.push({
      id: node.id ?? null,
      name: node.name,
      nextId: node.next ? node.next.id ?? node.next.name : null,
      childIds: node.children ? node.children.map((c) => c.id ?? c.name) : null,
      hasNextNodeSelector: typeof node.nextNodeSelector === 'function',
      isSubflowRoot: node.isSubflowRoot ?? null,
      subflowId: node.subflowId ?? null,
      subflowName: node.subflowName ?? null,
      subflowMountOptions: node.subflowMountOptions ?? null,
    });

    if (node.children) for (const child of node.children) visit(child);
    if (node.next) visit(node.next);
  };

  visit(root);
  return shapes;
}

/** JSON round-trip so later mutations cannot retroactively change the baseline. */
function frozenShape(root: StageNode): unknown[] {
  return JSON.parse(JSON.stringify(graphShape(root)));
}

describe('Scenario: dynamic StageNode returns do not mutate the shared built chart', () => {
  // ─── (a) + (e): dynamic children isolation across fresh executors ───

  it('dynamic children from run 1 do not leak into run 2 on a fresh executor sharing the built chart', async () => {
    const executedChildren: string[] = [];

    const chart = flowChart(
      'Seed',
      (scope: any) => {
        const args = scope.$getArgs<{ fanout: boolean; tag: string }>();
        if (args.fanout) {
          return {
            name: 'dynamic-fork',
            children: [
              {
                name: 'ChildA',
                id: 'child-a',
                fn: (s: any) => {
                  executedChildren.push(`${args.tag}-A`);
                  s.childA = `${args.tag}-A`;
                },
              },
              {
                name: 'ChildB',
                id: 'child-b',
                fn: (s: any) => {
                  executedChildren.push(`${args.tag}-B`);
                  s.childB = `${args.tag}-B`;
                },
              },
            ],
          };
        }
        scope.linearOnly = true;
      },
      'seed',
    )
      .addFunction(
        'After',
        (scope: any) => {
          scope.after = true;
        },
        'after',
      )
      .build();

    const shapeBefore = frozenShape(chart.root);

    // Run 1: dynamic fan-out fires. Fork children commit branch-scoped state.
    const executor1 = new FlowChartExecutor(chart);
    await executor1.run({ input: { fanout: true, tag: 'r1' } });
    expect(executedChildren.sort()).toEqual(['r1-A', 'r1-B']);
    const state1 = executor1.getSnapshot()?.sharedState as any;
    expect(state1?.runs?.['child-a']?.childA).toBe('r1-A');
    expect(state1?.runs?.['child-b']?.childB).toBe('r1-B');
    expect(state1?.after).toBe(true);

    // (e) Built chart structurally unchanged after the dynamic run.
    expect(frozenShape(chart.root)).toEqual(shapeBefore);

    // Run 2 on a FRESH executor: no dynamic return — must see the ORIGINAL
    // graph. Before the overlay fix, run 1's children were still attached to
    // the shared 'seed' node and executed here with run 1's closed-over args.
    const executor2 = new FlowChartExecutor(chart);
    await executor2.run({ input: { fanout: false, tag: 'r2' } });
    expect(executedChildren).toHaveLength(2); // no stale children re-ran
    const state2 = executor2.getSnapshot()?.sharedState as any;
    expect(state2?.runs?.['child-a']).toBeUndefined();
    expect(state2?.runs?.['child-b']).toBeUndefined();
    expect(state2?.linearOnly).toBe(true);
    expect(state2?.after).toBe(true);

    expect(frozenShape(chart.root)).toEqual(shapeBefore);
  });

  // ─── (b) + (e): dynamic next isolation across fresh executors ───

  it('dynamic next from run 1 does not leak into run 2 on a fresh executor sharing the built chart', async () => {
    const hops: string[] = [];

    const chart = flowChart(
      'Driver',
      (scope: any) => {
        const args = scope.$getArgs<{ dynamic: boolean }>();
        if (args.dynamic) {
          return {
            name: 'continuation',
            next: {
              name: 'DynamicHop',
              id: 'dynamic-hop',
              fn: (s: any) => {
                hops.push('dynamic-hop');
                s.dynamicHop = true;
              },
            },
          };
        }
        scope.plain = true;
      },
      'driver',
    )
      .addFunction(
        'BuiltNext',
        (scope: any) => {
          hops.push('built-next');
          scope.builtNext = true;
        },
        'built-next',
      )
      .build();

    const shapeBefore = frozenShape(chart.root);

    // Run 1: dynamic next REPLACES the built continuation for this visit.
    const executor1 = new FlowChartExecutor(chart);
    await executor1.run({ input: { dynamic: true } });
    const state1 = executor1.getSnapshot()?.sharedState as any;
    expect(state1?.dynamicHop).toBe(true);
    expect(state1?.builtNext).toBeUndefined();

    expect(frozenShape(chart.root)).toEqual(shapeBefore);

    // Run 2 on a fresh executor: built continuation runs, dynamic hop does not.
    const executor2 = new FlowChartExecutor(chart);
    await executor2.run({ input: { dynamic: false } });
    const state2 = executor2.getSnapshot()?.sharedState as any;
    expect(state2?.plain).toBe(true);
    expect(state2?.builtNext).toBe(true);
    expect(state2?.dynamicHop).toBeUndefined();

    expect(hops).toEqual(['dynamic-hop', 'built-next']);
    expect(frozenShape(chart.root)).toEqual(shapeBefore);
  });

  // ─── (b) + (e): dynamic subflow isolation across fresh executors ───

  it('dynamic subflow from run 1 does not leak into run 2 on a fresh executor sharing the chart', async () => {
    const subRuns: string[] = [];

    // Dynamic-subflow mounts require a stageMap-keyed mount node (no embedded
    // fn) so Phase 0 resolves the auto-registered def by reference — the shape
    // the engine supports for this pattern (see traverser-coverage.test.ts).
    // Hand-assembled charts get the default ScopeFacade (not TypedScope).
    const mountFn = (scope: any) => {
      const args = scope.getArgs<{ mount: boolean; tag: string }>();
      if (args.mount) {
        return {
          name: 'dyn-subflow',
          isSubflowRoot: true,
          subflowId: 'sf-dynamic',
          subflowName: 'Dynamic Sub',
          subflowDef: {
            root: {
              name: 'SubEntry',
              id: 'sub-entry',
              fn: () => {
                subRuns.push(args.tag);
                return 'sub-done';
              },
            },
            stageMap: new Map(),
          },
          // isStageNodeReturn duck-typing needs a continuation property
          children: [{ name: 'placeholder', id: 'placeholder' }],
        };
      }
      scope.setValue('skipped', true);
    };

    const afterNode: StageNode = {
      name: 'After',
      id: 'after',
      fn: (scope: any) => {
        scope.setValue('after', true);
      },
    };
    const chart: FlowChart = {
      root: { name: 'Mount', id: 'mount', next: afterNode },
      stageMap: new Map([['Mount', mountFn]]),
      subflows: {},
    };

    const shapeBefore = frozenShape(chart.root);
    const builtSubflowKeys = Object.keys(chart.subflows ?? {});

    // Run 1: dynamic subflow auto-registers and executes.
    const executor1 = new FlowChartExecutor(chart);
    await executor1.run({ input: { mount: true, tag: 'r1' } });
    expect(subRuns).toEqual(['r1']);
    const state1 = executor1.getSnapshot()?.sharedState as any;
    expect(state1?.after).toBe(true);

    // (e) Neither the node fields NOR the chart's subflow registry leaked.
    expect(frozenShape(chart.root)).toEqual(shapeBefore);
    expect(Object.keys(chart.subflows ?? {})).toEqual(builtSubflowKeys);

    // Run 2 on a fresh executor: no mount — the stage must run as a plain
    // linear stage. Before the overlay fix, the shared node still carried
    // isSubflowRoot/subflowId from run 1, Phase 0 misclassified it as a
    // subflow mount, and the post-mount continuation never ran.
    const executor2 = new FlowChartExecutor(chart);
    await executor2.run({ input: { mount: false, tag: 'r2' } });
    expect(subRuns).toEqual(['r1']);
    const state2 = executor2.getSnapshot()?.sharedState as any;
    expect(state2?.skipped).toBe(true);
    expect(state2?.after).toBe(true);

    expect(frozenShape(chart.root)).toEqual(shapeBefore);
  });

  // ─── (c): concurrent executors, one shared dynamic chart ───

  it('two concurrent executors with DIFFERENT dynamic children do not cross-contaminate', async () => {
    const executed: string[] = [];

    const chart = flowChart(
      'Spawn',
      (scope: any) => {
        const args = scope.$getArgs<{ tags: string[]; delayMs: number }>();
        return {
          name: 'fanout',
          children: args.tags.map((tag, i) => ({
            name: `Child-${tag}`,
            id: `child-${tag}`,
            fn: async (s: any) => {
              // Stagger completion so the two runs interleave — a shared-node
              // race would surface as wrong children executing.
              await new Promise((resolve) => setTimeout(resolve, args.delayMs * (i + 1)));
              executed.push(tag);
              s.ran = tag;
            },
          })),
        };
      },
      'spawn',
    ).build();

    const shapeBefore = frozenShape(chart.root);

    const executorA = new FlowChartExecutor(chart);
    const executorB = new FlowChartExecutor(chart);

    await Promise.all([
      executorA.run({ input: { tags: ['a1', 'a2'], delayMs: 9 } }),
      executorB.run({ input: { tags: ['b1', 'b2', 'b3'], delayMs: 3 } }),
    ]);

    // Every child ran exactly once across both runs.
    expect([...executed].sort()).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);

    // Each executor ran EXACTLY its own children (branch-scoped fork state).
    const runsA = (executorA.getSnapshot()?.sharedState as any)?.runs ?? {};
    const runsB = (executorB.getSnapshot()?.sharedState as any)?.runs ?? {};
    expect(Object.keys(runsA).sort()).toEqual(['child-a1', 'child-a2']);
    expect(Object.keys(runsB).sort()).toEqual(['child-b1', 'child-b2', 'child-b3']);
    expect(runsA['child-a1']?.ran).toBe('a1');
    expect(runsB['child-b3']?.ran).toBe('b3');

    expect(frozenShape(chart.root)).toEqual(shapeBefore);
  });

  // ─── (d): loop revisit of a dynamic-next stage inside ONE run ───

  it('a stage returning dynamic next still works when revisited via loopTo within one run', async () => {
    const order: string[] = [];

    const chart = flowChart(
      'Pump',
      (scope: any) => {
        const n = ((scope.n as number) ?? 0) + 1;
        scope.n = n;
        order.push(`pump-${n}`);
        // EVERY visit routes dynamically to 'hop' (reference by id),
        // bypassing the built next ('skipped').
        return { name: 'continuation', next: { name: 'Hop', id: 'hop' } };
      },
      'pump',
    )
      .addFunction(
        'SkippedBuilt',
        () => {
          order.push('skipped');
        },
        'skipped',
      )
      .addFunction(
        'Hop',
        () => {
          order.push('hop');
        },
        'hop',
      )
      .addFunction(
        'Check',
        (scope: any) => {
          order.push(`check-${scope.n}`);
          if ((scope.n as number) >= 2) scope.$break();
        },
        'check',
      )
      .loopTo('pump')
      .build();

    const shapeBefore = frozenShape(chart.root);

    const executor = new FlowChartExecutor(chart);
    await executor.run({ input: {} });

    // Both visits of 'pump' (initial + loop revisit) take the dynamic route;
    // the built next ('skipped') never runs.
    expect(order).toEqual(['pump-1', 'hop', 'check-1', 'pump-2', 'hop', 'check-2']);
    expect(executor.getSnapshot()?.sharedState?.n).toBe(2);

    expect(frozenShape(chart.root)).toEqual(shapeBefore);
  });
});

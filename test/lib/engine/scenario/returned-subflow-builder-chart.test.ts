/**
 * A stage that RETURNS a sub-flowchart, on a chart made with the ordinary builder.
 *
 * The builder keeps a stage's function on its node. The mount was resolved from that node, so the
 * mount ran the node's own function as its root: the function returned the sub-flowchart again,
 * the next mount ran it again, and the process ran out of memory. The registered sub-flowchart
 * never ran. Only a hand-built chart whose functions live in a stage map worked (the shape
 * `dynamic-graph-isolation.test.ts` uses). The mount is now the definition the stage registered.
 */
import { describe, expect, it } from 'vitest';

import type { FlowChart, StageNode } from '../../../../src/advanced.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, unknown>;

function innerChart(runs: string[]) {
  return flowChart<S>(
    'Inner',
    (s) => {
      runs.push('inner');
      s.fromInner = 'done';
    },
    'inner',
  ).build();
}

const asMount = (chart: ReturnType<typeof innerChart>, extra: Record<string, unknown> = {}) => ({
  name: 'dyn',
  isSubflowRoot: true,
  subflowId: 'dyn-sf',
  subflowDef: { root: chart.root, stageMap: chart.stageMap, buildTimeStructure: chart.buildTimeStructure },
  ...extra,
});

describe('a stage that returns a sub-flowchart (builder chart)', () => {
  it('runs the sub-flowchart once, runs its own function once, and goes on to the next stage', async () => {
    const runs: string[] = [];
    const inner = innerChart(runs);
    const chart = flowChart<S>(
      'Mount',
      () => {
        runs.push('mount');
        return asMount(inner) as never;
      },
      'mount',
    )
      .addFunction(
        'After',
        () => {
          runs.push('after');
        },
        'after',
      )
      .build();

    await new FlowChartExecutor(chart).run();
    expect(runs).toEqual(['mount', 'inner', 'after']);
  });

  it('applies the output mapping the stage returned with it', async () => {
    const runs: string[] = [];
    const inner = innerChart(runs);
    const chart = flowChart<S>(
      'Mount',
      () =>
        asMount(inner, {
          subflowMountOptions: { outputMapper: (state: S) => ({ result: state.fromInner }) },
        }) as never,
      'mount',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(runs).toEqual(['inner']);
    expect((executor.getSnapshot().sharedState as S).result).toBe('done');
  });

  it('a second run of the same built chart mounts it again, once', async () => {
    const runs: string[] = [];
    const inner = innerChart(runs);
    const chart = flowChart<S>('Mount', () => asMount(inner) as never, 'mount').build();
    await new FlowChartExecutor(chart).run();
    await new FlowChartExecutor(chart).run();
    expect(runs).toEqual(['inner', 'inner']);
  });

  it('in a loop, a builder chart and a hand-built chart with a stage map both mount once per return', async () => {
    // Both shapes: Plan returns the sub-flowchart on pass 1; a decider loops back to Plan once.
    const trace = async (shape: 'builder' | 'stage-map') => {
      const runs: string[] = [];
      const inner = innerChart(runs);
      let pass = 0;
      const plan = () => {
        pass++;
        runs.push(`plan:${pass}`);
        return (pass === 1 ? asMount(inner) : undefined) as never;
      };
      const again = () => (pass < 2 ? 'loop' : 'stop');
      const nothing = () => {
        /* nothing */
      };
      let chart: FlowChart;
      if (shape === 'builder') {
        chart = flowChart<S>('Plan', plan, 'plan')
          .addDeciderFunction('Again', again, 'again')
          .addFunctionBranch('loop', 'Loop', nothing)
          .loopTo('plan')
          .addFunctionBranch('stop', 'Stop', nothing)
          .end()
          .build() as unknown as FlowChart;
      } else {
        const built = flowChart<S>('Plan', plan, 'plan')
          .addDeciderFunction('Again', again, 'again')
          .addFunctionBranch('loop', 'Loop', nothing)
          .loopTo('plan')
          .addFunctionBranch('stop', 'Stop', nothing)
          .end()
          .build() as unknown as FlowChart;
        // The same graph with Plan's function moved off its node into the stage map.
        const root: StageNode = { ...built.root, fn: undefined };
        chart = { ...built, root, stageMap: new Map([...built.stageMap, ['Plan', plan as never]]) };
      }
      await new FlowChartExecutor(chart as never).run();
      return runs;
    };
    // The mount is for the pass that returned it: on pass 2 Plan's function runs again and returns
    // nothing, so nothing is mounted. (The node used to stay a mount: the function never ran again,
    // `pass` stayed at 1 and the loop ran into the iteration limit.)
    expect(await trace('stage-map')).toEqual(['plan:1', 'inner', 'plan:2']);
    expect(await trace('builder')).toEqual(['plan:1', 'inner', 'plan:2']);
  });
});

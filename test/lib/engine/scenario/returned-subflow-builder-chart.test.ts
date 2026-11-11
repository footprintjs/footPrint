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

describe('one definition per sub-flowchart id in a run', () => {
  const named = (name: string, runs: string[]) =>
    flowChart<S>(
      name,
      () => {
        runs.push(name);
      },
      name.toLowerCase(),
    ).build();

  /** A loop of two passes whose Plan stage returns `pick(pass)`. */
  async function loop(runs: string[], pick: (pass: number) => unknown) {
    let pass = 0;
    const chart = flowChart<S>(
      'Plan',
      () => {
        pass += 1;
        runs.push(`plan:${pass}`);
        return pick(pass) as never;
      },
      'plan',
    )
      .addDeciderFunction('Again', () => (pass < 2 ? 'loop' : 'stop'), 'again')
      .addFunctionBranch('loop', 'Loop', () => {})
      .loopTo('plan')
      .addFunctionBranch('stop', 'Stop', () => {})
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    const errors: string[] = [];
    executor.attachFlowRecorder({
      id: 'errors',
      onError: (event: { stageName: string }) => errors.push(event.stageName),
    } as never);
    let rejected: unknown;
    try {
      await executor.run();
    } catch (error) {
      rejected = error;
    }
    return { rejected, errors, commits: executor.getSnapshot().commitLog.map((bundle) => bundle.runtimeStageId) };
  }

  it('a second definition under an id already used is refused, not swapped for the first in silence', async () => {
    const runs: string[] = [];
    const [first, second] = [named('A', runs), named('B', runs)];
    const { rejected, errors, commits } = await loop(runs, (pass) => asMount((pass === 1 ? first : second) as never));
    // The first definition ran on pass 1. On pass 2 the stage is refused: neither definition runs again.
    expect(runs).toEqual(['plan:1', 'A', 'plan:2']);
    expect((rejected as Error).message).toMatch(/sub-flowchart id 'dyn-sf' already names another definition/);
    // It fails as a stage fails: its bundle is committed and its error is reported under its name.
    expect(errors).toEqual(['Plan']);
    expect(commits.filter((id) => id.startsWith('plan#'))).toHaveLength(3);
  });

  it('each definition under its own id runs on its own pass', async () => {
    const runs: string[] = [];
    const [first, second] = [named('A', runs), named('B', runs)];
    const { rejected } = await loop(runs, (pass) =>
      asMount((pass === 1 ? first : second) as never, { subflowId: `dyn-${pass}` }),
    );
    expect(rejected).toBeUndefined();
    expect(runs).toEqual(['plan:1', 'A', 'plan:2', 'B']);
  });

  it('the same built chart returned again is the same definition', async () => {
    const runs: string[] = [];
    const only = named('A', runs);
    const { rejected } = await loop(runs, () => asMount(only as never));
    expect(rejected).toBeUndefined();
    expect(runs).toEqual(['plan:1', 'A', 'plan:2', 'A']);
  });

  it('a returned definition may not take the id of a mount the chart was built with', async () => {
    const runs: string[] = [];
    const [built, returned] = [named('Built', runs), named('Returned', runs)];
    const chart = flowChart<S>(
      'Plan',
      () => {
        runs.push('plan');
        return asMount(returned as never, { subflowId: 'shared' }) as never;
      },
      'plan',
    )
      .addSubFlowChartNext('shared', built, 'Built mount')
      .build();
    await expect(new FlowChartExecutor(chart).run()).rejects.toThrow(
      /sub-flowchart id 'shared' already names another definition/,
    );
    expect(runs).toEqual(['plan']);
  });
});

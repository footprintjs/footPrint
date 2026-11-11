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

describe('each return mounts the definition it handed back', () => {
  /** A one-stage chart that records its name when it runs. */
  const named = (name: string, runs: string[]) =>
    flowChart<S>(
      name,
      () => {
        runs.push(name);
      },
      name.toLowerCase(),
    ).build();

  async function settle(chart: unknown) {
    const executor = new FlowChartExecutor(chart as never);
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
    return { rejected, errors };
  }

  /** A loop of two passes whose Plan stage returns `pick(pass)`. */
  function loop(runs: string[], pick: (pass: number) => unknown) {
    let pass = 0;
    return flowChart<S>(
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
  }

  // The id registry keeps the FIRST definition registered under an id for the whole run. A mount
  // resolved from it ran pass 1's chart on every later pass, whatever the stage returned.
  it('a loop that returns another definition under the same id runs the new one', async () => {
    const runs: string[] = [];
    const { rejected, errors } = await settle(
      loop(runs, (pass) => asMount(named(pass === 1 ? 'A' : 'B', runs) as never)),
    );
    expect(rejected).toBeUndefined();
    expect(errors).toEqual([]);
    expect(runs).toEqual(['plan:1', 'A', 'plan:2', 'B']);
  });

  it('a stage that builds its sub-flowchart afresh on each pass runs it on each pass', async () => {
    const runs: string[] = [];
    const { rejected } = await settle(loop(runs, () => asMount(named('A', runs) as never)));
    expect(rejected).toBeUndefined();
    expect(runs).toEqual(['plan:1', 'A', 'plan:2', 'A']);
  });

  it('two stages that use one id each run their own definition', async () => {
    const runs: string[] = [];
    const chart = flowChart<S>(
      'First',
      () => {
        runs.push('first');
        return asMount(named('X', runs) as never) as never;
      },
      'first',
    )
      .addFunction(
        'Second',
        () => {
          runs.push('second');
          return asMount(named('Y', runs) as never) as never;
        },
        'second',
      )
      .build();
    const { rejected } = await settle(chart);
    expect(rejected).toBeUndefined();
    expect(runs).toEqual(['first', 'X', 'second', 'Y']);
  });

  it('parallel children that use one id each run their own definition, whichever registers first', async () => {
    const runs: string[] = [];
    const chart = flowChart<S>('Start', () => {}, 'start')
      .addListOfFunction([
        { id: 'c1', name: 'C1', fn: () => asMount(named('X', runs) as never) as never },
        { id: 'c2', name: 'C2', fn: () => asMount(named('Y', runs) as never) as never },
      ])
      .build();
    const { rejected, errors } = await settle(chart);
    expect(rejected).toBeUndefined();
    expect(errors).toEqual([]);
    expect([...runs].sort()).toEqual(['X', 'Y']);
  });

  it('a return under the id of a mount the chart was built with runs the returned definition', async () => {
    const runs: string[] = [];
    const built = named('Built', runs);
    const chart = flowChart<S>('Start', () => {}, 'start')
      .addSubFlowChartNext('shared', built, 'Built mount')
      .addFunction(
        'Plan',
        () => {
          runs.push('plan');
          return asMount(named('Returned', runs) as never, { subflowId: 'shared' }) as never;
        },
        'plan',
      )
      .build();
    const { rejected } = await settle(chart);
    expect(rejected).toBeUndefined();
    expect(runs).toEqual(['Built', 'plan', 'Returned']);
  });

  it("KNOWN GAP: two hand-built definitions that share a stage name run the first one's function", async () => {
    // A hand-built definition keeps its functions in its own stage map, by stage name. Those entries are
    // merged into the run's one stage map and the first entry under a name is kept, so the second
    // definition's stage finds the first definition's function. A definition made with the builder carries
    // its functions on its nodes and is not affected. Giving each definition its own stage names avoids it.
    const handBuilt = (label: string, runs: string[], stageName: string) => ({
      name: 'dyn',
      isSubflowRoot: true,
      subflowId: 'dyn-sf',
      subflowDef: {
        root: { name: stageName, id: stageName.toLowerCase() },
        stageMap: new Map([
          [
            stageName,
            () => {
              runs.push(label);
            },
          ],
        ]),
      },
    });
    const shared: string[] = [];
    await settle(loop(shared, (pass) => handBuilt(pass === 1 ? 'first' : 'second', shared, 'Work')));
    expect(shared).toEqual(['plan:1', 'first', 'plan:2', 'first']);

    const own: string[] = [];
    await settle(loop(own, (pass) => handBuilt(pass === 1 ? 'first' : 'second', own, pass === 1 ? 'WorkA' : 'WorkB')));
    expect(own).toEqual(['plan:1', 'first', 'plan:2', 'second']);
  });
});

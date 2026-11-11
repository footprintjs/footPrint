/**
 * What a stage function RETURNS at run time (a sub-flowchart to mount, children to fan out, a
 * selector for them) belongs to the visit that returned it.
 *
 * Two defects this pins, both on charts made with the ordinary builder:
 *
 *  1. A stage that returned a sub-flowchart was mounted with its OWN function as the mount's root,
 *     so the function ran again inside the mount, returned the sub-flowchart again, and so on until
 *     the process ran out of memory. The registered sub-flowchart never ran. (Only a hand-built
 *     chart whose functions live in a stage map worked, and that was the shape the tests used.)
 *  2. Children and a selector returned on one pass of a loop stayed for the rest of the run: a
 *     later pass that returned nothing still fanned out the earlier pass's children.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, unknown>;

function innerChart(runs: string[], name = 'inner') {
  return flowChart<S>(
    'Inner',
    (s) => {
      runs.push(name);
      s.fromInner = name;
    },
    name,
  ).build();
}

const asMount = (id: string, chart: ReturnType<typeof innerChart>, extra: Record<string, unknown> = {}) => ({
  name: id,
  isSubflowRoot: true,
  subflowId: id,
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
        return asMount('dyn-sf', inner) as never;
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

  it('hands the sub-flowchart its output mapping, so the parent state gets the result', async () => {
    const runs: string[] = [];
    const inner = innerChart(runs);
    const chart = flowChart<S>(
      'Mount',
      () =>
        asMount('dyn-sf', inner, {
          subflowMountOptions: { outputMapper: (state: S) => ({ result: state.fromInner }) },
        }) as never,
      'mount',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(runs).toEqual(['inner']);
    expect((executor.getSnapshot().sharedState as S).result).toBe('inner');
  });

  it('on a later pass of a loop the stage decides again: its function runs, the earlier mount does not', async () => {
    const runs: string[] = [];
    const inner = innerChart(runs);
    let pass = 0;
    const chart = flowChart<S>(
      'Seed',
      () => {
        /* nothing */
      },
      'seed',
    )
      .addFunction(
        'Plan',
        () => {
          pass++;
          runs.push(`plan:${pass}`);
          return (pass === 1 ? asMount('dyn-sf', inner) : undefined) as never;
        },
        'plan',
      )
      .addDeciderFunction('Again', () => (pass < 2 ? 'loop' : 'stop'), 'again')
      .addFunctionBranch('loop', 'Loop', () => {
        /* nothing */
      })
      .loopTo('plan')
      .addFunctionBranch('stop', 'Stop', () => {
        /* nothing */
      })
      .end()
      .build();

    await new FlowChartExecutor(chart).run();
    expect(runs).toEqual(['plan:1', 'inner', 'plan:2']);
  });

  it('a different sub-flowchart on each pass: each one runs on its own pass', async () => {
    const runs: string[] = [];
    const first = innerChart(runs, 'first');
    const second = innerChart(runs, 'second');
    let pass = 0;
    const chart = flowChart<S>(
      'Plan',
      () => {
        pass++;
        return (pass === 1 ? asMount('sf-first', first) : asMount('sf-second', second)) as never;
      },
      'plan',
    )
      .addDeciderFunction('Again', () => (pass < 2 ? 'loop' : 'stop'), 'again')
      .addFunctionBranch('loop', 'Loop', () => {
        /* nothing */
      })
      .loopTo('plan')
      .addFunctionBranch('stop', 'Stop', () => {
        /* nothing */
      })
      .end()
      .build();

    await new FlowChartExecutor(chart).run();
    expect(runs).toEqual(['first', 'second']);
  });
});

describe('children and a selector a stage returns belong to that pass', () => {
  const loopChart = (plan: (pass: number, childRuns: string[]) => unknown) => {
    const childRuns: string[] = [];
    let pass = 0;
    const chart = flowChart<S>(
      'Seed',
      () => {
        /* nothing */
      },
      'seed',
    )
      .addFunction(
        'Plan',
        () => {
          pass++;
          return plan(pass, childRuns) as never;
        },
        'plan',
      )
      .addDeciderFunction('Again', () => (pass < 3 ? 'loop' : 'stop'), 'again')
      .addFunctionBranch('loop', 'Loop', () => {
        /* nothing */
      })
      .loopTo('plan')
      .addFunctionBranch('stop', 'Stop', () => {
        /* nothing */
      })
      .end()
      .build();
    return { chart, childRuns, passes: () => pass };
  };

  const child = (id: string, pass: number, childRuns: string[]) => ({
    name: id,
    id,
    fn: () => {
      childRuns.push(`${id}@${pass}`);
    },
  });

  it('children returned on pass 1 do not run on a pass that returns nothing', async () => {
    const { chart, childRuns, passes } = loopChart((pass, runs) =>
      pass === 1 ? { name: 'fan', children: [child('tool', pass, runs)] } : undefined,
    );
    await new FlowChartExecutor(chart).run();
    expect(passes()).toBe(3);
    expect(childRuns).toEqual(['tool@1']);
  });

  it('each pass fans out the children it returned, and only those', async () => {
    const { chart, childRuns } = loopChart((pass, runs) =>
      pass === 2 ? undefined : { name: 'fan', children: [child(pass === 1 ? 'a' : 'c', pass, runs)] },
    );
    await new FlowChartExecutor(chart).run();
    expect(childRuns).toEqual(['a@1', 'c@3']);
  });

  it('a selector returned on pass 1 does not choose among the children of pass 2', async () => {
    const { chart, childRuns } = loopChart((pass, runs) => {
      if (pass === 1) {
        return {
          name: 'fan',
          children: [child('x', pass, runs), child('y', pass, runs)],
          nextNodeSelector: () => ['x'],
        };
      }
      if (pass === 2) return { name: 'fan', children: [child('x', pass, runs), child('y', pass, runs)] };
      return undefined;
    });
    await new FlowChartExecutor(chart).run();
    // Pass 1 selects x only. Pass 2 returns no selector, so both of ITS children run.
    expect(childRuns.slice(0, 1)).toEqual(['x@1']);
    expect(childRuns.slice(1).sort()).toEqual(['x@2', 'y@2']);
  });
});

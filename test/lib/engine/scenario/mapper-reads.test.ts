/**
 * A subflow mapper's reads are the mount's reads.
 *
 * A subflow's `inputMapper` and `outputMapper` were handed the parent's state object itself, so what
 * they read left no trace. The mount had no reads in the execution tree, its merge-back rows said
 * they read nothing, and a walk back from a value a subflow produced named the mount and stopped:
 * every stage before the mount was missing, with no warning.
 *
 * The mapper is now handed a record whose key reads go through the mount's tracked-read funnel
 * (`engine/handlers/mapperScope.ts`, `StageContext · readForMapper`).
 *
 * Test types: scenario (the walk back, on the real engine), unit (what the mapper is handed),
 * boundary (key listings, assignments, tracking settings), regression (values and final state as
 * before), security (a selected value the mapper read stays under its rule).
 */
import { keysReadFromExecutionTree, sliceForKey, sliceToJSON } from 'foottrace';
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';

type State = Record<string, any>;
type Mapper = (parent: State) => State;

const work = () =>
  flowChart<State>(
    'Work',
    (s) => {
      s.out = `worked(${s.input})`;
    },
    'work',
  ).build();

/** Seed writes a and unrelated; Prep writes b from a; the mount hands something to Work; Use reads result. */
function chartWith(
  inputMapper: Mapper,
  outputMapper: (out: State, parent: State) => State = (out) => ({ result: out.out }),
) {
  return flowChart<State>(
    'Seed',
    (s) => {
      s.a = 'A';
      s.unrelated = 'U';
    },
    'seed',
  )
    .addFunction(
      'Prep',
      (s) => {
        s.b = `${s.a}!`;
      },
      'prep',
    )
    .addSubFlowChartNext('sf', work(), 'Mount', { inputMapper, outputMapper })
    .addFunction(
      'Use',
      (s) => {
        s.final = `used(${s.result})`;
      },
      'use',
    )
    .build();
}
async function run(chart: ReturnType<typeof chartWith>, options: object = {}) {
  const executor = new FlowChartExecutor(chart, options as never);
  await executor.run();
  const snap = executor.getSnapshot();
  const reads = keysReadFromExecutionTree(snap.executionTree);
  const slice = sliceForKey(snap.commitLog, 'final', reads);
  const edges = sliceToJSON(slice).edges.map((edge) => `${edge.from} <- ${edge.to} via ${edge.key}`);
  return { executor, snap, reads, slice, edges };
}
const mountOf = (snap: { commitLog: readonly { runtimeStageId: string; trace: readonly any[] }[] }) =>
  snap.commitLog.find((bundle) => bundle.runtimeStageId.startsWith('sf#') && bundle.trace.length > 0)!;

describe('the walk back crosses a subflow mount', () => {
  it('from a value the subflow produced, back through the mount to the stages before it', async () => {
    const { snap, edges, slice } = await run(chartWith((s) => ({ input: s.b })));
    expect(snap.sharedState.final).toBe('used(worked(A!))');
    expect(edges).toEqual(['use#4 <- sf#2 via result', 'sf#2 <- prep#1 via b', 'prep#1 <- seed#0 via a']);
    expect(slice.notes).toBeUndefined();
  });

  it('with per-write provenance the merge-back row names what the mapper read', async () => {
    const { snap, edges } = await run(
      chartWith((s) => ({ input: s.b })),
      { writeProvenance: 'reads-prefix' },
    );
    expect(mountOf(snap).trace).toEqual([{ path: 'result', verb: 'set', readKeys: ['b'] }]);
    expect(edges).toEqual(['use#4 <- sf#2 via result', 'sf#2 <- prep#1 via b', 'prep#1 <- seed#0 via a']);
  });

  it("only the keys the mapper read are the mount's reads", async () => {
    const { reads } = await run(chartWith((s) => ({ input: s.b })));
    expect(reads.lookup('sf#2')).toEqual(['b']);
  });

  it('a mapper that spreads the parent read every key', async () => {
    const { reads, snap } = await run(chartWith((s) => ({ ...s, input: s.b })));
    expect([...reads.lookup('sf#2')].sort()).toEqual(['a', 'b', 'unrelated']);
    expect(snap.sharedState.final).toBe('used(worked(A!))');
  });

  it('what the outputMapper reads of the parent is a read of the mount too', async () => {
    const chart = chartWith(
      (s) => ({ input: s.b }),
      (out, parent) => ({ result: `${out.out}+${parent.unrelated}` }),
    );
    const { reads, snap, edges } = await run(chart, { writeProvenance: 'reads-prefix' });
    expect(snap.sharedState.final).toBe('used(worked(A!)+U)');
    expect(reads.lookup('sf#2')).toEqual(['b', 'unrelated']);
    expect(mountOf(snap).trace[0].readKeys).toEqual(['b', 'unrelated']);
    expect(edges).toContain('sf#2 <- seed#0 via unrelated');
  });

  it('a mount with no mapper reads nothing', async () => {
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.a = 1;
      },
      'seed',
    )
      .addSubFlowChartNext('sf', work(), 'Mount')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(keysReadFromExecutionTree(executor.getSnapshot().executionTree).lookup('sf#1')).toEqual([]);
  });
});

describe('what a mapper is handed', () => {
  /** Run a chart whose inputMapper is `probe`, and hand back what it returned through a closure. */
  async function handed<T>(probe: (parent: State) => T, options: object = {}) {
    let seen: T | undefined;
    const { snap, reads } = await run(
      chartWith((s) => {
        seen = probe(s);
        return { input: 'x' };
      }),
      options,
    );
    return { seen: seen as T, snap, reads: reads.lookup('sf#2') };
  }

  it('the same keys and values as the parent state', async () => {
    const { seen } = await handed((s) => ({
      keys: Object.keys(s),
      json: JSON.stringify(s),
      a: s.a,
      has: Object.hasOwn(s, 'b'),
    }));
    expect(seen).toEqual({
      keys: ['a', 'unrelated', 'b'],
      json: '{"a":"A","unrelated":"U","b":"A!"}',
      a: 'A',
      has: true,
    });
  });

  it('a key listing reads no value, so it records no read', async () => {
    const { reads } = await handed((s) => [
      Object.keys(s),
      Object.hasOwn(s, 'b'),
      Object.entries(Object.getOwnPropertyDescriptors(s)).length,
    ]);
    expect(reads).toEqual([]);
  });

  it('it can be spread, cloned and serialized', async () => {
    const { seen } = await handed((s) => [{ ...s }, structuredClone(s), JSON.parse(JSON.stringify(s))]);
    for (const copy of seen) expect(copy).toEqual({ a: 'A', unrelated: 'U', b: 'A!' });
  });

  it('an object value is the committed object itself, as before: no copy is made for the mapper', async () => {
    let seenByMapper: unknown;
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.profile = { name: 'Ada' };
      },
      'seed',
    )
      .addSubFlowChartNext('sf', work(), 'Mount', {
        inputMapper: (s: State) => {
          seenByMapper = s.profile;
          return { input: s.profile.name };
        },
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(seenByMapper).toEqual({ name: 'Ada' });
    expect(keysReadFromExecutionTree(executor.getSnapshot().executionTree).lookup('sf#1')).toEqual(['profile']);
  });

  it('an assignment lands on what the mapper was handed, never on the state behind it', async () => {
    const { seen, snap } = await handed((s) => {
      s.a = 'changed by the mapper';
      s.added = 1;
      return [s.a, s.added];
    });
    expect(seen).toEqual(['changed by the mapper', 1]);
    expect(snap.sharedState.a).toBe('A');
    expect(snap.sharedState).not.toHaveProperty('added');
  });

  it('a key named like an object method is data', async () => {
    let seenByMapper: unknown;
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.toString = 't';
        s.hasOwnProperty = 'h';
      },
      'seed',
    )
      .addSubFlowChartNext('sf', work(), 'Mount', {
        inputMapper: (s: State) => {
          seenByMapper = [s.toString, s.hasOwnProperty];
          return {};
        },
      })
      .build();
    await new FlowChartExecutor(chart).run();
    expect(seenByMapper).toEqual(['t', 'h']);
  });
});

describe("what the execution tree keeps of a mapper's read", () => {
  const big = () =>
    flowChart<State>(
      'Seed',
      (s) => {
        s.history = [{ role: 'user', content: 'hello' }];
      },
      'seed',
    )
      .addSubFlowChartNext('sf', work(), 'Mount', { inputMapper: (s: State) => ({ input: s.history.length }) })
      .build();
  const mountNode = (tree: any): any => {
    for (let node = tree; node; node = node.next) if (node.runtimeStageId?.startsWith('sf#')) return node;
    return undefined;
  };

  it('a summary of the value, never a copy, whatever the read-tracking setting keeps for a stage', async () => {
    for (const readTracking of ['full', 'summary'] as const) {
      const executor = new FlowChartExecutor(big(), { readTracking } as never);
      await executor.run();
      expect(mountNode(executor.getSnapshot().executionTree).stageReads, readTracking).toEqual({
        history: { __readSummary: true, type: 'array', size: 1 },
      });
    }
  });

  it("nothing with readTracking 'off', and the read is still on the write's provenance", async () => {
    const executor = new FlowChartExecutor(
      chartWith((s) => ({ input: s.b })),
      {
        readTracking: 'off',
        writeProvenance: 'reads-prefix',
      } as never,
    );
    await executor.run();
    const snap = executor.getSnapshot();
    expect(mountNode(snap.executionTree).stageReads).toBeUndefined();
    expect(mountOf(snap).trace[0].readKeys).toEqual(['b']);
  });
});

describe('a selected value a mapper read stays under its rule', () => {
  it('the tree keeps the placeholder for it, and the mapper still gets the value', async () => {
    let seenByMapper: unknown;
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.token = 'tok-SECRET';
        s.plain = 'p';
      },
      'seed',
    )
      .addSubFlowChartNext('sf', work(), 'Mount', {
        inputMapper: (s: State) => {
          seenByMapper = s.token;
          return { input: s.plain };
        },
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['token'] });
    await executor.run();
    const snap = executor.getSnapshot();
    expect(seenByMapper).toBe('tok-SECRET');
    expect(keysReadFromExecutionTree(snap.executionTree).lookup('sf#1')).toEqual(['token', 'plain']);
    expect(JSON.stringify(snap.executionTree)).not.toContain('tok-SECRET');
    expect(JSON.stringify(snap.commitLog)).not.toContain('tok-SECRET');
  });
});

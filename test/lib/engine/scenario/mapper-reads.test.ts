/**
 * A subflow mapper's reads are the mount's reads.
 *
 * A subflow's `inputMapper` and `outputMapper` were handed the parent's state object itself, so what
 * they read left no trace. The mount had no reads in the execution tree, its merge-back rows said
 * they read nothing, and a walk back from a value a subflow produced named the mount and stopped:
 * every stage before the mount was missing, with no warning.
 *
 * The mapper is now handed a view whose key reads go through the mount's tracked-read funnel
 * (`engine/handlers/mapperScope.ts`, `StageContext · readLiveRoot`), and the merge-back's own reads
 * of what it adds to go the same way.
 *
 * Test types: scenario (the walk back, on the real engine), unit (what the mapper is handed, what it
 * costs), boundary (key listings, assignments, a view kept too long, tracking settings), regression
 * (values and final state as before), security (a selected value the mapper read stays under its rule).
 */
import { inspect } from 'node:util';

import { keysReadFromExecutionTree, sliceForKey, sliceToJSON } from 'foottrace';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode } from '../../../../src';
import { flowChart } from '../../../../src/lib/builder';
import { mapperScope } from '../../../../src/lib/engine/handlers/mapperScope';
import { extractParentScopeValues } from '../../../../src/lib/engine/handlers/SubflowInputMapper';
import { RedactionRule } from '../../../../src/lib/memory/redaction';
import type { StageContext } from '../../../../src/lib/memory/StageContext';
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

  it('it can be spread, assigned from and serialized', async () => {
    const { seen } = await handed((s) => [{ ...s }, Object.assign({}, s), JSON.parse(JSON.stringify(s))]);
    for (const copy of seen) expect(copy).toEqual({ a: 'A', unrelated: 'U', b: 'A!' });
  });

  it('it cannot be cloned itself, like every handle of a scope; a spread copy can', async () => {
    const { seen } = await handed((s) => {
      try {
        structuredClone(s);
        return 'cloned';
      } catch (error) {
        return [(error as Error).name, structuredClone({ ...s })];
      }
    });
    expect(seen).toEqual(['DataCloneError', { a: 'A', unrelated: 'U', b: 'A!' }]);
  });

  it('a key the state does not hold reads undefined and records no read', async () => {
    const { seen, reads, snap } = await handed((s) => [s.nope, Reflect.has(s, 'nope'), s.then, s.toJSON], {
      writeProvenance: 'reads-prefix',
    });
    expect(seen).toEqual([undefined, false, undefined, undefined]);
    expect(reads).toEqual([]);
    expect(mountOf(snap).trace[0].readKeys).toEqual([]);
  });

  it('printing it shows the names of its keys, and reads nothing', async () => {
    const { seen, reads } = await handed((s) => inspect(s));
    expect(seen).toBe('[parent state, keys: a, unrelated, b. Read a key, or spread it, to see values.]');
    expect(reads).toEqual([]);
  });

  it('under a redaction policy a print shows no value and marks nothing', async () => {
    // Found by the second reader: the first print hook spread the view. Under a policy that printed the
    // selected value in clear, and counted as "the mapper read a secret", which masked an unrelated output.
    let printed = '';
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.token = 'TOK-SECRET';
        s.count = 3;
      },
      'seed',
    )
      .addSubFlowChartNext('sf', work(), 'Mount', {
        inputMapper: (s: State) => {
          printed = inspect(s);
          return { input: s.count + 1 };
        },
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['token'] });
    await executor.run();
    expect(printed).toBe('[parent state, keys: token, count. Read a key, or spread it, to see values.]');
    expect(executor.getRedactionReport().redactedKeys).toEqual(['token']);
  });

  it('a key the mapper adds is listed where an object would list it, and `__proto__` is no key', async () => {
    const { seen } = await handed((s) => {
      s['7'] = 'seven';
      s.added = 1;
      s.__proto__ = { inherited: true };
      return [Object.keys(s), Object.hasOwn({ ...s }, '__proto__'), s.inherited];
    });
    expect(seen).toEqual([['7', 'a', 'unrelated', 'b', 'added'], false, true]);
  });

  it('so is a getter that is not enumerable, or sits under a symbol', async () => {
    // Found by the second reader (round 3): the copy of the args made for the subflow asks for those keys
    // too, after the view has closed.
    const hidden = Symbol('hidden');
    const { snap, reads } = await run(
      chartWith((s) => {
        const input: State = { input: s.b };
        Object.defineProperty(input, 'unlisted', { get: () => s.a });
        Object.defineProperty(input, hidden, { get: () => s.unrelated, enumerable: true });
        return input;
      }),
    );
    expect(snap.sharedState.final).toBe('used(worked(A!))');
    expect([...reads.lookup('sf#2')].sort()).toEqual(['a', 'b', 'unrelated']);
  });

  it('a getter in what the inputMapper returns is taken as its value while the view is open', async () => {
    // Found by the second reader: left as a getter, it was asked after the view had closed, and threw.
    const { snap, reads } = await run(
      chartWith(
        (s) => ({
          get input() {
            return s.b;
          },
        }),
        (out) => ({ result: out.out }),
      ),
    );
    expect(snap.sharedState.final).toBe('used(worked(A!))');
    expect(reads.lookup('sf#2')).toEqual(['b']);
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
      return [s.a, s.added, Object.keys(s)];
    });
    expect(seen).toEqual(['changed by the mapper', 1, ['a', 'unrelated', 'b', 'added']]);
    expect(snap.sharedState.a).toBe('A');
    expect(snap.sharedState).not.toHaveProperty('added');
  });

  it('so do a deletion and a definition: before, both changed committed state with no record', async () => {
    const { seen, snap, reads } = await handed((s) => {
      delete s.a;
      Object.defineProperty(s, 'defined', { value: 1, enumerable: true });
      const after = [s.a, Reflect.has(s, 'a'), s.defined, Object.keys(s)];
      s.a = 'back';
      return [...after, s.a];
    });
    expect(seen).toEqual([undefined, false, 1, ['unrelated', 'b', 'defined'], 'back']);
    expect(snap.sharedState).toMatchObject({ a: 'A', unrelated: 'U', b: 'A!' });
    expect(snap.sharedState).not.toHaveProperty('defined');
    expect(reads).toEqual([]); // nothing of the parent's was read: every value above is the mapper's own
  });

  it("it cannot be frozen: its keys are the state's, which a frozen object could not follow", async () => {
    const { seen } = await handed((s) => {
      try {
        Object.freeze(s);
        return 'frozen';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(seen).toBe('TypeError');
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

describe('the view handed on whole is taken as a plain record of its keys', () => {
  // A proxy cannot be cloned, and the seed and the merge-back are. The view is one of the library's
  // handles (`reactive/handles.ts`): where a mapper's result enters the record it is swapped for a
  // plain record, every key of it read.
  const seenBySubflow = () => {
    const seen: { value?: unknown } = {};
    const sub = flowChart<State>(
      'Work',
      (s) => {
        seen.value = JSON.parse(JSON.stringify(s.$getValue ? s.$getValue() : s));
        s.out = 'done';
      },
      'work',
    ).build();
    return { seen, sub };
  };
  const seedThen = (sub: ReturnType<typeof work>, inputMapper: Mapper) =>
    flowChart<State>(
      'Seed',
      (s) => {
        s.a = 'A';
        s.b = { deep: 1 };
      },
      'seed',
    )
      .addSubFlowChartNext('sf', sub, 'Mount', { inputMapper, outputMapper: (out: State) => ({ result: out.out }) })
      .build();

  it.each([
    ['returned as it is', (s: State) => s, { a: 'A', b: { deep: 1 } }],
    ['as a value of the result', (s: State) => ({ parent: s }), { parent: { a: 'A', b: { deep: 1 } } }],
    ['inside a list in the result', (s: State) => ({ all: [s] }), { all: [{ a: 'A', b: { deep: 1 } }] }],
  ])('%s', async (_name, inputMapper, expected) => {
    // With and without a redaction policy: under one, the mapper is handed the policy's own view of the view.
    for (const policy of [undefined, { keys: ['nothing-here'] }, { keys: ['a'] }]) {
      const { seen, sub } = seenBySubflow();
      const executor = new FlowChartExecutor(seedThen(sub, inputMapper as Mapper));
      if (policy) executor.setRedactionPolicy(policy);
      await executor.run();
      const snap = executor.getSnapshot();
      expect(snap.sharedState.result, JSON.stringify(policy)).toBe('done');
      expect(seen.value).toMatchObject(expected);
      expect([...keysReadFromExecutionTree(snap.executionTree).lookup('sf#1')].sort()).toEqual(['a', 'b']);
    }
  });
});

describe('the view where the unwrapping does not look', () => {
  // Handles are found in plain objects and arrays only (`reactive/handles.ts`): walking every Map a run
  // records would cost what the Map holds, at every boundary. So this is a stated limit, and it is LOUD:
  // the run fails with a clone error, it never seeds or merges a proxy. A spread copy can go anywhere.
  class Box {
    constructor(readonly inner: unknown) {}
  }
  const quiet = { info() {}, log() {}, debug() {}, warn() {}, error() {} };
  const mounted = (inputMapper: Mapper) =>
    flowChart<State>(
      'Seed',
      (s) => {
        s.a = 'A';
      },
      'seed',
    )
      .addSubFlowChartNext('sf', work(), 'Mount', { inputMapper })
      .setLogger(quiet)
      .build();

  it.each([
    ['a Map', (s: State) => ({ input: new Map([['parent', s]]) })],
    ['a Set', (s: State) => ({ input: new Set([s]) })],
    ['a class instance', (s: State) => ({ input: new Box(s) })],
  ])('inside %s the run fails with a clone error', async (_name, inputMapper) => {
    const run = new FlowChartExecutor(mounted(inputMapper as Mapper)).run();
    await expect(run).rejects.toMatchObject({ name: 'DataCloneError' });
  });

  it('a spread copy of it can be put there', async () => {
    let seenBySubflow: unknown;
    const sub = flowChart<State>(
      'Work',
      (s) => {
        seenBySubflow = (s.$getValue('input') as Map<string, State>).get('parent');
      },
      'work',
    ).build();
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.a = 'A';
      },
      'seed',
    )
      .addSubFlowChartNext('sf', sub, 'Mount', {
        inputMapper: (s: State) => ({ input: new Map([['parent', { ...s }]]) }),
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(seenBySubflow).toEqual({ a: 'A' });
    expect(keysReadFromExecutionTree(executor.getSnapshot().executionTree).lookup('sf#1')).toEqual(['a']);
  });
});

describe('the view costs what the mapper reads, not what the state holds', () => {
  // The first cut defined one accessor per root key for every mapper call: a mount in a loop over a state
  // of 500 keys ran 9 times slower although its mapper read one key (the second reader measured it).
  const mount = () => {
    const state: Record<string, unknown> = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    const calls = { rootKeys: 0, hasRootKey: 0, readLiveRoot: 0 };
    const context = {
      stageName: 'Mount',
      rootKeys() {
        calls.rootKeys += 1;
        return Object.keys(state);
      },
      hasRootKey(key: unknown) {
        calls.hasRootKey += 1;
        return typeof key === 'string' && Object.hasOwn(state, key);
      },
      readLiveRoot(key: string) {
        calls.readLiveRoot += 1;
        return state[key];
      },
    };
    return { calls, view: mapperScope<Record<string, unknown>>(context as unknown as StageContext) };
  };

  it('opening it asks the state nothing, and one read asks for one key', () => {
    const { calls, view } = mount();
    expect(calls).toEqual({ rootKeys: 0, hasRootKey: 0, readLiveRoot: 0 });
    expect(view.scope.k7).toBe(7);
    expect(calls).toEqual({ rootKeys: 0, hasRootKey: 1, readLiveRoot: 1 });
  });

  it('only a key listing asks for the keys, and it reads no value', () => {
    const { calls, view } = mount();
    expect(Object.keys(view.scope)).toHaveLength(500);
    expect(calls.rootKeys).toBe(1);
    expect(calls.readLiveRoot).toBe(0);
  });

  it('under a redaction rule too: the rule learns the reads from the view, and wraps nothing', () => {
    // The rule used to watch a mapper through a second record with one accessor per key. Under a policy a
    // mount over 500 keys then paid for 500 accessors per mapper call, on main as well (measured: 92 ms
    // for 200 passes against 11 ms with no policy). The view reports its own reads now.
    const { calls, view } = mount();
    const rule = new RedactionRule({ keys: ['k7'] });
    const seed = extractParentScopeValues(view.scope, { inputMapper: (s) => ({ copy: s.k7, plain: s.k8 }) }, rule);
    expect(seed).toEqual({ copy: 7, plain: 8 });
    expect(calls).toEqual({ rootKeys: 0, hasRootKey: 2, readLiveRoot: 2 });
    // And the law held: the copy of the selected key is marked, the other key is not.
    expect(rule.verdictAt([], 'copy').kind).toBe('whole');
    expect(rule.verdictAt([], 'plain').kind).toBe('whole'); // computed after a selected read: the cautious half
    const cleanRule = new RedactionRule({ keys: ['nothing-here'] });
    const clean = mount();
    extractParentScopeValues(clean.view.scope, { inputMapper: (s) => ({ plain: s.k8 }) }, cleanRule);
    expect(cleanRule.verdictAt([], 'plain').kind).toBe('clear');
    expect(clean.calls).toEqual({ rootKeys: 0, hasRootKey: 1, readLiveRoot: 1 });
  });
});

describe('a view kept past its mapper', () => {
  it('refuses a later read, says why, and adds no read to the mount that has long committed', async () => {
    // Found by the second reader: the kept object handed a later stage live state with no tracked read
    // behind it, and wrote that read onto the mount's node after its commit.
    let kept: State | undefined;
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.a = 1;
      },
      'seed',
    )
      .addSubFlowChartNext('sf', work(), 'Mount', {
        inputMapper: (s: State) => {
          kept = s;
          return { input: s.a };
        },
      })
      .addFunction(
        'Later',
        (s) => {
          s.a = 2;
          try {
            s.seen = kept!.a;
          } catch (error) {
            s.refused = (error as Error).message;
          }
        },
        'later',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snap = executor.getSnapshot();
    expect(snap.sharedState).not.toHaveProperty('seen');
    expect(snap.sharedState.refused).toMatch(/Subflow mount "Mount".*read \('a'\) after the mapper returned/);
    const reads = keysReadFromExecutionTree(snap.executionTree);
    expect(reads.lookup('sf#1')).toEqual(['a']);
    // What the mount read stays what it read then: the value 1, not the 2 written after it.
    const node = (snap.executionTree as any).next;
    expect(node.stageReads).toEqual({ a: 1 });
    // Its names can still be listed, and printing it does not throw.
    expect(Object.keys(kept!)).toContain('a');
    expect(inspect(kept)).toContain('readable only while the mapper runs');
  });

  it("is refused under a redaction policy too, where the mapper is handed the policy's own view of it", async () => {
    let kept: State | undefined;
    const chart = flowChart<State>(
      'Seed',
      (s) => {
        s.a = 1;
        s.token = 'tok-SECRET';
      },
      'seed',
    )
      .addSubFlowChartNext('sf', work(), 'Mount', {
        inputMapper: (s: State) => {
          kept = s;
          return { input: s.a };
        },
      })
      .addFunction(
        'Later',
        (s) => {
          try {
            s.seen = kept!.token;
          } catch (error) {
            s.refused = (error as Error).message;
          }
        },
        'later',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['token'] });
    await executor.run();
    const snap = executor.getSnapshot();
    expect(snap.sharedState).not.toHaveProperty('seen');
    expect(snap.sharedState.refused).toMatch(/read \('token'\) after the mapper returned/);
    expect(keysReadFromExecutionTree(snap.executionTree).lookup('sf#1')).toEqual(['a']);
  });

  it('a getter in what the outputMapper returned still reads while the merge-back is written', async () => {
    const chart = chartWith(
      (s) => ({ input: s.b }),
      (out, parent) => ({
        result: {
          get late() {
            return `${out.out}+${parent.unrelated}`;
          },
        },
      }),
    );
    const { snap, reads } = await run(chart);
    expect(snap.sharedState.result).toEqual({ late: 'worked(A!)+U' });
    expect(reads.lookup('sf#2')).toContain('unrelated');
  });
});

describe('development mode', () => {
  afterEach(() => disableDevMode());

  it("warns of no in-place change for a key a mapper only read (the second reader's finding)", async () => {
    // The check compares the copy a read kept with the value in the frame's pinned view. The first cut
    // kept a marker for a mapper's read, so every key a mapper read looked changed: two false warnings
    // on the plainest mount. A mapper's read keeps the value now, and is skipped by name (next test).
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const chart = flowChart<State>(
        'Seed',
        (s) => {
          s.profile = { name: 'n' };
          s.name = 'x';
        },
        'seed',
      )
        .addSubFlowChartNext('sf', work(), 'Mount', {
          inputMapper: (s: State) => ({ input: s.profile, n: s.name }),
          outputMapper: (out: State, parent: State) => ({ result: [out.out, parent.name] }),
        })
        .build();
      await new FlowChartExecutor(chart).run();
      expect(warn.mock.calls.map((call) => String(call[0])).filter((text) => text.includes('IN PLACE'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('development mode, a mount beside a sibling', () => {
  afterEach(() => disableDevMode());

  it('warns of no in-place change when a sibling replaces a record the mapper read while the subflow ran', async () => {
    // A mapper reads committed state as it is at that moment, and its mount stays open for the whole run
    // of the subflow. The sibling's write is a rightful replacement, not an in-place edit by the mount:
    // the check has no pinned value to hold the mapper's copy against, so it leaves such a read alone.
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const slow = flowChart<State>(
        'Work',
        async (s) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          s.out = `worked(${s.input.name})`;
        },
        'work',
      ).build();
      const quick = flowChart<State>(
        'Quick',
        (s) => {
          s.z = 1;
        },
        'quick',
      ).build();
      const chart = flowChart<State>(
        'Seed',
        (s) => {
          s.profile = { name: 'seed' };
          s.box = { kept: true };
        },
        'seed',
      )
        .addSubFlowChart('mount', slow, 'Mount', {
          inputMapper: (s: State) => ({ input: s.profile, also: s.box }),
          // `box` is read by the inputMapper and merged into by the merge-back: read live, then written.
          outputMapper: (out: State) => ({ result: out.out, box: { from: 'mount' } }),
        } as never)
        .addSubFlowChart('sib', quick, 'Sib', {
          inputMapper: () => ({}),
          outputMapper: () => ({ profile: { name: 'sib', more: 1 }, box: { sib: true } }),
        } as never)
        .build();
      const executor = new FlowChartExecutor(chart);
      await executor.run();
      const state = executor.getSnapshot().sharedState as State;
      expect(state.result).toBe('worked(seed)');
      expect(state.profile).toEqual({ name: 'sib', more: 1 });
      expect(warn.mock.calls.map((call) => String(call[0])).filter((text) => text.includes('IN PLACE'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('development mode, a mapper that changes what it was handed', () => {
  afterEach(() => disableDevMode());

  /** The "IN PLACE" warnings of one run, in dev mode. */
  async function warningsOf(chart: ReturnType<typeof chartWith>, options: object = {}) {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const executor = new FlowChartExecutor(chart, options as never);
      await executor.run();
      const told = warn.mock.calls.map((call) => String(call[0])).filter((text) => text.includes('IN PLACE'));
      return { told, state: executor.getSnapshot().sharedState as State };
    } finally {
      warn.mockRestore();
    }
  }
  const seeded = (mount: object) =>
    flowChart<State>(
      'Seed',
      (s) => {
        s.profile = { name: 'ann', tags: ['a'] };
        s.list = [1];
      },
      'seed',
    )
      .addSubFlowChartNext('sf', work(), 'Mount', mount as never)
      .build();

  it('an inputMapper that edits a value in place is reported, by mount, key and path', async () => {
    // The edit lands on committed state itself, with no row: the parent's `profile.name` is 'changed'
    // after the run, and nothing in the record says who did it.
    const { told, state } = await warningsOf(
      seeded({
        inputMapper: (s: State) => {
          s.profile.name = 'changed';
          return { input: s.profile.name };
        },
      }),
    );
    expect(state.profile.name).toBe('changed');
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('Subflow mount "Mount": a mapper changed `profile.name` IN PLACE');
    expect(told[0]).toContain('A mapper only reads');
  });

  it('an outputMapper that edits the parent in place is reported too', async () => {
    const { told } = await warningsOf(
      seeded({
        inputMapper: () => ({ input: 'x' }),
        outputMapper: (out: State, parent: State) => {
          parent.list.push(2);
          return { result: out.out };
        },
      }),
    );
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('a mapper changed `list');
  });

  it('an edit is reported although the mapper read the key again after it', async () => {
    // A read is kept once for each object a key holds, so the copy of the first read stands and the
    // second read does not hide the edit.
    const { told } = await warningsOf(
      seeded({
        inputMapper: (s: State) => {
          s.profile.tags.push('b');
          return { input: s.profile.tags.length };
        },
      }),
    );
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('`profile.tags');
  });

  it.each([
    ['only reads', { inputMapper: (s: State) => ({ input: s.profile.name, n: s.list.length }) }],
    [
      'appends to a list it read (the merge-back writes; nothing is edited in place)',
      { inputMapper: (s: State) => ({ input: s.list.length }), outputMapper: () => ({ list: [2] }) },
    ],
    [
      'merges into an object it read',
      { inputMapper: (s: State) => ({ input: s.profile.name }), outputMapper: () => ({ profile: { more: true } }) },
    ],
    [
      'assigns to the view (that lands on the view, never on the state)',
      {
        inputMapper: (s: State) => {
          s.profile = { name: 'on the view only' };
          return { input: s.profile.name };
        },
      },
    ],
  ])('a mapper that %s is not reported', async (_name, mount) => {
    const { told, state } = await warningsOf(seeded(mount));
    expect(told).toEqual([]);
    expect(state.profile.name).toBe('ann');
  });

  it('a record with a selected field is not reported: what is kept of it is not the value', async () => {
    // Under a redaction rule the copy of such a read holds the placeholder where the field is. Held
    // against the live value it would always differ, and the report would name the selected field.
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const executor = new FlowChartExecutor(seeded({ inputMapper: (s: State) => ({ input: s.profile.name }) }));
      executor.setRedactionPolicy({ fields: { profile: ['name'] } });
      await executor.run();
      expect(warn.mock.calls.map((call) => String(call[0])).filter((text) => text.includes('IN PLACE'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('nothing is reported, and nothing is kept for the check, outside dev mode or without full reads', async () => {
    const editing = {
      inputMapper: (s: State) => {
        s.profile.name = 'changed';
        return { input: 1 };
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await new FlowChartExecutor(seeded(editing)).run();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect((await warningsOf(seeded(editing), { readTracking: 'summary' })).told).toEqual([]);
  });
});

describe('with read sources on, a mapper read is said to have no source of its own', () => {
  // The record's source-capturing read serves a frame's own view; a mapper reads live root state. So the
  // capture cannot give such a read a source, and it says so. Before, a run with a mapper read reported
  // "captured" although the mapper's reads were not in the capture at all.
  const sources = async (inputMapper: Mapper) => {
    const executor = new FlowChartExecutor(chartWith(inputMapper), { readSources: true } as never);
    await executor.run();
    const { status, limitations } = (executor.getSnapshot() as any).readSources;
    return { status, limitations };
  };

  it('a mount whose mappers read the parent: partial, with the reason', async () => {
    expect(await sources((s) => ({ input: s.b }))).toEqual({ status: 'partial', limitations: ['untracked-read'] });
  });

  it('a mount whose mappers read nothing of the parent: captured, as before', async () => {
    expect(await sources(() => ({ input: 'fixed' }))).toEqual({ status: 'captured', limitations: [] });
  });
});

describe("the merge-back reads what it adds to, and that is the mount's read too", () => {
  // A list the outputMapper returns is appended to the parent's list; a plain object is merged into the
  // parent's object field by field. Either way the new value is made of what was there, so the mount read
  // it. Read untracked, the walk back from such a value named the mount and lost every earlier writer.
  const merging = (outputMapper: (out: State) => State, options: object = {}) =>
    flowChart<State>(
      'Seed',
      (s) => {
        s.messages = ['m0'];
        s.box = { list: ['b0'], note: { a: 1 } };
      },
      'seed',
    )
      .addSubFlowChartNext('sf', work(), 'Mount', { inputMapper: () => ({ input: 'x' }), outputMapper, ...options })
      .addFunction(
        'Use',
        (s) => {
          s.final = JSON.stringify([s.messages, s.box]);
        },
        'use',
      )
      .build();

  it.each([
    ['a list at the root is appended to', (out: State) => ({ messages: [out.out] }), 'messages'],
    ['a list inside an object is appended to', (out: State) => ({ box: { list: [out.out] } }), 'box'],
    ['an object is merged into', () => ({ box: { note: { b: 2 } } }), 'box'],
    ['a field of an object is set', () => ({ box: { flag: true } }), 'box'],
  ])('%s: the walk back reaches the stage that wrote what was there', async (_name, outputMapper, key) => {
    for (const options of [{}, { writeProvenance: 'reads-prefix' }]) {
      const { edges, reads } = await run(merging(outputMapper as never) as never, options);
      expect(edges, JSON.stringify(options)).toContain(`sf#1 <- seed#0 via ${key}`);
      expect(reads.lookup('sf#1')).toContain(key);
    }
  });

  it.each([
    ['a list that replaces', (out: State) => ({ messages: [out.out] }), { arrayMerge: 'replace' }],
    ['a value that is not a list or a plain object', (out: State) => ({ messages: out.out }), {}],
    ['an empty object, which merges nothing', () => ({ box: {} }), {}],
    ['a key the parent does not hold yet', (out: State) => ({ fresh: [out.out] }), {}],
  ])('%s reads nothing of the parent', async (_name, outputMapper, options) => {
    const { reads } = await run(merging(outputMapper as never, options) as never);
    expect(reads.lookup('sf#1')).toEqual([]);
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

  it("what the run's read tracking keeps of any step's read: a copy by default, a marker under 'summary'", async () => {
    // The first cut kept a marker whatever the setting said. A record made under 'full' then held a
    // marker where that setting promises the value, and a consumer's own test caught it.
    const kept = async (options: object) => {
      const executor = new FlowChartExecutor(big(), options as never);
      await executor.run();
      const snap = executor.getSnapshot();
      return { reads: mountNode(snap.executionTree).stageReads, state: snap.sharedState as State };
    };
    for (const options of [{}, { readTracking: 'full' }]) {
      const { reads, state } = await kept(options);
      expect(reads, JSON.stringify(options)).toEqual({ history: [{ role: 'user', content: 'hello' }] });
      // A copy: the record never holds the committed object itself.
      expect(reads.history).not.toBe(state.history);
    }
    expect((await kept({ readTracking: 'summary' })).reads).toEqual({
      history: { __readSummary: true, type: 'array', size: 1 },
    });
  });

  it('one copy for a key a mapper reads many times (the read kept once holds for a mount too)', async () => {
    // A mount's read goes through the same retention as a stage's (`memory/keptReads.ts`): the same
    // object, read again, is not copied again. Counted, not timed: the copies must not grow with the reads.
    const copiesFor = async (reads: number) => {
      const chart = flowChart<State>(
        'Seed',
        (s) => {
          s.history = Array.from({ length: 30 }, (_, id) => ({ id }));
        },
        'seed',
      )
        .addSubFlowChartNext('sf', work(), 'Mount', {
          inputMapper: (s: State) => {
            let total = 0;
            for (let i = 0; i < reads; i++) total += s.history.length;
            return { input: total };
          },
        })
        .build();
      const real = globalThis.structuredClone;
      let copies = 0;
      const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementation(((value: unknown, options?: never) => {
        if (Array.isArray(value) && value.length === 30) copies += 1;
        return real(value, options);
      }) as typeof structuredClone);
      try {
        const executor = new FlowChartExecutor(chart);
        await executor.run();
        expect(mountNode(executor.getSnapshot().executionTree).stageReads.history).toHaveLength(30);
      } finally {
        spy.mockRestore();
      }
      return copies;
    };
    expect(await copiesFor(40)).toBe(await copiesFor(2));
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

  it('a selected object keeps its rule when the merge-back takes it apart', async () => {
    // Found by the second reader: the merge-back merges a plain object field by field and appends a list as
    // a new array, so the write funnel saw only the pieces, and the most common shape (a record of
    // credentials) stayed in clear in the commit log.
    const carried = async (secrets: unknown, outputOf: (held: unknown) => State, before: State = {}) => {
      let held: unknown;
      const chart = flowChart<State>(
        'Seed',
        (s) => {
          s.creds = secrets;
          Object.assign(s, before);
        },
        'seed',
      )
        .addSubFlowChartNext('sf', work(), 'Mount', {
          inputMapper: (s: State) => {
            held = s.creds;
            return { input: 1 };
          },
          outputMapper: () => outputOf(held),
        } as never)
        .build();
      const executor = new FlowChartExecutor(chart);
      executor.setRedactionPolicy({ keys: ['creds'] });
      await executor.run();
      const snap = executor.getSnapshot();
      return { log: JSON.stringify(snap.commitLog), tree: JSON.stringify(snap.executionTree), state: snap.sharedState };
    };
    // A record of credentials, written back under another name: merged field by field.
    const record = await carried({ user: 'u', pass: 'PASS-SECRET' }, (held) => ({ copy: held }));
    expect(record.log).not.toContain('PASS-SECRET');
    expect(record.tree).not.toContain('PASS-SECRET');
    expect(record.state.copy).toEqual({ user: 'u', pass: 'PASS-SECRET' }); // live state is the application's own
    // A selected list inside a new object: appended as a new array under `copy.list`.
    const inside = await carried(['LIST-SECRET'], (held) => ({ copy: { list: held } }));
    expect(inside.log).not.toContain('LIST-SECRET');
    // A selected list appended to a list the parent already holds.
    const appended = await carried(['LIST-SECRET'], (held) => ({ log: held }), { log: ['clear'] });
    expect(appended.log).not.toContain('LIST-SECRET');
    expect(appended.state.log).toEqual(['clear', 'LIST-SECRET']);
  });

  it('a record with a selected FIELD, carried the same way, keeps that field hidden and the rest readable', async () => {
    // Under a rule a mapper is handed a view of such a record, not the record. The mount knows the record it
    // read; it has to know the view as the same thing, or the copy leaves with the field in clear (it did).
    const carried = async (outputOf: (held: unknown) => State) => {
      let held: unknown;
      const chart = flowChart<State>(
        'Seed',
        (s) => {
          s.profile = { name: 'ann', ssn: 'SSN-SECRET' };
        },
        'seed',
      )
        .addSubFlowChartNext('sf', work(), 'Mount', {
          inputMapper: (s: State) => {
            held = s.profile;
            return { input: 1 };
          },
          outputMapper: () => outputOf(held),
        } as never)
        .build();
      const executor = new FlowChartExecutor(chart);
      executor.setRedactionPolicy({ fields: { profile: ['ssn'] } });
      await executor.run();
      const snap = executor.getSnapshot();
      const mount = snap.commitLog.find((bundle) => bundle.runtimeStageId.startsWith('sf#') && bundle.trace.length > 0);
      return { log: JSON.stringify(snap.commitLog), wrote: mount!.overwrite };
    };
    const whole = await carried((held) => ({ copy: held }));
    expect(whole.log).not.toContain('SSN-SECRET');
    expect(whole.wrote).toEqual({ copy: { name: 'ann', ssn: 'REDACTED' } });
    const field = await carried((held) => ({ copy: { inner: held } }));
    expect(field.log).not.toContain('SSN-SECRET');
    expect(field.wrote).toEqual({ copy: { inner: { name: 'ann', ssn: 'REDACTED' } } });
    // KNOWN LIMIT, the same as for a stage (`s.copy = [s.profile]`): a NEW list or object built around a
    // selected object is selected by its own name only. Identity is followed for the object that is
    // written, not for what a new container holds.
    const inList = await carried((held) => ({ copy: [held] }));
    expect(inList.log).toContain('SSN-SECRET');
  });

  it('a selected value carried from one mapper to the other by a closure keeps its rule on the way back', async () => {
    // Before, the mount's frame did not know what its mappers had read. The inputMapper read `secrets`, the
    // outputMapper wrote the same list back as `copy`, and `copy` was kept in clear in the commit log. Each
    // mapper call has its own redaction view, so neither saw the whole copy; the mount's frame now does, as
    // a stage's frame does for a value read under one name and written under another.
    for (const secrets of [['s-1', 's-2'], new Map([['k', 's-1']])]) {
      let held: unknown;
      const chart = flowChart<State>(
        'Seed',
        (s) => {
          s.secrets = secrets;
        },
        'seed',
      )
        .addSubFlowChartNext('sf', work(), 'Mount', {
          inputMapper: (s: State) => {
            held = s.secrets;
            return { input: 1 };
          },
          outputMapper: () => ({ copy: held }),
          arrayMerge: 'replace',
        } as never)
        .build();
      const executor = new FlowChartExecutor(chart);
      executor.setRedactionPolicy({ keys: ['secrets'] });
      await executor.run();
      const snap = executor.getSnapshot();
      const text = (value: unknown) => JSON.stringify(value, (_key, each) => (each instanceof Map ? [...each] : each));
      expect(executor.getRedactionReport().redactedKeys).toContain('copy');
      expect(text(snap.commitLog)).not.toContain('s-1');
      expect(text(snap.executionTree)).not.toContain('s-1');
      // The live value is the application's own and stays as it is.
      expect(text(snap.sharedState.copy)).toContain('s-1');
    }
  });
});

/**
 * 9.20.0 — a subflow's SERVED state is its own redacted mirror.
 *
 * The 9.19.0 law says a policy covers everything retained or served, and
 * named one limit: `subflowResults[*].treeContext.globalContext` (and its
 * `#n` twin) was the subflow's RAW heap even under `getSnapshot({ redact:
 * true })`, because only the run-level runtime kept a mirror while
 * `SubflowExecutor` built each nested runtime bare. agentfootprint had to
 * refold every subflow's state from its scrubbed history to serve it.
 *
 * Closed at the root, one owner: `SubflowExecutor` enables the mirror on the
 * nested runtime the way the root does (`ExecutionRuntime.enableRedactedMirror`,
 * inherited like the dials), remembers it beside the raw result, and
 * `FlowChartExecutor.getSnapshot({ redact: true })` serves it — the plain
 * snapshot, the checkpoint and the live heap are untouched. Each `describe`
 * pins one clause of that.
 */

import type { CommitValuesMode, FlowRecorder, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { stateAt } from '../../../../src/trace.js';

const memoryAllocations = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../../src/lib/memory/SharedMemory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/memory/SharedMemory.js')>();
  class CountingSharedMemory extends actual.SharedMemory {
    constructor(...args: ConstructorParameters<typeof actual.SharedMemory>) {
      super(...args);
      memoryAllocations.count += 1;
    }
  }
  return { ...actual, SharedMemory: CountingSharedMemory };
});

const SECRET = 'sk-live-SUPER-SECRET-BYTES';
const TOKEN = 'tok-SUPER-SECRET-FIELD';
const POLICY = { keys: ['apiKey'], fields: { profile: ['auth.token'] } };
const ENCODINGS: CommitValuesMode[] = ['full', 'delta'];

const bytes = (v: unknown) => JSON.stringify(v);

interface Profile {
  name: string;
  auth: { token: string };
}
interface Deep {
  apiKey: string;
  profile: Profile;
  deepSeen?: number;
}
interface Inner {
  apiKey: string;
  profile: Profile;
  seen?: number;
  deepSeen?: number;
}
interface Outer {
  apiKey: string;
  profile: Profile;
  seen?: number;
  deepSeen?: number;
}

type ServedEntry = {
  subflowId: string;
  treeContext: { globalContext: Record<string, unknown>; history: unknown[]; initialState?: Record<string, unknown> };
};
type Served = Record<string, ServedEntry>;

const pathKeys = (served: Served) => Object.keys(served).filter((k) => !k.includes('#'));
const mountKeys = (served: Served) => Object.keys(served).filter((k) => k.includes('#'));

/** Outer → `sf` (Inner) → `sf/sf-deep` (Deep): a policy key and a `fields` policy cross both mounts. */
function buildTwoDeep() {
  const deep = flowChart<Deep>(
    'DeepStage',
    (scope: TypedScope<Deep>) => {
      expect(scope.apiKey).toBe(SECRET); // the subflow computes on the REAL seed
      scope.deepSeen = scope.apiKey.length;
    },
    'deep-stage',
  ).build();

  const inner = flowChart<Inner>(
    'InnerStage',
    (scope: TypedScope<Inner>) => {
      scope.seen = scope.profile.auth.token.length;
    },
    'inner-stage',
  )
    .addSubFlowChartNext('sf-deep', deep, 'DeepMount', {
      inputMapper: (p: Inner) => ({ apiKey: p.apiKey, profile: p.profile }),
      outputMapper: (out: Deep) => ({ deepSeen: out.deepSeen }),
    })
    .build();

  return flowChart<Outer>(
    'Start',
    (scope: TypedScope<Outer>) => {
      scope.apiKey = SECRET;
      scope.profile = { name: 'Ada', auth: { token: TOKEN } };
    },
    'start',
  )
    .addSubFlowChartNext('sf', inner, 'Sub', {
      inputMapper: (p: Outer) => ({ apiKey: p.apiKey, profile: p.profile }),
      outputMapper: (out: Inner) => ({ seen: out.seen, deepSeen: out.deepSeen }),
    })
    .build();
}

async function runTwoDeep(commitValues: CommitValuesMode, policy: boolean) {
  const executor = new FlowChartExecutor(buildTwoDeep(), { commitValues });
  if (policy) executor.setRedactionPolicy(POLICY);
  await executor.run();
  return executor;
}

function expectScrubbed(state: Record<string, unknown>) {
  expect(state.apiKey).toBe('REDACTED');
  expect((state.profile as Profile).auth.token).toBe('REDACTED');
  expect((state.profile as Profile).name).toBe('Ada');
}

// ── Clause 1 · the served subflow state is the placeholder; the raw surfaces are untouched ──

describe('served — getSnapshot({ redact: true }).subflowResults holds the mirror, one and two mounts deep', () => {
  it.each(ENCODINGS)('[%s] every entry, by path key AND by `#n` twin, is scrubbed', async (encoding) => {
    const executor = await runTwoDeep(encoding, true);
    const served = executor.getSnapshot({ redact: true }).subflowResults as Served;

    expect(pathKeys(served)).toEqual(['sf/sf-deep', 'sf']);
    expect(mountKeys(served)).toHaveLength(2);
    for (const entry of Object.values(served)) expectScrubbed(entry.treeContext.globalContext);
    expect(bytes(served)).not.toContain(SECRET);
    expect(bytes(served)).not.toContain(TOKEN);
    // The subflows still computed on the real values.
    expect((executor.getSnapshot().sharedState as Outer).deepSeen).toBe(SECRET.length);
    expect((executor.getSnapshot().sharedState as Outer).seen).toBe(TOKEN.length);
  });

  it.each(ENCODINGS)('[%s] the dual keys stay ONE object on the served surface', async (encoding) => {
    const executor = await runTwoDeep(encoding, true);
    const served = executor.getSnapshot({ redact: true }).subflowResults as Served;
    for (const key of mountKeys(served)) {
      expect(served[served[key].subflowId]).toBe(served[key]);
    }
  });

  it.each(ENCODINGS)('[%s] the plain snapshot still serves the live subflow heap — real values', async (encoding) => {
    const executor = await runTwoDeep(encoding, true);
    const plain = executor.getSnapshot().subflowResults as Served;
    for (const entry of Object.values(plain)) {
      expect(entry.treeContext.globalContext.apiKey).toBe(SECRET);
      expect((entry.treeContext.globalContext.profile as Profile).auth.token).toBe(TOKEN);
    }
    // ...and it is the traverser's own record, not a rebuilt one.
    expect((executor.getSnapshot().subflowResults as Served).sf).toBe(plain.sf);
    // The served twin is a different object with the same history and tree.
    const served = executor.getSnapshot({ redact: true }).subflowResults as Served;
    expect(served.sf).not.toBe(plain.sf);
    expect(served.sf.treeContext.history).toBe(plain.sf.treeContext.history);
    expect(served.sf.treeContext.initialState).toBe(plain.sf.treeContext.initialState);
  });
});

// ── Clause 2 · consistency: the nested mirror IS the fold of the subflow's scrubbed history ──

describe('consistency — the nested mirror equals stateAt over the subflow’s scrubbed history at its last stop', () => {
  it.each(ENCODINGS)('[%s] for every subflow entry; the run-level mirror is unchanged', async (encoding) => {
    const executor = await runTwoDeep(encoding, true);
    const snapshot = executor.getSnapshot({ redact: true });
    const served = snapshot.subflowResults as Served;
    for (const entry of Object.values(served)) {
      const { history, initialState } = entry.treeContext;
      const fold = stateAt({ history, initialState }, history.length - 1);
      expect(fold.basis).toBe('initial+log');
      expect(fold.redacted).toBe(true);
      expect(entry.treeContext.globalContext).toEqual(fold.state);
    }
    // The run level folds to its mirror exactly as it did in 9.19.0.
    const plain = executor.getSnapshot();
    expect(snapshot.sharedState).toEqual(stateAt(plain, plain.commitLog.length - 1).state);
  });
});

// ── Clause 3 · the checkpoint carries real values; a resumed subflow serves the mirror ──

describe('resume — the checkpoint’s subflowStates are real; the re-seeded subflow is served scrubbed', () => {
  function buildPausing() {
    const inner = flowChart<Inner>(
      'Prep',
      (scope: TypedScope<Inner>) => {
        expect(scope.apiKey).toBe(SECRET);
      },
      'prep',
    )
      .addPausableFunction(
        'Gate',
        {
          execute: async () => ({ question: 'go?' }),
          resume: async (scope: TypedScope<Inner>) => {
            scope.seen = scope.apiKey === SECRET ? 1 : 0;
          },
        },
        'gate',
      )
      .build();
    return flowChart<Outer>(
      'Start',
      (scope: TypedScope<Outer>) => {
        scope.apiKey = SECRET;
        scope.profile = { name: 'Ada', auth: { token: TOKEN } };
      },
      'start',
    )
      .addSubFlowChartNext('sf', inner, 'Sub', {
        inputMapper: (p: Outer) => ({ apiKey: p.apiKey, profile: p.profile }),
        outputMapper: (out: Inner) => ({ seen: out.seen }),
      })
      .build();
  }

  it.each(ENCODINGS)(
    '[%s] checkpoint real; resumed subflowResults scrubbed and equal to the fold',
    async (encoding) => {
      const executor = new FlowChartExecutor(buildPausing(), { commitValues: encoding });
      executor.setRedactionPolicy(POLICY);
      await executor.run();
      const checkpoint = executor.getCheckpoint()!;
      expect(bytes(checkpoint.subflowStates)).toContain(SECRET);
      expect(bytes(checkpoint.subflowStates)).toContain(TOKEN);

      const fresh = new FlowChartExecutor(buildPausing(), { commitValues: encoding });
      fresh.setRedactionPolicy(POLICY);
      await fresh.resume(JSON.parse(JSON.stringify(checkpoint)), { approved: true });
      expect((fresh.getSnapshot().sharedState as Outer).seen).toBe(1);

      const served = fresh.getSnapshot({ redact: true }).subflowResults as Served;
      expect(pathKeys(served)).toEqual(['sf']);
      for (const entry of Object.values(served)) {
        expectScrubbed(entry.treeContext.globalContext);
        const { history, initialState } = entry.treeContext;
        expect(entry.treeContext.globalContext).toEqual(stateAt({ history, initialState }, history.length - 1).state);
      }
      expect(bytes(served)).not.toContain(SECRET);
      // The resumed subflow's live heap holds the real re-seeded values.
      const plain = fresh.getSnapshot().subflowResults as Served;
      expect(plain.sf.treeContext.globalContext.apiKey).toBe(SECRET);
    },
  );
});

// ── Clause 4 · a looping subflow: every iteration's `#n` entry is served scrubbed ──

describe('loop — each iteration’s `#n` entry is scrubbed; the path key is the last iteration', () => {
  interface Loose {
    apiKey: string;
    i: number;
    iNext?: number;
  }
  function buildLooping() {
    const body = flowChart<Loose>(
      'BodyStage',
      (scope: TypedScope<Loose>) => {
        scope.iNext = scope.i + 1;
      },
      'body-stage',
    ).build();
    return flowChart<Loose>(
      'Seed',
      (scope: TypedScope<Loose>) => {
        scope.apiKey = SECRET;
        scope.i = 0;
      },
      'seed',
    )
      .addSubFlowChartNext('sf-body', body, 'BodyMount', {
        inputMapper: (s: Loose) => ({ apiKey: s.apiKey, i: s.i }),
        outputMapper: (out: Loose) => ({ i: out.iNext }),
      })
      .addDeciderFunction('Check', async (scope: TypedScope<Loose>) => (scope.i < 2 ? 'again' : 'done'), 'check')
      .addFunctionBranch('again', 'Again', async () => undefined, undefined, { loopTo: 'sf-body' })
      .addFunctionBranch('done', 'Done', async () => undefined)
      .setDefault('done')
      .end()
      .build();
  }

  it('two iterations → two `#n` entries, each scrubbed, distinct; path key === the last', async () => {
    const executor = new FlowChartExecutor(buildLooping());
    executor.setRedactionPolicy({ keys: ['apiKey'] });
    await executor.run();
    const served = executor.getSnapshot({ redact: true }).subflowResults as Served;
    const mounts = mountKeys(served);
    expect(mounts).toHaveLength(2);
    expect(served[mounts[0]]).not.toBe(served[mounts[1]]);
    expect(served[mounts[0]].treeContext.globalContext.i).toBe(0);
    expect(served[mounts[1]].treeContext.globalContext.i).toBe(1);
    for (const key of mounts) expect(served[key].treeContext.globalContext.apiKey).toBe('REDACTED');
    expect(served['sf-body']).toBe(served[mounts[1]]);
    expect(bytes(served)).not.toContain(SECRET);
  });
});

// ── Clause 5 · the exit event: recorders receive the served form, never the raw heap ──

describe('onSubflowExit.outputState — the recorder sees the mirror, the same view subflowResults serves', () => {
  function collectExits(executor: FlowChartExecutor<unknown, unknown>) {
    const exits: Array<Record<string, unknown> | undefined> = [];
    const recorder: FlowRecorder = {
      id: 'exit-spy',
      onSubflowExit: (event) => {
        exits.push(event.outputState);
      },
    };
    executor.attachFlowRecorder(recorder);
    return exits;
  }

  it('with a policy: every exit carries the placeholder, byte-free of the secret', async () => {
    const executor = new FlowChartExecutor(buildTwoDeep());
    executor.setRedactionPolicy(POLICY);
    const exits = collectExits(executor);
    await executor.run();
    expect(exits).toHaveLength(2);
    for (const state of exits) expectScrubbed(state!);
    expect(bytes(exits)).not.toContain(SECRET);
    expect(bytes(exits)).not.toContain(TOKEN);
  });

  it('without a policy: the exit carries the subflow’s own final state, the same object the snapshot serves', async () => {
    const executor = new FlowChartExecutor(buildTwoDeep());
    const exits = collectExits(executor);
    await executor.run();
    const plain = executor.getSnapshot().subflowResults as Served;
    expect(exits).toHaveLength(2);
    expect(exits[0]).toBe(plain['sf/sf-deep'].treeContext.globalContext);
    expect(exits[1]).toBe(plain.sf.treeContext.globalContext);
  });
});

// ── Clause 6 · no policy, no mirror, no rebuild — the served objects are the plain ones ──

describe('no policy — the served view is the plain view, object for object, and allocates no mirror', () => {
  it.each(ENCODINGS)('[%s] redact: true serves the traverser’s own records', async (encoding) => {
    const executor = await runTwoDeep(encoding, false);
    const plain = executor.getSnapshot().subflowResults as Served;
    const served = executor.getSnapshot({ redact: true }).subflowResults as Served;
    expect(Object.keys(served)).toEqual(Object.keys(plain));
    for (const key of Object.keys(plain)) expect(served[key]).toBe(plain[key]);
    expect(bytes(served)).toContain(SECRET);
  });

  it('one SharedMemory per runtime without a policy; exactly one more per runtime with one', async () => {
    // A run builds three runtimes: the root, `sf`, `sf/sf-deep`. (The executor's
    // constructor builds a first traverser of its own — one runtime, no mirror —
    // so construction is measured apart from the run.)
    const measure = async (policy: boolean) => {
      memoryAllocations.count = 0;
      const executor = new FlowChartExecutor(buildTwoDeep());
      if (policy) executor.setRedactionPolicy(POLICY);
      const atConstruction = memoryAllocations.count;
      await executor.run();
      return { atConstruction, perRun: memoryAllocations.count - atConstruction };
    };
    expect(await measure(false)).toEqual({ atConstruction: 1, perRun: 3 });
    expect(await measure(true)).toEqual({ atConstruction: 1, perRun: 6 });
  });
});

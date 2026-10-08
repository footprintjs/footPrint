/**
 * The flowchart scenarios whose record bytes are pinned (one line each in
 * ../README.md). Each is a small chart aimed at one record-shaping path;
 * each returns its pins — what `getSnapshot()` serves (commit log, fold base,
 * state, execution tree, subflow results, dials), plus the checkpoint and the
 * resumed run's snapshot when it pauses, the redacted view under a policy, and
 * how a failed run failed.
 *
 * The first nine are the charts of `scripts/byte-identity-probe.ts`, promoted
 * here (the script is gone): now stored and checked on every run. The probe's
 * narrative and resume return value are not record bytes and are not pinned.
 * A stage body returns nothing — a returned value is the stage's output.
 */
import { ScopeFacade } from '../../../src/advanced.js';
import type {
  FlowChart,
  FlowChartExecutorOptions,
  PausableHandler,
  RedactionPolicy,
  ScopeFactory,
} from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';

type S = Record<string, any>;
type Pins = Record<string, unknown>;

/** Run once; pin what the executor serves (and the redacted view under a policy), and how a failed run failed. */
async function served(
  chart: FlowChart<any, any>,
  options?: FlowChartExecutorOptions,
  policy?: RedactionPolicy,
): Promise<Pins> {
  const ex = new FlowChartExecutor(chart, options);
  if (policy) ex.setRedactionPolicy(policy);
  const failed = await ex.run().then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
  );
  return {
    ...(failed !== undefined && { failed }),
    snapshot: ex.getSnapshot(),
    ...(policy && { redacted: ex.getSnapshot({ redact: true }) }),
  };
}

/** Run to the pause, then resume — on the same executor, or on a new one from the stored checkpoint. */
async function pausedThenResumed(chart: FlowChart<any, any>, answer: unknown, on: 'same' | 'stored'): Promise<Pins> {
  const ex = new FlowChartExecutor(chart);
  await ex.run();
  const checkpoint = ex.getCheckpoint()!;
  const paused = structuredClone(ex.getSnapshot());
  const resumer = on === 'same' ? ex : new FlowChartExecutor(chart);
  await resumer.resume(on === 'same' ? checkpoint : JSON.parse(JSON.stringify(checkpoint)), answer);
  return { paused, checkpoint, resumed: resumer.getSnapshot() };
}

/** The same chart under several dial settings, each pinned under its name. */
async function variants(
  chart: () => FlowChart<any, any>,
  dials: Record<string, FlowChartExecutorOptions>,
  policy?: RedactionPolicy,
): Promise<Pins> {
  const pins: Pins = {};
  for (const [name, options] of Object.entries(dials)) pins[name] = await served(chart(), options, policy);
  return pins;
}

const ENCODINGS: Record<string, FlowChartExecutorOptions> = {
  full: { commitValues: 'full' },
  delta: { commitValues: 'delta' },
};

/** The retention dials (`readTracking` / `writeTracking`) — what a run retains, never what it records. */
const RETENTION: Record<string, FlowChartExecutorOptions> = {
  full: {},
  summary: { readTracking: 'summary', writeTracking: 'summary' },
  off: { readTracking: 'off', writeTracking: 'off' },
};

const withEach = (dials: Record<string, FlowChartExecutorOptions>, base: FlowChartExecutorOptions) =>
  Object.fromEntries(Object.entries(dials).map(([name, options]) => [name, { ...base, ...options }]));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plain `ScopeFacade` stages — for the facade's own doors (`setGlobal`, the path-aware `*At`). */
const facades: ScopeFactory = (ctx, name, readOnly, env) => new ScopeFacade(ctx, name, readOnly, env);

// ─── The probe, promoted ─────────────────────────────────────────────────────

function forkChart(failing: 'none' | 'error' | 'throttled') {
  const [second, value] =
    failing === 'throttled' ? ['throttled-child', '429 rate limited'] : ['child-b', 'child-b boom'];
  return flowChart<S>('Seed', (s) => s.$setValue('k', 'orig'), 'seed')
    .addListOfFunction([
      { id: 'child-a', name: 'ChildA', fn: (s: S) => s.$setValue('a', 1) },
      {
        id: second,
        name: second === 'child-b' ? 'ChildB' : 'ThrottledChild',
        fn: (s: S) => {
          if (failing !== 'throttled') s.$setValue('b', 2);
          if (failing !== 'none') throw new Error(value);
        },
      },
    ])
    .addFunction('Join', (s) => s.$setValue('joined', true), 'join')
    .build();
}

function pausableChart(corner: boolean) {
  const handler: PausableHandler<S> = {
    execute: async () => ({ question: 'approve?' }),
    resume: async (s, input) => {
      const seen = s.$getValue('k');
      // corner: back to the RUN-START value — still a change against the post-pause state.
      s.$setValue('k', corner ? 'orig' : `resumed:${seen}:${(input as S).approved}`);
      s.$setValue('resumeRead', seen);
    },
  };
  return flowChart<S>('Seed', (s) => s.$setValue('k', 'orig'), 'seed')
    .addFunction('Mutate', (s) => s.$setValue('k', 'mutated'), 'mutate')
    .addPausableFunction('Approve', handler, 'approve')
    .addFunction('Finish', (s) => s.$setValue('finished', s.$getValue('k')), 'finish')
    .build();
}

const probe = {
  sequential: () =>
    served(
      flowChart<S>(
        'Seed',
        (s) => {
          s.$setValue('greeting', 'hello');
          s.$setValue('config', { retries: 3 });
        },
        'seed',
      )
        .addFunction('ReadWrite', (s) => s.$setValue('echo', `${s.$getValue('greeting')}-back`), 'read-write')
        .addFunction('NoTouch', () => undefined, 'no-touch')
        .addFunction('SameValue', (s) => s.$setValue('greeting', 'hello'), 'same-value')
        .build(),
    ),
  fork: () => served(forkChart('none')),
  forkError: () => served(forkChart('error')),
  subflow: () => {
    const inner = flowChart<S>(
      'InnerWork',
      (s) => s.$setValue('innerResult', `got:${s.$getValue('seededKey')}`),
      'inner-work',
    )
      .addFunction('InnerSecond', (s) => s.$setValue('innerSecond', true), 'inner-second')
      .build();
    return served(
      flowChart<S>('Outer', (s) => s.$setValue('outerKey', 'outer-value'), 'outer')
        .addSubFlowChartNext('sf-inner', inner, 'Inner', {
          inputMapper: () => ({ seededKey: 'seeded-value' }),
          outputMapper: (out: S) => ({ innerResult: out.innerResult }),
        })
        .addFunction('After', (s) => s.$setValue('after', s.$getValue('innerResult')), 'after')
        .build(),
    );
  },
  forkSubflowBranch: () => {
    const inner = flowChart<S>('BranchWork', (s) => s.$setValue('branchResult', 'from-subflow'), 'branch-work').build();
    return served(
      flowChart<S>('Seed', (s) => s.$setValue('k', 'orig'), 'seed')
        .addSelectorFunction('PickBoth', () => ['plain', 'sf-branch'], 'pick-both')
        .addFunctionBranch('plain', 'Plain', (s: S) => s.$setValue('plainDone', true))
        // The merge-back writes a parent ROOT key mid-fork (the #13 first-touch anchor case).
        .addSubFlowChartBranch('sf-branch', inner, 'SubflowBranch', {
          outputMapper: (out: S) => ({ branchResult: out.branchResult }),
        })
        .end()
        .addFunction('Join', (s) => s.$setValue('joined', s.$getValue('branchResult')), 'join')
        .build(),
    );
  },
  throttledFork: () =>
    served(forkChart('throttled'), { throttlingErrorChecker: (error: unknown) => String(error).includes('429') }),
  deciderLoop: () =>
    served(
      flowChart<S>(
        'Seed',
        (s) => {
          s.$setValue('i', 0);
          s.$setValue('history', []);
        },
        'seed',
      )
        .addFunction(
          'Work',
          (s) => {
            const i = s.$getValue('i') as number;
            s.$batchArray('history', (arr: unknown[]) => {
              arr.push({ idx: i });
            });
            s.$setValue('i', i + 1);
            if (i + 1 >= 5) s.$break();
          },
          'work',
        )
        .loopTo('work')
        .build(),
    ),
  pauseResumeSame: () => pausedThenResumed(pausableChart(false), { approved: true }, 'same'),
  pauseResumeCorner: () => pausedThenResumed(pausableChart(true), { approved: true }, 'same'),
};

// ─── One chart per remaining record-shaping path ─────────────────────────────

const paths = {
  /** The decider commits before its branch resolves; the chosen branch writes at the root. */
  decider: () =>
    served(
      flowChart<S>('Score', (s) => s.$setValue('score', 72), 'score')
        .addDeciderFunction(
          'Route',
          (s) => {
            s.routed = true;
            return s.score > 50 ? 'high' : 'low';
          },
          'route',
        )
        .addFunctionBranch('high', 'High', (s: S) => s.$setValue('lane', 'fast'))
        .addFunctionBranch('low', 'Low', (s: S) => s.$setValue('lane', 'slow'))
        .setDefault('low')
        .end()
        .addFunction('After', (s) => s.$setValue('done', s.lane), 'after')
        .build(),
    ),
  /** A lazy mount with no outputMapper: its exit is its only bundle (no `phase`). */
  lazySubflow: () => {
    const inner = flowChart<S>('Inner', (s) => s.$setValue('innerDone', `${s.seed}!`), 'inner').build();
    return served(
      flowChart<S>('Start', (s) => s.$setValue('seedValue', 'v'), 'start')
        .addLazySubFlowChartNext('sf-lazy', () => inner, 'Lazy', { inputMapper: (s: S) => ({ seed: s.seedValue }) })
        .addFunction('After', (s) => s.$setValue('after', true), 'after')
        .build(),
    );
  },
  /** One branch per item (`<id>~<index>`), each its own log; `into` written by the fan-out; a truncated item. */
  parallelForEach: () => {
    const branch = () => flowChart<S>('Measure', (s) => s.$setValue('len', String(s.item).length), 'measure').build();
    return served(
      flowChart<S>('Split', (s) => s.$setValue('words', ['a', 'bb', 'ccc']), 'split')
        .addParallelForEach('Each', 'each', { items: (s: S) => s.words, branch, maxBranches: 2, into: 'lens' })
        .addFunction('Count', (s) => s.$setValue('count', s.lens.length), 'count')
        .build(),
    );
  },
  /** interrupt() inside a subflow: the stage re-runs from its top on a resume from the stored checkpoint. */
  interruptSubflow: () => {
    const inner = flowChart<S>(
      'Ask',
      (s) => {
        s.asked = true;
        s.approved = interrupt<{ ok: boolean }>(s, { reason: 'Approve?', expects: { ok: 'boolean' } }).ok;
      },
      'ask',
    ).build();
    return pausedThenResumed(
      flowChart<S>('Prepare', (s) => s.$setValue('amount', 10), 'prepare')
        .addSubFlowChartNext('sf-ask', inner, 'Approval', {
          inputMapper: (s: S) => ({ amount: s.amount }),
          outputMapper: (out: S) => ({ approved: out.approved }),
        })
        .addFunction('Settle', (s) => s.$setValue('outcome', s.approved ? 'paid' : 'held'), 'settle')
        .build(),
      { ok: true },
      'stored',
    );
  },
  /**
   * Two failed attempts staged writes, reads and an untracked source (`$getArgs`); none reaches the log or the
   * final attempt's `readKeys` / `untrackedSources`. The stage's declared tag survives the discards.
   */
  retry: () => {
    let attempt = 0;
    return served(
      flowChart<S>('Seed', (s) => s.$setValue('base', 1), 'seed')
        .addFunction(
          'Flaky',
          (s) => {
            attempt += 1;
            s.tries = attempt;
            if (attempt < 3) throw new Error(`attempt ${attempt} failed at ${s.base} for ${s.$getArgs<S>().who}`);
            s.result = s.base + 1;
          },
          'flaky',
        )
        .tag('retried')
        .retry({ attempts: 3 })
        .build(),
      { writeProvenance: 'reads-prefix', readOnlyContext: { who: 'ops' } },
    );
  },
  /**
   * keys, patterns, fields: objects copied under new names keep their rule (fields and whole); merges under a whole
   * and a field rule; a redacted array grown by a tail; a seeded secret and defaults (the mirror's seed, the fold
   * base) — under each retention dial, the last under 'delta' (an `append` of a redacted key).
   */
  redactionPolicy: () =>
    variants(
      () =>
        flowChart<S>(
          'Collect',
          (s) => {
            s.ssn = 'ssn-1';
            s.apiSecret = { id: 'k-1' };
            s.profile = { name: 'Ada', auth: { token: 't-1' } };
            s.note = 'clear';
          },
          'collect',
        )
          .addFunction(
            'Copy',
            (s) => {
              s.person = s.$getValue('profile');
              s.vault = s.$getValue('apiSecret');
              s.ssnCopy = s.ssn;
              s.cards = [...s.cards, 'c1'];
              s.$update('profile', { name: 'Ada L.', auth: { token: 't-2' } });
              s.$update('apiSecret', { rotated: true });
            },
            'copy',
          )
          .build(),
      withEach(
        { full: {}, summary: RETENTION.summary, offDelta: { ...RETENTION.off, commitValues: 'delta' } },
        { initialContext: { ssn: 'ssn-0', cards: ['c0'] }, defaultValuesForContext: { region: 'eu' } },
      ),
      { keys: ['ssn', 'cards'], patterns: [/secret/i], fields: { profile: ['auth.token'] } },
    ),
  /** Per-call marks: declared once, cleared by a delete, carried by the checkpoint into the resumed run. */
  redactionMarks: () => {
    const gate: PausableHandler<S> = {
      execute: async () => ({ question: 'go?' }),
      resume: async (s) => s.$setValue('token', 'tok-3'),
    };
    return pausedThenResumed(
      flowChart<S>(
        'Mark',
        (s) => {
          s.$setValue('token', 'tok-1', true);
          s.$setValue('pin', '0000', true);
        },
        'mark',
      )
        .addFunction(
          'Again',
          (s) => {
            s.token = 'tok-2';
            s.$delete('pin');
          },
          'again',
        )
        .addFunction('Unmarked', (s) => s.$setValue('pin', '1111'), 'unmarked')
        .addPausableFunction('Gate', gate, 'gate')
        .build(),
      undefined,
      'stored',
    );
  },
  /** set, merge, delete and append (an array grown by a tail), under 'full' and 'delta'. */
  verbs: () =>
    variants(
      () =>
        flowChart<S>(
          'Seed',
          (s) => {
            s.list = [1, 2];
            s.profile = { name: 'a', tags: ['x'] };
            s.temp = 'gone soon';
          },
          'seed',
        )
          .addFunction(
            'Change',
            (s) => {
              s.list = [...s.list, 3];
              s.$update('profile', { tags: ['y'], age: 3 });
              s.$delete('temp');
            },
            'change',
          )
          .addFunction(
            'Shrink',
            (s) => {
              s.list = [9];
              s.profile.name = 'b';
            },
            'shrink',
          )
          .build(),
      ENCODINGS,
    ),
  /** Date, Map and Set: an equal value is no change, a different one is; an own undefined; both encodings. */
  values: () =>
    variants(
      () =>
        flowChart<S>(
          'Seed',
          (s) => {
            s.when = new Date('2026-07-02T00:00:00Z');
            s.index = new Map([['k', 1]]);
            s.tags = new Set(['a']);
          },
          'seed',
        )
          .addFunction(
            'Same',
            (s) => {
              s.when = new Date('2026-07-02T00:00:00Z');
              s.tags = new Set(['a']);
            },
            'same',
          )
          .addFunction(
            'Changed',
            (s) => {
              s.when = new Date('2026-07-03T00:00:00Z');
              s.index = new Map([['k', 2]]);
              s.tags = new Set(['b']);
              s.blank = undefined;
            },
            'changed',
          )
          .build(),
      ENCODINGS,
    ),
  /** writeProvenance 'reads-prefix': each row names the keys read before it (a read of its own write included), under each retention dial. */
  readsPrefix: () =>
    variants(
      () =>
        flowChart<S>(
          'Seed',
          (s) => {
            s.a = 1;
            s.b = 2;
          },
          'seed',
        )
          .addFunction(
            'Derive',
            (s) => {
              s.x = s.a + 1;
              s.y = s.b + s.x;
            },
            'derive',
          )
          .build(),
      withEach(RETENTION, { writeProvenance: 'reads-prefix', commitValues: 'delta' }),
    ),
  /** The bundle's fragments in their order: untrackedSources, tags (on an empty commit too), a tagged mount's exit `phase`. */
  tags: () => {
    const inner = flowChart<S>('Inner', (s) => s.$setValue('out', s.in * 2), 'inner').build();
    return served(
      flowChart<S>('Args', (s) => s.$setValue('forTenant', s.$getArgs<S>().tenant), 'args')
        .tag('ingress')
        .addFunction('Quiet', () => undefined, 'quiet')
        .tag('audit', 'stop')
        .addSubFlowChartNext('sf-double', inner, 'Double', {
          inputMapper: () => ({ in: 2 }),
          outputMapper: (out: S) => ({ doubled: out.out }),
          tags: ['mount'],
        })
        .build(),
      { readOnlyContext: { tenant: 't-1' } },
    );
  },
  /**
   * The diff base is the state at the stage's FIRST touch: Reader reads k, Writer commits a new
   * k meanwhile, Reader writes back what it read — no change against its base, so no row. A key the Writer
   * committed after that first touch is still read, from live state (the second read tier).
   */
  firstTouch: () =>
    served(
      flowChart<any>('Seed', (s: ScopeFacade) => s.setValue('k', 1), 'seed')
        .addListOfFunction([
          {
            id: 'reader',
            name: 'Reader',
            fn: async (s: ScopeFacade) => {
              const seen = s.getValue('k');
              await wait(5);
              s.setGlobal('k', seen);
              s.setValue('seenLate', s.getValue('late') ?? 'absent');
            },
          },
          {
            id: 'writer',
            name: 'Writer',
            fn: (s: ScopeFacade) => {
              s.setGlobal('k', 2);
              s.setGlobal('late', 'from-sibling');
            },
          },
        ])
        .addFunction('Join', (s: ScopeFacade) => s.setValue('final', s.getValue('k')), 'join')
        .build(),
      { scopeFactory: facades },
    ),
  /**
   * Where a frame writes: a fork child's no-op delete under its `runs/<id>` address commits nothing,
   * and a subflow child's per-field merge-back lands at its parent's address (`useAddressOf`).
   */
  addresses: () => {
    const inner = flowChart<S>('Summarize', (s) => s.$setValue('from', 'subflow'), 'summarize').build();
    return served(
      flowChart<S>('Seed', (s) => s.$setValue('summary', { kept: true }), 'seed')
        .addListOfFunction([{ id: 'cleaner', name: 'Cleaner', fn: (s: S) => s.$delete('missing') }])
        .addSubFlowChart('sf-merge', inner, 'Merge', { outputMapper: (out: S) => ({ summary: { from: out.from } }) })
        .addFunction('Join', (s) => s.$setValue('seen', s.summary.from), 'join')
        .build(),
    );
  },
  /**
   * The facade's path-aware doors (as adapters use them), in fork children at `runs/<id>`: a nested tracked
   * read (`readKeys` 'profile.name'), a nested write under a field rule, a merge, and an object read under a
   * ruled name written at a nested path (its rule re-based there). A sibling merges, hard-writes and merges
   * the same key again: a family that does not fold back, re-encoded as what the stage read.
   */
  nestedPaths: () =>
    served(
      flowChart<any>('Seed', (s: ScopeFacade) => s.setValue('profile', { name: 'Ada', auth: { token: 't-1' } }), 'seed')
        .addListOfFunction([
          {
            id: 'child',
            name: 'Child',
            fn: (s: ScopeFacade) => {
              const profile = s.getValue('profile');
              const name = s.getValueAt(['profile'], 'name');
              s.setValueAt(['profile', 'auth'], 'token', 't-2');
              s.updateValue('stats', { seen: name, count: 1 });
              s.setValueAt(['box'], 'inner', profile);
            },
          },
          {
            id: 'remerge',
            name: 'Remerge',
            fn: (s: ScopeFacade) => {
              s.getValue('profile');
              s.updateValue('k', { x: 1 });
              s.setValue('k', { y: 2 });
              s.updateValue('k', { z: 3 });
            },
          },
        ])
        .build(),
      { scopeFactory: facades, writeProvenance: 'reads-prefix', commitValues: 'delta' },
      { fields: { profile: ['auth.token'] } },
    ),
  /**
   * Writes at a subflow's boundary under a policy: the seed (a mapper's copies keep their rule; a plain
   * object seeds field by field), a mark made inside the subflow, a fork inside it (`runs/<sf-in/p>`), and
   * every merge-back shape — a scalar, a top-level array (concatenated) and a plain object merged field by
   * field (`appendToArray`, `mergeObject`), whose reads land in `readKeys`.
   */
  subflowBoundary: () => {
    // Ends on a plain stage: its output is then the subflow's state, so the marked token crosses back.
    const inner = flowChart<S>('Fan', () => undefined, 'fan')
      .addListOfFunction([
        { id: 'p', name: 'P', fn: (s: S) => s.$setValue('pv', 1) },
        { id: 'q', name: 'Q', fn: (s: S) => s.$setValue('qv', 2) },
      ])
      .addFunction('Mark', (s) => s.$setValue('token', 'tok-1', true), 'mark')
      .build();
    return served(
      flowChart<S>(
        'Seed',
        (s) => {
          s.ssn = 'ssn-1';
          s.profile = { name: 'Ada', auth: { token: 't-1' } };
          s.items = ['a'];
          s.meta = { list: ['x'], obj: { w: 0 } };
        },
        'seed',
      )
        .addSubFlowChartNext('sf-in', inner, 'Inner', {
          inputMapper: (s: S) => ({ ssnIn: s.ssn, who: s.profile }),
          // It reads a selected value, so the taint law masks every value it computes; live state keeps them.
          outputMapper: (out: S) => ({ items: ['b'], meta: { list: ['y'], obj: { z: 1 } }, token: out.token }),
        })
        .build(),
      { writeProvenance: 'reads-prefix' },
      { keys: ['ssn'], fields: { profile: ['auth.token'] } },
    );
  },
  /** A stage that throws still commits its writes; a write nothing can clone fails at commit and records nothing. */
  failures: async () => ({
    stageThrows: await served(
      flowChart<S>('Seed', (s) => s.$setValue('k', 1), 'seed')
        .addFunction(
          'Fails',
          (s) => {
            s.$setValue('partial', true);
            throw new Error('stage failed');
          },
          'fails',
        )
        .build(),
    ),
    uncloneable: await served(
      flowChart<S>('Seed', (s) => s.$setValue('k', 1), 'seed')
        .addFunction(
          'Uncloneable',
          (s) => {
            s.$setValue('kept', 2);
            s.$setValue('fn', () => 1);
          },
          'uncloneable',
        )
        .build(),
    ),
  }),
  /**
   * The two read tiers, out of contract on purpose (an in-place edit of a read). Before the first
   * write a read is the committed value itself (no buffer yet), so the edit moves the diff base with
   * it and writing it back records nothing (M1b). After the first write, a read the working copy
   * cannot answer is served from live state with the diff base detached first, so the same edit is
   * recorded (B2, `detachBase`).
   */
  readTiers: () =>
    served(
      flowChart<S>(
        'BeforeFirstWrite',
        (s) => {
          const held = s.$getValue('y') as number[];
          held.push(1);
          s.$setValue('y', held);
        },
        'before-first-write',
      )
        .addFunction(
          'AfterFirstWrite',
          (s) => {
            s.$delete('x');
            const live = s.$getValue('x') as number[];
            live.push(0);
            s.$setValue('x', live);
          },
          'after-first-write',
        )
        .build(),
      { initialContext: { x: [], y: [] } },
    ),
};

export const SCENARIOS: Record<string, () => Promise<Pins>> = { ...probe, ...paths };

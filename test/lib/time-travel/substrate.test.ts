/**
 * The substrate a fold-at-stop needs, and the promises the snapshot now makes.
 *
 * Two gaps closed here:
 *   1. The commit log's fold BASE travels with the log (`initialState`), so an
 *      offline consumer can reconstruct state that was seeded before the run.
 *   2. `getSnapshot().commitLog` is DETACHED and frozen — a snapshot is a fold
 *      result, and a fold result does not keep changing under its holder.
 */

import type { PausableHandler } from '../../../src/index.js';
import { flowChart, FlowChartBuilder, FlowChartExecutor, getSubtreeSnapshot } from '../../../src/index.js';
import { stateAt, timeTravel } from '../../../src/trace.js';

describe('substrate — the fold base travels with the log', () => {
  it('carries the run’s initialContext', async () => {
    const chart = flowChart<any>(
      'Touch',
      async (scope: any) => {
        scope.touched = true;
      },
      'touch',
    ).build();

    const executor = new FlowChartExecutor(chart, { initialContext: { tenant: 'acme' } } as any);
    await executor.run();
    const snapshot = executor.getSnapshot();

    expect(snapshot.initialState).toEqual({ tenant: 'acme' });
    expect(stateAt(snapshot, -1).state).toEqual({ tenant: 'acme' });
    expect(stateAt(snapshot, 0).state).toEqual({ tenant: 'acme', touched: true });
  });

  it('carries defaultValuesForContext too — the store’s real starting point', async () => {
    const chart = flowChart<any>(
      'Touch',
      async (scope: any) => {
        scope.touched = true;
      },
      'touch',
    ).build();

    const executor = new FlowChartExecutor(chart, {
      defaultValuesForContext: { region: 'eu' },
      initialContext: { tenant: 'acme' },
    } as any);
    await executor.run();
    const snapshot = executor.getSnapshot();

    expect(snapshot.initialState).toEqual({ tenant: 'acme', region: 'eu' });
    // The fold reproduces the live state exactly — base included.
    expect(stateAt(snapshot, snapshot.commitLog.length - 1).state).toEqual(snapshot.sharedState);
  });

  it('is `{}` (not undefined) for a run with no seed at all', async () => {
    const chart = flowChart<any>(
      'Touch',
      async (scope: any) => {
        scope.touched = true;
      },
      'touch',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSnapshot().initialState).toEqual({});
  });

  it('is frozen and detached — a consumer cannot reach engine state through it', async () => {
    const chart = flowChart<any>(
      'Touch',
      async (scope: any) => {
        scope.touched = true;
      },
      'touch',
    ).build();
    const executor = new FlowChartExecutor(chart, { initialContext: { seed: { deep: 1 } } } as any);
    await executor.run();
    const base = executor.getSnapshot().initialState as any;

    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(base.seed)).toBe(true);
    expect(() => {
      base.seed.deep = 2;
    }).toThrow();
  });

  it('a subflow carries its own base beside its own log', async () => {
    const inner = new FlowChartBuilder<any, any>()
      .start(
        'In',
        async (scope: any) => {
          scope.doubled = scope.given * 2;
        },
        'in',
      )
      .build();

    const chart = flowChart<any>(
      'Seed',
      async (scope: any) => {
        scope.given = 21;
      },
      'seed',
    )
      .addSubFlowChartNext('sf', inner, 'Inner', {
        inputMapper: (p: any) => ({ given: p.given }),
        outputMapper: (o: any) => ({ doubled: o.doubled }),
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const subtree = getSubtreeSnapshot(executor.getSnapshot(), 'sf')!;

    expect(subtree.initialState).toEqual({});
    // Fold the subflow's OWN log from its OWN base.
    expect(stateAt(subtree, subtree.history!.length - 1).state).toEqual({ given: 21, doubled: 42 });
  });

  it('says `log-only` when no base travelled with the log', async () => {
    const chart = flowChart<any>(
      'Touch',
      async (scope: any) => {
        scope.touched = true;
      },
      'touch',
    ).build();
    const executor = new FlowChartExecutor(chart, { initialContext: { tenant: 'acme' } } as any);
    await executor.run();

    // An older stored snapshot: a log with no base beside it.
    const old = { commitLog: executor.getSnapshot().commitLog };
    const folded = stateAt(old, 0);
    expect(folded.basis).toBe('log-only');
    expect(folded.state).toEqual({ touched: true }); // 'tenant' is honestly absent
    expect(stateAt(executor.getSnapshot(), 0).basis).toBe('initial+log');
  });
});

describe('substrate — the served commit log is detached', () => {
  const chart = flowChart<any>(
    'One',
    async (scope: any) => {
      scope.a = 1;
    },
    'one',
  )
    .addFunction(
      'Two',
      async (scope: any) => {
        scope.b = 2;
      },
      'two',
    )
    .build();

  it('is frozen — push throws instead of corrupting the engine’s history', async () => {
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const { commitLog } = executor.getSnapshot();

    expect(Object.isFrozen(commitLog)).toBe(true);
    expect(() => commitLog.push({} as never)).toThrow();
    expect(commitLog).toHaveLength(2);
  });

  it('a snapshot taken mid-run does not grow under its holder', async () => {
    let midRun: ReturnType<FlowChartExecutor['getSnapshot']> | undefined;
    const observed = flowChart<any>(
      'One',
      async (scope: any) => {
        scope.a = 1;
      },
      'one',
    )
      .addFunction(
        'Two',
        async (scope: any) => {
          scope.b = 2;
          midRun = executor.getSnapshot();
        },
        'two',
      )
      .addFunction(
        'Three',
        async (scope: any) => {
          scope.c = 3;
        },
        'three',
      )
      .build();

    const executor = new FlowChartExecutor(observed);
    await executor.run();

    // Taken while 'two' was still running: only 'one' had committed.
    expect(midRun!.commitLog.map((b) => b.stageId)).toEqual(['one']);
    expect(executor.getSnapshot().commitLog).toHaveLength(3);
  });

  it('still reports the same length the engine counts', async () => {
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSnapshot().commitLog.length).toBe(executor.getCommitCount());
  });
});

describe('substrate — redaction is folded honestly', () => {
  it('a folded state shows REDACTED where the log was scrubbed, and says so', async () => {
    const chart = flowChart<any>(
      'Register',
      async (scope: any) => {
        scope.ssn = '999-88-7777';
        scope.plan = 'gold';
      },
      'register',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();
    const snapshot = executor.getSnapshot();

    const folded = stateAt(snapshot, 0);
    expect(folded.redacted).toBe(true);
    expect(folded.redactedPaths).toEqual(['ssn']);
    expect(folded.state.ssn).toBe('REDACTED');
    expect(folded.state.plan).toBe('gold');
    // The RUNTIME still holds the real value — the log is what was scrubbed.
    expect(snapshot.sharedState.ssn).toBe('999-88-7777');

    const cursor = timeTravel(snapshot);
    cursor.last();
    expect(cursor.stateAt().redacted).toBe(true);
  });

  it('a REDACTED snapshot does not ship the raw fold base', async () => {
    // The regression this pins: `initialState` is the run's raw pre-run seed
    // and no redaction policy ever touched it (a policy scrubs stage WRITES at
    // the scope facade; nothing wrote the base). Serving it under
    // `redact: true` handed back the ORIGINAL value of a seeded secret that a
    // later commit had already scrubbed — in the same object whose whole
    // purpose is being safe to share.
    const chart = flowChart<any>(
      'Rotate',
      async (scope: any) => {
        scope.ssn = 'NEW-00-0000';
      },
      'rotate',
    ).build();

    const executor = new FlowChartExecutor(chart, { initialContext: { ssn: 'SEED-88-7777' } } as any);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();

    const safe = executor.getSnapshot({ redact: true });
    expect(safe.initialState).toBeUndefined();
    // The fold over a redacted snapshot must SAY it has no base rather than
    // fold from a raw seed it was not handed.
    expect(stateAt(safe, safe.commitLog.length - 1).basis).toBe('log-only');
    // NOT asserted here: that the seed is absent from `safe` altogether. The
    // redacted mirror's `sharedState` is seeded from the raw initial state
    // (ExecutionRuntime, the mirror constructor) — a pre-existing gap this
    // packet reports, not one it closes. A whole-object `not.toContain` passed
    // only because this chart's stage happens to overwrite `ssn`.

    // And the fold SAYS the base did not travel — never a silent partial.
    const folded = stateAt(safe, safe.commitLog.length - 1);
    expect(folded.basis).toBe('log-only');
    expect(timeTravel(safe).stateAt().basis).toBe('log-only');

    // The unredacted view is unchanged: base served, basis complete.
    const raw = executor.getSnapshot();
    expect(raw.initialState).toEqual({ ssn: 'SEED-88-7777' });
    expect(stateAt(raw, raw.commitLog.length - 1).basis).toBe('initial+log');
  });

  it('omits the base only when a redacted mirror actually exists', async () => {
    // No policy ⇒ no mirror ⇒ `redact: true` already falls back to the raw
    // view for `sharedState`. The base must stay consistent with it rather
    // than vanishing for a caller who is getting raw values anyway.
    const chart = flowChart<any>(
      'Plain',
      async (scope: any) => {
        scope.plan = 'gold';
      },
      'plain',
    ).build();
    const executor = new FlowChartExecutor(chart, { initialContext: { tenant: 'acme' } } as any);
    await executor.run();

    const snapshot = executor.getSnapshot({ redact: true });
    expect(snapshot.initialState).toEqual({ tenant: 'acme' });
    expect(stateAt(snapshot, 0).basis).toBe('initial+log');
  });

  it('says nothing was redacted when nothing was', async () => {
    const chart = flowChart<any>(
      'Plain',
      async (scope: any) => {
        scope.plan = 'gold';
      },
      'plain',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const folded = stateAt(executor.getSnapshot(), 0);
    expect(folded.redacted).toBe(false);
    expect(folded.redactedPaths).toEqual([]);
  });
});

describe('substrate — resume', () => {
  const approval: PausableHandler<any> = {
    execute: async (scope: any) => {
      scope.stage1 = 'done';
      return { question: 'ok?' };
    },
    resume: async (scope: any, input: unknown) => {
      scope.approved = (input as { ok: boolean }).ok;
    },
  };

  const chart = flowChart<any>(
    'Start',
    async (scope: any) => {
      scope.started = true;
    },
    'start',
  )
    .addPausableFunction('Approval', approval, 'approval')
    .addFunction(
      'Finish',
      async (scope: any) => {
        scope.finished = true;
      },
      'finish',
    )
    .build();

  it('a same-executor resume EXTENDS the cursor', async () => {
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const paused = timeTravel(executor.getSnapshot());
    const stopsWhilePaused = paused.stops.length;

    await executor.resume(executor.getCheckpoint()!, { ok: true });
    const resumed = timeTravel(executor.getSnapshot());

    expect(resumed.stops.length).toBeGreaterThan(stopsWhilePaused);
    // The earlier stops are still the same stages, at the same commit indices.
    for (let k = 1; k < stopsWhilePaused - 1; k++) {
      expect(resumed.stops[k].runtimeStageId).toBe(paused.stops[k].runtimeStageId);
      expect(resumed.stops[k].commitIdx).toBe(paused.stops[k].commitIdx);
    }
    expect(resumed.stops.some((s) => s.stageId === 'finish')).toBe(true);
    cursorFoldsToFinalState(resumed, executor.getSnapshot().sharedState);
  });

  it('a fresh-executor resume starts a NEW cursor — commit indices are run-local', async () => {
    const first = new FlowChartExecutor(chart);
    await first.run();
    const wire = JSON.parse(JSON.stringify(first.getCheckpoint()!));

    const second = new FlowChartExecutor(chart);
    await second.resume(wire, { ok: true });
    const resumed = timeTravel(second.getSnapshot());

    // A brand-new log: it starts at index 0 and holds only post-resume stages.
    expect(resumed.stops.some((s) => s.stageId === 'start')).toBe(false);
    expect(resumed.stops.filter((s) => s.kind !== 'start' && s.kind !== 'end')[0].commitIdx).toBe(0);
    // …but the pre-pause state is not lost: it is the fold BASE of the new run.
    expect(second.getSnapshot().initialState).toMatchObject({ started: true, stage1: 'done' });
    cursorFoldsToFinalState(resumed, second.getSnapshot().sharedState);
  });
});

function cursorFoldsToFinalState(cursor: ReturnType<typeof timeTravel>, sharedState: Record<string, unknown>) {
  cursor.last();
  expect(cursor.stateAt().state).toEqual(sharedState);
}

describe('back-compat — a 9.16.x snapshot still folds and still compiles', () => {
  it('a snapshot literal built WITHOUT a fold base folds from `{}` and says so', () => {
    // The shape a UI fixture or a stored 9.16.x trace has: no `initialState`.
    const legacy = {
      runId: 'r-legacy',
      sharedState: { n: 2 },
      executionTree: { id: 'root', logs: {}, errors: {}, metrics: {}, evals: {} },
      commitLog: [
        {
          idx: 0,
          stage: 'BUMP',
          stageId: 'bump',
          runtimeStageId: 'bump#0',
          trace: [{ path: 'n', verb: 'set' as const }],
          redactedPaths: [],
          overwrite: { n: 2 },
          updates: {},
        },
      ],
      commitValues: 'full' as const,
      writeProvenance: 'off' as const,
    };

    const folded = stateAt(legacy as never, 0);
    expect(folded.basis).toBe('log-only');
    expect(folded.state).toEqual({ n: 2 });

    // …and the cursor works over it: `initialState` is optional, not assumed.
    const cursor = timeTravel(legacy as never);
    expect(cursor.stops.map((s) => s.kind)).toEqual(['start', 'commit', 'end']);
    cursor.last();
    expect(cursor.stateAt().basis).toBe('log-only');
  });
});

describe('a lone parallel-fork child is not a subflow mount', () => {
  it('classifies it as `commit`, and `drill` on it is undefined', async () => {
    const chart = flowChart<any>(
      'Seed',
      async (scope: any) => {
        scope.$setValue('s', 1);
      },
      'seed',
    )
      .addListOfFunction([
        {
          id: 'only',
          name: 'Only',
          fn: async (scope: any) => {
            scope.$setValue('a', 1);
          },
        },
      ])
      .addFunction(
        'After',
        async (scope: any) => {
          scope.$setValue('b', 2);
        },
        'after',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const cursor = timeTravel(executor.getSnapshot());

    const child = cursor.stops.find((s) => s.stageId === 'only');
    expect(child).toBeDefined();
    expect(child!.kind).toBe('commit');
    expect(cursor.drill(child!.runtimeStageId)).toBeUndefined();
    // The run has no subflows at all — nothing on this axis is drillable.
    expect(cursor.stops.some((s) => s.kind === 'mount')).toBe(false);
  });
});

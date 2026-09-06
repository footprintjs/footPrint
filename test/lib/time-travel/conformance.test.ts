/**
 * THE conformance test for read-time time travel.
 *
 * The claim under test is one sentence: **folding as you walk equals folding a
 * replay.** Every stage function records a detached clone of the whole state it
 * sees at entry — the WALK witness, collected during traversal, never
 * post-processed. Afterwards the reader's cursor folds the finished commit log
 * at every stop. The two must agree, everywhere, in both commit encodings.
 *
 * The chart deliberately carries everything that makes the two disagree if the
 * fold is wrong: a seed, a subflow with its own isolated log and an array that
 * CONCATs back through the outputMapper, a parallel fork whose children commit
 * out of order, and a decider loop that runs three iterations via `loopTo`.
 */

import { flowChart, FlowChartBuilder, FlowChartExecutor, getSubtreeSnapshot } from '../../../src/index.js';
import type { Stop, TimeTravel } from '../../../src/trace.js';
import { stateAt, timeTravel } from '../../../src/trace.js';

// ── The WALK witness ───────────────────────────────────────────────────────

interface Witness {
  stage: string;
  state: Record<string, unknown>;
}

/** The whole state this stage sees at entry, detached. */
function witness(scope: unknown, stage: string, into: Witness[]): void {
  const raw = (scope as { $toRaw(): { getValueSilent(): unknown } }).$toRaw();
  into.push({ stage, state: structuredClone(raw.getValueSilent()) as Record<string, unknown> });
}

/**
 * Fork children ENTER together, before either has committed, so they share one
 * entry state. They are the one place where "the next stop's stage" is not the
 * next thing that ran — asserted on its own terms below.
 */
const FORK_CHILDREN = ['fan-a', 'fan-b'];

/** The k-th stop with a given stageId lines up with that stage's k-th entry. */
function witnessFor(cursor: TimeTravel, stop: Stop, walk: Witness[]): Witness | undefined {
  const occurrence = cursor.stops.filter((s) => s.stageId === stop.stageId && s.step < stop.step).length;
  return walk.filter((w) => w.stage === stop.stageId)[occurrence];
}

function buildChart(walk: Witness[]) {
  const inner = new FlowChartBuilder<any, any>()
    .start(
      'Grade',
      async (scope: any) => {
        witness(scope, 'grade', walk);
        scope.grade = scope.tally >= 1 ? 'pass' : 'fail';
      },
      'grade',
    )
    .addFunction(
      'Explain',
      async (scope: any) => {
        witness(scope, 'explain', walk);
        scope.notes = [`graded ${scope.grade}`];
      },
      'explain',
    )
    .build();

  return flowChart<any>(
    'Seed',
    async (scope: any) => {
      witness(scope, 'seed', walk);
      scope.tally = 1;
      scope.notes = ['seeded'];
    },
    'seed',
  )
    .addSubFlowChartNext('sf-grade', inner, 'Grading', {
      inputMapper: (parent: any) => ({ tally: parent.tally }),
      // `notes` is an ARRAY, so the parent's merge CONCATs it back.
      outputMapper: (out: any) => ({ grade: out.grade, notes: out.notes }),
    })
    .addFunction(
      'Report',
      async (scope: any) => {
        witness(scope, 'report', walk);
        scope.report = `${scope.grade}:${scope.notes.length}`;
      },
      'report',
    )
    .addListOfFunction([
      {
        id: 'fan-a',
        name: 'FanA',
        fn: async (scope: any) => {
          witness(scope, 'fan-a', walk);
          scope.fanA = 'a';
        },
      },
      {
        id: 'fan-b',
        name: 'FanB',
        fn: async (scope: any) => {
          witness(scope, 'fan-b', walk);
          scope.fanB = 'b';
        },
      },
    ])
    .addFunction(
      'Bump',
      async (scope: any) => {
        witness(scope, 'bump', walk);
        scope.tally = scope.tally + 1;
        scope.notes = [...scope.notes, `bump ${scope.tally}`];
      },
      'bump',
    )
    .addDeciderFunction(
      'Check',
      async (scope: any) => {
        witness(scope, 'check', walk);
        return scope.tally < 4 ? 'again' : 'done';
      },
      'check',
    )
    .addFunctionBranch(
      'again',
      'Again',
      async (scope: any) => {
        witness(scope, 'again', walk);
        scope.lastLoop = scope.tally;
      },
      undefined,
      { loopTo: 'bump' },
    )
    .addFunctionBranch('done', 'Done', async (scope: any) => {
      witness(scope, 'done', walk);
      scope.looped = true;
    })
    .end()
    .build();
}

async function runIt(commitValues: 'full' | 'delta') {
  const walk: Witness[] = [];
  const executor = new FlowChartExecutor(buildChart(walk), { commitValues } as any);
  await executor.run();
  return { walk, snapshot: executor.getSnapshot(), executor };
}

describe('time travel conformance — folding as you walk equals folding a replay', () => {
  for (const mode of ['full', 'delta'] as const) {
    describe(`commitValues: '${mode}'`, () => {
      it('the chart really did loop, mount and fan out', async () => {
        const { walk, snapshot } = await runIt(mode);
        expect(walk.filter((w) => w.stage === 'bump')).toHaveLength(3);
        expect(walk.filter((w) => w.stage === 'grade')).toHaveLength(1);
        expect(snapshot.commitValues).toBe(mode);
        const cursor = timeTravel(snapshot);
        expect(cursor.stops.filter((s) => s.kind === 'mount')).toHaveLength(1);
      });

      it('every stop folds to the state the next stage actually saw', async () => {
        const { walk, snapshot } = await runIt(mode);
        const cursor = timeTravel(snapshot);

        let checked = 0;
        for (let k = 0; k < cursor.stops.length - 1; k++) {
          const stop = cursor.stops[k];
          const after = cursor.stops[k + 1];
          // Concurrent siblings: the second one entered BEFORE the first
          // committed, so the axis order is not the entry order. Asserted below.
          if (FORK_CHILDREN.includes(stop.stageId) && FORK_CHILDREN.includes(after.stageId)) continue;
          const expected = witnessFor(cursor, after, walk);
          if (!expected) continue; // bookends and the fn-less subflow mount
          expect(cursor.stateAt(stop).state, `stop ${k} (${stop.label}) → ${after.label}`).toEqual(expected.state);
          checked += 1;
        }
        // Every outer stage that ran was covered — the loop's three bumps included.
        expect(checked).toBe(walk.filter((w) => w.stage !== 'grade' && w.stage !== 'explain').length - 1);
      });

      it('parallel siblings all enter from the state at the stop before the fork', async () => {
        const { walk, snapshot } = await runIt(mode);
        const cursor = timeTravel(snapshot);
        const firstChild = cursor.stops.findIndex((s) => s.stageId === FORK_CHILDREN[0]);
        const beforeFork = cursor.stops[firstChild - 1];

        for (const child of FORK_CHILDREN) {
          expect(walk.find((w) => w.stage === child)!.state).toEqual(cursor.stateAt(beforeFork).state);
        }
      });

      it('the last stop folds to the run’s final state', async () => {
        const { snapshot } = await runIt(mode);
        const cursor = timeTravel(snapshot);
        cursor.last();
        expect(cursor.at()!.kind).toBe('end');
        expect(cursor.stateAt().state).toEqual(snapshot.sharedState);
      });

      it('the first stop folds to the state before anything ran', async () => {
        const { walk, snapshot } = await runIt(mode);
        const cursor = timeTravel(snapshot);
        expect(cursor.at()!.kind).toBe('start');
        expect(cursor.stateAt().state).toEqual(walk[0].state);
        expect(cursor.stateAt().basis).toBe('initial+log');
      });

      it('the subflow’s array CONCATs back into the parent', async () => {
        const { snapshot } = await runIt(mode);
        expect(snapshot.sharedState.notes).toEqual(['seeded', 'graded pass', 'bump 2', 'bump 3', 'bump 4']);
      });
    });
  }

  it('both encodings produce the same stops and the same folded states', async () => {
    const full = await runIt('full');
    const delta = await runIt('delta');
    const a = timeTravel(full.snapshot);
    const b = timeTravel(delta.snapshot);

    expect(b.stops.map((s) => [s.step, s.runtimeStageId, s.kind, s.commitIdx, s.lastCommitIdx])).toEqual(
      a.stops.map((s) => [s.step, s.runtimeStageId, s.kind, s.commitIdx, s.lastCommitIdx]),
    );
    for (let k = 0; k < a.stops.length; k++) {
      expect(b.stateAt(b.stops[k]).state).toEqual(a.stateAt(a.stops[k]).state);
    }
    // …and the encodings really did differ in the log itself.
    expect(delta.snapshot.commitLog.some((c) => c.trace.some((t) => t.verb === 'append'))).toBe(true);
    expect(full.snapshot.commitLog.some((c) => c.trace.some((t) => t.verb === 'append'))).toBe(false);
  });

  describe('drilling into a subflow', () => {
    it('folds the subflow’s own log against its own base', async () => {
      const { walk, snapshot } = await runIt('full');
      const cursor = timeTravel(snapshot);
      const mount = cursor.stops.find((s) => s.kind === 'mount')!;
      const inner = cursor.drill(mount.runtimeStageId)!;

      expect(inner.path).toBe('sf-grade');
      expect(inner.mountRuntimeStageId).toBe(mount.runtimeStageId);
      expect(inner.parent).toBe(cursor);
      // A run's own cursor was drilled out of nothing.
      expect(cursor.mountRuntimeStageId).toBeUndefined();

      // 'start' on a drilled cursor IS the subflow's input seed.
      expect(inner.stateAt(inner.stops[0]).state).toEqual(walk.find((w) => w.stage === 'grade')!.state);

      const innerStages = inner.stops.filter((s) => s.kind === 'commit');
      expect(innerStages.map((s) => s.stageId)).toEqual(['sf-grade/grade', 'sf-grade/explain']);
      expect(inner.stateAt(innerStages[0]).state).toEqual(walk.find((w) => w.stage === 'explain')!.state);
    });

    it('agrees with getSubtreeSnapshot fed straight to stateAt', async () => {
      const { snapshot } = await runIt('full');
      const cursor = timeTravel(snapshot);
      const mount = cursor.stops.find((s) => s.kind === 'mount')!;
      const inner = cursor.drill(mount.runtimeStageId)!;
      const subtree = getSubtreeSnapshot(snapshot, 'sf-grade')!;

      expect(subtree.initialState).toEqual({});
      const last = inner.stops[inner.stops.length - 1];
      expect(stateAt(subtree, last.lastCommitIdx).state).toEqual(inner.stateAt(last).state);
    });

    it('a stop inside the subflow is NOT a stop of the outer cursor', async () => {
      const { snapshot } = await runIt('full');
      const cursor = timeTravel(snapshot);
      const mount = cursor.stops.find((s) => s.kind === 'mount')!;
      const inner = cursor.drill(mount.runtimeStageId)!;
      const innerStage = inner.stops.find((s) => s.kind === 'commit')!;

      expect(cursor.stops.some((s) => s.runtimeStageId === innerStage.runtimeStageId)).toBe(false);

      const before = cursor.at();
      const move = cursor.jumpTo(innerStage.runtimeStageId);
      expect(move.moved).toBe(false);
      expect(cursor.at()).toBe(before); // law 2: a miss never moves
    });

    it('returns undefined for a mount that is not there', async () => {
      const { snapshot } = await runIt('full');
      expect(timeTravel(snapshot).drill('no-such-mount#99')).toBeUndefined();
    });

    it('tells two iterations of ONE looping mount apart', async () => {
      // `path` is the subflow PATH, so every iteration of a mount inside a
      // loop reports the same string. A UI opening three drill panels would
      // label all three identically; `mountRuntimeStageId` is the iteration
      // that was actually opened.
      const inner = new FlowChartBuilder<any, any>()
        .start(
          'Echo',
          async (scope: any) => {
            scope.seen = scope.seedIn;
          },
          'echo',
        )
        .build();

      const chart = flowChart<any>(
        'Init',
        async (scope: any) => {
          scope.n = 0;
        },
        'init',
      )
        .addFunction(
          'Bump',
          async (scope: any) => {
            scope.n = scope.n + 1;
          },
          'bump',
        )
        .addSubFlowChartNext('sfx', inner, 'Echoing', {
          inputMapper: (parent: any) => ({ seedIn: parent.n }),
          outputMapper: (out: any) => ({ seen: out.seen }),
        })
        .addDeciderFunction('Check', async (scope: any) => (scope.n < 3 ? 'again' : 'done'), 'check')
        .addFunctionBranch('again', 'Again', async () => {}, undefined, { loopTo: 'bump' })
        .addFunctionBranch('done', 'Done', async () => {})
        .end()
        .build();

      const executor = new FlowChartExecutor(chart);
      await executor.run();
      const cursor = timeTravel(executor.getSnapshot());

      const mounts = cursor.stops.filter((s) => s.kind === 'mount');
      expect(mounts).toHaveLength(3);

      const drilled = mounts.map((m) => cursor.drill(m.runtimeStageId)!);
      expect(drilled.every((d) => d !== undefined)).toBe(true);

      // Same path for all three — that is the ambiguity...
      expect(new Set(drilled.map((d) => d.path))).toEqual(new Set(['sfx']));
      // ...and this is what resolves it.
      expect(drilled.map((d) => d.mountRuntimeStageId)).toEqual(mounts.map((m) => m.runtimeStageId));
      expect(new Set(drilled.map((d) => d.mountRuntimeStageId)).size).toBe(3);

      // Each really is a different iteration, not three views of the last.
      expect(drilled.map((d) => d.stateAt(d.stops[0]).state.seedIn)).toEqual([1, 2, 3]);
    });
  });

  describe('changedSince', () => {
    it('names exactly the keys the bundles in the range wrote', async () => {
      const { snapshot } = await runIt('full');
      const cursor = timeTravel(snapshot);

      for (const stop of cursor.stops) {
        cursor.jumpTo(stop.step);
        const previous = cursor.stops[stop.step - 1];
        const from = previous ? previous.lastCommitIdx + 1 : 0;
        const expected = new Set<string>();
        for (let i = from; i <= stop.lastCommitIdx; i++) {
          for (const entry of snapshot.commitLog[i].trace) expected.add(entry.path);
        }
        expect(cursor.changedSince(), `at ${stop.label}`).toEqual([...expected].sort());
      }
    });

    it('reports what a named earlier stop is responsible for', async () => {
      const { snapshot } = await runIt('full');
      const cursor = timeTravel(snapshot);
      const seed = cursor.stops.find((s) => s.stageId === 'seed')!;
      cursor.jumpTo(cursor.stops.find((s) => s.stageId === 'report')!.step);
      const keys = cursor.changedSince(seed);
      expect(keys).toContain('grade');
      expect(keys).toContain('report');
      expect(keys).not.toContain('looped'); // the loop ran AFTER the cursor's stop
    });
  });
});

/**
 * The strategy seam, from the composer's side (9.18.0).
 *
 * Three gaps two consumers hit in the same week, each with the test that would
 * have caught it:
 *
 *   1. A STRATEGY HAD NOWHERE TO PUT ITS OWN VOCABULARY. `Stop.kind` is the
 *      port's ('commit' | 'mount' | 'start' | 'end'), so a domain classifier's
 *      answer travelled by being RE-DERIVED from the runtimeStageId at every
 *      read — a second run of the classifier that just ran. `Stop.meta` now
 *      carries it, opaquely, and the port never reads it.
 *   2. `'start'` MEANS SOMETHING DIFFERENT ON A FILTERING STRATEGY. It must
 *      absorb the commits of the stages dropped before the first survivor, so
 *      its fold is the base PLUS that prologue — and `Stop.prologue` is how it
 *      says so, instead of a renderer assuming `kind: 'start'` means "the
 *      run's raw base" and being wrong on every derived axis.
 *   3. `[start, …stages, end]` WAS AN UNSTATED CONTRACT. Every composer wrote
 *      its own guard. `splitAxis` states it; `filterStops` keeps it.
 */

import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartBuilder, FlowChartExecutor } from '../../../src/index.js';
import type { Stop, TimeTravelStrategy } from '../../../src/trace.js';
import { commitStops, filterStops, splitAxis, stateAt, timeTravel } from '../../../src/trace.js';

// ── A real chart: a seed, a mount, and stages worth classifying ─────────────

/** The consumer's OWN vocabulary — nothing the port knows about. */
interface Beat {
  readonly kind: 'turn' | 'tool';
  readonly title: string;
}

const BEATS: Record<string, Beat> = {
  ask: { kind: 'turn', title: 'The question' },
  answer: { kind: 'turn', title: 'The answer' },
  lookup: { kind: 'tool', title: 'The lookup' },
};

/** Classify by the LOCAL stage id, the way a domain classifier really does. */
function beatFor(runtimeStageId: string): Beat | null {
  const local = runtimeStageId.split('#')[0].split('/').pop() ?? '';
  return BEATS[local] ?? null;
}

function buildChart() {
  const inner = new FlowChartBuilder<any, any>()
    .start(
      'Lookup',
      async (scope: any) => {
        scope.found = `row-${scope.needle}`;
      },
      'lookup',
    )
    .build();

  return flowChart<any>(
    'Seed',
    async (scope: any) => {
      scope.tenant = 'acme';
      scope.needle = 7;
    },
    'seed',
  )
    .addFunction(
      'Prepare',
      async (scope: any) => {
        scope.prepared = true;
      },
      'prepare',
    )
    .addFunction(
      'Ask',
      async (scope: any) => {
        scope.question = 'where?';
      },
      'ask',
    )
    .addSubFlowChartNext('sf-lookup', inner, 'Lookup', {
      inputMapper: (parent: any) => ({ needle: parent.needle }),
      outputMapper: (out: any) => ({ found: out.found }),
    })
    .addFunction(
      'Answer',
      async (scope: any) => {
        scope.answer = `${scope.question} ${scope.found}`;
      },
      'answer',
    )
    .build();
}

async function runIt() {
  const executor = new FlowChartExecutor(buildChart());
  await executor.run();
  return executor.getSnapshot();
}

/** The consumer's strategy, written the way 9.18.0 lets it be written. */
const beatStops: TimeTravelStrategy<Beat> = {
  stopsFor: (log, tree) =>
    filterStops<Beat>(commitStops(log, tree), (stop) => {
      const beat = beatFor(stop.runtimeStageId);
      return beat ? { label: beat.title, meta: beat } : null;
    }),
};

// ── Gap 1 — the strategy's own vocabulary rides ON the stop ─────────────────

describe("Stop.meta — a strategy's own vocabulary, carried not re-derived", () => {
  it('every stop the strategy labelled carries its meta, verbatim, out of timeTravel', async () => {
    const snapshot = await runIt();
    const cursor = timeTravel(snapshot, { strategy: beatStops });

    const labelled = cursor.stops.filter((stop) => stop.meta !== undefined);
    expect(labelled.map((s) => [s.stageId, s.meta!.kind])).toEqual([
      ['ask', 'turn'],
      ['answer', 'turn'],
    ]);
    // VERBATIM: the same object the strategy put there, not a copy or a clone.
    expect(labelled[0].meta).toBe(BEATS.ask);
    // The bookends carry none — the shipped grammar has no vocabulary to add.
    expect(cursor.stops[0].meta).toBeUndefined();
    expect(cursor.stops[cursor.stops.length - 1].meta).toBeUndefined();
  });

  it('filterStops over an axis that ALREADY carries meta strips the inherited meta unless the decision supplies one', async () => {
    const snapshot = await runIt();
    const beats = beatStops.stopsFor(snapshot.commitLog, snapshot.executionTree);
    expect(beats.filter((s) => s.meta !== undefined)).toHaveLength(2);

    interface Tag {
      tag: string;
    }
    const hasMetaKey = (stop: object) => Object.keys(stop).includes('meta');

    // `true` keeps the stop, not the OTHER strategy's vocabulary: a Tag axis
    // must not carry a Beat under the Tag type.
    const kept = filterStops<Tag>(beats, () => true);
    expect(kept.map((s) => s.stageId)).toEqual(beats.map((s) => s.stageId));
    expect(kept.some(hasMetaKey)).toBe(false);

    // An object WITHOUT meta relabels and still strips.
    const relabelled = filterStops<Tag>(beats, () => ({ label: 'x' }));
    expect(relabelled.slice(1, -1).every((s) => s.label === 'x')).toBe(true);
    expect(relabelled.some(hasMetaKey)).toBe(false);

    // The decision's own meta is the ONLY meta that survives — and never on a bookend.
    const tagged = filterStops<Tag>(beats, (s) => ({ meta: { tag: s.stageId } }));
    expect(tagged.slice(1, -1).map((s) => s.meta)).toEqual([{ tag: 'ask' }, { tag: 'answer' }]);
    expect(hasMetaKey(tagged[0])).toBe(false);
    expect(hasMetaKey(tagged[tagged.length - 1])).toBe(false);
  });

  it('survives jumpTo, marks and a drill into a subflow', async () => {
    const snapshot = await runIt();
    const cursor = timeTravel(snapshot, { strategy: beatStops });

    const answer = cursor.stops.find((s) => s.stageId === 'answer')!;
    const jumped = cursor.jumpTo(answer.runtimeStageId);
    expect(jumped.moved).toBe(true);
    expect(jumped.moved && jumped.to.meta).toBe(BEATS.answer);

    cursor.mark('here');
    cursor.first();
    const back = cursor.jumpToMark('here');
    expect(back.moved && back.to.meta).toBe(BEATS.answer);

    // The drilled cursor runs the SAME strategy over the subflow's own log,
    // and the classifier reads the local segment, so the inner stage is
    // classified there too.
    const mount = timeTravel(snapshot).stops.find((s) => s.kind === 'mount')!;
    const inner = cursor.drill(mount.runtimeStageId)!;
    expect(inner.stops.map((s) => [s.stageId, s.meta?.kind])).toEqual([
      ['', undefined],
      ['sf-lookup/lookup', 'tool'],
      ['', undefined],
    ]);
    expect(inner.stops[1].meta).toBe(BEATS.lookup);
  });

  it('the port assigns meta no meaning — it never reads, validates or branches on it', async () => {
    const snapshot = await runIt();
    const nonsense = { anything: Symbol('opaque') };
    const opaque: TimeTravelStrategy<typeof nonsense> = {
      stopsFor: (log, tree) => commitStops(log, tree).map((s) => ({ ...s, meta: nonsense })),
    };
    const cursor = timeTravel(snapshot, { strategy: opaque });
    expect(cursor.stops.every((s) => s.meta === nonsense)).toBe(true);
    // Movement and folds behave exactly as they do without it.
    expect(cursor.last().moved).toBe(true);
    expect(cursor.stateAt().state).toEqual(snapshot.sharedState);
  });
});

// ── Gap 2 — what `'start'` folds on a FILTERING axis ────────────────────────

describe("the 'start' bookend on a filtering strategy", () => {
  it('folds the base PLUS the prologue, and says so with prologue: true', async () => {
    const snapshot = await runIt();
    const perStage = timeTravel(snapshot);
    const beats = timeTravel(snapshot, { strategy: beatStops });

    const rawStart = perStage.stops[0];
    const beatStart = beats.stops[0];
    const firstBeat = beats.stops[1];

    // The library's own axis: start IS the raw fold base, and says nothing.
    expect(rawStart.kind).toBe('start');
    expect(rawStart.prologue).toBeUndefined();
    expect(perStage.stateAt(rawStart).state).toEqual(stateAt(snapshot, -1).state);

    // The derived axis: start is the state the FIRST BEAT read — the contract
    // the docs state, asserted against the fold at the right commit index.
    expect(beatStart.kind).toBe('start');
    expect(beatStart.prologue).toBe(true);
    expect(beatStart.lastCommitIdx).toBe(firstBeat.commitIdx - 1);
    expect(beats.stateAt(beatStart).state).toEqual(stateAt(snapshot, firstBeat.commitIdx - 1).state);

    // And it is NOT the raw base — the exact confusion the flag prevents. Two
    // whole stages (`seed`, `prepare`) folded into it.
    expect(beats.stateAt(beatStart).state).not.toEqual(stateAt(snapshot, -1).state);
    expect(Object.keys(beats.stateAt(beatStart).state).sort()).toEqual(['needle', 'prepared', 'tenant']);
    expect(Object.keys(stateAt(snapshot, -1).state)).toEqual([]);
  });

  it('an axis that dropped nothing before its first stop keeps a silent start', async () => {
    const snapshot = await runIt();
    const keepAll: TimeTravelStrategy<Beat> = {
      stopsFor: (log, tree) => filterStops<Beat>(commitStops(log, tree), () => true),
    };
    const cursor = timeTravel(snapshot, { strategy: keepAll });
    expect(cursor.stops[0].prologue).toBeUndefined();
    expect(cursor.stateAt(cursor.stops[0]).state).toEqual(stateAt(snapshot, -1).state);
    // Keeping everything reproduces the shipped axis, stop for stop.
    expect(cursor.stops.map((s) => [s.kind, s.commitIdx, s.lastCommitIdx])).toEqual(
      timeTravel(snapshot).stops.map((s) => [s.kind, s.commitIdx, s.lastCommitIdx]),
    );
  });

  it('the survivors still PARTITION the log — nothing is orphaned', async () => {
    const snapshot = await runIt();
    const cursor = timeTravel(snapshot, { strategy: beatStops });
    const stops = cursor.stops;

    // start covers [0 … its lastCommitIdx]; each stop runs to just before the
    // next one begins; the last stage stop runs to the end of the log.
    let covered = stops[0].lastCommitIdx;
    for (const stop of stops.slice(1, -1)) {
      expect(stop.commitIdx).toBe(covered + 1);
      covered = stop.lastCommitIdx;
    }
    expect(covered).toBe(snapshot.commitLog.length - 1);
    // A stop's fold is the state the NEXT beat read.
    const answer = stops.find((s) => s.stageId === 'answer')!;
    expect(cursor.stateAt(answer).state).toEqual(snapshot.sharedState);
  });

  it('a run the strategy recognises nothing in has two bookends and nowhere to stand', async () => {
    const snapshot = await runIt();
    const nothing: TimeTravelStrategy<Beat> = {
      stopsFor: (log, tree) => filterStops<Beat>(commitStops(log, tree), () => false),
    };
    const cursor = timeTravel(snapshot, { strategy: nothing });
    expect(cursor.stops.map((s) => s.kind)).toEqual(['start', 'end']);
    // Said out loud: this start folded the WHOLE run.
    expect(cursor.stops[0].prologue).toBe(true);
    expect(cursor.stateAt(cursor.stops[0]).state).toEqual(snapshot.sharedState);
    expect(cursor.jumpTo('answer#4').moved).toBe(false);
    // …and that is NOT the empty axis, which says the log itself was empty.
    expect(cursor.stops.length).toBe(2);
  });
});

// ── Gap 3 — the invariant a composer may rely on ────────────────────────────

describe('splitAxis — the [start, …stages, end] contract, stated once', () => {
  it('holds on an EMPTY log — and says empty, not broken', () => {
    const split = splitAxis(commitStops([]));
    expect(split.ok).toBe(false);
    expect(!split.ok && split.reason).toBe('empty');
    expect(!split.ok && split.kinds).toEqual([]);
  });

  it('holds on a ONE-STAGE log', async () => {
    const executor = new FlowChartExecutor(
      flowChart<any>(
        'Only',
        async (scope: any) => {
          scope.x = 1;
        },
        'only',
      ).build(),
    );
    await executor.run();
    const snapshot = executor.getSnapshot();
    const split = splitAxis(commitStops(snapshot.commitLog, snapshot.executionTree));
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.start.commitIdx).toBe(-1);
    expect(split.stages.map((s) => s.stageId)).toEqual(['only']);
    expect(split.end.lastCommitIdx).toBe(snapshot.commitLog.length - 1);
  });

  it('holds on a log with a MOUNT', async () => {
    const snapshot = await runIt();
    const split = splitAxis(commitStops(snapshot.commitLog, snapshot.executionTree));
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.stages.filter((s) => s.kind === 'mount').map((s) => s.stageId)).toEqual(['sf-lookup']);
    expect(split.end.kind).toBe('end');
  });

  it('holds on a log with a FORK', async () => {
    const executor = new FlowChartExecutor(
      flowChart<any>(
        'Seed',
        async (scope: any) => {
          scope.n = 0;
        },
        'seed',
      )
        .addListOfFunction([
          {
            id: 'fan-a',
            name: 'A',
            fn: async (scope: any) => {
              scope.a = 1;
            },
          },
          {
            id: 'fan-b',
            name: 'B',
            fn: async (scope: any) => {
              scope.b = 2;
            },
          },
        ])
        .build(),
    );
    await executor.run();
    const snapshot = executor.getSnapshot();
    const split = splitAxis(commitStops(snapshot.commitLog, snapshot.executionTree));
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.start.kind).toBe('start');
    expect(split.end.kind).toBe('end');
    // Each fork child appears ONCE, between the bookends.
    expect(split.stages.filter((s) => s.stageId.startsWith('fan-'))).toHaveLength(2);
  });

  it('refuses a strategy that broke the shape — a different fact from an empty run', () => {
    const bogus: Stop[] = [
      { step: 0, runtimeStageId: 'a#0', commitIdx: 0, lastCommitIdx: 0, stageId: 'a', label: 'A', kind: 'commit' },
    ];
    const split = splitAxis(bogus);
    expect(!split.ok && split.reason).toBe('not-bookended');
    expect(() => filterStops(bogus, () => true)).toThrow(/bookended axis/);
    // The refusal names what it actually saw, so the report is actionable.
    expect(() => filterStops(bogus, () => true)).toThrow(/\[commit\]/);
  });
});

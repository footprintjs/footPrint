/**
 * A pause and its resume, read as ONE axis (9.18.0).
 *
 * THE GAP. A cross-executor resume — persist the checkpoint, pick it up on a
 * fresh executor — produces TWO snapshots. The second run gets a fresh
 * runtime: its `commitLog` starts at index 0 and holds only the post-resume
 * commits. So a reader scrubbing a resumed run saw only the second half unless
 * the application had kept the paused snapshot and stitched the halves itself.
 *
 * THE HONEST BIT, tested here as hard as the feature: commit indices are
 * RUN-LOCAL. A chained stop still indexes its OWN source and says which one
 * (`sourceIdx`); only the STEPS run across the seam. And a chain that is not
 * ordered, or not from one lineage, is REFUSED with a reason — the execution
 * counter the engine never resets across a resume is what makes that
 * checkable.
 */

import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { stateAt, timeTravel } from '../../../src/trace.js';

interface GateState {
  trail?: string[];
  approved?: boolean;
  done?: boolean;
  [key: string]: unknown;
}

/** The pausable stage: asks on the first run, records the answer on resume. */
const gate: PausableHandler<any> = {
  execute: async () => ({ question: 'Approve?' }),
  resume: async (scope: any, input: unknown) => {
    scope.approved = (input as { approved?: boolean } | undefined)?.approved ?? false;
    scope.trail = [...(scope.trail ?? []), 'gate'];
  },
};

/** seed → prepare → gate (pausable) → finish. */
function buildChart() {
  return flowChart<GateState>(
    'Seed',
    (scope) => {
      scope.trail = ['seed'];
    },
    'seed',
  )
    .addFunction(
      'Prepare',
      (scope) => {
        scope.trail = [...(scope.trail ?? []), 'prepare'];
      },
      'prepare',
    )
    .addPausableFunction('Gate', gate, 'gate')
    .addFunction(
      'Finish',
      (scope) => {
        scope.trail = [...(scope.trail ?? []), 'finish'];
        scope.done = true;
      },
      'finish',
    )
    .build();
}

/** The real thing: pause on one executor, resume on a fresh one. */
async function pauseThenResume() {
  const chart = buildChart();
  const before = new FlowChartExecutor(chart);
  await before.run();
  const checkpoint = before.getCheckpoint()!;
  const paused = before.getSnapshot();

  const after = new FlowChartExecutor(chart);
  await after.resume(checkpoint, { approved: true });
  const resumed = after.getSnapshot();
  return { paused, resumed };
}

describe('a chained cursor — two snapshots, one axis', () => {
  it('really is two disjoint logs before it is chained', async () => {
    const { paused, resumed } = await pauseThenResume();
    expect(paused.commitLog.map((b) => b.stageId)).toEqual(['seed', 'prepare', 'gate']);
    // A fresh runtime: its own log, its own indices, starting again at 0.
    expect(resumed.commitLog.map((b) => b.stageId)).toEqual(['gate', 'finish']);
    expect(resumed.commitLog[0].idx).toBe(0);
    // …but the EXECUTION counter continued, which is the lineage signal.
    expect(paused.commitLog.map((b) => b.runtimeStageId)).toEqual(['seed#0', 'prepare#1', 'gate#2']);
    expect(resumed.commitLog.map((b) => b.runtimeStageId)).toEqual(['gate#3', 'finish#4']);
    // Read alone, the resumed half is missing the first half of the story.
    expect(timeTravel(resumed).stops.map((s) => s.stageId)).toEqual(['', 'gate', 'finish', '']);
  });

  it('gives ONE axis with one pair of bookends, each stop naming its source', async () => {
    const { paused, resumed } = await pauseThenResume();
    const chained = timeTravel([paused, resumed]);

    expect(chained.sourceCount).toBe(2);
    expect(chained.stops.map((s) => [s.kind, s.stageId, s.sourceIdx])).toEqual([
      ['start', '', 0],
      ['commit', 'seed', 0],
      ['commit', 'prepare', 0],
      ['commit', 'gate', 0],
      ['commit', 'gate', 1],
      ['commit', 'finish', 1],
      ['end', '', 1],
    ]);
    // Steps are contiguous across the seam; commit indices are NOT — they
    // restart, because they are run-local and the library will not pretend
    // otherwise.
    expect(chained.stops.map((s) => s.step)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(chained.stops.map((s) => s.commitIdx)).toEqual([-1, 0, 1, 2, 0, 1, 1]);
  });

  it('prev/next crosses the seam', async () => {
    const { paused, resumed } = await pauseThenResume();
    const chained = timeTravel([paused, resumed]);

    chained.jumpTo('gate#2'); // the LAST stop of the first leg
    expect(chained.at()!.sourceIdx).toBe(0);
    const forward = chained.next();
    expect(forward.moved).toBe(true);
    expect(forward.moved && forward.to.runtimeStageId).toBe('gate#3');
    expect(chained.at()!.sourceIdx).toBe(1);

    const backward = chained.prev();
    expect(backward.moved && backward.to.runtimeStageId).toBe('gate#2');
    expect(chained.at()!.sourceIdx).toBe(0);

    // …and the ends still clamp, on the chained axis rather than a leg's.
    chained.first();
    expect(chained.prev().moved).toBe(false);
    chained.last();
    expect(chained.at()!.sourceIdx).toBe(1);
    expect(chained.next().moved).toBe(false);
  });

  it('stateAt is correct on BOTH sides of the seam', async () => {
    const { paused, resumed } = await pauseThenResume();
    const chained = timeTravel([paused, resumed]);

    for (const stop of chained.stops) {
      const leg = stop.sourceIdx === 1 ? resumed : paused;
      const folded = chained.stateAt(stop);
      expect(folded.state, `${stop.label} (source ${stop.sourceIdx})`).toEqual(stateAt(leg, stop.lastCommitIdx).state);
      // The fold says which leg its index belongs to.
      expect(folded.sourceIdx).toBe(stop.sourceIdx);
      expect(folded.basis).toBe('initial+log');
    }

    // Before the pause: no approval yet. After: the run's real final state.
    expect(chained.stateAt(chained.stops[3]).state.approved).toBeUndefined();
    chained.last();
    expect(chained.stateAt().state).toEqual(resumed.sharedState);
    expect(chained.stateAt().state.trail).toEqual(['seed', 'prepare', 'gate', 'finish']);
  });

  it('changedSince walks a range that crosses the seam', async () => {
    const { paused, resumed } = await pauseThenResume();
    const chained = timeTravel([paused, resumed]);

    chained.jumpTo('finish#4');
    // Since the last PRE-pause stop: the resume half's writes, both legs' rows
    // walked in order rather than one leg's indices being read in the other.
    const across = chained.changedSince(chained.stops[3]);
    expect(across).toEqual(['approved', 'done', 'trail']);
    // The one-stop default is unchanged by chaining.
    expect(chained.changedSince()).toEqual(['done', 'trail']);
  });

  it('jumpTo by runtimeStageId finds a stop in EITHER leg', async () => {
    const { paused, resumed } = await pauseThenResume();
    const chained = timeTravel([paused, resumed]);

    expect(chained.jumpTo('seed#0').moved).toBe(true);
    expect(chained.at()!.sourceIdx).toBe(0);
    expect(chained.jumpTo('finish#4').moved).toBe(true);
    expect(chained.at()!.sourceIdx).toBe(1);

    // A miss still never moves, and still names a neighbour.
    const missed = chained.jumpTo('finish#99');
    expect(missed.moved).toBe(false);
    expect(!missed.moved && missed.reason).toBe('miss');
    expect(chained.at()!.runtimeStageId).toBe('finish#4');

    // A mark placed on one leg resolves on the chained axis by id.
    chained.jumpTo('seed#0');
    chained.mark('the beginning');
    chained.last();
    expect(chained.jumpToMark('the beginning').moved).toBe(true);
    expect(chained.at()!.runtimeStageId).toBe('seed#0');
  });

  it('a single source behaves EXACTLY as it did before chaining existed', async () => {
    const { paused } = await pauseThenResume();
    const plain = timeTravel(paused);
    const wrapped = timeTravel([paused]);
    expect(wrapped.sourceCount).toBe(1);
    expect(wrapped.stops).toEqual(plain.stops);
    // No `sourceIdx` on a one-source axis, and no `sourceIdx` on its folds.
    expect(wrapped.stops.every((s) => s.sourceIdx === undefined)).toBe(true);
    expect(wrapped.stateAt(wrapped.stops[1])).toEqual(plain.stateAt(plain.stops[1]));
  });
});

describe('a chain that is not one — refused with a reason, never guessed', () => {
  it('refuses sources handed over backwards', async () => {
    const { paused, resumed } = await pauseThenResume();
    expect(() => timeTravel([resumed, paused])).toThrow(/not past source 0's last/);
    expect(() => timeTravel([resumed, paused])).toThrow(/run order/);
  });

  it('refuses an unrelated run, which restarts the counter at 0', async () => {
    const { paused } = await pauseThenResume();
    const other = new FlowChartExecutor(buildChart());
    await other.run();
    // A different run of the same chart: `seed#0` again — not a continuation.
    expect(() => timeTravel([paused, other.getSnapshot()])).toThrow(/both record 'seed#0'/);
  });

  it('refuses a SAME-executor resume, whose one snapshot already holds both halves', async () => {
    const chart = buildChart();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const atPause = executor.getSnapshot();
    await executor.resume(executor.getCheckpoint()!, { approved: true });
    const whole = executor.getSnapshot();

    // The same runtime kept accumulating — one log with the whole story.
    expect(whole.commitLog.map((b) => b.stageId)).toEqual(['seed', 'prepare', 'gate', 'gate', 'finish']);
    expect(() => timeTravel([atPause, whole])).toThrow(/same-executor resume/);
    // …and read on its own it needs no chain at all.
    // Two `gate` stops, because the stage really did run twice — the pause
    // half (`gate#2`) and the resume half (`gate#3`), each its own execution.
    expect(timeTravel(whole).stops.map((s) => s.runtimeStageId)).toEqual([
      '',
      'seed#0',
      'prepare#1',
      'gate#2',
      'gate#3',
      'finish#4',
      '',
    ]);
  });

  it('refuses an empty chain', () => {
    expect(() => timeTravel([])).toThrow(/at least one source/);
  });
});

// ── The lineage signal the record carries ───────────────────────────────────

/**
 * A DIFFERENT chart, one stage longer, so its resumed half starts at a HIGHER
 * execution index than `buildChart()`'s paused half ends on (`gate2#4` vs
 * `gate#2`) and shares no runtimeStageId with it. Index order and id
 * uniqueness both pass — only the state can tell it is foreign.
 */
function buildForeignChart() {
  return flowChart<GateState>(
    'Seed2',
    (scope) => {
      scope.trail = ['seed2'];
    },
    'seed2',
  )
    .addFunction(
      'Alpha',
      (scope) => {
        scope.trail = [...(scope.trail ?? []), 'alpha'];
      },
      'alpha',
    )
    .addFunction(
      'Beta',
      (scope) => {
        scope.trail = [...(scope.trail ?? []), 'beta'];
      },
      'beta',
    )
    .addPausableFunction('Gate2', gate, 'gate2')
    .addFunction(
      'Finish2',
      (scope) => {
        scope.done = true;
      },
      'finish2',
    )
    .build();
}

async function foreignResumedLeg() {
  const chart = buildForeignChart();
  const before = new FlowChartExecutor(chart);
  await before.run();
  const after = new FlowChartExecutor(chart);
  await after.resume(before.getCheckpoint()!, { approved: false });
  return after.getSnapshot();
}

describe('lineage — a later leg must BEGIN where the earlier leg ENDED', () => {
  it('a real resume passes: the resumed initialState IS the state the paused leg folds to', async () => {
    const { paused, resumed } = await pauseThenResume();
    // The signal itself, stated plainly before it is relied on.
    expect(resumed.initialState).toEqual(stateAt(paused, paused.commitLog.length - 1).state);
    expect(() => timeTravel([paused, resumed])).not.toThrow();
  });

  it('refuses a FOREIGN leg whose indices happen to be higher, naming the seam', async () => {
    const { paused } = await pauseThenResume();
    const foreign = await foreignResumedLeg();

    // Both index checks are blind to it: higher counter, no shared id.
    expect(foreign.commitLog.map((b) => b.runtimeStageId)).toEqual(['gate2#4', 'finish2#5']);
    expect(foreign.initialState).not.toEqual(stateAt(paused, 2).state);

    expect(() => timeTravel([paused, foreign])).toThrow(/source 1's initialState is not the state source 0 folds to/);
    expect(() => timeTravel([paused, foreign])).toThrow(/one lineage/);
  });

  it('a leg with NO initialState (an older recording) is chained on the index checks alone — the documented degradation', async () => {
    const { paused, resumed } = await pauseThenResume();
    const foreign = await foreignResumedLeg();
    const bare = (leg: typeof resumed) => ({ commitLog: leg.commitLog, executionTree: leg.executionTree });

    // The real resume still reads as one axis; the leg rule CONTINUES the
    // fold from the paused half, which is the right state for a real resume.
    const chained = timeTravel([paused, bare(resumed)]);
    chained.last();
    expect(chained.stateAt().state).toEqual(resumed.sharedState);
    expect(chained.stateAt().basis).toBe('initial+log');

    // Said out loud, and pinned: without a base to compare, the foreign leg is
    // NOT caught. The index checks still run; the state check cannot.
    expect(() => timeTravel([paused, bare(foreign)])).not.toThrow();

    // The other side of the seam: an earlier leg with no base folds
    // 'log-only', and a log-only fold is not a state the check may hold a
    // real base against — so it does not pretend to.
    expect(stateAt(bare(paused), 2).basis).toBe('log-only');
    expect(() => timeTravel([bare(paused), resumed])).not.toThrow();
  });
});

/**
 * 9.17.0 code, unchanged, still compiles and still behaves identically.
 *
 * Everything 9.18.0 added is additive, and this file is the proof: it is
 * written the way the two consumers wrote it against 9.17.0 — bare `Stop`,
 * bare `TimeTravelStrategy`, bare `TimeTravel` and `Move`, a hand-rolled
 * bookend guard, a hand-rolled re-partition, and a domain kind RE-DERIVED from
 * the runtimeStageId at every read. None of it is touched, and the axis it
 * produces is asserted equal, stop for stop, to the one the new helpers build.
 *
 * That equality is what lets those repos DELETE their copies: the same axis,
 * from a third of the code, with the classification riding on the stop.
 */

import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import type { Move, Stop, TimeTravel, TimeTravelSource, TimeTravelStrategy } from '../../../src/trace.js';
import { commitStops, filterStops, timeTravel } from '../../../src/trace.js';

// ── The consumer's domain vocabulary, exactly as it was ────────────────────

interface Milestone {
  kind: 'turn' | 'tool';
  label: string;
}

const MILESTONES: Record<string, Milestone> = {
  ask: { kind: 'turn', label: 'LLM turn' },
  call: { kind: 'tool', label: 'Tool call' },
};

function milestoneFor(runtimeStageId: string): Milestone | null {
  const local = runtimeStageId.split('#')[0].split('/').pop() ?? '';
  return MILESTONES[local] ?? null;
}

/** 9.17.0: the kind could only travel by being derived a second time. */
function milestoneOf(stop: Stop): Milestone | null {
  return stop.runtimeStageId ? milestoneFor(stop.runtimeStageId) : null;
}

/** 9.17.0's milestoneStops, byte for byte in shape: guard, filter, re-partition. */
function milestoneStops(commitLog: any, executionTree?: any): Stop[] {
  const perStage = commitStops(commitLog, executionTree);
  if (perStage.length === 0) return [];

  const [start, ...rest] = perStage;
  const end = rest.pop();
  if (!start || start.kind !== 'start' || !end || end.kind !== 'end') {
    throw new Error('milestoneStops: commitStops returned an unexpected shape');
  }

  const kept = rest
    .map((stop) => ({ stop, milestone: milestoneFor(stop.runtimeStageId) }))
    .filter((row): row is { stop: Stop; milestone: Milestone } => row.milestone !== null);

  const first = kept[0];
  const stops: Stop[] = [{ ...start, step: 0, lastCommitIdx: (first ? first.stop.commitIdx : commitLog.length) - 1 }];
  for (const [i, { stop, milestone }] of kept.entries()) {
    const next = kept[i + 1];
    stops.push({
      ...stop,
      step: stops.length,
      lastCommitIdx: next ? next.stop.commitIdx - 1 : commitLog.length - 1,
      label: milestone.label,
    });
  }
  stops.push({ ...end, step: stops.length });
  return stops;
}

const oldStrategy: TimeTravelStrategy = { stopsFor: milestoneStops };

/** 9.18.0: the same axis, composed. */
const newStrategy: TimeTravelStrategy<Milestone> = {
  stopsFor: (log, tree) =>
    filterStops<Milestone>(commitStops(log, tree), (stop) => {
      const milestone = milestoneFor(stop.runtimeStageId);
      return milestone ? { label: milestone.label, meta: milestone } : null;
    }),
};

// ── The chart ──────────────────────────────────────────────────────────────

const chart = flowChart<any>(
  'Seed',
  async (scope: any) => {
    scope.tenant = 'acme';
  },
  'seed',
)
  .addFunction(
    'Ask',
    async (scope: any) => {
      scope.question = 'q?';
    },
    'ask',
  )
  .addFunction(
    'Call',
    async (scope: any) => {
      scope.tool = 'search';
    },
    'call',
  )
  .addFunction(
    'Wrap',
    async (scope: any) => {
      scope.done = true;
    },
    'wrap',
  )
  .build();

async function run() {
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  return executor.getSnapshot();
}

describe('a 9.17.0 consumer, unchanged', () => {
  it('compiles against the bare types and produces the axis it always did', async () => {
    const snapshot = await run();
    // The lens's own line: a `TimeTravelSource` variable holding a live
    // snapshot, and a bare `TimeTravel` holding the cursor.
    const source: TimeTravelSource = snapshot;
    const cursor: TimeTravel = timeTravel(source, { strategy: oldStrategy });

    expect(cursor.stops.map((s) => [s.kind, s.label, s.commitIdx, s.lastCommitIdx])).toEqual([
      ['start', 'Run start', -1, 0],
      ['commit', 'LLM turn', 1, 1],
      ['commit', 'Tool call', 2, 3],
      ['end', 'Run end', 3, 3],
    ]);
    // The old way of asking "which milestone is this?" still answers.
    expect(cursor.stops.map(milestoneOf).map((m) => m?.kind)).toEqual([undefined, 'turn', 'tool', undefined]);

    // A bare `Move`, read the way the lens's port reads one.
    const move: Move = cursor.jumpTo('ask#1');
    expect(move.moved).toBe(true);
    expect(move.moved ? move.to.label : '').toBe('LLM turn');
  });

  it('the 9.18.0 composition is the SAME axis — so the copy can be deleted', async () => {
    const snapshot = await run();
    const before = timeTravel(snapshot, { strategy: oldStrategy });
    const after = timeTravel(snapshot, { strategy: newStrategy });

    const shape = (stop: Stop) => [
      stop.step,
      stop.kind,
      stop.runtimeStageId,
      stop.label,
      stop.commitIdx,
      stop.lastCommitIdx,
    ];
    expect(after.stops.map(shape)).toEqual(before.stops.map(shape));
    for (const [k, stop] of after.stops.entries()) {
      expect(after.stateAt(stop).state).toEqual(before.stateAt(before.stops[k]).state);
    }

    // What it gains: the classification RIDES on the stop instead of being
    // re-derived, and the start says that it absorbed a prologue.
    expect(after.stops.map((s) => s.meta?.kind)).toEqual([undefined, 'turn', 'tool', undefined]);
    expect(after.stops[0].prologue).toBe(true);
    expect(before.stops[0].prologue).toBeUndefined();
  });

  it('every 9.17.0 fold result still has the shape it had', async () => {
    const snapshot = await run();
    const cursor = timeTravel(snapshot);
    cursor.last();
    const folded = cursor.stateAt();
    expect(Object.keys(folded).sort()).toEqual(['basis', 'redacted', 'redactedPaths', 'state', 'throughCommitIdx']);
    // The three 9.18.0 fields are ABSENT as keys, not present as `undefined` —
    // a 9.17.0 consumer that serializes or enumerates a stop sees no new key.
    const added = ['meta', 'sourceIdx', 'prologue'];
    expect(cursor.stops.every((s) => !Object.keys(s).some((key) => added.includes(key)))).toBe(true);
  });
});

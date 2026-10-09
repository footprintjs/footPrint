/**
 * A STORED recording drives the cursor with no cast (9.18.0).
 *
 * THE GAP. `TimeTravelSource.commitLog` was `readonly CommitBundle[]`, but a
 * recording arrives as parsed JSON and a careful consumer will not claim that
 * what came back off disk is a `CommitBundle`. So it either cast at the seam —
 * a lie with a comment on it, documented as a known wart — or could not call
 * the library at all. The source now takes `readonly unknown[]` and the
 * narrowing happens PER BUNDLE where the fold reads one, which is the only
 * place that can honestly do it.
 *
 * AND THE REFUSAL. One corrupt row loses that row, not the recording: it keeps
 * its index, contributes no state, gets no stop, and is reported BY INDEX with
 * a reason. Never a crash, and never a silently shorter log — which would
 * shift every commit index after it.
 *
 * Every recording here is written through `footprintjs/write`
 * (test/helpers/recordRun.ts) — the bytes the charts' executor wrote, with no
 * engine loaded.
 */

import { describe, expect, it } from 'vitest';

import type { ExecutionTree } from '../../../src/trace.js';
import { stateAt, timeTravel } from '../../../src/trace.js';
import { recordRun } from '../../helpers/recordRun.js';

/**
 * How a consumer really types a recording it read back off disk: rows it has
 * not validated, because it has not validated them.
 */
interface StoredRecording {
  readonly commitLog: readonly unknown[];
  readonly initialState?: Record<string, unknown>;
  readonly executionTree?: unknown;
}

/**
 * Collect → Decide → Report over a seeded tenant, written through
 * `footprintjs/write` (test/helpers/recordRun.ts) — the record that chart's
 * executor wrote, with no engine loaded. `live` is what a reader read off the
 * run: the log, its fold base, and the heap (`sharedState`).
 */
function record() {
  const run = recordRun({ tenant: { id: 'T-1', plan: 'enterprise' } });
  run.step('collect', (s) => s.set('events', ['collected']), { name: 'Collect' });
  run.step(
    'decide',
    (s) => s.set('verdict', (s.read('tenant') as { plan: string }).plan === 'enterprise' ? 'allow' : 'review'),
    { name: 'Decide' },
  );
  run.step('report', (s) => s.set('report', `${s.read('verdict')}/${(s.read('events') as string[]).length}`), {
    name: 'Report',
  });
  const live = { ...run.snapshot(), sharedState: run.state.getState() };
  // Through JSON and back — the real round trip, not a cast.
  const stored: StoredRecording = JSON.parse(
    JSON.stringify({ commitLog: live.commitLog, initialState: live.initialState }),
  );
  return { live, stored };
}

/** `tree` with node `id` marked as the subflow mount it is (`subflowId`), as the engine's tree marks one. */
function markMount(tree: ExecutionTree | undefined, id: string): ExecutionTree | undefined {
  if (!tree) return tree;
  return {
    ...tree,
    ...(tree.id === id ? { subflowId: id } : {}),
    ...(tree.next ? { next: markMount(tree.next, id) } : {}),
  };
}

describe('a JSON round-tripped recording — no cast at the seam', () => {
  it('drives timeTravel and stateAt with rows typed `unknown[]`', () => {
    const { live, stored } = record();

    // NO CAST on either call. `stored` is the consumer's own type.
    const cursor = timeTravel(stored);
    const folded = stateAt(stored, 1);

    expect(cursor.stops.map((s) => [s.kind, s.stageId])).toEqual([
      ['start', ''],
      ['commit', 'collect'],
      ['commit', 'decide'],
      ['commit', 'report'],
      ['end', ''],
    ]);
    cursor.last();
    expect(cursor.stateAt().state).toEqual(live.sharedState);
    expect(folded.state).toEqual(stateAt(live, 1).state);
    expect(folded.basis).toBe('initial+log');
    // A clean recording says nothing about gaps — the 9.17.0 shape exactly.
    expect(folded.skipped).toBeUndefined();
    expect(cursor.stateAt().skipped).toBeUndefined();
  });

  it('a live snapshot keeps the typed path it always had', () => {
    const { live, stored } = record();
    expect(timeTravel(live).stops).toEqual(timeTravel(stored).stops);
    expect(stateAt(live, 2)).toEqual(stateAt(stored, 2));
  });
});

describe('the structural fields of a stored recording — typed unknown, read as what they are', () => {
  /** A consumer's honest type for a WHOLE stored snapshot: nothing narrowed. */
  interface StoredSnapshot {
    readonly commitLog: readonly unknown[];
    readonly initialState?: Record<string, unknown>;
    readonly executionTree?: unknown;
    readonly subflowResults?: unknown;
  }

  /**
   * Seed (`given = 21`) → a subflow `sf` whose one stage doubles it, mapped in
   * and out — written as the engine writes a mount: the subflow's OWN record
   * (its seed, the inputMapper's values, committed under the mount's id `sf#1`;
   * then its stage under the prefixed id `sf/double#2`, numbered by the run's
   * one counter), and on the parent's log the mount's bundle (the
   * outputMapper's merge-back) and its `phase: 'exit'` continuation. The
   * subflow's result is dual-keyed, by subflow id and by the mount's execution.
   */
  function recordWithMount() {
    const run = recordRun();
    run.step('seed', (s) => s.set('given', 21), { name: 'Seed' });
    const sub = recordRun();
    sub.step('sf', (s) => s.set('given', run.state.getState().given), { name: 'Inner', runtimeStageId: 'sf#1' });
    sub.step('sf/double', (s) => s.set('doubled', (s.read('given') as number) * 2), {
      name: 'sf/Double',
      runtimeStageId: 'sf/double#2',
    });
    run.step('sf', (s) => s.set('doubled', sub.state.getState().doubled), { name: 'Inner' });
    run.step('sf', undefined, { name: 'Inner', phase: 'exit' });
    const result = {
      subflowId: 'sf',
      subflowName: 'Inner',
      treeContext: {
        stageContexts: sub.snapshot().executionTree?.next,
        history: sub.log.list(),
        initialState: sub.log.getInitialState(),
      },
      parentStageId: 'Inner',
    };
    const { commitLog, initialState, executionTree } = run.snapshot();
    const live = {
      commitLog,
      initialState,
      sharedState: run.state.getState(),
      executionTree: markMount(executionTree, 'sf'),
      subflowResults: { sf: result, 'sf#1': result },
    };
    const stored: StoredSnapshot = JSON.parse(JSON.stringify(live));
    return { live, stored };
  }

  it('reads the tree and the subflow results off parsed JSON — mount kind and drill both work, no cast', () => {
    const { live, stored } = recordWithMount();
    const cursor = timeTravel(stored);
    expect(cursor.stops.map((s) => [s.kind, s.stageId])).toEqual(
      timeTravel(live).stops.map((s) => [s.kind, s.stageId]),
    );

    const mount = cursor.stops.find((s) => s.kind === 'mount')!;
    const drilled = cursor.drill(mount.runtimeStageId)!;
    expect(drilled.stops.map((s) => s.stageId)).toEqual(['', 'sf/double', '']);
    drilled.last();
    expect(drilled.stateAt().state).toEqual({ given: 21, doubled: 42 });
  });

  it('a tree or a results map that is not an object is read as absent, never crashed on', () => {
    const { stored } = recordWithMount();
    const damaged: StoredSnapshot = { ...stored, executionTree: 'nope', subflowResults: 42 };
    const cursor = timeTravel(damaged);
    // Without a tree the mount is still found — by the entry/exit shape
    // heuristic, exactly as for a log handed over without its tree.
    expect(cursor.stops.filter((s) => s.kind === 'mount').map((s) => s.stageId)).toEqual(['sf']);
    // Without results there is nothing to drill into, and that is the answer.
    expect(cursor.drill(cursor.stops[2].runtimeStageId)).toBeUndefined();
  });
});

describe('a corrupted row — refused by index, never crashed on', () => {
  /** The same recording with row 1 replaced by whatever came off disk. */
  function corrupt(row: unknown): StoredRecording {
    const { stored } = record();
    return { ...stored, commitLog: [stored.commitLog[0], row, stored.commitLog[2]] };
  }

  it('names the index and the reason instead of throwing', () => {
    for (const [row, reason] of [
      [null, /index 1.*not an object \(null\)/],
      ['{"stageId":"decide"}', /index 1.*not an object \(string\)/],
      [{ stageId: 'decide' }, /index 1.*runtimeStageId is missing/],
      [{ runtimeStageId: 'decide#1', trace: { path: 'verdict' } }, /index 1.*trace is a object/],
    ] as const) {
      const stored = corrupt(row);
      const folded = stateAt(stored, 2);
      const said = (folded.skipped ?? []).map((gap) => `index ${gap.index}: ${gap.reason}`).join(' | ');
      expect(said, JSON.stringify(row)).toMatch(reason);
      expect(folded.skipped).toHaveLength(1);
      expect(folded.skipped![0].index).toBe(1);
    }
  });

  it('the gap HOLDS ITS INDEX, so every other commit still addresses the same row', () => {
    const { live } = record();
    const stored = corrupt(null);
    const cursor = timeTravel(stored);

    // Three rows in, three rows out: the surviving stages keep the indices
    // they had. A dropped row would have shifted 'report' from 2 to 1 and
    // silently re-pointed every stored commitIdx in the consumer's UI.
    expect(cursor.stops.map((s) => [s.stageId, s.commitIdx])).toEqual([
      ['', -1],
      ['collect', 0],
      ['report', 2],
      ['', 2],
    ]);
    expect(cursor.stops.find((s) => s.stageId === 'decide')).toBeUndefined();
    // 'collect' folds exactly as it did — the corruption is downstream of it.
    expect(cursor.stateAt(cursor.stops[1]).state).toEqual(stateAt(live, 0).state);
  });

  it('a fold that crosses the gap is INCOMPLETE and says so; one that stops short says nothing', () => {
    const stored = corrupt(null);

    const before = stateAt(stored, 0);
    expect(before.skipped).toBeUndefined();
    expect(before.state.verdict).toBeUndefined();

    const across = stateAt(stored, 2);
    expect(across.skipped).toEqual([{ index: 1, reason: 'not an object (null)' }]);
    // The lost row's write is honestly absent rather than invented…
    expect(across.state.verdict).toBeUndefined();
    // …while everything the readable rows wrote is still there.
    expect(across.state.events).toEqual(['collected']);
    expect(across.throughCommitIdx).toBe(2);
  });

  it('an entirely unreadable log is two bookends around nothing — NOT the empty axis', () => {
    const stored: StoredRecording = { commitLog: [null, 7, 'nope'], initialState: { seeded: true } };
    const cursor = timeTravel(stored);

    // Three rows arrived and none could be read. That is a different fact from
    // "this run committed nothing", and the axis keeps them apart: bookends
    // with no stage between them, versus `[]` for a genuinely empty log.
    expect(cursor.stops.map((s) => s.kind)).toEqual(['start', 'end']);
    expect(timeTravel({ commitLog: [] }).stops).toEqual([]);
    expect(cursor.jumpTo('decide#1').moved).toBe(false);

    const folded = stateAt(stored, 2);
    expect(folded.state).toEqual({ seeded: true });
    expect(folded.basis).toBe('initial+log');
    expect(folded.skipped?.map((g) => g.index)).toEqual([0, 1, 2]);
    expect(folded.skipped?.map((g) => g.reason)).toEqual([
      'not an object (null)',
      'not an object (number)',
      'not an object (string)',
    ]);
  });
});

describe('a row with no trace — refused by index, and the fold COMPLETES', () => {
  it('is a gap with a reason, not a crash in the fold or the cursor', () => {
    const { live, stored } = record();
    // Looks like a bundle from the outside — an id, a stage, even the writes —
    // but the one field the fold WALKS is not there.
    const traceless = { runtimeStageId: 'decide#1', stageId: 'decide', stage: 'Decide', updates: { verdict: 'allow' } };
    const damaged: StoredRecording = { ...stored, commitLog: [stored.commitLog[0], traceless, stored.commitLog[2]] };

    const folded = stateAt(damaged, 2);
    expect(folded.skipped).toEqual([{ index: 1, reason: 'trace is missing, not an array' }]);
    expect(folded.state.events).toEqual(['collected']);
    expect(folded.throughCommitIdx).toBe(2);

    const cursor = timeTravel(damaged);
    expect(cursor.stops.map((s) => [s.stageId, s.commitIdx])).toEqual([
      ['', -1],
      ['collect', 0],
      ['report', 2],
      ['', 2],
    ]);
    cursor.last();
    expect(cursor.stateAt().state.events).toEqual(['collected']);
    expect(cursor.stateAt().state).not.toEqual(live.sharedState);
    expect(cursor.changedSince(cursor.stops[0])).toEqual(['events', 'report']);
  });
});

describe('a source whose log is OPTIONAL — the shape a stored-recording consumer really types', () => {
  /** e.g. a lens's RecordedSnapshot: every field optional, the rest unknown. */
  interface OptionalLogRecording {
    readonly commitLog?: readonly unknown[];
    readonly initialState?: Record<string, unknown>;
    readonly [key: string]: unknown;
  }

  it('stateAt accepts the same optional shape timeTravel accepts', () => {
    const { live, stored } = record();
    const rec: OptionalLogRecording = { ...stored, recorders: [] };
    // NO CAST on either call — the same source drives both.
    expect(stateAt(rec, 1).state).toEqual(stateAt(live, 1).state);
    expect(timeTravel(rec).stops.map((s) => s.stageId)).toEqual(['', 'collect', 'decide', 'report', '']);
  });

  it('an absent log folds to the base and says it folded nothing', () => {
    const { stored } = record();
    const rec: OptionalLogRecording = { initialState: stored.initialState };
    const folded = stateAt(rec, 0);
    expect(folded.state).toEqual(stored.initialState);
    expect(folded.throughCommitIdx).toBe(-1);
    expect(folded.basis).toBe('initial+log');
    expect(folded.skipped).toBeUndefined();
  });
});

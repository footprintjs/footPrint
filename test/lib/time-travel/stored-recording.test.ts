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
 */

import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartBuilder, FlowChartExecutor } from '../../../src/index.js';
import { stateAt, timeTravel } from '../../../src/trace.js';

/**
 * How a consumer really types a recording it read back off disk: rows it has
 * not validated, because it has not validated them.
 */
interface StoredRecording {
  readonly commitLog: readonly unknown[];
  readonly initialState?: Record<string, unknown>;
  readonly executionTree?: unknown;
}

const chart = flowChart<any>(
  'Collect',
  async (scope: any) => {
    scope.events = ['collected'];
  },
  'collect',
)
  .addFunction(
    'Decide',
    async (scope: any) => {
      scope.verdict = scope.tenant.plan === 'enterprise' ? 'allow' : 'review';
    },
    'decide',
  )
  .addFunction(
    'Report',
    async (scope: any) => {
      scope.report = `${scope.verdict}/${scope.events.length}`;
    },
    'report',
  )
  .build();

async function record() {
  const executor = new FlowChartExecutor(chart, {
    initialContext: { tenant: { id: 'T-1', plan: 'enterprise' } },
  } as any);
  await executor.run();
  const live = executor.getSnapshot();
  // Through JSON and back — the real round trip, not a cast.
  const stored: StoredRecording = JSON.parse(
    JSON.stringify({ commitLog: live.commitLog, initialState: live.initialState }),
  );
  return { live, stored };
}

describe('a JSON round-tripped recording — no cast at the seam', () => {
  it('drives timeTravel and stateAt with rows typed `unknown[]`', async () => {
    const { live, stored } = await record();

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

  it('a live snapshot keeps the typed path it always had', async () => {
    const { live, stored } = await record();
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

  const inner = new FlowChartBuilder<any, any>()
    .start(
      'Double',
      async (scope: any) => {
        scope.doubled = scope.given * 2;
      },
      'double',
    )
    .build();

  const withMount = flowChart<any>(
    'Seed',
    async (scope: any) => {
      scope.given = 21;
    },
    'seed',
  )
    .addSubFlowChartNext('sf', inner, 'Inner', {
      inputMapper: (parent: any) => ({ given: parent.given }),
      outputMapper: (out: any) => ({ doubled: out.doubled }),
    })
    .build();

  async function recordWithMount() {
    const executor = new FlowChartExecutor(withMount);
    await executor.run();
    const live = executor.getSnapshot();
    const stored: StoredSnapshot = JSON.parse(JSON.stringify(live));
    return { live, stored };
  }

  it('reads the tree and the subflow results off parsed JSON — mount kind and drill both work, no cast', async () => {
    const { live, stored } = await recordWithMount();
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

  it('a tree or a results map that is not an object is read as absent, never crashed on', async () => {
    const { stored } = await recordWithMount();
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
  async function corrupt(row: unknown): Promise<StoredRecording> {
    const { stored } = await record();
    return { ...stored, commitLog: [stored.commitLog[0], row, stored.commitLog[2]] };
  }

  it('names the index and the reason instead of throwing', async () => {
    for (const [row, reason] of [
      [null, /index 1.*not an object \(null\)/],
      ['{"stageId":"decide"}', /index 1.*not an object \(string\)/],
      [{ stageId: 'decide' }, /index 1.*runtimeStageId is missing/],
      [{ runtimeStageId: 'decide#1', trace: { path: 'verdict' } }, /index 1.*trace is a object/],
    ] as const) {
      const stored = await corrupt(row);
      const folded = stateAt(stored, 2);
      const said = (folded.skipped ?? []).map((gap) => `index ${gap.index}: ${gap.reason}`).join(' | ');
      expect(said, JSON.stringify(row)).toMatch(reason);
      expect(folded.skipped).toHaveLength(1);
      expect(folded.skipped![0].index).toBe(1);
    }
  });

  it('the gap HOLDS ITS INDEX, so every other commit still addresses the same row', async () => {
    const { live } = await record();
    const stored = await corrupt(null);
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

  it('a fold that crosses the gap is INCOMPLETE and says so; one that stops short says nothing', async () => {
    const stored = await corrupt(null);

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

  it('an entirely unreadable log is two bookends around nothing — NOT the empty axis', async () => {
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
  it('is a gap with a reason, not a crash in the fold or the cursor', async () => {
    const { live, stored } = await record();
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

  it('stateAt accepts the same optional shape timeTravel accepts', async () => {
    const { live, stored } = await record();
    const rec: OptionalLogRecording = { ...stored, recorders: [] };
    // NO CAST on either call — the same source drives both.
    expect(stateAt(rec, 1).state).toEqual(stateAt(live, 1).state);
    expect(timeTravel(rec).stops.map((s) => s.stageId)).toEqual(['', 'collect', 'decide', 'report', '']);
  });

  it('an absent log folds to the base and says it folded nothing', async () => {
    const { stored } = await record();
    const rec: OptionalLogRecording = { initialState: stored.initialState };
    const folded = stateAt(rec, 0);
    expect(folded.state).toEqual(stored.initialState);
    expect(folded.throughCommitIdx).toBe(-1);
    expect(folded.basis).toBe('initial+log');
    expect(folded.skipped).toBeUndefined();
  });
});

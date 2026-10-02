/**
 * Scenario: the verb law at its public doors.
 *
 * One law (`memory/verbs.ts`), seen the way a consumer sees it:
 *
 *   (a) ENGINE LOGS — a real run, both `commitValues` encodings, writes only the
 *       four verbs, and every door agrees on it: the whole log folded through
 *       `applySmartMerge` (`footprintjs/advanced`) is the live state,
 *       `commitValueAt` / `arrayProvenance` (`footprintjs/trace`) answer what the
 *       state holds, and nothing throws. This is the "engine-written logs never
 *       carry an unknown verb, so every engine run is byte-identical" half of R2.
 *   (b) FOREIGN LOGS — the same log with one row's verb rewritten by a tool that
 *       did not know the contract. Every public replay and reader REFUSES it with
 *       `UnknownVerbError` naming the row (it used to fold the row as a merge);
 *       `stateAt` — the cursor's reader — keeps its own honest answer, a GAP, and
 *       folds the rest.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src';
import { applySmartMerge } from '../../../../src/advanced';
import type { CommitBundle } from '../../../../src/lib/memory/types';
import { isVerb } from '../../../../src/lib/memory/verbs';
import { arrayProvenance, commitValueAt, stateAt, UnknownVerbError } from '../../../../src/trace';

type Loose = Record<string, unknown>;

/** set, append (the growing history), merge (the profile), delete (the scratch key) — every verb the engine writes. */
function buildChart() {
  const work = (i: number) => async (scope: Loose & Record<string, any>) => {
    scope.$batchArray('history', (arr: unknown[]) => {
      arr.push({ idx: i });
    });
    scope.$update('profile', { [`n${i}`]: i });
    scope.$setValue('i', i + 1);
  };
  return flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('history', [] as unknown[]);
      scope.$setValue('profile', { name: 'a' });
      scope.$setValue('scratch', 1);
      scope.$setValue('i', 0);
    },
    'seed',
  )
    .addFunction('Work 0', work(0), 'work-0')
    .addFunction('Work 1', work(1), 'work-1')
    .addFunction('Work 2', work(2), 'work-2')
    .addFunction(
      'Cleanup',
      async (scope) => {
        (scope as any).$delete('scratch');
      },
      'cleanup',
    )
    .build();
}

async function run(commitValues: 'full' | 'delta') {
  const executor = new FlowChartExecutor(buildChart(), { commitValues });
  await executor.run();
  const snap = executor.getSnapshot();
  return { log: snap.commitLog, initialState: snap.initialState, state: snap.sharedState };
}

/** The whole log through the public replay, bundle by bundle — the state it says the run ended in. */
function foldAll(initialState: unknown, log: readonly CommitBundle[]): unknown {
  let state = structuredClone(initialState ?? {});
  for (const b of log) state = applySmartMerge(state, b.updates, b.overwrite, b.trace);
  return state;
}

describe('(a) engine logs: only the four verbs, and every door agrees', () => {
  for (const encoding of ['full', 'delta'] as const) {
    it(`commitValues '${encoding}'`, async () => {
      const { log, initialState, state } = await run(encoding);

      for (const bundle of log) for (const row of bundle.trace) expect(isVerb(row.verb)).toBe(true);
      const verbs = new Set(log.flatMap((b) => b.trace.map((t) => t.verb)));
      expect(verbs.has('merge')).toBe(true);
      if (encoding === 'delta') {
        expect(verbs.has('append')).toBe(true);
        expect(verbs.has('delete')).toBe(true);
      }

      expect(foldAll(initialState, log)).toEqual(state);
      const last = log.length - 1;
      expect(commitValueAt(log, last, 'history')).toEqual(state.history);
      expect(commitValueAt(log, last, 'profile')).toEqual(state.profile);
      expect(commitValueAt(log, last, 'i')).toEqual(state.i);
      expect(commitValueAt(log, last, 'scratch')).toBeUndefined();

      const provenance = arrayProvenance(log, 'history');
      expect(provenance.length).toBe(3);
      expect(provenance.births!.map((b) => b.stageId)).toEqual(['work-0', 'work-1', 'work-2']);
      expect(
        provenance.births!.every((b) => b.basis === (encoding === 'delta' ? 'append-verb' : 'prefix-inference')),
      ).toBe(true);
    });
  }
});

describe('(b) foreign logs: refused at every public door, a gap at the cursor', () => {
  /** A log a foreign tool rewrote: the `history` row of bundle `at` now carries a verb the contract does not name. */
  async function foreign(verb: string) {
    const { log, initialState } = await run('delta');
    const at = log.findIndex((b, i) => i > 0 && b.trace.some((t) => t.path === 'history'));
    const row = log[at].trace.findIndex((t) => t.path === 'history');
    const corrupted = structuredClone(log);
    (corrupted[at].trace[row] as { verb: string }).verb = verb;
    return { corrupted, initialState, at, row };
  }

  it('applySmartMerge, commitValueAt and arrayProvenance throw UnknownVerbError naming the row', async () => {
    const { corrupted, initialState, at, row } = await foreign('upsert');
    const bundle = corrupted[at];

    const replay = () => applySmartMerge(initialState ?? {}, bundle.updates, bundle.overwrite, bundle.trace);
    expect(replay).toThrow(UnknownVerbError);
    expect(replay).toThrow(`unknown verb "upsert" on trace row ${row}`);

    for (const read of [
      () => commitValueAt(corrupted, corrupted.length - 1, 'history'),
      () => arrayProvenance(corrupted, 'history'),
    ]) {
      let thrown: unknown;
      try {
        read();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(UnknownVerbError);
      expect(thrown).toMatchObject({ verb: 'upsert', path: 'history', row, commit: at });
    }
  });

  it('a key the bad row is not on is answered as before', async () => {
    const { corrupted } = await foreign('upsert');
    expect(commitValueAt(corrupted, corrupted.length - 1, 'profile')).toBeDefined();
    expect(arrayProvenance(corrupted, 'profile').missing).toBe('not-an-array');
  });

  it('stateAt keeps its own honest answer: the bundle is a gap, the rest of the log folds', async () => {
    const { corrupted, initialState, at } = await foreign('upsert');
    const folded = stateAt({ initialState, commitLog: corrupted }, corrupted.length - 1);
    expect(folded.skipped).toEqual([
      { index: at, reason: expect.stringContaining('verb is "upsert", not set | merge | append | delete') },
    ]);
    expect((folded.state as Loose).profile).toBeDefined();
  });

  it.each(['SET', 'Merge', '', 'constructor', '__proto__', 'toString'])('%j is not one of the four', async (verb) => {
    const { corrupted } = await foreign(verb);
    expect(() => commitValueAt(corrupted, corrupted.length - 1, 'history')).toThrow(UnknownVerbError);
  });
});

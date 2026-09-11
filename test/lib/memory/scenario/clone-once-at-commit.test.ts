/**
 * 9.23.0 — clone once at commit (docs/design/2026-09-clone-once-at-commit.md).
 *
 * The transaction buffer's patch trees and the stage's tracked writes hold
 * the caller's REFERENCES until the stage commits; the copy the record needs
 * is taken once per surviving path / key at that boundary instead of at
 * every write. Two things must be true of that, and this file pins both
 * through the real executor under BOTH `commitValues` encodings:
 *
 *   proof 2 — THE ONE MOVED BEHAVIOUR, by name: `$setValue(k, o); o.x = 1`
 *             in the same stage commits `x: 1` — the value the stage read
 *             back — so the log, the fold and the live heap agree (CLAUDE.md
 *             landmine 3's first bite, closed). This is the CHANGELOG example.
 *   proof 3 — THE LAW KEPT: after commit, mutating the caller's object changes
 *             NOTHING the engine retained — commit log, redacted mirror,
 *             execution-tree `stageWrites`, folded state.
 *
 * Proof 1 (byte-identity for every program that does not mutate its own
 * object) is the three reference suites: repeated-path-byte-identity,
 * redaction-no-policy-byte-identity, declared-tags-byte-identity.
 */

import { describe, expect, it } from 'vitest';

import type { CommitValuesMode, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import type { StageSnapshot } from '../../../../src/lib/memory/types.js';
import { stateAt } from '../../../../src/trace.js';

const ENCODINGS: CommitValuesMode[] = ['full', 'delta'];

interface State {
  doc: { x: number; tags: string[] };
  secret?: { token: string; kind: string };
}

function findStage(root: StageSnapshot, id: string): StageSnapshot | undefined {
  const work = [root];
  while (work.length > 0) {
    const s = work.pop()!;
    if (s.id === id) return s;
    if (s.next) work.push(s.next);
    if (s.children) work.push(...s.children);
  }
  return undefined;
}

describe('9.23.0 clone once at commit', () => {
  describe('proof 2 — the one moved behaviour: `$setValue(k, o); o.x = 1` commits x: 1', () => {
    it.each(ENCODINGS)('the bundle carries x: 1 and stateAt agrees with sharedState (%s)', async (commitValues) => {
      const chart = flowChart<State>(
        'Write',
        (scope: TypedScope<State>) => {
          const o = { x: 0, tags: ['a'] };
          scope.$setValue('doc', o);
          o.x = 1; // the caller's own object, after the write, before the stage ends
          o.tags.push('b');
          expect(scope.doc).toEqual({ x: 1, tags: ['a', 'b'] }); // the stage reads it back this way…
        },
        'write',
      ).build();
      const executor = new FlowChartExecutor(chart, { commitValues });
      await executor.run();

      const snapshot = executor.getSnapshot();
      const bundle = snapshot.commitLog.find((b) => b.stageId === 'write')!;
      expect(bundle.overwrite.doc).toEqual({ x: 1, tags: ['a', 'b'] }); // …and so does the record
      expect(snapshot.sharedState.doc).toEqual({ x: 1, tags: ['a', 'b'] });
      expect(stateAt(snapshot, snapshot.commitLog.length - 1).state.doc).toEqual({ x: 1, tags: ['a', 'b'] });
      expect(findStage(snapshot.executionTree, 'write')?.stageWrites?.doc).toEqual({ x: 1, tags: ['a', 'b'] });
    });

    it.each(ENCODINGS)(
      'the honest form of the old intent is `$setValue(k, structuredClone(o))` (%s)',
      async (commitValues) => {
        const chart = flowChart<State>(
          'Write',
          (scope: TypedScope<State>) => {
            const o = { x: 0, tags: ['a'] };
            scope.$setValue('doc', structuredClone(o));
            o.x = 1;
          },
          'write',
        ).build();
        const executor = new FlowChartExecutor(chart, { commitValues });
        await executor.run();
        const snapshot = executor.getSnapshot();
        expect(snapshot.commitLog.find((b) => b.stageId === 'write')!.overwrite.doc).toEqual({ x: 0, tags: ['a'] });
        expect(snapshot.sharedState.doc).toEqual({ x: 0, tags: ['a'] });
      },
    );
  });

  describe('proof 3 — the law kept: after commit, the record never aliases the caller’s object', () => {
    it.each(ENCODINGS)('log, mirror, stageWrites and fold are all detached (%s)', async (commitValues) => {
      let held!: { x: number; tags: string[] };
      let heldSecret!: { token: string; kind: string };
      const chart = flowChart<State>(
        'Write',
        (scope: TypedScope<State>) => {
          held = { x: 1, tags: ['a'] };
          heldSecret = { token: 'tok-1', kind: 'bearer' };
          scope.$setValue('doc', held);
          scope.$setValue('secret', heldSecret);
        },
        'write',
      )
        .addFunction(
          'Read',
          (scope: TypedScope<State>) => {
            expect(scope.doc.x).toBe(1);
          },
          'read',
        )
        .build();
      const executor = new FlowChartExecutor(chart, { commitValues });
      executor.setRedactionPolicy({ fields: { secret: ['token'] } });
      await executor.run();

      const snapshot = executor.getSnapshot();
      const bundle = snapshot.commitLog.find((b) => b.stageId === 'write')!;
      const writes = findStage(snapshot.executionTree, 'write')!.stageWrites!;
      const mirrorBefore = JSON.stringify(executor.getSnapshot({ redact: true }).sharedState);
      const foldBefore = JSON.stringify(stateAt(snapshot, snapshot.commitLog.length - 1).state);

      // Mutate the caller's objects AFTER the stage committed.
      held.x = 999;
      held.tags.push('z');
      heldSecret.kind = 'leaked';

      expect(bundle.overwrite.doc).toEqual({ x: 1, tags: ['a'] });
      expect((bundle.overwrite.secret as { kind: string }).kind).toBe('bearer');
      expect(writes.doc).toEqual({ x: 1, tags: ['a'] });
      expect(writes.secret).toEqual({ token: '[REDACTED]', kind: 'bearer' }); // scope-tier placeholder
      expect(snapshot.sharedState.doc).toEqual({ x: 1, tags: ['a'] });
      expect(JSON.stringify(executor.getSnapshot({ redact: true }).sharedState)).toBe(mirrorBefore);
      expect(JSON.stringify(stateAt(snapshot, snapshot.commitLog.length - 1).state)).toBe(foldBefore);
      // And none of the retained objects IS the caller's object.
      expect(bundle.overwrite.doc).not.toBe(held);
      expect(writes.doc).not.toBe(held);
      expect(snapshot.sharedState.doc).not.toBe(held);
    });

    it.each(ENCODINGS)(
      'consequence: an uncloneable value fails the run at COMMIT, loudly, and the failed run still snapshots (%s)',
      async (commitValues) => {
        // 9.22.1 threw the DataCloneError at the WRITE (inside the stage, where a
        // try/catch could swallow a contract violation and the run went on).
        // Clone-at-commit moves the throw to the commit: the stage cannot catch
        // it, the run fails with the same error, and — a consequence, not a
        // goal — none of that stage's writes land, because the payload itself
        // could not be built. "State values must survive structuredClone" is
        // the standing invariant; this is where it is now enforced.
        const chart = flowChart<State & { fn?: unknown; good?: number }>(
          'Write',
          (scope) => {
            scope.$setValue('good', 1);
            scope.$setValue('fn', () => 1);
          },
          'write',
        ).build();
        const executor = new FlowChartExecutor(chart, { commitValues });
        await expect(executor.run()).rejects.toMatchObject({ name: 'DataCloneError' });
        const snapshot = executor.getSnapshot(); // must not throw again
        expect(snapshot.sharedState.good).toBeUndefined();
        expect(snapshot.commitLog).toHaveLength(0);
      },
    );

    it.each(ENCODINGS)('a key written N times retains only its final value, detached (%s)', async (commitValues) => {
      const values: Array<{ x: number; tags: string[] }> = [];
      const chart = flowChart<State>(
        'Write',
        (scope: TypedScope<State>) => {
          for (let i = 0; i < 20; i++) {
            const v = { x: i, tags: [] };
            values.push(v);
            scope.$setValue('doc', v);
          }
        },
        'write',
      ).build();
      const executor = new FlowChartExecutor(chart, { commitValues });
      await executor.run();
      const snapshot = executor.getSnapshot();
      for (const v of values) v.x = -1;
      expect(snapshot.sharedState.doc).toEqual({ x: 19, tags: [] });
      expect(snapshot.commitLog.find((b) => b.stageId === 'write')!.overwrite.doc).toEqual({ x: 19, tags: [] });
      expect(findStage(snapshot.executionTree, 'write')?.stageWrites?.doc).toEqual({ x: 19, tags: [] });
    });
  });
});

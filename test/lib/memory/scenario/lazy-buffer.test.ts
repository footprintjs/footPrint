/**
 * Scenario: truly-lazy TransactionBuffer (backlog #13)
 *
 * The buffer is constructed on a stage's FIRST WRITE — never on reads, never
 * by commit(). A stage that only reads (or touches nothing) performs ZERO
 * structuredClones of the shared state; its commit still records the same
 * (empty) bundle it always did, so every executed stage remains a time-travel
 * cursor stop.
 *
 * Covers:
 *   (a) read-only / no-touch stages perform zero structuredClones of state
 *   (b) read-your-writes still holds after the first write
 *   (c) read-before-write returns the committed pre-write value
 *   (d) net-change commit semantics unchanged (same-value write → empty commit)
 *   (e) no-touch stage's commit bundle is byte-identical to the eager-buffer era
 *   (f) the commit baseline is anchored at the stage's FIRST TOUCH (not first
 *       write): a concurrent root-key commit landing between first read and
 *       first write must not shift the net-change diff base (eager parity),
 *       and fork-sibling namespace isolation is pinned e2e
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src';
import { EventLog } from '../../../../src/lib/memory/EventLog';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';

/** Seeds 'greeting' into run p1 via a first stage commit; returns a SECOND stage context. */
function seededCtx() {
  const mem = new SharedMemory();
  const log = new EventLog(mem.getState());
  const seed = new StageContext('p1', 'seed', 'seed', mem, '', log);
  seed.setObject([], 'greeting', 'hello');
  seed.setObject([], 'config', { retries: 3 });
  seed.commit();
  const ctx = new StageContext('p1', 'stage2', 'stage2', mem, '', log);
  return { mem, log, ctx };
}

describe('Scenario: lazy TransactionBuffer (#13)', () => {
  // ── (a) zero structuredClones for read-only / no-touch stages ────────────
  describe('zero clones for stages that never write', () => {
    const realClone = globalThis.structuredClone;
    let cloneCalls: unknown[];

    beforeEach(() => {
      cloneCalls = [];
      globalThis.structuredClone = ((value: unknown, opts?: StructuredSerializeOptions) => {
        cloneCalls.push(value);
        return realClone(value, opts);
      }) as typeof structuredClone;
    });

    afterEach(() => {
      globalThis.structuredClone = realClone;
    });

    it('untracked read + commit performs ZERO structuredClones', () => {
      const { ctx } = seededCtx();
      cloneCalls = [];

      expect(ctx.getValueDirect([], 'greeting')).toBe('hello');
      ctx.commit();

      expect(cloneCalls).toHaveLength(0);
    });

    it('no-touch commit leaves the shared state object untouched (no applyPatch replay)', () => {
      const { mem, ctx } = seededCtx();
      const stateRef = mem.getState();
      cloneCalls = [];

      ctx.commit();

      expect(cloneCalls).toHaveLength(0);
      // applyPatch replaces the state object wholesale; the fast path must not run it.
      expect(mem.getState()).toBe(stateRef);
    });

    it('tracked read clones only the read VALUE (#14 cost), never the full state', () => {
      const { mem, ctx } = seededCtx();
      cloneCalls = [];

      expect(ctx.getValue([], 'greeting')).toBe('hello');
      ctx.commit();

      // Exactly one clone: the _stageReads tracking copy of the small value.
      expect(cloneCalls).toEqual(['hello']);
      expect(cloneCalls[0]).not.toBe(mem.getState());
    });

    it('e2e: extra no-touch stages add ZERO structuredClone calls to a run', async () => {
      const noTouch = async () => {
        /* touches nothing */
      };
      const buildChart = (extraStages: number) => {
        const builder = flowChart<{ seeded: string }>(
          'Seed',
          async (scope) => {
            scope.seeded = 'yes';
          },
          'seed',
        );
        for (let i = 0; i < extraStages; i++) {
          builder.addFunction(`NoTouch${i}`, noTouch, `no-touch-${i}`);
        }
        return builder.build();
      };

      cloneCalls = [];
      await new FlowChartExecutor(buildChart(1)).run();
      const clonesWithOne = cloneCalls.length;

      cloneCalls = [];
      await new FlowChartExecutor(buildChart(5)).run();
      const clonesWithFive = cloneCalls.length;

      expect(clonesWithFive).toBe(clonesWithOne);
    });

    it('e2e: a read-only typed-scope stage costs exactly one clone (the tracked read value)', async () => {
      let lastRead: string | undefined;
      const buildChart = (readStages: number) => {
        const builder = flowChart<{ seeded: string }>(
          'Seed',
          async (scope) => {
            scope.seeded = 'yes';
          },
          'seed',
        );
        for (let i = 0; i < readStages; i++) {
          builder.addFunction(
            `Read${i}`,
            async (scope) => {
              lastRead = scope.seeded;
            },
            `read-${i}`,
          );
        }
        return builder.build();
      };

      cloneCalls = [];
      await new FlowChartExecutor(buildChart(1)).run();
      const clonesWithOne = cloneCalls.length;

      cloneCalls = [];
      await new FlowChartExecutor(buildChart(5)).run();
      const clonesWithFive = cloneCalls.length;

      // Each added read-only stage pays ONLY its tracked-read value clone
      // (read tracking is backlog #14) — no full-state buffer construction.
      expect(clonesWithFive - clonesWithOne).toBe(4);
      expect(lastRead).toBe('yes');
    });
  });

  // ── (b) read-your-writes ─────────────────────────────────────────────────
  describe('read-your-writes after the first write', () => {
    it('write then read in the same stage sees the new value', () => {
      const { ctx } = seededCtx();
      ctx.setObject([], 'greeting', 'updated');
      expect(ctx.getValue([], 'greeting')).toBe('updated');
      expect(ctx.getValueDirect([], 'greeting')).toBe('updated');
    });

    it('merge then read in the same stage sees the merged value', () => {
      const { ctx } = seededCtx();
      ctx.updateObject([], 'config', { mode: 'fast' });
      expect(ctx.getValue([], 'config')).toEqual({ retries: 3, mode: 'fast' });
    });

    it('e2e: typed-scope write then read in one stage sees the new value', async () => {
      let observed: string | undefined;
      const chart = flowChart<{ greeting: string }>(
        'Stage',
        async (scope) => {
          scope.greeting = 'written';
          observed = scope.greeting;
        },
        'stage',
      ).build();
      await new FlowChartExecutor(chart).run();
      expect(observed).toBe('written');
    });
  });

  // ── (c) read-before-write returns the committed pre-write value ──────────
  describe('read-before-write semantics', () => {
    it('reads before the first write return the committed value; after, the buffered one', () => {
      const { mem, ctx } = seededCtx();

      expect(ctx.getValue([], 'greeting')).toBe('hello'); // pre-write read
      ctx.setObject([], 'greeting', 'changed');
      expect(ctx.getValue([], 'greeting')).toBe('changed'); // buffered read

      // SharedMemory unchanged until commit
      expect(mem.getValue('p1', [], 'greeting')).toBe('hello');
      ctx.commit();
      expect(mem.getValue('p1', [], 'greeting')).toBe('changed');
    });

    it('after the first write, reads of OTHER keys still see committed values', () => {
      const { ctx } = seededCtx();
      ctx.setObject([], 'newKey', 1);
      expect(ctx.getValue([], 'greeting')).toBe('hello');
      expect(ctx.getValue([], 'config')).toEqual({ retries: 3 });
    });

    it('global-scope fallback works with and without a buffer', () => {
      const mem = new SharedMemory(undefined, { globalKey: 'globalVal' });
      const log = new EventLog(mem.getState());
      const ctx = new StageContext('p1', 'stage', 'stage', mem, '', log);

      expect(ctx.getValue([], 'globalKey')).toBe('globalVal'); // no buffer: straight read + fallback
      ctx.setObject([], 'localKey', 1); // buffer constructed
      expect(ctx.getValue([], 'globalKey')).toBe('globalVal'); // buffer miss → same fallback
    });
  });

  // ── (d) net-change commit semantics unchanged ────────────────────────────
  describe('net-change commit semantics', () => {
    it('writing the same value produces an EMPTY commit bundle', () => {
      const { log, ctx } = seededCtx();
      ctx.setObject([], 'greeting', 'hello'); // same value as committed
      ctx.commit();

      const bundle = log.list()[1];
      expect(bundle.overwrite).toEqual({});
      expect(bundle.updates).toEqual({});
      expect(bundle.trace).toEqual([]);
    });

    it('writing a new value produces the diff', () => {
      const { log, ctx } = seededCtx();
      ctx.setObject([], 'greeting', 'world');
      ctx.commit();

      const bundle = log.list()[1];
      expect(bundle.overwrite).toEqual({ runs: { p1: { greeting: 'world' } } });
      expect(bundle.trace).toHaveLength(1);
    });

    it('write-then-revert nets to an empty commit', () => {
      const { log, ctx } = seededCtx();
      ctx.setObject([], 'greeting', 'temp');
      ctx.setObject([], 'greeting', 'hello'); // revert to committed value
      ctx.commit();

      const bundle = log.list()[1];
      expect(bundle.overwrite).toEqual({});
      expect(bundle.trace).toEqual([]);
    });
  });

  // ── (e) no-touch commit bundle identical to the eager-buffer era ─────────
  describe('no-touch commit bundle parity', () => {
    it('records the same empty bundle shape, key order included', () => {
      const { log, ctx } = seededCtx();
      ctx.runtimeStageId = 'stage2#1';
      ctx.commit();

      const bundle = log.list()[1];
      expect(bundle).toEqual({
        overwrite: {},
        updates: {},
        redactedPaths: [],
        trace: [],
        stage: 'stage2',
        stageId: 'stage2',
        runtimeStageId: 'stage2#1',
        idx: 1,
      });
      // Key ORDER pins JSON byte-identity with the eager-buffer bundles.
      expect(Object.keys(bundle)).toEqual([
        'overwrite',
        'updates',
        'redactedPaths',
        'trace',
        'stage',
        'stageId',
        'runtimeStageId',
        'idx',
      ]);
    });

    it('commit observer still fires (with empty mutations) for a no-touch stage', () => {
      const { ctx } = seededCtx();
      let observedMutations: Record<string, unknown> | undefined;
      ctx.setCommitObserver((mutations) => {
        observedMutations = mutations;
      });
      ctx.commit();
      expect(observedMutations).toEqual({});
    });

    it('e2e: commitLog has one entry per stage — read-only and no-touch included', async () => {
      let readBack: string | undefined;
      const chart = flowChart<{ seeded: string }>(
        'Seed',
        async (scope) => {
          scope.seeded = 'yes';
        },
        'seed',
      )
        .addFunction(
          'ReadOnly',
          async (scope) => {
            readBack = scope.seeded;
          },
          'read-only',
        )
        .addFunction(
          'NoTouch',
          async () => {
            /* touches nothing */
          },
          'no-touch',
        )
        .build();

      const executor = new FlowChartExecutor(chart);
      await executor.run();
      const commitLog = executor.getSnapshot().commitLog;

      expect(readBack).toBe('yes');
      expect(commitLog.map((b) => b.runtimeStageId)).toEqual(['seed#0', 'read-only#1', 'no-touch#2']);
      const readOnly = commitLog[1];
      const noTouch = commitLog[2];
      for (const bundle of [readOnly, noTouch]) {
        expect(bundle.overwrite).toEqual({});
        expect(bundle.updates).toEqual({});
        expect(bundle.trace).toEqual([]);
        expect(bundle.redactedPaths).toEqual([]);
      }
    });
  });

  // ── (f) first-touch anchor: concurrent commit between first read and first
  //     write ──────────────────────────────────────────────────────────────
  // The case a sequential probe cannot hit. Fork siblings are namespace-
  // isolated for run-scoped keys (each child writes under runs/<childId>/),
  // but ROOT-level keys are shared: `setGlobal` is reachable from consumer
  // scope code AND from SubflowInputMapper's output mapping — exactly what
  // runs when a subflow is a fork branch. The eager engine anchored the
  // commit baseline (net-change diff base) at the stage's first ACCESS; the
  // lazy buffer must anchor its zero-clone state view at the same point, NOT
  // at first write, where a concurrent root-key commit landing in the gap
  // would shift the diff base and record a phantom change (or swallow a real
  // one). See firstTouchState() in StageContext.
  describe('first-touch anchor: concurrent root-key commit in the read→write gap', () => {
    it('commit baseline stays at first touch — rewriting the first-read value nets EMPTY', () => {
      const mem = new SharedMemory();
      const log = new EventLog(mem.getState());

      const seed = new StageContext('', 'seed', 'seed', mem, '', log);
      seed.setGlobal('g', 'orig');
      seed.commit();

      // Sibling B's first touch: a read. View anchored HERE (g='orig').
      const b = new StageContext('b', 'B', 'b', mem, '', log);
      expect(b.getValue([], 'g')).toBe('orig');

      // Sibling A commits g='A' into the gap (the subflow-outputMapper-
      // inside-a-fork pattern).
      const a = new StageContext('a', 'A', 'a', mem, '', log);
      a.setGlobal('g', 'A');
      a.commit();

      // Live fallback parity: 'g' is absent from B's namespaced view, so a
      // post-gap read sees the LIVE value — the eager engine's exact
      // visibility (its workingCopy lookup also missed runs/b/g and fell
      // back to live state). Only the DIFF BASE is pinned, not reads.
      expect(b.getValue([], 'g')).toBe('A');

      // B writes back what it FIRST read. Eager diffed against the
      // first-ACCESS base (g='orig') → no net change → EMPTY bundle. A
      // first-write anchor would diff against A's 'A' and record g:'orig' —
      // a phantom change that replays over (and clobbers) A's commit.
      b.setGlobal('g', 'orig');
      b.commit();

      const bundle = log.list().find((entry) => entry.stageId === 'b');
      expect(bundle?.overwrite).toEqual({});
      expect(bundle?.updates).toEqual({});
      expect(bundle?.trace).toEqual([]);

      // A's value survives — B's empty patch replays nothing over it.
      expect(mem.getValue('', [], 'g')).toBe('A');
    });

    it('keys present in the view at first touch read repeatably from it', () => {
      const { mem, log, ctx } = seededCtx();

      // First touch: 'greeting' IS in the view (runs/p1/greeting) → snapshot read.
      expect(ctx.getValue([], 'greeting')).toBe('hello');

      // Another context commits a change to the same run-namespaced key.
      const intruder = new StageContext('p1', 'intruder', 'intruder', mem, '', log);
      intruder.setObject([], 'greeting', 'changed');
      intruder.commit();
      expect(mem.getValue('p1', [], 'greeting')).toBe('changed');

      // View-present keys are repeatable: the eager engine served them from
      // its workingCopy clone; the lazy view serves the same bytes by
      // reference. (A first-write anchor would leak 'changed' here.)
      expect(ctx.getValue([], 'greeting')).toBe('hello');
    });

    it('e2e pin: fork siblings stay namespace-isolated; root keys are untouched by children', async () => {
      // Documents the REAL fork contract the anchor analysis rests on:
      // children write under runs/<childId>/ — invisible to siblings — and
      // the root namespace has no writers while plain-function children run.
      const reads: unknown[] = [];
      let crossSibling: unknown = 'sentinel';
      const chart = flowChart<{ k: string }>(
        'Seed',
        async (scope) => {
          scope.k = 'orig';
        },
        'seed',
      )
        .addListOfFunction([
          {
            id: 'fast-writer',
            name: 'FastWriter',
            fn: async (scope: { k: string }) => {
              scope.k = 'A'; // lands in runs/fast-writer/k, NOT the root k
            },
          },
          {
            id: 'slow-reader',
            name: 'SlowReader',
            fn: async (scope: { k: string } & Record<string, unknown>) => {
              reads.push(scope.k); // root k via live global fallback
              await new Promise((resolve) => setTimeout(resolve, 25)); // sibling commits here
              reads.push(scope.k); // root k unchanged — isolation, not snapshotting
              crossSibling = (scope as Record<string, unknown>).onlyInSibling;
            },
          },
        ])
        .build();

      const executor = new FlowChartExecutor(chart);
      await executor.run();
      const snapshot = executor.getSnapshot();

      expect(reads).toEqual(['orig', 'orig']);
      // A sibling's namespaced write is invisible to this child — by design.
      expect(crossSibling).toBeUndefined();

      const state = snapshot.sharedState as { k?: string; runs?: Record<string, { k?: string }> };
      expect(state.k).toBe('orig'); // root key untouched by children
      expect(state.runs?.['fast-writer']?.k).toBe('A'); // child write in its namespace
    });
  });
});

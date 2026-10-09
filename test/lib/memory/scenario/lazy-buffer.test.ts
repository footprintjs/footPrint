/**
 * Engine witnesses for the lazy-buffer contract (backlog #13).
 *
 * StageContext owns tracked-read retention and the commit observer; the executor supplies stage
 * boundaries and fork addresses. These tests keep those integration assertions. The record-owned
 * first-touch view, lazy allocation, addressed reads/writes, net diff and empty-bundle bytes are
 * exercised directly through RecordFrame in record-frame-lazy.test.ts.
 */
import { EventLog } from 'foottrace/write';
import { SharedMemory } from 'foottrace/write';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src';
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

describe('Scenario: lazy TransactionBuffer through the engine (#13)', () => {
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
    it('tracked and direct reads both see the stage’s buffered write', () => {
      const { ctx } = seededCtx();
      ctx.setObject([], 'greeting', 'updated');
      expect(ctx.getValue([], 'greeting')).toBe('updated');
      expect(ctx.getValueDirect([], 'greeting')).toBe('updated');
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

  // ── (e) no-touch commit bundle identical to the eager-buffer era ─────────
  describe('no-touch commit bundle parity', () => {
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

  describe('fork namespace integration', () => {
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

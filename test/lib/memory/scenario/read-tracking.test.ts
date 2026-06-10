/**
 * Scenario: read-tracking policy (backlog #14)
 *
 * The per-read `structuredClone` into `StageSnapshot.stageReads`
 * (StageContext.getValue) is policy-gated by `ReadTrackingMode`:
 *
 *   'full'    — default; per-read value clone. BYTE-IDENTICAL to history.
 *   'summary' — cheap ReadSummaryMarker per read (type/size/preview), no clone.
 *   'off'     — no stageReads tracking at all, zero per-read cost.
 *
 * The policy scopes ONLY the snapshot's stageReads payload. `onRead` events
 * (which pass the live reference, never cloned) and therefore narrative are
 * identical in every mode. Plumbed: executor option/`setReadTracking` →
 * `ExecutionRuntime.useReadTracking` → root StageContext → inherited via
 * createNext/createChild → pushed into subflow roots by SubflowExecutor.
 *
 * Covers:
 *   (a) default-mode parity — stageReads identical to today, clone included
 *       (negative control: the clone counter FIRES under 'full')
 *   (b) 'off' — zero clones, keys still readable, stageReads absent,
 *       narrative byte-identical to default
 *   (c) 'summary' — marker shapes per value type, no value clone
 *   (d) policy plumbing — executor option + setReadTracking reach root
 *       stages, fork children, and subflow stages
 *   (e) read-your-writes + commit semantics unaffected by the policy
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReadSummaryMarker } from '../../../../src';
import { flowChart, FlowChartExecutor } from '../../../../src';
import { EventLog } from '../../../../src/lib/memory/EventLog';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';
import type { StageSnapshot } from '../../../../src/lib/memory/types';

/** Seeds keys into run p1 via a first stage commit; returns a SECOND stage context. */
function seededCtx() {
  const mem = new SharedMemory();
  const log = new EventLog(mem.getState());
  const seed = new StageContext('p1', 'seed', 'seed', mem, '', log);
  seed.setObject([], 'greeting', 'hello');
  seed.setObject([], 'config', { retries: 3 });
  seed.setObject([], 'tags', ['a', 'b', 'c']);
  seed.setObject([], 'count', 42);
  seed.commit();
  const ctx = new StageContext('p1', 'stage2', 'stage2', mem, '', log);
  return { mem, log, ctx };
}

/** Depth-first walk of a StageSnapshot tree (next + children). */
function* walkTree(snap: StageSnapshot): Generator<StageSnapshot> {
  yield snap;
  if (snap.children) for (const child of snap.children) yield* walkTree(child);
  if (snap.next) yield* walkTree(snap.next);
}

function findStage(root: StageSnapshot, id: string): StageSnapshot | undefined {
  for (const snap of walkTree(root)) if (snap.id === id) return snap;
  return undefined;
}

describe('Scenario: read-tracking policy (#14)', () => {
  // ── Instrumented structuredClone (counts every clone + its value) ────────
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

  // ── (a) default ('full') — byte-identical to today ───────────────────────
  describe("default ('full') parity", () => {
    it('records a deep-cloned value per tracked read (detached from committed state)', () => {
      const { mem, ctx } = seededCtx();
      ctx.getValue([], 'config');
      ctx.getValue([], 'greeting');

      const snap = ctx.getSnapshot();
      expect(snap.stageReads).toEqual({ config: { retries: 3 }, greeting: 'hello' });
      // The recorded read is a CLONE, not the committed reference.
      expect(snap.stageReads?.config).not.toBe(mem.getValue('p1', [], 'config'));
    });

    it("NEGATIVE CONTROL: under 'full' the per-read value clone DOES fire (counter proof)", () => {
      // This is the assertion that fails if the default ever silently stops
      // cloning — and it validates that the counter used by the 'off'/'summary'
      // zero-clone tests below actually observes read-path clones.
      const { ctx } = seededCtx();
      cloneCalls = [];

      ctx.getValue([], 'config');

      expect(cloneCalls).toEqual([{ retries: 3 }]);
    });

    it('e2e: no option, explicit option, and setReadTracking("full") produce identical stageReads', async () => {
      const observed: unknown[] = [];
      const buildChart = () =>
        flowChart<{ seeded: string; config: { retries: number } }>(
          'Seed',
          async (scope) => {
            scope.seeded = 'yes';
            scope.config = { retries: 3 };
          },
          'seed',
        )
          .addFunction(
            'Reader',
            async (scope) => {
              observed.push(scope.seeded, scope.config);
            },
            'reader',
          )
          .build();

      const plain = new FlowChartExecutor(buildChart());
      await plain.run();
      const optioned = new FlowChartExecutor(buildChart(), { readTracking: 'full' });
      await optioned.run();
      const viaSetter = new FlowChartExecutor(buildChart());
      viaSetter.setReadTracking('full');
      await viaSetter.run();

      const readsOf = (ex: FlowChartExecutor) => findStage(ex.getSnapshot().executionTree, 'reader')?.stageReads;
      const expected = { seeded: 'yes', config: { retries: 3 } };
      expect(readsOf(plain)).toEqual(expected);
      expect(readsOf(optioned)).toEqual(expected);
      expect(readsOf(viaSetter)).toEqual(expected);
      expect(observed).toHaveLength(6); // 3 executors × 2 reads — all stages really ran
    });
  });

  // ── (b) 'off' — zero clones, keys still readable, stageReads absent ──────
  describe("'off' mode", () => {
    it('reads return values with ZERO structuredClones; stageReads absent from snapshot', () => {
      const { ctx } = seededCtx();
      ctx.useReadTracking('off');
      cloneCalls = [];

      expect(ctx.getValue([], 'greeting')).toBe('hello');
      expect(ctx.getValue([], 'config')).toEqual({ retries: 3 });
      ctx.commit();

      expect(cloneCalls).toHaveLength(0);
      expect(ctx.getSnapshot().stageReads).toBeUndefined();
    });

    it('e2e: extra read-only stages add ZERO clones (delta is 4 under default — see lazy-buffer test)', async () => {
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
      await new FlowChartExecutor(buildChart(1), { readTracking: 'off' }).run();
      const clonesWithOne = cloneCalls.length;

      cloneCalls = [];
      await new FlowChartExecutor(buildChart(5), { readTracking: 'off' }).run();
      const clonesWithFive = cloneCalls.length;

      expect(clonesWithFive).toBe(clonesWithOne);
      expect(lastRead).toBe('yes');
    });

    it('e2e: reader stage snapshot carries NO stageReads; writes still tracked', async () => {
      const chart = flowChart<{ seeded: string; derived?: string }>(
        'Seed',
        async (scope) => {
          scope.seeded = 'yes';
        },
        'seed',
      )
        .addFunction(
          'Reader',
          async (scope) => {
            scope.derived = `${scope.seeded}!`;
          },
          'reader',
        )
        .build();

      const executor = new FlowChartExecutor(chart, { readTracking: 'off' });
      await executor.run();

      const reader = findStage(executor.getSnapshot().executionTree, 'reader');
      expect(reader?.stageReads).toBeUndefined();
      expect(reader?.stageWrites).toEqual({ derived: 'yes!' }); // write tracking untouched
    });

    it("narrative is byte-identical between default and 'off' (onRead never cloned)", async () => {
      const buildChart = () =>
        flowChart<{ seeded: string; out?: string }>(
          'Seed',
          async (scope) => {
            scope.seeded = 'yes';
          },
          'seed',
        )
          .addFunction(
            'Reader',
            async (scope) => {
              scope.out = scope.seeded.toUpperCase();
            },
            'reader',
          )
          .build();

      const base = new FlowChartExecutor(buildChart());
      base.enableNarrative();
      await base.run();

      const off = new FlowChartExecutor(buildChart(), { readTracking: 'off' });
      off.enableNarrative();
      await off.run();

      const lines = (ex: FlowChartExecutor) => ex.getNarrativeEntries().map((e) => `${e.type}|${e.depth}|${e.text}`);
      expect(lines(off)).toEqual(lines(base));
      // The read line is genuinely present in both — 'off' silences the
      // snapshot view, not the recorder channel.
      expect(lines(off).some((line) => line.includes('seeded'))).toBe(true);
    });

    it("ScopeRecorder.onRead still fires with the value under 'off'", async () => {
      const reads: Array<{ key?: string; value: unknown }> = [];
      let lastRead: string | undefined;
      const chart = flowChart<{ seeded: string }>(
        'Seed',
        async (scope) => {
          scope.seeded = 'yes';
        },
        'seed',
      )
        .addFunction(
          'Reader',
          async (scope) => {
            lastRead = scope.seeded;
          },
          'reader',
        )
        .build();

      const executor = new FlowChartExecutor(chart, { readTracking: 'off' });
      executor.attachScopeRecorder({
        id: 'probe',
        onRead: (e) => reads.push({ key: e.key, value: e.value }),
      });
      await executor.run();

      expect(reads).toContainEqual({ key: 'seeded', value: 'yes' });
      expect(lastRead).toBe('yes');
    });
  });

  // ── (c) 'summary' — markers instead of cloned values ─────────────────────
  describe("'summary' mode", () => {
    it('records type/size/preview markers per value kind — with ZERO value clones', () => {
      const { ctx } = seededCtx();
      ctx.useReadTracking('summary');
      cloneCalls = [];

      ctx.getValue([], 'greeting'); // string
      ctx.getValue([], 'config'); // object
      ctx.getValue([], 'tags'); // array
      ctx.getValue([], 'count'); // number
      ctx.getValue([], 'missing'); // undefined

      expect(cloneCalls).toHaveLength(0);
      expect(ctx.getSnapshot().stageReads).toEqual({
        greeting: { __readSummary: true, type: 'string', size: 5, preview: 'hello' },
        config: { __readSummary: true, type: 'object', size: 1 },
        tags: { __readSummary: true, type: 'array', size: 3 },
        count: { __readSummary: true, type: 'number', preview: '42' },
        missing: undefined, // same shape as 'full' for absent keys
      });
    });

    it('string previews are capped at 80 characters', () => {
      const { ctx } = seededCtx();
      ctx.setObject([], 'long', 'x'.repeat(500));
      ctx.useReadTracking('summary');

      ctx.getValue([], 'long');

      const marker = ctx.getSnapshot().stageReads?.long as ReadSummaryMarker;
      expect(marker.size).toBe(500);
      expect(marker.preview).toHaveLength(80);
    });

    it('e2e: snapshot stageReads entries are markers, not values', async () => {
      const chart = flowChart<{ doc: { big: string }; touched?: boolean }>(
        'Seed',
        async (scope) => {
          scope.doc = { big: 'payload' };
        },
        'seed',
      )
        .addFunction(
          'Reader',
          async (scope) => {
            scope.touched = scope.doc.big.length > 0;
          },
          'reader',
        )
        .build();

      const executor = new FlowChartExecutor(chart, { readTracking: 'summary' });
      await executor.run();

      const reader = findStage(executor.getSnapshot().executionTree, 'reader');
      expect(reader?.stageReads?.doc).toEqual({ __readSummary: true, type: 'object', size: 1 });
    });
  });

  // ── (d) policy plumbing ──────────────────────────────────────────────────
  describe('policy plumbing', () => {
    it('createNext / createChild inherit the mode', () => {
      const { ctx } = seededCtx();
      ctx.useReadTracking('off');

      const next = ctx.createNext('p1', 'next-stage', 'next-stage');
      const child = ctx.createChild('p1', 'branch-1', 'child-stage', 'child-stage');

      expect(next.getReadTracking()).toBe('off');
      expect(child.getReadTracking()).toBe('off');
      // And it is live, not just stored: reads on the child track nothing.
      child.getValue([], 'greeting');
      expect(child.getSnapshot().stageReads).toBeUndefined();
    });

    it("e2e: 'off' reaches SUBFLOW stages (isolated runtime inherits via the mount context)", async () => {
      const inner = flowChart<{ seeded: string; innerOut?: string }>(
        'InnerRead',
        async (scope) => {
          scope.innerOut = `inner saw ${scope.seeded}`;
        },
        'inner-read',
      ).build();

      const buildOuter = () =>
        flowChart<{ seeded: string; innerOut?: string }>(
          'Seed',
          async (scope) => {
            scope.seeded = 'yes';
          },
          'seed',
        )
          .addSubFlowChartNext('sf-inner', inner, 'Inner', {
            inputMapper: (scope: { seeded: string }) => ({ seeded: scope.seeded }),
            outputMapper: (scope: { innerOut?: string }) => ({ innerOut: scope.innerOut }),
          })
          .build();

      const findInnerRead = (ex: FlowChartExecutor) => {
        const sf = ex.getSnapshot().subflowResults?.['sf-inner'] as
          | { treeContext: { stageContexts: StageSnapshot } }
          | undefined;
        expect(sf).toBeDefined();
        if (!sf) return undefined;
        for (const snap of walkTree(sf.treeContext.stageContexts)) {
          if (snap.id.endsWith('inner-read')) return snap;
        }
        return undefined;
      };

      const offEx = new FlowChartExecutor(buildOuter(), { readTracking: 'off' });
      await offEx.run();
      expect(findInnerRead(offEx)?.stageReads).toBeUndefined();

      // Control: the same subflow stage DOES track reads under the default.
      const defaultEx = new FlowChartExecutor(buildOuter());
      await defaultEx.run();
      expect(findInnerRead(defaultEx)?.stageReads).toEqual({ seeded: 'yes' });
    });

    it("e2e: 'off' reaches parallel fork children", async () => {
      const reads: string[] = [];
      const buildFork = () =>
        flowChart<{ seeded: string }>(
          'Seed',
          async (scope) => {
            scope.seeded = 'yes';
          },
          'seed',
        )
          .addListOfFunction([
            {
              id: 'child-a',
              name: 'ChildA',
              fn: async (scope: { seeded: string }) => {
                reads.push(`a:${scope.seeded}`);
              },
            },
            {
              id: 'child-b',
              name: 'ChildB',
              fn: async (scope: { seeded: string }) => {
                reads.push(`b:${scope.seeded}`);
              },
            },
          ])
          .build();

      const executor = new FlowChartExecutor(buildFork(), { readTracking: 'off' });
      await executor.run();

      expect(reads.sort()).toEqual(['a:yes', 'b:yes']);
      const tree = executor.getSnapshot().executionTree;
      expect(findStage(tree, 'child-a')?.stageReads).toBeUndefined();
      expect(findStage(tree, 'child-b')?.stageReads).toBeUndefined();

      // Control under default: children track their reads.
      const defaultEx = new FlowChartExecutor(buildFork());
      await defaultEx.run();
      expect(findStage(defaultEx.getSnapshot().executionTree, 'child-a')?.stageReads).toEqual({ seeded: 'yes' });
    });

    it('setReadTracking("off") before run() is equivalent to the constructor option', async () => {
      let lastRead: string | undefined;
      const chart = flowChart<{ seeded: string }>(
        'Seed',
        async (scope) => {
          scope.seeded = 'yes';
        },
        'seed',
      )
        .addFunction(
          'Reader',
          async (scope) => {
            lastRead = scope.seeded;
          },
          'reader',
        )
        .build();

      const executor = new FlowChartExecutor(chart);
      executor.setReadTracking('off');
      await executor.run();

      expect(lastRead).toBe('yes');
      expect(findStage(executor.getSnapshot().executionTree, 'reader')?.stageReads).toBeUndefined();
    });
  });

  // ── (e) read-your-writes + commit semantics unaffected ──────────────────
  describe('read-your-writes and commit semantics are policy-independent', () => {
    it.each(['off', 'summary'] as const)('%s: write-then-read sees the new value; commit diff intact', (mode) => {
      const { mem, log, ctx } = seededCtx();
      ctx.useReadTracking(mode);

      ctx.setObject([], 'greeting', 'updated');
      expect(ctx.getValue([], 'greeting')).toBe('updated'); // buffered read
      expect(ctx.getValue([], 'config')).toEqual({ retries: 3 }); // committed read
      ctx.commit();

      expect(mem.getValue('p1', [], 'greeting')).toBe('updated');
      const bundle = log.list()[1];
      expect(bundle.overwrite).toEqual({ runs: { p1: { greeting: 'updated' } } });
      expect(bundle.trace).toHaveLength(1);
    });

    it("e2e 'off': typed-scope write then read in one stage sees the new value", async () => {
      let observed: string | undefined;
      const chart = flowChart<{ greeting: string }>(
        'Stage',
        async (scope) => {
          scope.greeting = 'written';
          observed = scope.greeting;
        },
        'stage',
      ).build();
      await new FlowChartExecutor(chart, { readTracking: 'off' }).run();
      expect(observed).toBe('written');
    });
  });
});

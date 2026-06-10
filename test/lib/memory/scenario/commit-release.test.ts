/**
 * Scenario: per-stage staging state is RELEASED at commit end (backlog #13b)
 *
 * The execution tree retains every StageContext for the lifetime of the run.
 * Before #13b each context pinned, FOREVER:
 *   (a) its `stateView` — a reference to one full committed-state GENERATION
 *       (`applySmartMerge` clones + swaps the whole state per commit, so every
 *       stage's first-touch view is a DISTINCT full-state object), and
 *   (b) its TransactionBuffer — 2 full-state structuredClones, with zero
 *       release sites after commit.
 * On an agent-style loop with a growing history key that made retained heap
 * grow O(N²) — 563.8MB at N=200, OOM at N=500 on a default Node heap (#18).
 *
 * #13b: `StageContext.commit()` nulls `buffer` + `stateView` at the end of
 * BOTH paths (no-buffer fast path and buffer path). Both fields re-create
 * lazily, so re-use after commit (fork double-commit, subflow outputMapper
 * double-commit, engine post-commit writes) stays observably identical —
 * proven byte-for-byte by scripts/byte-identity-probe.ts across 9 scenarios.
 *
 * Covers:
 *   UNIT        — release on both commit paths; lazy re-anchor of reads and
 *                 writes after release; recommit bundle byte-identity
 *   FUNCTIONAL  — a 100-iteration loop chart retains ZERO buffers and ZERO
 *                 state-generation references in its execution tree
 *   INTEGRATION — fork double-commit, post-commit engine write (throttle
 *                 flag), subflow outputMapper double-commit
 *   PAUSE/RESUME— reads/writes/commit bundles across same-executor AND
 *                 cross-executor resume, incl. the rewrite-to-run-start
 *                 corner (diff base must be the post-pause state)
 *   PROPERTY    — random write/commit/read cycles on one context never
 *                 diverge from shared state
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../../src';
import { flowChart, FlowChartExecutor } from '../../../../src';
import { EventLog } from '../../../../src/lib/memory/EventLog';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';
import type { CommitBundle } from '../../../../src/lib/memory/types';

type Loose = Record<string, unknown>;

/** Test-only view of the released private fields. */
function staging(ctx: StageContext): { buffer: unknown; stateView: unknown } {
  const anyCtx = ctx as unknown as { buffer: unknown; stateView: unknown };
  return { buffer: anyCtx.buffer, stateView: anyCtx.stateView };
}

/** Walk the LIVE execution tree (next + children) collecting every context. */
function walkContexts(root: StageContext): StageContext[] {
  const out: StageContext[] = [];
  const work: StageContext[] = [root];
  while (work.length > 0) {
    const ctx = work.pop()!;
    out.push(ctx);
    if (ctx.next) work.push(ctx.next);
    if (ctx.children) work.push(...ctx.children);
  }
  return out;
}

/** The live root context of an executor's CURRENT runtime (test-only). */
function liveRoot(executor: FlowChartExecutor): StageContext {
  const runtime = (executor as unknown as { traverser: { getRuntime(): unknown } }).traverser.getRuntime() as {
    rootStageContext: StageContext;
    _snapshotRoot?: StageContext;
  };
  return runtime._snapshotRoot ?? runtime.rootStageContext;
}

function seededMemory() {
  const mem = new SharedMemory();
  const log = new EventLog(mem.getState());
  const seed = new StageContext('', 'seed', 'seed', mem, '', log);
  seed.setGlobal('greeting', 'hello');
  seed.setGlobal('count', 1);
  seed.commit();
  return { mem, log };
}

describe('Scenario: commit releases per-stage staging state (#13b)', () => {
  // ── UNIT — release on both commit paths ─────────────────────────────────
  describe('unit: release semantics', () => {
    it('buffer path: commit() nulls buffer and stateView', () => {
      const { mem, log } = seededMemory();
      const ctx = new StageContext('', 'writer', 'writer', mem, '', log);
      ctx.setGlobal('k', 'v');
      expect(staging(ctx).buffer).toBeDefined();
      expect(staging(ctx).stateView).toBeDefined();
      ctx.commit();
      expect(staging(ctx).buffer).toBeUndefined();
      expect(staging(ctx).stateView).toBeUndefined();
    });

    it('fast path: a read-only stage releases its stateView at commit', () => {
      const { mem, log } = seededMemory();
      const ctx = new StageContext('', 'reader', 'reader', mem, '', log);
      expect(ctx.getValue([], 'greeting')).toBe('hello');
      expect(staging(ctx).stateView).toBeDefined(); // first touch captured the view
      expect(staging(ctx).buffer).toBeUndefined(); // reads never construct the buffer (#13)
      ctx.commit();
      expect(staging(ctx).stateView).toBeUndefined();
    });

    it('post-commit read re-anchors on CURRENT state (sees own flushed writes)', () => {
      const { mem, log } = seededMemory();
      const ctx = new StageContext('', 'writer', 'writer', mem, '', log);
      ctx.setGlobal('k', 'v1');
      ctx.commit();
      expect(ctx.getValue([], 'k')).toBe('v1'); // re-created view includes the flushed write
      expect(mem.getValue('', [], 'k')).toBe('v1');
    });

    it('post-commit write gets a FRESH buffer whose diff base is post-commit state', () => {
      const { mem, log } = seededMemory();
      const ctx = new StageContext('', 'writer', 'writer', mem, '', log);
      ctx.setGlobal('k', 'v1');
      const firstBuffer = ctx.getTransactionBuffer();
      ctx.commit();

      // Same-value rewrite vs the POST-commit state → net no-change.
      ctx.setGlobal('k', 'v1');
      const secondBuffer = ctx.getTransactionBuffer();
      expect(secondBuffer).not.toBe(firstBuffer);
      ctx.commit();

      const bundles = log.list().filter((b: CommitBundle) => b.stageId === 'writer');
      expect(bundles).toHaveLength(2);
      expect(bundles[0].overwrite).toEqual({ k: 'v1' });
      expect(bundles[1].overwrite).toEqual({}); // no net change vs post-commit state
      expect(bundles[1].trace).toEqual([]);
    });

    it('recommit WITHOUT new writes records a bundle byte-identical to a no-touch stage', () => {
      const { mem, log } = seededMemory();
      const ctx = new StageContext('', 'writer', 'writer', mem, '', log);
      ctx.setGlobal('k', 'v1');
      ctx.commit();
      ctx.commit(); // the fork-wrapper double-commit shape

      const noTouch = new StageContext('', 'no-touch', 'no-touch', mem, '', log);
      noTouch.commit();

      const recommit = log.list().filter((b: CommitBundle) => b.stageId === 'writer')[1];
      const noTouchBundle = log.list().find((b: CommitBundle) => b.stageId === 'no-touch')!;
      const shape = ({ overwrite, updates, redactedPaths, trace }: CommitBundle) =>
        JSON.stringify({ overwrite, updates, redactedPaths, trace });
      expect(shape(recommit)).toBe(shape(noTouchBundle));
    });

    it('commit observer still fires with stageWrites on a released recommit', () => {
      const { mem, log } = seededMemory();
      const ctx = new StageContext('', 'writer', 'writer', mem, '', log);
      const observed: Array<Record<string, unknown>> = [];
      ctx.setCommitObserver((mutations) => observed.push(mutations));
      ctx.setObject([], 'k', 'v1');
      ctx.commit();
      ctx.commit();
      expect(observed).toHaveLength(2);
      expect(observed[0]).toEqual(observed[1]); // _stageWrites survives the release
    });
  });

  // ── FUNCTIONAL — loop chart retains no state generations ────────────────
  describe('functional: long loop retains zero staging state', () => {
    it('a 100-iteration growing-history loop retains ZERO buffers and ZERO state views', async () => {
      const ITERS = 100;
      const chart = flowChart<Loose>(
        'Seed',
        async (scope) => {
          scope.$setValue('i', 0);
          scope.$setValue('history', []);
        },
        'seed',
      )
        .addFunction(
          'Work',
          async (scope) => {
            const i = scope.$getValue('i') as number;
            scope.$batchArray('history', (arr) => {
              arr.push({ idx: i, payload: 'x'.repeat(200) });
            });
            scope.$setValue('i', i + 1);
            if (i + 1 >= ITERS) scope.$break();
          },
          'work',
        )
        .loopTo('work')
        .build();

      const executor = new FlowChartExecutor(chart);
      await executor.run({ maxIterations: ITERS + 1 });

      const contexts = walkContexts(liveRoot(executor));
      // The tree itself IS retained (one context per executed stage)…
      expect(contexts.length).toBeGreaterThanOrEqual(ITERS);
      // …but NOT the staging state: pre-#13b this held ~100 distinct
      // full-state generations (stateView) + ~100 buffers (2 clones each).
      const retainedBuffers = contexts.filter((c) => staging(c).buffer !== undefined);
      const retainedViews = contexts.filter((c) => staging(c).stateView !== undefined);
      expect(retainedBuffers).toHaveLength(0);
      expect(retainedViews).toHaveLength(0);

      // Sanity: the run itself was correct.
      const snap = executor.getSnapshot();
      expect((snap.sharedState.history as unknown[]).length).toBe(ITERS);
    });
  });

  // ── INTEGRATION — engine re-commit / post-commit-write paths ────────────
  describe('integration: engine double-commit paths stay observably identical', () => {
    it('fork children: wrapper double-commit records one real + one EMPTY bundle per child', async () => {
      const chart = flowChart<Loose>(
        'Seed',
        async (scope) => {
          scope.$setValue('k', 'orig');
        },
        'seed',
      )
        .addListOfFunction([
          {
            id: 'child-a',
            name: 'ChildA',
            fn: async (scope: Loose & { $setValue(k: string, v: unknown): void }) => {
              scope.$setValue('a', 1);
            },
          },
          {
            id: 'child-b',
            name: 'ChildB',
            fn: async (scope: Loose & { $setValue(k: string, v: unknown): void }) => {
              scope.$setValue('b', 2);
            },
          },
        ])
        .addFunction(
          'Join',
          async (scope) => {
            scope.$setValue('joined', true);
          },
          'join',
        )
        .build();
      const executor = new FlowChartExecutor(chart);
      await executor.run();

      const log = executor.getSnapshot().commitLog;
      for (const childId of ['child-a', 'child-b']) {
        const bundles = log.filter((b) => b.stageId === childId);
        expect(bundles).toHaveLength(2); // executeNode commit + ChildrenExecutor wrapper commit
        expect(Object.keys(bundles[0].overwrite)).not.toHaveLength(0);
        expect(bundles[1].overwrite).toEqual({}); // released context → empty fast-path bundle
        expect(bundles[1].trace).toEqual([]);
      }
      // And every fork-child context released its staging state.
      const contexts = walkContexts(liveRoot(executor));
      expect(contexts.some((c) => staging(c).buffer !== undefined)).toBe(false);
      expect(contexts.some((c) => staging(c).stateView !== undefined)).toBe(false);
    });

    it('post-commit engine write (throttle flag) lands in stageWrites, NOT in shared state', async () => {
      const chart = flowChart<Loose>(
        'Seed',
        async (scope) => {
          scope.$setValue('k', 'orig');
        },
        'seed',
      )
        .addListOfFunction([
          {
            id: 'ok-child',
            name: 'OkChild',
            fn: async (scope: Loose & { $setValue(k: string, v: unknown): void }) => {
              scope.$setValue('ok', true);
            },
          },
          {
            id: 'throttled-child',
            name: 'ThrottledChild',
            fn: async () => {
              throw new Error('429 rate limited');
            },
          },
        ])
        .addFunction('Join', async () => undefined, 'join')
        .build();
      const executor = new FlowChartExecutor(chart, {
        throttlingErrorChecker: (error: unknown) => String(error).includes('429'),
      });
      await executor.run();

      // ChildrenExecutor writes monitor.isThrottled AFTER the wrapper commit —
      // a staged-never-committed write on a RELEASED context. Pre-#13b it
      // stayed in the (reset) buffer; post-#13b a fresh buffer stages it.
      // Either way it reaches stageWrites (the snapshot) and never sharedState.
      const snap = executor.getSnapshot();
      const findStage = (node: any, id: string): any => {
        if (!node) return undefined;
        if (node.id === id) return node;
        const inChildren = (node.children ?? []).map((c: any) => findStage(c, id)).find(Boolean);
        return inChildren ?? findStage(node.next, id);
      };
      const throttled = findStage(snap.executionTree, 'throttled-child');
      expect(throttled?.stageWrites?.['monitor.isThrottled']).toBe(true);
      expect((snap.sharedState as Loose).monitor).toBeUndefined();
      expect(snap.commitLog.some((b) => JSON.stringify(b.overwrite).includes('isThrottled'))).toBe(false);
    });

    it('subflow outputMapper double-commit: parent mount bundles + final state unchanged', async () => {
      const inner = flowChart<Loose>(
        'InnerWork',
        async (scope) => {
          scope.$setValue('innerResult', `got:${scope.$getValue('seededKey')}`);
        },
        'inner-work',
      ).build();
      const chart = flowChart<Loose>(
        'Outer',
        async (scope) => {
          scope.$setValue('outerKey', 'outer-value');
        },
        'outer',
      )
        .addSubFlowChartNext('sf-inner', inner, 'Inner', {
          inputMapper: () => ({ seededKey: 'seeded-value' }),
          outputMapper: (out: Loose) => ({ innerResult: out.innerResult }),
        })
        .addFunction(
          'After',
          async (scope) => {
            scope.$setValue('after', scope.$getValue('innerResult'));
          },
          'after',
        )
        .build();
      const executor = new FlowChartExecutor(chart);
      await executor.run();

      const snap = executor.getSnapshot();
      expect((snap.sharedState as Loose).innerResult).toBe('got:seeded-value');
      expect((snap.sharedState as Loose).after).toBe('got:seeded-value');
      // outputContext.commit() at SubflowExecutor:282 + parentContext.commit()
      // at :317 — the second is empty on the released context.
      const mountBundles = snap.commitLog.filter((b) => b.stageId === 'sf-inner');
      expect(mountBundles.length).toBeGreaterThanOrEqual(2);
      expect(mountBundles[0].overwrite).toEqual({ innerResult: 'got:seeded-value' });
      expect(mountBundles[mountBundles.length - 1].overwrite).toEqual({});
    });
  });

  // ── PAUSE/RESUME — bundles across resume ────────────────────────────────
  describe('pause/resume: reads, writes, and bundles across resume', () => {
    function pausableChart() {
      const handler: PausableHandler<Loose> = {
        execute: async () => ({ question: 'approve?' }),
        resume: async (scope, input) => {
          const s = scope as Loose & {
            $getValue(k: string): unknown;
            $setValue(k: string, v: unknown): void;
          };
          s.$setValue('resumeRead', s.$getValue('k'));
          s.$setValue('k', `resumed:${String((input as Loose).approved)}`);
        },
      };
      return flowChart<Loose>(
        'Seed',
        async (scope) => {
          scope.$setValue('k', 'orig');
        },
        'seed',
      )
        .addFunction(
          'Mutate',
          async (scope) => {
            scope.$setValue('k', 'mutated');
          },
          'mutate',
        )
        .addPausableFunction('Approve', handler, 'approve')
        .addFunction(
          'Finish',
          async (scope) => {
            scope.$setValue('finished', scope.$getValue('k'));
          },
          'finish',
        )
        .build();
    }

    it('pause commit releases the paused context; resume runs on a FRESH context', async () => {
      const chart = pausableChart();
      const executor = new FlowChartExecutor(chart);
      await executor.run();
      expect(executor.isPaused()).toBe(true);

      // Every context in the paused tree — including the paused stage's —
      // released its staging state at the pause commit.
      const pausedContexts = walkContexts(liveRoot(executor));
      expect(pausedContexts.some((c) => staging(c).buffer !== undefined)).toBe(false);
      expect(pausedContexts.some((c) => staging(c).stateView !== undefined)).toBe(false);

      await executor.resume(executor.getCheckpoint()!, { approved: true });
      expect(executor.isPaused()).toBe(false);

      const snap = executor.getSnapshot();
      // The resume handler READ the post-pause value (k='mutated')…
      expect((snap.sharedState as Loose).resumeRead).toBe('mutated');
      // …its WRITES committed and the continuation saw them.
      expect((snap.sharedState as Loose).k).toBe('resumed:true');
      expect((snap.sharedState as Loose).finished).toBe('resumed:true');

      // The resume stage's commit bundle records the exact net change.
      const approveBundles = snap.commitLog.filter((b) => b.stageId === 'approve');
      const resumeBundle = approveBundles[approveBundles.length - 1];
      expect(resumeBundle.overwrite).toEqual({ resumeRead: 'mutated', k: 'resumed:true' });
    });

    it('corner: resumeFn rewriting a key to its RUN-START value IS recorded (diff base = post-pause state)', async () => {
      const handler: PausableHandler<Loose> = {
        execute: async () => ({ question: 'approve?' }),
        resume: async (scope) => {
          const s = scope as Loose & { $setValue(k: string, v: unknown): void };
          // 'orig' is the RUN-START value; pre-pause stages changed k to
          // 'mutated'. This is a REAL change at resume time — a stale
          // run-start diff base would swallow it.
          s.$setValue('k', 'orig');
        },
      };
      const chart = flowChart<Loose>(
        'Seed',
        async (scope) => {
          scope.$setValue('k', 'orig');
        },
        'seed',
      )
        .addFunction(
          'Mutate',
          async (scope) => {
            scope.$setValue('k', 'mutated');
          },
          'mutate',
        )
        .addPausableFunction('Approve', handler, 'approve')
        .build();

      const executor = new FlowChartExecutor(chart);
      await executor.run();
      await executor.resume(executor.getCheckpoint()!, {});

      const snap = executor.getSnapshot();
      expect((snap.sharedState as Loose).k).toBe('orig');
      const approveBundles = snap.commitLog.filter((b) => b.stageId === 'approve');
      const resumeBundle = approveBundles[approveBundles.length - 1];
      expect(resumeBundle.overwrite).toEqual({ k: 'orig' }); // recorded, not swallowed
    });

    it('cross-executor resume: fresh executor commits the same resume bundle', async () => {
      const chart = pausableChart();
      const first = new FlowChartExecutor(chart);
      await first.run();
      const checkpoint = JSON.parse(JSON.stringify(first.getCheckpoint()));

      const second = new FlowChartExecutor(pausableChart());
      await second.resume(checkpoint, { approved: true });

      const snap = second.getSnapshot();
      expect((snap.sharedState as Loose).resumeRead).toBe('mutated');
      expect((snap.sharedState as Loose).k).toBe('resumed:true');
      expect((snap.sharedState as Loose).finished).toBe('resumed:true');
      const approveBundles = snap.commitLog.filter((b) => b.stageId === 'approve');
      expect(approveBundles[approveBundles.length - 1].overwrite).toEqual({
        resumeRead: 'mutated',
        k: 'resumed:true',
      });
    });
  });

  // ── PROPERTY — random write/commit/read cycles never diverge ────────────
  describe('property: post-commit reads always agree with shared state', () => {
    it('random write→commit→read cycles on ONE context stay consistent (seeded)', () => {
      // Deterministic LCG so failures reproduce.
      let s = 42;
      const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff;

      const { mem, log } = seededMemory();
      const ctx = new StageContext('', 'cycler', 'cycler', mem, '', log);
      const keys = ['a', 'b', 'c'];
      const expected: Record<string, unknown> = {};

      for (let cycle = 0; cycle < 50; cycle++) {
        const writes = Math.floor(rand() * 3); // 0..2 writes per cycle
        for (let w = 0; w < writes; w++) {
          const key = keys[Math.floor(rand() * keys.length)];
          const value = `v${Math.floor(rand() * 5)}`; // small space → frequent same-value rewrites
          ctx.setGlobal(key, value);
          expected[key] = value;
        }
        ctx.commit();
        expect(staging(ctx).buffer).toBeUndefined();
        expect(staging(ctx).stateView).toBeUndefined();
        for (const key of keys) {
          expect(ctx.getValue([], key)).toBe(expected[key]);
          expect(mem.getValue('', [], key)).toBe(expected[key]);
        }
        // Reads between cycles re-create the view — drop it again so the
        // next cycle starts cold, like a fresh engine touch.
        ctx.commit();
      }
    });
  });
});

/**
 * Scenario: write-tracking policy (backlog #13c-A)
 *
 * The per-write `structuredClone` into `StageSnapshot.stageWrites`
 * (StageContext.setObject / updateObject via trackWrite) is policy-gated by
 * `WriteTrackingMode` — the sibling of #14's readTracking, built on the
 * shared `lib/capture` retention module:
 *
 *   'full'    — default; per-write value clone. BYTE-IDENTICAL to history.
 *   'summary' — cheap WriteSummaryMarker per write (type/size/preview), no
 *               tracking clone.
 *   'off'     — no stageWrites tracking at all, zero per-write tracking cost.
 *
 * The policy scopes the snapshot's stageWrites payload AND the commit
 * observer's mutations (`ScopeRecorder.onCommit` receives the retained
 * `_stageWrites` entries). It does NOT touch the write itself: shared state,
 * the transaction buffer, and the COMMIT LOG are identical in every mode
 * (commitLog values are #13c-B's delta verb, out of scope), and per-op
 * `onWrite` events fire with live values regardless. Plumbed: executor
 * option/`setWriteTracking` → `ExecutionRuntime.useWriteTracking` → root
 * StageContext → inherited via createNext/createChild → pushed into subflow
 * roots by SubflowExecutor — and re-applied on the resume path.
 *
 * CLONE-COUNTING NOTE: a `set` write structuredClones its value TWICE under
 * 'full' — once in TransactionBuffer.set (the COMMIT path, which must stay in
 * every mode) and once in trackWrite (the gated tracking clone). The counter
 * below filters by VALUE IDENTITY, so the expected counts are 2 under 'full'
 * and exactly 1 under 'summary'/'off' (the surviving buffer clone). A `merge`
 * write (updateObject) never identity-clones its value on the commit path, so
 * its counts are 1 under 'full' and 0 otherwise.
 *
 * Covers:
 *   (a) default-mode parity — stageWrites + onCommit mutations identical to
 *       today, clone fires (negative-control counter)
 *   (b) 'summary' — markers per value kind incl. Map/Set real sizes, zero
 *       tracking clones, onCommit carries the markers
 *   (c) 'off' — entry absent, zero tracking clones, commit/sharedState
 *       UNAFFECTED (writes still commit!), onCommit mutations empty,
 *       onWrite + narrative identical to default
 *   (d) policy plumbing — option + setWriteTracking reach root stages, fork
 *       children, subflow stages, and the resume path
 *   (e) redaction precedence — '[REDACTED]' beats the dial under
 *       'full'/'summary'; nothing stored (nothing leaked) under 'off'
 *   (f) read+write dials are independent
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommitEvent, WriteSummaryMarker } from '../../../../src';
import { flowChart, FlowChartExecutor } from '../../../../src';
import { EventLog } from '../../../../src/lib/memory/EventLog';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';
import type { StageSnapshot } from '../../../../src/lib/memory/types';

/** Fresh writable stage context (plus the memory + log it commits into). */
function freshCtx() {
  const mem = new SharedMemory();
  const log = new EventLog(mem.getState());
  const ctx = new StageContext('p1', 'writer', 'writer', mem, '', log);
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

describe('Scenario: write-tracking policy (#13c-A)', () => {
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

  /** Identity-filtered count — see the CLONE-COUNTING NOTE in the header. */
  const clonesOf = (value: unknown) => cloneCalls.filter((v) => v === value).length;

  // ── (a) default ('full') — byte-identical to today ───────────────────────
  describe("default ('full') parity", () => {
    it('records a deep-cloned value per tracked write (detached from the caller value)', () => {
      const { ctx } = freshCtx();
      const cfg = { retries: 5 };
      ctx.setObject([], 'config', cfg);
      ctx.setObject([], 'greeting', 'hello');

      const snap = ctx.getSnapshot();
      expect(snap.stageWrites).toEqual({ config: { retries: 5 }, greeting: 'hello' });
      // The recorded write is a CLONE — mutating the caller's object later
      // cannot retroactively edit the snapshot.
      expect(snap.stageWrites?.config).not.toBe(cfg);
      cfg.retries = 99;
      expect(ctx.getSnapshot().stageWrites?.config).toEqual({ retries: 5 });
    });

    it("NEGATIVE CONTROL: under 'full' the tracking clone DOES fire (2 identity clones: commit path + tracking)", () => {
      // This is the assertion that fails if the default ever silently stops
      // cloning — and it calibrates the counter the 'summary'/'off' tests
      // rely on: the buffer's commit-path clone accounts for exactly 1.
      const { ctx } = freshCtx();
      const cfg = { retries: 5 };
      cloneCalls = [];

      ctx.setObject([], 'config', cfg);

      expect(clonesOf(cfg)).toBe(2);
    });

    it("updateObject under 'full': 1 identity clone (tracking only — merge has no commit-path value clone)", () => {
      const { ctx } = freshCtx();
      const delta = { nested: { added: true } };
      cloneCalls = [];

      ctx.updateObject([], 'config', delta);

      expect(clonesOf(delta)).toBe(1);
      expect(ctx.getSnapshot().stageWrites?.config).toEqual(delta);
    });

    it('e2e: no option, explicit option, and setWriteTracking("full") produce identical stageWrites + onCommit mutations', async () => {
      const buildChart = () =>
        flowChart<{ seeded: string; config: { retries: number } }>(
          'Writer',
          async (scope) => {
            scope.seeded = 'yes';
            scope.config = { retries: 3 };
          },
          'writer',
        ).build();

      const commitsFor = async (executor: FlowChartExecutor) => {
        const commits: CommitEvent['mutations'][] = [];
        executor.attachScopeRecorder({ id: 'probe', onCommit: (e) => commits.push(e.mutations) });
        await executor.run();
        return commits;
      };

      const plainCommits = await commitsFor(new FlowChartExecutor(buildChart()));
      const optionedCommits = await commitsFor(new FlowChartExecutor(buildChart(), { writeTracking: 'full' }));
      const viaSetter = new FlowChartExecutor(buildChart());
      viaSetter.setWriteTracking('full');
      const setterCommits = await commitsFor(viaSetter);

      const expectedMutations = [
        { key: 'seeded', value: 'yes', operation: 'set' },
        { key: 'config', value: { retries: 3 }, operation: 'set' },
      ];
      expect(plainCommits.flat()).toEqual(expectedMutations);
      expect(optionedCommits).toEqual(plainCommits);
      expect(setterCommits).toEqual(plainCommits);
    });
  });

  // ── (b) 'summary' — markers instead of cloned values ─────────────────────
  describe("'summary' mode", () => {
    it('records type/size/preview markers per value kind — with ZERO tracking clones', () => {
      const { ctx } = freshCtx();
      ctx.useWriteTracking('summary');
      const cfg = { retries: 3 };
      const tags = ['a', 'b', 'c'];
      cloneCalls = [];

      ctx.setObject([], 'greeting', 'hello'); // string
      ctx.setObject([], 'config', cfg); // object
      ctx.setObject([], 'tags', tags); // array
      ctx.setObject([], 'count', 42); // number

      // Only the buffer's commit-path clone survives per set write.
      expect(clonesOf(cfg)).toBe(1);
      expect(clonesOf(tags)).toBe(1);
      expect(ctx.getSnapshot().stageWrites).toEqual({
        greeting: { __writeSummary: true, type: 'string', size: 5, preview: 'hello' },
        config: { __writeSummary: true, type: 'object', size: 1 },
        tags: { __writeSummary: true, type: 'array', size: 3 },
        count: { __writeSummary: true, type: 'number', preview: '42' },
      });
    });

    it('Map/Set report their real entry count, not Object.keys (always 0)', () => {
      const { ctx } = freshCtx();
      ctx.useWriteTracking('summary');

      ctx.setObject(
        [],
        'lookup',
        new Map([
          ['a', 1],
          ['b', 2],
          ['c', 3],
        ]),
      );
      ctx.setObject([], 'seen', new Set(['x', 'y']));

      expect(ctx.getSnapshot().stageWrites).toEqual({
        lookup: { __writeSummary: true, type: 'object', size: 3 },
        seen: { __writeSummary: true, type: 'object', size: 2 },
      });
    });

    it('string previews are capped at 80 characters', () => {
      const { ctx } = freshCtx();
      ctx.useWriteTracking('summary');

      ctx.setObject([], 'long', 'x'.repeat(500));

      const marker = ctx.getSnapshot().stageWrites?.long as WriteSummaryMarker;
      expect(marker.size).toBe(500);
      expect(marker.preview).toHaveLength(80);
    });

    it("updateObject under 'summary': ZERO identity clones; marker keeps operation 'update' for onCommit", () => {
      const { ctx } = freshCtx();
      ctx.useWriteTracking('summary');
      const observed: Record<string, { value: unknown; operation: string }>[] = [];
      ctx.setCommitObserver((mutations) => observed.push(mutations));
      const delta = { nested: { added: true } };
      cloneCalls = [];

      ctx.updateObject([], 'config', delta);
      ctx.commit();

      expect(clonesOf(delta)).toBe(0);
      expect(observed[0].config).toEqual({
        value: { __writeSummary: true, type: 'object', size: 1 },
        operation: 'update',
      });
    });

    it('e2e: snapshot stageWrites are markers AND onCommit mutations carry the same markers', async () => {
      const commits: CommitEvent['mutations'][] = [];
      const chart = flowChart<{ doc: { big: string } }>(
        'Writer',
        async (scope) => {
          scope.doc = { big: 'payload' };
        },
        'writer',
      ).build();

      const executor = new FlowChartExecutor(chart, { writeTracking: 'summary' });
      executor.attachScopeRecorder({ id: 'probe', onCommit: (e) => commits.push(e.mutations) });
      await executor.run();

      const expectedMarker = { __writeSummary: true, type: 'object', size: 1 };
      const writer = findStage(executor.getSnapshot().executionTree, 'writer');
      expect(writer?.stageWrites?.doc).toEqual(expectedMarker);
      expect(commits.flat()).toEqual([{ key: 'doc', value: expectedMarker, operation: 'set' }]);
      // The write itself still committed at full fidelity.
      expect(executor.getSnapshot().sharedState).toMatchObject({ doc: { big: 'payload' } });
    });
  });

  // ── (c) 'off' — entry absent; the WRITE itself is unaffected ─────────────
  describe("'off' mode", () => {
    it('zero tracking clones; stageWrites absent; commit + sharedState UNAFFECTED', () => {
      const { mem, log, ctx } = freshCtx();
      ctx.useWriteTracking('off');
      const cfg = { retries: 5 };
      cloneCalls = [];

      ctx.setObject([], 'config', cfg);
      ctx.commit();

      expect(clonesOf(cfg)).toBe(1); // ONLY the buffer's commit-path clone
      expect(ctx.getSnapshot().stageWrites).toBeUndefined();
      // The write still committed — shared state, bundle payload, and trace intact.
      expect(mem.getValue('p1', [], 'config')).toEqual({ retries: 5 });
      const bundle = log.list()[0];
      expect(bundle.overwrite).toEqual({ runs: { p1: { config: { retries: 5 } } } });
      expect(bundle.trace).toHaveLength(1);
    });

    it('e2e: extra writer stages add ZERO tracking clones (identity-counted)', async () => {
      const payload = { blob: 'x'.repeat(100) };
      const buildChart = (writeStages: number) => {
        const builder = flowChart<Record<string, unknown>>(
          'Seed',
          async (scope) => {
            scope.$setValue('seeded', 'yes');
          },
          'seed',
        );
        for (let i = 0; i < writeStages; i++) {
          builder.addFunction(
            `Write${i}`,
            async (scope) => {
              scope.$setValue(`out-${i}`, payload);
            },
            `write-${i}`,
          );
        }
        return builder.build();
      };

      cloneCalls = [];
      await new FlowChartExecutor(buildChart(4), { writeTracking: 'off' }).run();
      // 4 stages × 1 commit-path clone each — and NOT 8 (no tracking clones).
      expect(clonesOf(payload)).toBe(4);

      cloneCalls = [];
      await new FlowChartExecutor(buildChart(4)).run();
      expect(clonesOf(payload)).toBe(8); // control: default pays the tracking clone too
    });

    it('e2e: onCommit mutations are EMPTY; writes still reach sharedState and the commitLog', async () => {
      const commits: CommitEvent['mutations'][] = [];
      const chart = flowChart<{ derived: string }>(
        'Writer',
        async (scope) => {
          scope.derived = 'computed';
        },
        'writer',
      ).build();

      const executor = new FlowChartExecutor(chart, { writeTracking: 'off' });
      executor.attachScopeRecorder({ id: 'probe', onCommit: (e) => commits.push(e.mutations) });
      await executor.run();

      expect(commits).toEqual([[]]); // commit fired, mutations bag empty
      const snapshot = executor.getSnapshot();
      expect(findStage(snapshot.executionTree, 'writer')?.stageWrites).toBeUndefined();
      expect(snapshot.sharedState).toMatchObject({ derived: 'computed' });
      // The commit log is OUT of the dial's scope — full payload retained (#13c-B).
      const writerBundle = snapshot.commitLog.find((b) => b.stageId === 'writer');
      expect(writerBundle?.overwrite).toEqual({ derived: 'computed' });
      expect(writerBundle?.trace).toHaveLength(1);
    });

    it("ScopeRecorder.onWrite still fires with the LIVE value under 'off' (delivery tier untouched)", async () => {
      const writes: Array<{ key?: string; value: unknown }> = [];
      const chart = flowChart<{ doc: { big: string } }>(
        'Writer',
        async (scope) => {
          scope.doc = { big: 'payload' };
        },
        'writer',
      ).build();

      const executor = new FlowChartExecutor(chart, { writeTracking: 'off' });
      executor.attachScopeRecorder({
        id: 'probe',
        onWrite: (e) => writes.push({ key: e.key, value: e.value }),
      });
      await executor.run();

      expect(writes).toContainEqual({ key: 'doc', value: { big: 'payload' } });
    });

    it("narrative is byte-identical between default and 'off' (write lines come from onWrite, never from retention)", async () => {
      const buildChart = () =>
        flowChart<{ seeded: string; out?: string }>(
          'Seed',
          async (scope) => {
            scope.seeded = 'yes';
          },
          'seed',
        )
          .addFunction(
            'Writer',
            async (scope) => {
              scope.out = scope.seeded.toUpperCase();
            },
            'writer',
          )
          .build();

      const base = new FlowChartExecutor(buildChart());
      base.enableNarrative();
      await base.run();

      const off = new FlowChartExecutor(buildChart(), { writeTracking: 'off' });
      off.enableNarrative();
      await off.run();

      const lines = (ex: FlowChartExecutor) => ex.getNarrativeEntries().map((e) => `${e.type}|${e.depth}|${e.text}`);
      expect(lines(off)).toEqual(lines(base));
      expect(lines(off).some((line) => line.includes('out'))).toBe(true);
    });
  });

  // ── (d) policy plumbing ──────────────────────────────────────────────────
  describe('policy plumbing', () => {
    it('createNext / createChild inherit the mode', () => {
      const { ctx } = freshCtx();
      ctx.useWriteTracking('off');

      const next = ctx.createNext('p1', 'next-stage', 'next-stage');
      const child = ctx.createChild('p1', 'branch-1', 'child-stage', 'child-stage');

      expect(next.getWriteTracking()).toBe('off');
      expect(child.getWriteTracking()).toBe('off');
      // And it is live, not just stored: writes on the child track nothing.
      child.setObject([], 'fromChild', 1);
      expect(child.getSnapshot().stageWrites).toBeUndefined();
    });

    it("e2e: 'off' reaches SUBFLOW stages (isolated runtime inherits via the mount context)", async () => {
      const inner = flowChart<{ seeded: string; innerOut?: string }>(
        'InnerWrite',
        async (scope) => {
          scope.innerOut = `inner saw ${scope.seeded}`;
        },
        'inner-write',
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

      const findInnerWrite = (ex: FlowChartExecutor) => {
        const sf = ex.getSnapshot().subflowResults?.['sf-inner'] as
          | { treeContext: { stageContexts: StageSnapshot } }
          | undefined;
        expect(sf).toBeDefined();
        if (!sf) return undefined;
        for (const snap of walkTree(sf.treeContext.stageContexts)) {
          if (snap.id.endsWith('inner-write')) return snap;
        }
        return undefined;
      };

      const offEx = new FlowChartExecutor(buildOuter(), { writeTracking: 'off' });
      await offEx.run();
      expect(findInnerWrite(offEx)?.stageWrites).toBeUndefined();
      // The subflow's write still flowed back to the parent via outputMapper.
      expect(offEx.getSnapshot().sharedState).toMatchObject({ innerOut: 'inner saw yes' });

      // Control: the same subflow stage DOES track writes under the default.
      const defaultEx = new FlowChartExecutor(buildOuter());
      await defaultEx.run();
      expect(findInnerWrite(defaultEx)?.stageWrites).toEqual({ innerOut: 'inner saw yes' });
    });

    it("e2e: 'summary' reaches parallel fork children", async () => {
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
              fn: async (scope: { seeded: string } & Record<string, unknown>) => {
                (scope as Record<string, unknown>).outA = { from: 'a' };
              },
            },
            {
              id: 'child-b',
              name: 'ChildB',
              fn: async (scope: { seeded: string } & Record<string, unknown>) => {
                (scope as Record<string, unknown>).outB = { from: 'b' };
              },
            },
          ])
          .build();

      const executor = new FlowChartExecutor(buildFork(), { writeTracking: 'summary' });
      await executor.run();

      const tree = executor.getSnapshot().executionTree;
      expect(findStage(tree, 'child-a')?.stageWrites?.outA).toEqual({ __writeSummary: true, type: 'object', size: 1 });
      expect(findStage(tree, 'child-b')?.stageWrites?.outB).toEqual({ __writeSummary: true, type: 'object', size: 1 });

      // Control under default: children track full values.
      const defaultEx = new FlowChartExecutor(buildFork());
      await defaultEx.run();
      expect(findStage(defaultEx.getSnapshot().executionTree, 'child-a')?.stageWrites?.outA).toEqual({ from: 'a' });
    });

    it("e2e: the policy survives PAUSE/RESUME (continuation stages stay 'off')", async () => {
      const buildChart = () =>
        flowChart<{ amount: number; approved?: boolean; finalized?: string }>(
          'Seed',
          async (scope) => {
            scope.amount = 100;
          },
          'seed',
        )
          .addPausableFunction(
            'Approve',
            {
              execute: async (scope) => ({ question: `Approve $${scope.amount}?` }),
              resume: async (scope, input: { approved: boolean }) => {
                scope.approved = input.approved;
              },
            },
            'approve',
          )
          .addFunction(
            'Finalize',
            async (scope) => {
              scope.finalized = scope.approved ? 'done' : 'rejected';
            },
            'finalize',
          )
          .build();

      const executor = new FlowChartExecutor(buildChart(), { writeTracking: 'off' });
      await executor.run();
      expect(executor.isPaused()).toBe(true);
      await executor.resume(executor.getCheckpoint()!, { approved: true });

      const tree = executor.getSnapshot().executionTree;
      const finalize = findStage(tree, 'finalize');
      expect(finalize).toBeDefined();
      expect(finalize?.stageWrites).toBeUndefined();
      expect(executor.getSnapshot().sharedState).toMatchObject({ finalized: 'done' });

      // Control: under the default the post-resume stage tracks its write.
      const defaultEx = new FlowChartExecutor(buildChart());
      await defaultEx.run();
      await defaultEx.resume(defaultEx.getCheckpoint()!, { approved: true });
      expect(findStage(defaultEx.getSnapshot().executionTree, 'finalize')?.stageWrites).toEqual({
        finalized: 'done',
      });
    });
  });

  // ── (e) redaction precedence ─────────────────────────────────────────────
  describe('redaction takes precedence over the dial', () => {
    it.each(['full', 'summary'] as const)(
      "%s: a redacted write stores '[REDACTED]', never a value or marker",
      (mode) => {
        const { ctx } = freshCtx();
        ctx.useWriteTracking(mode);

        ctx.setObject([], 'ssn', '123-45-6789', true);

        const tracked = ctx.getSnapshot().stageWrites?.ssn;
        expect(tracked).toBe('[REDACTED]');
        // Specifically NOT a summary marker — a marker would leak size/preview.
        expect(JSON.stringify(ctx.getSnapshot().stageWrites)).not.toContain('123');
      },
    );

    it("'off': a redacted write stores nothing at all (nothing to leak)", () => {
      const { ctx } = freshCtx();
      ctx.useWriteTracking('off');

      ctx.setObject([], 'ssn', '123-45-6789', true);

      expect(ctx.getSnapshot().stageWrites).toBeUndefined();
    });

    it("e2e: RedactionPolicy keys beat 'summary' through the scope tier", async () => {
      const chart = flowChart<{ ssn: string; plain: string }>(
        'Writer',
        async (scope) => {
          scope.ssn = '123-45-6789';
          scope.plain = 'visible';
        },
        'writer',
      ).build();

      const executor = new FlowChartExecutor(chart, { writeTracking: 'summary' });
      executor.setRedactionPolicy({ keys: ['ssn'] });
      await executor.run();

      const writer = findStage(executor.getSnapshot().executionTree, 'writer');
      expect(writer?.stageWrites?.ssn).toBe('[REDACTED]');
      expect(writer?.stageWrites?.plain).toEqual({
        __writeSummary: true,
        type: 'string',
        size: 7,
        preview: 'visible',
      });
    });
  });

  // ── (f) the two dials are independent ────────────────────────────────────
  describe('read and write dials are independent', () => {
    it("unit: useWriteTracking doesn't move readTracking, and vice versa", () => {
      const { ctx } = freshCtx();
      ctx.useWriteTracking('off');
      expect(ctx.getReadTracking()).toBe('full');
      ctx.useReadTracking('summary');
      expect(ctx.getWriteTracking()).toBe('off');
    });

    it("e2e: writeTracking 'off' leaves stageReads at full fidelity", async () => {
      const chart = flowChart<{ seeded: string; out?: string }>(
        'Seed',
        async (scope) => {
          scope.seeded = 'yes';
        },
        'seed',
      )
        .addFunction(
          'Worker',
          async (scope) => {
            scope.out = scope.seeded.toUpperCase();
          },
          'worker',
        )
        .build();

      const executor = new FlowChartExecutor(chart, { writeTracking: 'off' });
      await executor.run();

      const worker = findStage(executor.getSnapshot().executionTree, 'worker');
      expect(worker?.stageWrites).toBeUndefined();
      expect(worker?.stageReads).toEqual({ seeded: 'yes' }); // read dial untouched: full clone
    });

    it("e2e: readTracking 'off' + writeTracking 'summary' compose", async () => {
      const chart = flowChart<{ seeded: string; out?: string }>(
        'Seed',
        async (scope) => {
          scope.seeded = 'yes';
        },
        'seed',
      )
        .addFunction(
          'Worker',
          async (scope) => {
            scope.out = scope.seeded.toUpperCase();
          },
          'worker',
        )
        .build();

      const executor = new FlowChartExecutor(chart, { readTracking: 'off', writeTracking: 'summary' });
      await executor.run();

      const worker = findStage(executor.getSnapshot().executionTree, 'worker');
      expect(worker?.stageReads).toBeUndefined();
      expect(worker?.stageWrites?.out).toEqual({ __writeSummary: true, type: 'string', size: 3, preview: 'YES' });
    });
  });
});

/**
 * Scenario: commit-values encoding policy (backlog #13c-B)
 *
 * `CommitValuesMode` governs how COMMIT LOG values are encoded — the third
 * dial of the readTracking/writeTracking family, and the only LOSSLESS one
 * (it changes the log's encoding, never its information):
 *
 *   'full'  — default; every surviving `set` path stores the full final
 *             value. BYTE-IDENTICAL to history (the byte-identity probe
 *             gates this — scripts/byte-identity-probe.ts).
 *   'delta' — array net-changes that are "base plus a tail" commit as an
 *             `append` verb storing ONLY the tail; `deleteValue()` commits
 *             as a real `delete` verb (replay removes the key); exactly ONE
 *             trace entry per surviving path.
 *
 * Plumbed exactly like the sibling dials: executor option /
 * `setCommitValues` → `ExecutionRuntime.useCommitValues` → root StageContext
 * → inherited via createNext/createChild → pushed into subflow roots by
 * SubflowExecutor — and re-applied on the resume path. Surfaced as the
 * snapshot discriminant `getSnapshot().commitValues`.
 *
 * Covers (Convention 3 — functional / integration / security tiers):
 *   (a) default parity — commit log + narrative byte-equal to an unset
 *       executor; discriminant 'full'
 *   (b) delta end-to-end — growing-history loop commits O(tail) append
 *       bundles; final state + every materialise() step identical to 'full'
 *   (c) delete end-to-end — key REMOVED from live state (vs the historical
 *       key:undefined flattening)
 *   (d) plumbing — option + setCommitValues reach root stages, fork
 *       children, subflow internals, and the resume path; discriminant
 *   (e) security — redaction: appended tails of redacted keys record
 *       'REDACTED' in the log (never the raw tail), the redacted mirror
 *       stays consistent, mixed unredacted-set + redacted-append degrades
 *       to 'REDACTED' (no char-spread), raw state keeps real values
 *   (f) consumer-matrix pins — findCommit/findLastWriter/causalChain over
 *       delta logs (they read trace.path, not values); commitValueAt
 *       reconstructs full values from either log
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../../src';
import { flowChart, FlowChartExecutor } from '../../../../src';
import { causalChain } from '../../../../src/lib/memory/backtrack';
import { commitValueAt, findCommit, findLastWriter } from '../../../../src/lib/memory/commitLogUtils';
import { EventLog } from '../../../../src/lib/memory/EventLog';
import type { CommitBundle } from '../../../../src/lib/memory/types';

type Loose = Record<string, unknown>;

/** A 4-stage chart with an agent-style growing `history` loop (3 iterations). */
function buildHistoryLoopChart() {
  return flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('i', 0);
      scope.$setValue('history', [] as unknown[]);
    },
    'seed',
  )
    .addFunction(
      'Work',
      async (scope) => {
        const i = scope.$getValue('i') as number;
        scope.$batchArray('history', (arr) => {
          arr.push({ idx: i, text: `message-${i}` });
        });
        scope.$setValue('i', i + 1);
        if (i + 1 >= 3) scope.$break();
      },
      'work',
    )
    .loopTo('work')
    .build();
}

/** Strip volatile fields for byte-comparison. */
function canonical(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (k, v) => (k === 'timestamp' ? undefined : v)) ?? 'null');
}

/** Replay a commit log step-by-step from an empty base (charts here start empty). */
function materialiseAll(commitLog: CommitBundle[]): unknown[] {
  const log = new EventLog({});
  for (const b of commitLog) log.record(structuredClone(b));
  const steps: unknown[] = [];
  for (let k = 0; k <= commitLog.length; k++) steps.push(log.materialise(k));
  return steps;
}

describe('Scenario: commit-values policy (#13c-B)', () => {
  // ── (a) default ('full') parity ───────────────────────────────────────────
  describe("default ('full') parity", () => {
    it('an explicit commitValues "full" executor produces a byte-equal commit log + narrative to an unset one', async () => {
      const run = async (opts?: { commitValues: 'full' }) => {
        const executor = new FlowChartExecutor(buildHistoryLoopChart(), opts);
        executor.enableNarrative();
        await executor.run();
        return {
          log: canonical(executor.getSnapshot().commitLog),
          state: canonical(executor.getSnapshot().sharedState),
          narrative: canonical(executor.getNarrativeEntries().map((e) => ({ ...e }))),
        };
      };
      const unset = await run();
      const explicit = await run({ commitValues: 'full' });
      expect(explicit).toEqual(unset);
    });

    it("the snapshot discriminant defaults to 'full'", async () => {
      const executor = new FlowChartExecutor(buildHistoryLoopChart());
      await executor.run();
      expect(executor.getSnapshot().commitValues).toBe('full');
    });
  });

  // ── (b) delta end-to-end — the growing-history loop ──────────────────────
  describe("'delta' end-to-end (functional)", () => {
    it('growing-history commits append bundles holding ONLY the new message', async () => {
      const executor = new FlowChartExecutor(buildHistoryLoopChart(), { commitValues: 'delta' });
      await executor.run();
      const snap = executor.getSnapshot();
      expect(snap.commitValues).toBe('delta');

      const historyWrites = snap.commitLog.filter((b) => b.trace.some((t) => t.path === 'history'));
      // Iteration 1: history [] → [m0] — append from the empty base array.
      // Iterations 2..3: strict-prefix growth — append.
      const verbs = historyWrites.map((b) => b.trace.find((t) => t.path === 'history')!.verb);
      expect(verbs[0]).toBe('set'); // the seed stage initialises history = []
      expect(verbs.slice(1)).toEqual(['append', 'append', 'append']);

      // Each append bundle stores exactly ONE message (the tail), not i messages.
      for (const b of historyWrites.slice(1)) {
        expect(b.overwrite.history).toHaveLength(1);
      }
    });

    it("final shared state and EVERY materialise() step are deep-equal across 'full' and 'delta' (the lossless invariant)", async () => {
      const runWith = async (commitValues: 'full' | 'delta') => {
        const executor = new FlowChartExecutor(buildHistoryLoopChart(), { commitValues });
        await executor.run();
        return executor.getSnapshot();
      };
      const full = await runWith('full');
      const delta = await runWith('delta');

      expect(canonical(delta.sharedState)).toEqual(canonical(full.sharedState));
      expect(delta.commitLog.length).toBe(full.commitLog.length); // cadence unchanged — every stage stays a cursor stop

      const fullSteps = materialiseAll(full.commitLog);
      const deltaSteps = materialiseAll(delta.commitLog);
      for (let k = 0; k < fullSteps.length; k++) {
        expect(canonical(deltaSteps[k])).toEqual(canonical(fullSteps[k]));
      }
    });

    it('narrative output is byte-identical across modes (op tier, not bundle tier)', async () => {
      const runWith = async (commitValues: 'full' | 'delta') => {
        const executor = new FlowChartExecutor(buildHistoryLoopChart(), { commitValues });
        executor.enableNarrative();
        await executor.run();
        return canonical(executor.getNarrativeEntries().map((e) => ({ ...e })));
      };
      expect(await runWith('delta')).toEqual(await runWith('full'));
    });
  });

  // ── (c) delete end-to-end ─────────────────────────────────────────────────
  describe('delete verb end-to-end', () => {
    const buildDeleteChart = () =>
      flowChart<Loose>(
        'Seed',
        async (scope) => {
          scope.$setValue('temp', 'scratch');
          scope.$setValue('keep', 1);
        },
        'seed',
      )
        .addFunction(
          'Cleanup',
          async (scope) => {
            (scope as any).$delete('temp');
          },
          'cleanup',
        )
        .build();

    it("under 'delta' the key is REMOVED from live shared state (B8 closed)", async () => {
      const executor = new FlowChartExecutor(buildDeleteChart(), { commitValues: 'delta' });
      await executor.run();
      const snap = executor.getSnapshot();

      const cleanup = findCommit(snap.commitLog, 'cleanup', 'temp')!;
      expect(cleanup.trace.find((t) => t.path === 'temp')!.verb).toBe('delete');
      // Key-set consumers still see the changed key enumerated:
      expect(Object.prototype.hasOwnProperty.call(cleanup.overwrite, 'temp')).toBe(true);
      // ...but live state no longer carries a dangling `temp: undefined`:
      expect(Object.prototype.hasOwnProperty.call(snap.sharedState, 'temp')).toBe(false);
      expect(snap.sharedState.keep).toBe(1);
    });

    it("under 'full' the historical set-undefined flattening is preserved byte-for-byte", async () => {
      const executor = new FlowChartExecutor(buildDeleteChart());
      await executor.run();
      const snap = executor.getSnapshot();
      const cleanup = findCommit(snap.commitLog, 'cleanup', 'temp')!;
      expect(cleanup.trace.find((t) => t.path === 'temp')!.verb).toBe('set');
      expect(Object.prototype.hasOwnProperty.call(snap.sharedState, 'temp')).toBe(true);
      expect(snap.sharedState.temp).toBeUndefined();
    });
  });

  // ── (d) plumbing — every inheritance hop ─────────────────────────────────
  describe('policy plumbing (integration)', () => {
    it('setCommitValues(mode) before run() is equivalent to the constructor option', async () => {
      const executor = new FlowChartExecutor(buildHistoryLoopChart());
      executor.setCommitValues('delta');
      await executor.run();
      const snap = executor.getSnapshot();
      expect(snap.commitValues).toBe('delta');
      expect(snap.commitLog.some((b) => b.trace.some((t) => t.verb === 'append'))).toBe(true);
    });

    it('fork children inherit the mode (createChild hop — child bundles carry the delta dedup)', async () => {
      // A fork child writes the same key TWICE in one stage. Under 'full'
      // that commits two trace entries (op log); under 'delta' the dedup
      // rule commits exactly ONE — observable proof that the child context's
      // buffer received the mode through createChild.
      const buildForkChart = () =>
        flowChart<Loose>(
          'Seed',
          async (scope) => {
            scope.$setValue('seeded', true);
          },
          'seed',
        )
          .addListOfFunction([
            {
              id: 'double-writer',
              name: 'DoubleWriter',
              fn: async (scope: any) => {
                scope.$setValue('childKey', 'first');
                scope.$setValue('childKey', 'second');
              },
            },
            {
              id: 'other-child',
              name: 'OtherChild',
              fn: async (scope: any) => {
                scope.$setValue('other', 1);
              },
            },
          ])
          .build();

      const runWith = async (commitValues: 'full' | 'delta') => {
        const executor = new FlowChartExecutor(buildForkChart(), { commitValues });
        await executor.run();
        return executor.getSnapshot().commitLog.find((b) => b.stageId === 'double-writer')!;
      };

      const fullBundle = await runWith('full');
      const deltaBundle = await runWith('delta');
      const childKeyEntries = (b: CommitBundle) => b.trace.filter((t) => t.path.endsWith('childKey'));
      expect(childKeyEntries(fullBundle)).toHaveLength(2); // historical op log
      expect(childKeyEntries(deltaBundle)).toHaveLength(1); // delta dedup reached the child
      // Same final value either way:
      expect(canonical(deltaBundle.overwrite)).toEqual(canonical(fullBundle.overwrite));
    });

    it('subflow INTERNALS inherit the mode (nested commit log carries append verbs)', async () => {
      const inner = flowChart<Loose>(
        'InnerGrow',
        async (scope) => {
          scope.$setValue('innerList', ['inner-item']);
        },
        'inner-grow',
      )
        .addFunction(
          'InnerGrowAgain',
          async (scope) => {
            const cur = scope.$getValue('innerList') as unknown[];
            scope.$setValue('innerList', [...cur, 'inner-item-2']);
          },
          'inner-grow-again',
        )
        .build();

      const chart = flowChart<Loose>(
        'Outer',
        async (scope) => {
          scope.$setValue('outerKey', 'outer-value');
        },
        'outer',
      )
        .addSubFlowChartNext('sf-inner', inner, 'Inner', {
          outputMapper: (out: Loose) => ({ innerList: out.innerList }),
        })
        .build();

      const executor = new FlowChartExecutor(chart, { commitValues: 'delta' });
      await executor.run();
      const snap = executor.getSnapshot();

      const sfResult = (snap.subflowResults as Record<string, any>)['sf-inner'];
      expect(sfResult).toBeDefined();
      const innerLog = sfResult.treeContext.history as CommitBundle[];
      // The SECOND inner stage grows the subflow-local array → append,
      // proving the mode crossed the isolated-runtime boundary.
      const growAgain = innerLog.find((b) => b.stageId.endsWith('inner-grow-again'))!;
      expect(growAgain.trace.some((t) => t.verb === 'append')).toBe(true);
    });

    it('the resume path re-applies the mode (post-resume commits append)', async () => {
      const handler: PausableHandler<Loose> = {
        execute: async () => ({ question: 'continue?' }),
        resume: async (scope: any) => {
          const cur = scope.$getValue('history') as unknown[];
          scope.$setValue('history', [...cur, 'post-resume-item']);
        },
      };
      const chart = flowChart<Loose>(
        'Seed',
        async (scope) => {
          scope.$setValue('history', ['pre-pause-item']);
        },
        'seed',
      )
        .addPausableFunction('Approve', handler, 'approve')
        .build();

      const executor = new FlowChartExecutor(chart, { commitValues: 'delta' });
      await executor.run();
      expect(executor.isPaused()).toBe(true);
      await executor.resume(executor.getCheckpoint()!, {});

      const log = executor.getSnapshot().commitLog;
      const resumeCommit = log.find((b) => b.trace.some((t) => t.path === 'history' && t.verb === 'append'))!;
      expect(resumeCommit).toBeDefined();
      expect(resumeCommit.overwrite.history).toEqual(['post-resume-item']); // tail only
      expect(executor.getSnapshot().sharedState.history).toEqual(['pre-pause-item', 'post-resume-item']);
    });
  });

  // ── (e) security — redaction × delta verbs ────────────────────────────────
  describe('redaction interaction (security)', () => {
    it('appended tails of a policy-redacted key record REDACTED in the commit log — never the raw tail', async () => {
      const chart = flowChart<Loose>(
        'Seed',
        async (scope) => {
          scope.$setValue('piiLog', ['ssn-111']);
        },
        'seed',
      )
        .addFunction(
          'Grow',
          async (scope) => {
            const cur = scope.$getValue('piiLog') as string[];
            scope.$setValue('piiLog', [...cur, 'ssn-222']);
          },
          'grow',
        )
        .build();
      const executor = new FlowChartExecutor(chart, { commitValues: 'delta' });
      executor.setRedactionPolicy({ keys: ['piiLog'] });
      await executor.run();
      const snap = executor.getSnapshot();

      const grow = findCommit(snap.commitLog, 'grow', 'piiLog')!;
      expect(grow.trace.find((t) => t.path === 'piiLog')!.verb).toBe('append');
      // The LOG (persisted audit surface) holds the scrubbed tail:
      expect(grow.overwrite.piiLog).toBe('REDACTED');
      expect(JSON.stringify(snap.commitLog)).not.toContain('ssn-222');
      expect(grow.redactedPaths).toContain('piiLog');

      // The redacted MIRROR collapses to REDACTED (the degrade arm — same
      // terminal value as a redacted 'set'), with no char-spread artifacts:
      const redacted = executor.getSnapshot({ redact: true });
      expect(redacted.sharedState.piiLog).toBe('REDACTED');

      // The RAW live state keeps real values (resume must replay real data):
      expect(snap.sharedState.piiLog).toEqual(['ssn-111', 'ssn-222']);
    });

    it('mixed history: unredacted set then per-call-redacted append — mirror degrades to REDACTED, raw state intact', async () => {
      const chart = flowChart<Loose>(
        'Seed',
        async (scope) => {
          scope.$setValue('log', ['public-entry']);
        },
        'seed',
      )
        .addFunction(
          'GrowSecret',
          async (scope: any) => {
            const cur = scope.$getValue('log') as string[];
            scope.$setValue('log', [...cur, 'secret-entry'], true); // per-call redaction
          },
          'grow-secret',
        )
        .build();
      const executor = new FlowChartExecutor(chart, { commitValues: 'delta' });
      // A policy must exist for the redacted mirror to be maintained.
      executor.setRedactionPolicy({ keys: ['unrelated'] });
      await executor.run();
      const snap = executor.getSnapshot();

      const grow = findCommit(snap.commitLog, 'grow-secret', 'log')!;
      expect(grow.overwrite.log).toBe('REDACTED');
      expect(JSON.stringify(snap.commitLog)).not.toContain('secret-entry');

      const redacted = executor.getSnapshot({ redact: true });
      // First commit was a real array; the redacted append degrades the
      // mirror value to 'REDACTED' — NOT ['public-entry', 'R', 'E', ...].
      expect(redacted.sharedState.log).toBe('REDACTED');
      expect(snap.sharedState.log).toEqual(['public-entry', 'secret-entry']);
    });

    it('commitValueAt over a redacted delta log returns the scrubbed value (no leakage path)', async () => {
      const chart = flowChart<Loose>(
        'Seed',
        async (scope) => {
          scope.$setValue('piiLog', ['ssn-111']);
        },
        'seed',
      )
        .addFunction(
          'Grow',
          async (scope) => {
            const cur = scope.$getValue('piiLog') as string[];
            scope.$setValue('piiLog', [...cur, 'ssn-222']);
          },
          'grow',
        )
        .build();
      const executor = new FlowChartExecutor(chart, { commitValues: 'delta' });
      executor.setRedactionPolicy({ keys: ['piiLog'] });
      await executor.run();
      const log = executor.getSnapshot().commitLog;
      const reconstructed = commitValueAt(log, log.length - 1, 'piiLog');
      // Both the anchor and the tail were scrubbed at write time — the fold
      // can only ever produce scrubbed values.
      expect(JSON.stringify(reconstructed)).not.toContain('ssn');
    });
  });

  // ── (f) consumer-matrix pins — path-tier consumers unaffected ────────────
  describe('consumer-matrix pins (delta logs)', () => {
    async function deltaRun() {
      const executor = new FlowChartExecutor(buildHistoryLoopChart(), { commitValues: 'delta' });
      await executor.run();
      return executor.getSnapshot();
    }

    it('findCommit / findLastWriter treat an appending stage as a writer of the key', async () => {
      const snap = await deltaRun();
      const log = snap.commitLog;

      const firstWork = findCommit(log, 'work', 'history')!;
      expect(firstWork).toBeDefined();
      expect(firstWork.trace.find((t) => t.path === 'history')!.verb).toBe('append');

      const lastWriter = findLastWriter(log, 'history')!;
      expect(lastWriter.stageId).toBe('work');
      // The last writer is the LAST loop iteration's append:
      expect(lastWriter.trace.find((t) => t.path === 'history')!.verb).toBe('append');
    });

    it('causalChain walks delta logs by trace.path — the appender is the causal parent', async () => {
      const snap = await deltaRun();
      const log = snap.commitLog;
      const lastWork = findLastWriter(log, 'history')!;

      const chain = causalChain(log, lastWork.runtimeStageId, () => ['history'])!;
      expect(chain).toBeDefined();
      expect(chain.keysWritten).toContain('history');
      // Its parent for 'history' is the PREVIOUS appender (an append bundle).
      const parent = chain.parents.find((p) => p.keysWritten.includes('history'));
      expect(parent).toBeDefined();
      expect(parent!.linkedBy).toBe('history');
      expect(parent!.stageId).toBe('work'); // the prior loop iteration
    });

    it('delta dedup removes duplicate causal edges without losing keysWritten', async () => {
      const snap = await deltaRun();
      for (const b of snap.commitLog) {
        const paths = b.trace.map((t) => t.path);
        expect(new Set(paths).size).toBe(paths.length);
      }
    });

    it('commitValueAt reconstructs the SAME full value from full-mode and delta-mode logs at every history commit', async () => {
      const runWith = async (commitValues: 'full' | 'delta') => {
        const executor = new FlowChartExecutor(buildHistoryLoopChart(), { commitValues });
        await executor.run();
        return executor.getSnapshot().commitLog;
      };
      const fullLog = await runWith('full');
      const deltaLog = await runWith('delta');
      expect(deltaLog.length).toBe(fullLog.length);
      for (let i = 0; i < fullLog.length; i++) {
        expect(canonical(commitValueAt(deltaLog, i, 'history'))).toEqual(
          canonical(commitValueAt(fullLog, i, 'history')),
        );
      }
      // And the final reconstruction equals the v1 "full value in overwrite" read:
      const v1Read = findLastWriter(fullLog, 'history')!.overwrite.history;
      expect(canonical(commitValueAt(deltaLog, deltaLog.length - 1, 'history'))).toEqual(canonical(v1Read));
    });
  });
});

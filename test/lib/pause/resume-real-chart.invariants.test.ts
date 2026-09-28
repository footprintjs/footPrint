/**
 * The invariants the one-shot resume re-entry (9.27.1) must keep.
 *
 * Moving where a resumed run starts, and letting it walk the real chart
 * afterwards, touches the event-correlation model and the per-stage policies
 * the synthetic stand-in carried. Pinned here, for every chart in the fixture
 * and both resume modes:
 *
 *   - executionIndex keeps climbing across every resume and is never reset;
 *     every runtimeStageId names ONE execution, at every level;
 *   - one CommitBundle per executed stage (a mount's entry/exit pair aside);
 *   - the reader's chain over a cross-executor run (`timeTravel(legs)`)
 *     accepts the legs — its lineage checks are the same two laws;
 *   - `maxIterations` still bounds a loop that spans a resume;
 *   - recorders and narrative accumulate across a same-executor resume, and a
 *     resumed loop edge is narrated as a loop, exactly as on a run;
 *   - declared tags and `retry` follow the resumed stage as before — and the
 *     REAL stage keeps its own when a loop re-visits it;
 *   - an `interrupt()` re-entry re-runs the stage from its top;
 *   - the checkpoint's shape is unchanged from 9.27.0.
 *
 * Test type: functional (invariants). Sibling of resume-real-chart.test.ts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { FlowRecorder, RuntimeSnapshot } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';
import { parseRuntimeStageId } from '../../../src/lib/engine/runtimeStageId.js';
import { tagStops, timeTravel } from '../../../src/trace.js';
import { type ResumeMode, type S, askLoopTopLevelChart, drive, RESUME_CHARTS } from './resume-real-chart-fixture.js';

const MODES: ResumeMode[] = ['same', 'cross'];
const CHART_NAMES = Object.keys(RESUME_CHARTS) as (keyof typeof RESUME_CHARTS)[];

type Bundle = { runtimeStageId: string; stageId?: string; tags?: readonly string[] };

/** The commit logs of one leg: the top-level log, then every per-execution subflow log. */
function logsOf(leg: RuntimeSnapshot, includeTopLevel: boolean): Bundle[][] {
  const logs: Bundle[][] = includeTopLevel ? [leg.commitLog as Bundle[]] : [];
  for (const [key, value] of Object.entries(leg.subflowResults ?? {})) {
    if (!key.includes('#')) continue; // the path key repeats the last execution's record
    const history = (value as { treeContext?: { history?: Bundle[] } }).treeContext?.history;
    if (history) logs.push(history);
  }
  return logs;
}

/**
 * Every commit log of the whole run, across legs and levels. Same-executor,
 * the top-level log ACCUMULATES across legs (the runtime is reused), so only
 * the last leg's is taken; cross-executor, every leg brings its own.
 */
function allLogs(legs: RuntimeSnapshot[], mode: ResumeMode): Bundle[][] {
  const logs: Bundle[][] = [];
  legs.forEach((leg, i) => {
    const topLevel = mode === 'cross' || i === legs.length - 1;
    logs.push(...logsOf(leg, topLevel));
  });
  return logs;
}

/**
 * The stage executions a log records: a mount's consecutive entry/exit
 * bundles collapse into one, and a subflow's SEED commit (`history[0]`,
 * committed by the nested root before any stage runs — runtimeStageId `''`)
 * is not a stage execution.
 */
function executionsOf(log: Bundle[]): Bundle[] {
  return log.filter((b, i) => b.runtimeStageId !== '' && (i === 0 || log[i - 1].runtimeStageId !== b.runtimeStageId));
}

describe.each(MODES)('invariants across a resume — %s-executor', (mode) => {
  it.each(CHART_NAMES)(
    '%s: every runtimeStageId names ONE execution, at every level, across every leg',
    async (name) => {
      const run = await drive(RESUME_CHARTS[name](), mode);

      const ids = allLogs(run.legs, mode).flatMap((log) => executionsOf(log).map((b) => b.runtimeStageId));
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it.each(CHART_NAMES)(
    '%s: executionIndex never resets — the top-level log climbs across every resume',
    async (name) => {
      const run = await drive(RESUME_CHARTS[name](), mode);

      const topLevel =
        mode === 'same'
          ? (run.legs[run.legs.length - 1].commitLog as Bundle[])
          : run.legs.flatMap((l) => l.commitLog as Bundle[]);
      const indices = topLevel.map((b) => parseRuntimeStageId(b.runtimeStageId).executionIndex);
      for (let i = 1; i < indices.length; i++) expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]);
      // Every checkpoint's counter is ahead of every index committed before it.
      for (const checkpoint of run.checkpoints) expect(checkpoint.executionCount).toBeGreaterThan(0);
      const counts = run.checkpoints.map((c) => c.executionCount!);
      for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]);
    },
  );

  it.each(CHART_NAMES)(
    '%s: one CommitBundle per executed stage — only a mount repeats, as its entry/exit pair',
    async (name) => {
      const run = await drive(RESUME_CHARTS[name](), mode);

      for (const log of allLogs(run.legs, mode)) {
        const seen = new Map<string, number>();
        log.forEach((b, i) => {
          if (b.runtimeStageId === '') {
            expect(i).toBe(0); // a subflow's seed commit, and only ever first
            return;
          }
          const repeat = i > 0 && log[i - 1].runtimeStageId === b.runtimeStageId;
          if (!repeat) {
            expect(seen.has(b.runtimeStageId)).toBe(false); // never re-used later in the log
            seen.set(b.runtimeStageId, 1);
            return;
          }
          const n = seen.get(b.runtimeStageId)! + 1;
          seen.set(b.runtimeStageId, n);
          expect(n).toBeLessThanOrEqual(2);
          // Only a subflow mount commits twice (its outputMapper merge-back).
          const stageId = parseRuntimeStageId(b.runtimeStageId).stageId;
          expect(stageId.split('/').pop()!.startsWith('sf')).toBe(true);
        });
      }
    },
  );
});

describe('the reader chains a cross-executor run as one axis', () => {
  it.each(CHART_NAMES)('%s: timeTravel(legs) accepts every leg — monotonic indices, no repeated id', async (name) => {
    const run = await drive(RESUME_CHARTS[name](), 'cross');

    const cursor = timeTravel(run.legs);
    expect(cursor.stops.length).toBeGreaterThan(0);
  });
});

describe('maxIterations still bounds a loop that spans a resume', () => {
  /** A loop that never exits, paused once in its body on the first pass. */
  function endlessLoop() {
    return flowChart(
      'Init',
      (s: S) => {
        s.iter = 0;
        s.trace = [];
      },
      'init',
    )
      .addFunction(
        'Head',
        (s: S) => {
          s.iter += 1;
        },
        'head',
      )
      .addPausableFunction(
        'Ask',
        { execute: (s: S) => (s.iter === 1 ? { question: 'q' } : undefined), resume: () => undefined },
        'ask',
      )
      .addDeciderFunction('Route', () => 'again', 'route')
      .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'head' })
      .addFunctionBranch('never', 'Never', () => undefined)
      .end()
      .build();
  }

  it.each(MODES)(
    '%s-executor: the resumed leg runs into the guard instead of ending (or running) silently',
    async (mode) => {
      const chart = endlessLoop();
      const first = new FlowChartExecutor(chart);
      await first.run();
      const checkpoint = mode === 'cross' ? JSON.parse(JSON.stringify(first.getCheckpoint())) : first.getCheckpoint()!;
      const executor = mode === 'cross' ? new FlowChartExecutor(chart) : first;

      await expect(executor.resume(checkpoint, undefined, { maxIterations: 5 })).rejects.toThrow(
        /Maximum loop iterations \(5\) exceeded for node 'head'/,
      );
      // The loop really ran past the resume point: five passes, then the guard.
      expect((executor.getSnapshot().sharedState as S).iter).toBe(6);
    },
  );
});

describe('recorders and narrative accumulate across a same-executor resume', () => {
  it('the flow recorder sees every leg; the resumed loop edge is a LOOP, as on a run', async () => {
    const events: string[] = [];
    const recorder: FlowRecorder = {
      id: 'probe',
      onLoop: (e) => events.push(`loop:${e.target}`),
      onPause: (e) => events.push(`pause:${e.stageId}`),
      onResume: (e) => events.push(`resume:${e.stageId}`),
    };
    const chart = askLoopTopLevelChart();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    executor.attachFlowRecorder(recorder);

    await executor.run();
    const afterRun = executor.getNarrativeEntries().length;
    await executor.resume(executor.getCheckpoint()!, { n: 1 }); // pauses again (the re-ask)
    const afterFirstResume = executor.getNarrativeEntries().length;
    await executor.resume(executor.getCheckpoint()!, { n: 2 });
    const afterSecondResume = executor.getNarrativeEntries().length;

    expect(events).toEqual(['pause:ask', 'resume:ask', 'loop:Ask', 'pause:ask', 'resume:ask']);
    expect(afterFirstResume).toBeGreaterThan(afterRun);
    expect(afterSecondResume).toBeGreaterThan(afterFirstResume);
    const text = executor.getNarrativeEntries().map((e) => e.text);
    // The loop back to the paused stage is narrated as a loop — the real stage.
    expect(text.filter((t) => /On pass 1: ask again/.test(t))).toHaveLength(1);
  });
});

describe('the re-entry into a subflow is narrated as THAT subflow', () => {
  it.each(MODES)(
    '%s-executor: onSubflowEntry carries the subflow root’s description, not the paused stage’s',
    async (mode) => {
      const inner = flowChart('Plan', () => undefined, 'plan', { description: 'Inner: plans, then asks' })
        .addPausableFunction(
          'Ask',
          { execute: () => ({ question: 'q' }), resume: () => undefined },
          'ask',
          'asks the person',
        )
        .build();
      const chart = flowChart('Init', () => undefined, 'init')
        .addSubFlowChartNext('sf', inner, 'Inner')
        .build();
      const entries: (string | undefined)[] = [];
      const recorder: FlowRecorder = { id: 'entries', onSubflowEntry: (e) => entries.push(e.description) };

      await drive(chart, mode, {
        newExecutor: (c) => {
          const executor = new FlowChartExecutor(c);
          executor.attachFlowRecorder(recorder);
          return executor;
        },
      });

      // The run's entry, then the resume's re-entry — the same subflow, the same words.
      expect(entries).toEqual(['Inner: plans, then asks', 'Inner: plans, then asks']);
    },
  );
});

describe('declared tags and retry follow the resumed stage — and the real stage keeps its own', () => {
  it('tags: the stand-in’s bundle AND the real stage’s bundle on the loop re-visit carry the tag', async () => {
    const chart = flowChart(
      'Plan',
      (s: S) => {
        s.trace = ['plan'];
      },
      'plan',
    )
      .addPausableFunction(
        'Ask',
        {
          execute: (s: S) => {
            s.trace = [...s.trace, 'ask'];
            return { question: 'q' };
          },
          resume: (s: S) => {
            s.rounds = ((s.rounds as number | undefined) ?? 0) + 1;
          },
        },
        'ask',
      )
      .tag('milestone:ask')
      .addDeciderFunction('Bind', (s: S) => ((s.rounds as number) < 2 ? 'again' : 'done'), 'bind')
      .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'ask' })
      .addFunctionBranch('done', 'Done', () => undefined)
      .end()
      .build();

    const run = await drive(chart, 'same');
    const log = run.legs[run.legs.length - 1].commitLog as Bundle[];
    const askBundles = log.filter((b) => b.runtimeStageId.startsWith('ask#'));
    // run: execute (paused) · resume 1: stand-in, then the REAL stage (paused
    // again) · resume 2: stand-in. Four executions of 'ask', every one tagged.
    expect(askBundles).toHaveLength(4);
    for (const bundle of askBundles) expect(bundle.tags).toEqual(['milestone:ask']);
    const stops = timeTravel(run.legs[run.legs.length - 1], { strategy: tagStops(['milestone:ask']) }).stops.filter(
      (s) => s.kind === 'commit',
    );
    expect(stops).toHaveLength(4);
  });

  it('retry: the interrupt re-entry keeps the stage’s policy; a loop re-visit runs the REAL stage with it', async () => {
    const attempts: string[] = [];
    let failNext = false;
    const chart = flowChart(
      'Init',
      (s: S) => {
        s.trace = [];
      },
      'init',
    )
      .addFunction(
        'Ask',
        (s: S) => {
          attempts.push(`attempt:${(s.trace as string[]).length}`);
          if (failNext) {
            failNext = false;
            throw new Error('flaky once');
          }
          const answer = interrupt<{ n: number }>(s, { reason: 'q' });
          s.trace = [...s.trace, `answer${answer.n}`];
        },
        'ask',
      )
      .retry({ attempts: 2, backoffMs: 0 })
      .addDeciderFunction('Bind', (s: S) => ((s.trace as string[]).length < 2 ? 'again' : 'done'), 'bind')
      .addFunctionBranch(
        'again',
        'Again',
        () => {
          failNext = true;
        },
        'again',
        { loopTo: 'ask' },
      )
      .addFunctionBranch('done', 'Done', () => undefined)
      .end()
      .build();

    // Pause 1 → resume: the stand-in re-runs 'ask' (answer1) → Bind loops →
    // the REAL 'ask' throws once (retried), then interrupts (pause 2) →
    // resume: the stand-in re-runs it again (answer2) → done.
    const run = await drive(chart, 'cross');
    expect(run.pauses).toBe(2);
    expect(run.trace).toEqual(['answer1', 'answer2']);
    // The re-visit's first attempt failed and was retried by the real stage's policy.
    expect(attempts).toEqual(['attempt:0', 'attempt:0', 'attempt:1', 'attempt:1', 'attempt:1']);
  });

  it('retry: the addPausableFunction re-entry runs its resume half WITHOUT the policy (unchanged)', async () => {
    let resumeCalls = 0;
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addPausableFunction(
        'Gate',
        {
          execute: () => ({ question: 'q' }),
          resume: () => {
            resumeCalls += 1;
            throw new Error('resume half failed');
          },
        },
        'gate',
      )
      .retry({ attempts: 3, backoffMs: 0 })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    await expect(executor.resume(executor.getCheckpoint()!, {})).rejects.toThrow('resume half failed');
    expect(resumeCalls).toBe(1);
  });
});

describe('interrupt() re-entry re-runs the stage from its top (unchanged)', () => {
  it('the half before the interrupt runs once per pass; the half after runs once', async () => {
    const tops: number[] = [];
    const chart = flowChart(
      'Init',
      (s: S) => {
        s.trace = [];
      },
      'init',
    )
      .addFunction(
        'Ask',
        (s: S) => {
          tops.push(tops.length + 1);
          const answer = interrupt<{ n: number }>(s, { reason: 'q' });
          s.trace = [...s.trace, `answer${answer.n}`];
        },
        'ask',
      )
      .build();

    for (const mode of MODES) {
      tops.length = 0;
      const run = await drive(chart, mode);
      expect(tops).toEqual([1, 2]);
      expect(run.trace).toEqual(['answer1']);
    }
  });
});

describe('the checkpoint shape is unchanged from 9.27.0', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const reference = JSON.parse(readFileSync(join(here, 'reference', 'resume-real-chart-9.27.0.json'), 'utf8')) as {
    checkpoints: Record<string, Record<string, unknown>>;
  };

  it.each(CHART_NAMES)('%s: same keys, same value kinds as the checkpoint 9.27.0 wrote', async (name) => {
    const executor = new FlowChartExecutor(RESUME_CHARTS[name]());
    await executor.run();
    const now = JSON.parse(JSON.stringify(executor.getCheckpoint())) as Record<string, unknown>;
    const then = reference.checkpoints[name];

    const kinds = (cp: Record<string, unknown>) =>
      Object.fromEntries(
        Object.keys(cp)
          .sort()
          .map((k) => [k, Array.isArray(cp[k]) ? 'array' : typeof cp[k]]),
      );
    expect(kinds(now)).toEqual(kinds(then));
    // And the parts resume reads are the same values.
    for (const key of ['pausedStageId', 'subflowPath', 'pauseData', 'pausedBy', 'sharedState', 'subflowStates']) {
      expect(now[key]).toEqual(then[key]);
    }
  });
});

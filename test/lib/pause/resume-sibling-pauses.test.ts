/**
 * PARALLEL SIBLINGS THAT BOTH PAUSE (9.28.0) — each asks in turn; the
 * fan-out's join runs once, after the last answer.
 *
 * When two children of one fork (or two selected branches of one selector)
 * pause in the same pass, only one question can be asked at a time. Before
 * 9.28.0 the fan-out kept the FIRST child's pause and dropped the others
 * silently: 9.27.0 then re-ran the whole fan-out on every resume and never
 * finished (the two children took turns pausing forever); the first 9.28.0
 * draft resumed the first child and skipped both the second question and the
 * join.
 *
 * Now the checkpoint asks the first child and carries every other paused
 * sibling in `pendingPauses` (stage, path, captured subflow state, question).
 * Resuming it finishes the first child, then pauses again with the next
 * sibling's question — nothing of that sibling re-runs, and a sibling that
 * COMPLETED before the pause never runs again. The join runs only when the
 * last sibling is resumed.
 *
 * Test type: functional + security (the new optional checkpoint field is
 * untrusted input). Both resume modes.
 */

import { describe, expect, it, vi } from 'vitest';

import { ArrayMergeMode } from '../../../src/advanced.js';
import type { FlowChart, FlowchartCheckpoint, FlowRecorder } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';
import { type ResumeMode, type S, drive } from './resume-real-chart-fixture.js';

const MODES: ResumeMode[] = ['same', 'cross'];

/** A subflow that starts, then asks through interrupt(); `runs` counts its opening stage. */
function asker(tag: string, runs: string[]): FlowChart {
  return flowChart(
    'Start',
    (s: S) => {
      runs.push(`${tag}-start`);
      s.log = [`${tag}-start`];
    },
    'start',
  )
    .addFunction(
      'Ask',
      (s: S) => {
        const answer = interrupt<{ n: number }>(s, { who: tag });
        s.log = [...(s.log as string[]), `${tag}-ans${answer.n}`];
      },
      'ask',
    )
    .build();
}

/** Pre (fork parent) → [c1, c2, (quiet)] → Join. `quiet` completes on the first pass. */
function forkBody(runs: string[], withQuiet = false): FlowChart {
  const quiet = flowChart(
    'Q',
    (s: S) => {
      runs.push('quiet');
      s.log = ['quiet-done'];
    },
    'q',
  ).build();
  let b = flowChart(
    'Pre',
    (s: S) => {
      runs.push('pre');
      s.pre = ((s.pre as number | undefined) ?? 0) + 1;
    },
    'pre',
  )
    .addSubFlowChart('c1', asker('c1', runs), 'C1', { outputMapper: (sf: Record<string, unknown>) => ({ c1: sf.log }) })
    .addSubFlowChart('c2', asker('c2', runs), 'C2', {
      outputMapper: (sf: Record<string, unknown>) => ({ c2: sf.log }),
    });
  if (withQuiet) {
    b = b.addSubFlowChart('quiet', quiet, 'Quiet', { outputMapper: (sf: Record<string, unknown>) => ({ q: sf.log }) });
  }
  return b
    .addFunction(
      'Join',
      (s: S) => {
        runs.push('join');
        s.joined = { c1: s.c1, c2: s.c2, q: s.q };
      },
      'join',
    )
    .build();
}

function nested(runs: string[], withQuiet = false): FlowChart {
  return flowChart(
    'Init',
    (s: S) => {
      s.trace = ['init'];
    },
    'init',
  )
    .addSubFlowChartNext('sf-a', forkBody(runs, withQuiet), 'A', {
      outputMapper: (sf: Record<string, unknown>) => ({ joined: sf.joined, pre: sf.pre }),
    })
    .addFunction(
      'Final',
      (s: S) => {
        s.trace = [...s.trace, 'final'];
      },
      'final',
    )
    .build();
}

describe.each(MODES)('two fork children both pause — %s-executor', (mode) => {
  it('top level: c1 is asked, then c2 — nothing re-runs — and the join runs once, after both', async () => {
    const runs: string[] = [];
    const run = await drive(forkBody(runs), mode);

    expect(run.pauses).toBe(2);
    expect(run.checkpoints.map((c) => c.pausedStageId)).toEqual(['c1/ask', 'c2/ask']);
    expect(run.checkpoints.map((c) => c.pauseData)).toEqual([{ who: 'c1' }, { who: 'c2' }]);
    // The first checkpoint carries c2's pause; the second carries nothing more.
    expect(run.checkpoints[0].pendingPauses).toEqual([
      {
        pausedStageId: 'c2/ask',
        subflowPath: ['c2'],
        subflowStates: { c2: { log: ['c2-start'] } },
        pauseData: { who: 'c2' },
        pausedBy: 'interrupt',
        // 9.37.0 (F7): the execution c2 paused in — its own resume links to it.
        pausedExecution: { runId: expect.any(String), runtimeStageId: 'c2/ask#6' },
      },
    ]);
    expect(run.checkpoints[1].pendingPauses).toBeUndefined();
    // c2's checkpoint names c2's OWN execution, in the run it paused in (the first leg).
    expect(run.checkpoints[1].pausedExecution).toEqual(run.checkpoints[0].pendingPauses![0].pausedExecution);
    expect(run.checkpoints[1].pausedExecution!.runId).toBe(run.checkpoints[0].pausedExecution!.runId);
    expect(run.state.joined).toEqual({ c1: ['c1-start', 'c1-ans1'], c2: ['c2-start', 'c2-ans2'], q: undefined });
    // pre, c1-start, c2-start once each (the run); the join once (the last resume).
    expect(runs).toEqual(['pre', 'c1-start', 'c2-start', 'join']);
  });

  it('nested one subflow down: the same, and the parent continues after the subflow', async () => {
    const runs: string[] = [];
    const run = await drive(nested(runs), mode);

    expect(run.pauses).toBe(2);
    expect(run.checkpoints.map((c) => c.subflowPath)).toEqual([
      ['sf-a', 'sf-a/c1'],
      ['sf-a', 'sf-a/c2'],
    ]);
    expect(run.checkpoints[0].pendingPauses?.map((p) => p.subflowPath)).toEqual([['sf-a', 'sf-a/c2']]);
    expect(run.trace).toEqual(['init', 'final']);
    expect(run.state.pre).toBe(1);
    expect(run.state.joined).toEqual({ c1: ['c1-start', 'c1-ans1'], c2: ['c2-start', 'c2-ans2'], q: undefined });
    expect(runs).toEqual(['pre', 'c1-start', 'c2-start', 'join']);
  });

  it('a sibling that COMPLETED before the pause never runs again', async () => {
    const runs: string[] = [];
    const run = await drive(nested(runs, true), mode);

    expect(run.pauses).toBe(2);
    expect(runs.filter((r) => r === 'quiet')).toHaveLength(1);
    expect((run.state.joined as { q: unknown }).q).toEqual(['quiet-done']);
  });

  it('the resumed child asking AGAIN keeps the waiting sibling in line', async () => {
    const runs: string[] = [];
    // c1 asks twice (a re-ask inside one stage), c2 once: three questions.
    const twice = flowChart(
      'Start',
      (s: S) => {
        runs.push('c1-start');
        s.log = ['c1-start'];
      },
      'start',
    )
      .addFunction(
        'Ask',
        (s: S) => {
          if (s.first === undefined) s.first = interrupt<{ n: number }>(s, { who: 'c1', round: 1 }).n;
          const second = interrupt<{ n: number }>(s, { who: 'c1', round: 2 }).n;
          s.log = [...(s.log as string[]), `c1-ans${s.first}+${second}`];
        },
        'ask',
      )
      .build();
    const chart = flowChart('Pre', () => undefined, 'pre')
      .addSubFlowChart('c1', twice, 'C1', { outputMapper: (sf: Record<string, unknown>) => ({ c1: sf.log }) })
      .addSubFlowChart('c2', asker('c2', runs), 'C2', {
        outputMapper: (sf: Record<string, unknown>) => ({ c2: sf.log }),
      })
      .addFunction(
        'Join',
        (s: S) => {
          s.joined = [s.c1, s.c2];
        },
        'join',
      )
      .build();

    const run = await drive(chart, mode);

    expect(run.checkpoints.map((c) => c.pauseData)).toEqual([
      { who: 'c1', round: 1 },
      { who: 'c1', round: 2 },
      { who: 'c2' },
    ]);
    // c2's pause waits behind BOTH of c1's questions.
    expect(run.checkpoints[1].pendingPauses?.map((p) => p.pausedStageId)).toEqual(['c2/ask']);
    expect(run.state.joined).toEqual([
      ['c1-start', 'c1-ans1+2'],
      ['c2-start', 'c2-ans3'],
    ]);
  });

  it('fail-fast fork: a pause does not race past its siblings — both are asked', async () => {
    const runs: string[] = [];
    const chart = flowChart('Pre', () => undefined, 'pre')
      .addSubFlowChart('c1', asker('c1', runs), 'C1', {
        outputMapper: (sf: Record<string, unknown>) => ({ c1: sf.log }),
      })
      .addSubFlowChart('c2', asker('c2', runs), 'C2', {
        outputMapper: (sf: Record<string, unknown>) => ({ c2: sf.log }),
      })
      .addFunction(
        'Join',
        (s: S) => {
          s.joined = [s.c1, s.c2];
        },
        'join',
      )
      .build();
    (chart.root as { failFast?: boolean }).failFast = true;

    const run = await drive(chart, mode);

    expect(run.pauses).toBe(2);
    expect(run.state.joined).toEqual([
      ['c1-start', 'c1-ans1'],
      ['c2-start', 'c2-ans2'],
    ]);
  });

  it('plain fork-child STAGES that interrupt(): each re-runs with its answer, then the join', async () => {
    const seen: string[] = [];
    const chart = flowChart(
      'Pre',
      (s: S) => {
        s.pre = ((s.pre as number | undefined) ?? 0) + 1;
      },
      'pre',
    )
      .addListOfFunction([
        {
          id: 'x',
          name: 'X',
          fn: (s: S) => {
            seen.push(`x=${interrupt<{ n: number }>(s, { who: 'x' }).n}`);
          },
        },
        {
          id: 'y',
          name: 'Y',
          fn: (s: S) => {
            seen.push(`y=${interrupt<{ n: number }>(s, { who: 'y' }).n}`);
          },
        },
      ])
      .addFunction(
        'Join',
        (s: S) => {
          seen.push('join');
          s.joins = ((s.joins as number | undefined) ?? 0) + 1;
        },
        'join',
      )
      .build();

    const run = await drive(chart, mode);

    expect(run.checkpoints.map((c) => [c.pausedStageId, c.subflowPath])).toEqual([
      ['x', []],
      ['y', []],
    ]);
    expect(run.state.pre).toBe(1);
    expect(run.state.joins).toBe(1);
    expect(seen).toEqual(['x=1', 'y=2', 'join']);
  });

  it('two SELECTED branches that both pause: the selector’s next runs after the second answer', async () => {
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addSelectorFunction('Pick', () => ['a', 'b'], 'pick')
      .addPausableFunctionBranch('a', 'A', {
        execute: () => ({ who: 'a' }),
        resume: (s: S, input: unknown) => {
          s.a = input;
        },
      })
      .addPausableFunctionBranch('b', 'B', {
        execute: () => ({ who: 'b' }),
        resume: (s: S, input: unknown) => {
          s.b = input;
        },
      })
      .end()
      .addFunction(
        'After',
        (s: S) => {
          s.after = ((s.after as number | undefined) ?? 0) + 1;
        },
        'after',
      )
      .build();

    const run = await drive(chart, mode);

    expect(run.checkpoints.map((c) => c.pausedStageId)).toEqual(['a', 'b']);
    expect(run.state.after).toBe(1);
  });
});

describe.each(MODES)('a nested fan-out as the SECOND child of a fan-out — %s-executor', (mode) => {
  it('its own waiting sibling is carried up too: b, then sf-a/c1, then sf-a/c2 — each join once', async () => {
    const runs: string[] = [];
    const chart = flowChart(
      'Top',
      (s: S) => {
        s.tops = ((s.tops as number | undefined) ?? 0) + 1;
      },
      'top',
    )
      .addSubFlowChart('b', asker('b', runs), 'B', { outputMapper: (sf: Record<string, unknown>) => ({ b: sf.log }) })
      .addSubFlowChart('sf-a', forkBody(runs), 'A', {
        outputMapper: (sf: Record<string, unknown>) => ({ aJoined: sf.joined }),
      })
      .addFunction(
        'TopJoin',
        (s: S) => {
          s.topJoins = ((s.topJoins as number | undefined) ?? 0) + 1;
        },
        'top-join',
      )
      .build();

    const run = await drive(chart, mode);

    // The fan-out inside sf-a queued c2 behind c1; the top fan-out must forward
    // THAT queue too when it queues sf-a's pause behind b's.
    expect(run.checkpoints.map((c) => c.pausedStageId)).toEqual(['b/ask', 'sf-a/c1/ask', 'sf-a/c2/ask']);
    expect(run.checkpoints[0].pendingPauses?.map((p) => p.pausedStageId)).toEqual(['sf-a/c1/ask', 'sf-a/c2/ask']);
    expect(run.state).toMatchObject({
      tops: 1,
      topJoins: 1,
      b: ['b-start', 'b-ans1'],
      aJoined: { c1: ['c1-start', 'c1-ans2'], c2: ['c2-start', 'c2-ans3'] },
    });
    expect(runs.filter((r) => r === 'join')).toHaveLength(1);
  });
});

describe('the waiting sibling’s question is announced when it is raised again', () => {
  it('onPause fires for it (flow channel), after the resumed child finished', async () => {
    const events: string[] = [];
    const recorder: FlowRecorder = {
      id: 'events',
      onPause: (e) => events.push(`pause:${e.stageId}`),
      onResume: (e) => events.push(`resume:${e.stageId}`),
    };
    await drive(forkBody([]), 'same', {
      newExecutor: (c) => {
        const executor = new FlowChartExecutor(c);
        executor.attachFlowRecorder(recorder);
        return executor;
      },
    });

    expect(events).toEqual([
      'pause:c1/ask',
      'pause:c2/ask',
      'resume:c1/ask',
      'pause:c2/ask', // raised again, nothing re-run
      'resume:c2/ask',
    ]);
  });
});

describe('checkpoint.pendingPauses is untrusted input', () => {
  async function pausedTwice(): Promise<{ chart: FlowChart; checkpoint: FlowchartCheckpoint }> {
    const chart = nested([]);
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    return { chart, checkpoint: JSON.parse(JSON.stringify(executor.getCheckpoint())) as FlowchartCheckpoint };
  }

  it('a record that is not a parallel sibling of the paused stage is refused before anything runs', async () => {
    const { chart, checkpoint } = await pausedTwice();
    const forged = {
      ...checkpoint,
      pendingPauses: [{ pausedStageId: 'final', subflowPath: [], subflowStates: {}, pauseData: 'x' }],
    };
    const resumer = new FlowChartExecutor(chart);

    await expect(resumer.resume(forged, { n: 1 })).rejects.toThrow(
      /Cannot resume: checkpoint\.pendingPauses\[0\] \('final'\) is not a parallel sibling of the paused stage/,
    );
    expect(resumer.getCommitCount()).toBe(0);
  });

  it.each([
    ['not an array', { oops: true }, /pendingPauses must be an array/],
    ['a non-object record', ['c2/ask'], /pendingPauses\[0\] must be an object/],
    ['no stage', [{ subflowPath: [] }], /pendingPauses\[0\]\.pausedStageId must be a non-empty string/],
    [
      'a bad path',
      [{ pausedStageId: 'x', subflowPath: 'sf-a' }],
      /pendingPauses\[0\]\.subflowPath must be an array of strings/,
    ],
    [
      'bad captures',
      [{ pausedStageId: 'x', subflowPath: [], subflowStates: [] }],
      /pendingPauses\[0\]\.subflowStates must be an object/,
    ],
    [
      'a bad pausedBy',
      [{ pausedStageId: 'x', subflowPath: [], pausedBy: 'magic' }],
      /pendingPauses\[0\]\.pausedBy must be 'interrupt'/,
    ],
  ])('a malformed field (%s) is refused', async (_name, pendingPauses, message) => {
    const { chart, checkpoint } = await pausedTwice();
    const executor = new FlowChartExecutor(chart);
    await expect(
      executor.resume({ ...checkpoint, pendingPauses } as unknown as FlowchartCheckpoint, { n: 1 }),
    ).rejects.toThrow(message);
  });

  it('a repeated record is refused', async () => {
    const { chart, checkpoint } = await pausedTwice();
    const twice = { ...checkpoint, pendingPauses: [...checkpoint.pendingPauses!, ...checkpoint.pendingPauses!] };

    await expect(new FlowChartExecutor(chart).resume(twice, { n: 1 })).rejects.toThrow(
      /pendingPauses\[1\] \('sf-a\/c2\/ask'\) repeats an earlier entry/,
    );
  });

  it('the WHOLE path is walked at the first resume — a tampered tail is refused up front', async () => {
    const chart = forkBody([]);
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const checkpoint = JSON.parse(JSON.stringify(executor.getCheckpoint())) as FlowchartCheckpoint;
    const ghost = { ...checkpoint, pendingPauses: [{ ...checkpoint.pendingPauses![0], subflowPath: ['c2', 'ghost'] }] };
    const wrongStage = {
      ...checkpoint,
      pendingPauses: [{ ...checkpoint.pendingPauses![0], pausedStageId: 'c2/nope' }],
    };

    for (const forged of [ghost, wrongStage]) {
      const resumer = new FlowChartExecutor(chart);
      await expect(resumer.resume(forged, { n: 1 })).rejects.toThrow(/is not a parallel sibling/);
      expect(resumer.getCommitCount()).toBe(0);
    }
  });

  it('a record naming the paused stage ITSELF is not its sibling', async () => {
    const chart = flowChart('Pre', () => undefined, 'pre')
      .addListOfFunction([
        {
          id: 'x',
          name: 'X',
          fn: (s: S) => {
            s.x = interrupt<{ n: number }>(s, { who: 'x' }).n;
          },
        },
        {
          id: 'y',
          name: 'Y',
          fn: (s: S) => {
            s.y = interrupt<{ n: number }>(s, { who: 'y' }).n;
          },
        },
      ])
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const checkpoint = JSON.parse(JSON.stringify(executor.getCheckpoint())) as FlowchartCheckpoint;
    expect(checkpoint.pausedStageId).toBe('x');
    const self = { ...checkpoint, pendingPauses: [{ pausedStageId: 'x', subflowPath: [], subflowStates: {} }] };

    await expect(new FlowChartExecutor(chart).resume(self, { n: 1 })).rejects.toThrow(/is not a parallel sibling/);
  });

  it('the stored record is copied in: mutating the caller’s checkpoint after resume() changes nothing', async () => {
    const { chart, checkpoint } = await pausedTwice();
    const executor = new FlowChartExecutor(chart);
    const pending = checkpoint.pendingPauses as unknown as { pauseData: unknown }[];
    const resumed = executor.resume(checkpoint, { n: 1 });
    pending[0].pauseData = 'tampered after the call';
    await resumed;

    expect(executor.getCheckpoint()?.pauseData).toEqual({ who: 'c2' });
  });

  it('a record’s captures above the fan-out are ignored — those subflows capture themselves afresh', async () => {
    const { chart, checkpoint } = await pausedTwice();
    const pending = checkpoint.pendingPauses as unknown as { subflowStates: Record<string, unknown> }[];
    pending[0].subflowStates['sf-a'] = { pre: 99, smuggled: true };
    const executor = new FlowChartExecutor(chart);
    await executor.resume(checkpoint, { n: 1 });

    const next = executor.getCheckpoint()!;
    expect(next.subflowStates['sf-a']).not.toHaveProperty('smuggled');
    expect(next.subflowStates['sf-a']).toMatchObject({ pre: 1 });
  });
});

describe('a checkpoint without pendingPauses resumes exactly as before', () => {
  it('one pausing child: no field on the checkpoint, the join runs after the one resume', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runs: string[] = [];
    const chart = flowChart('Pre', () => undefined, 'pre')
      .addSubFlowChart('c1', asker('c1', runs), 'C1', {
        outputMapper: (sf: Record<string, unknown>) => ({ c1: sf.log }),
        arrayMerge: ArrayMergeMode.Replace,
      })
      .addFunction(
        'Join',
        (s: S) => {
          s.joined = s.c1;
        },
        'join',
      )
      .build();

    for (const mode of MODES) {
      const run = await drive(chart, mode);
      expect(run.checkpoints[0]).not.toHaveProperty('pendingPauses');
      expect(run.state.joined).toEqual(['c1-start', 'c1-ans1']);
    }
    warn.mockRestore();
  });
});

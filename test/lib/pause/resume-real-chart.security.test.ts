/**
 * SECURITY — a checkpoint is untrusted input; the one-shot re-entry narrows
 * what it can do (9.28.0).
 *
 * A checkpoint may come back from Redis, Postgres or a client. Before 9.28.0
 * `resume()` handed the WHOLE `subflowStates` map to every subflow entry of the
 * resumed run, and fell back to running the paused stage's stand-in at the top
 * level when the path's mount could not be found. So a tampered checkpoint
 * could:
 *
 *   - seed ANY subflow the resumed run later entered — off the pause path,
 *     with its inputMapper skipped — with state of the attacker's choosing;
 *   - resume a path the chart cannot walk into a shape the chart never has
 *     (an inner resume half running at the top level, its outputMappers and
 *     the parent's continuation silently skipped).
 *
 * Now the re-entry is planned against the chart before anything runs: only
 * the subflows ON the pause path take a capture, each once; a path the chart
 * cannot walk — or cannot walk UNAMBIGUOUSLY (a subflow id mounted twice) —
 * is refused with nothing executed and nothing wiped; and what runs after
 * the paused stage is read from the chart, never from the checkpoint's
 * `continuationStageId`, so an edited id cannot redirect the run.
 *
 * Test type: security.
 */

import { describe, expect, it, vi } from 'vitest';

import type { FlowChart, FlowchartCheckpoint } from '../../../src/index.js';
import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from '../../../src/index.js';
import { type S, twoDeepChart } from './resume-real-chart-fixture.js';

/**
 * init → sf-ask (pauses) → sf-role (reads its inputMapper's `role`) → final.
 * sf-role runs only AFTER the resume — the entry a smuggled capture would hit.
 */
function roleChart(calls: string[]): FlowChart {
  const ask = flowChart(
    'Start',
    () => {
      calls.push('ask-start');
    },
    'ask-start',
  )
    .addPausableFunction(
      'Ask',
      {
        execute: () => ({ question: 'q' }),
        resume: () => {
          calls.push('ask-resume');
        },
      },
      'ask',
    )
    .build();
  const role = flowChart(
    'Read',
    (s: S) => {
      calls.push('role-read');
      s.seenRole = s.role;
    },
    'read',
  ).build();
  return flowChart(
    'Init',
    () => {
      calls.push('init');
    },
    'init',
  )
    .addSubFlowChartNext('sf-ask', ask, 'Ask')
    .addSubFlowChartNext('sf-role', role, 'Role', {
      inputMapper: () => ({ role: 'user' }),
      outputMapper: (sf: Record<string, unknown>) => ({ seenRole: sf.seenRole }),
    })
    .build();
}

describe('a capture for a subflow OFF the pause path is ignored', () => {
  it.each(['same', 'cross'] as const)('%s-executor: a smuggled capture cannot seed a later subflow', async (mode) => {
    const calls: string[] = [];
    const executor = new FlowChartExecutor(roleChart(calls));
    await executor.run();
    const checkpoint = JSON.parse(JSON.stringify(executor.getCheckpoint())) as FlowchartCheckpoint;
    expect(checkpoint.subflowPath).toEqual(['sf-ask']);
    // Tamper: a capture for sf-role, which is not on the pause path.
    (checkpoint.subflowStates as Record<string, unknown>)['sf-role'] = { role: 'admin', seenRole: 'admin' };

    const resumer = mode === 'cross' ? new FlowChartExecutor(roleChart(calls)) : executor;
    calls.length = 0;
    await resumer.resume(checkpoint, {});

    // sf-role's inputMapper ran; the smuggled state never reached it.
    expect(resumer.getSnapshot().sharedState.seenRole).toBe('user');
    expect(calls).toEqual(['ask-resume', 'role-read']);
  });
});

describe('a path the chart cannot walk is refused before anything runs', () => {
  it('a path that SKIPS a level (the inner subflow named without its parent) is refused', async () => {
    const chart = twoDeepChart();
    const first = new FlowChartExecutor(chart);
    await first.run();
    const checkpoint = JSON.parse(JSON.stringify(first.getCheckpoint())) as FlowchartCheckpoint;
    expect(checkpoint.subflowPath).toEqual(['sf-a', 'sf-a/sf-b']);
    const skipped = { ...checkpoint, subflowPath: ['sf-a/sf-b'] };

    const resumer = new FlowChartExecutor(chart);
    await expect(resumer.resume(skipped, { n: 1 })).rejects.toThrow(
      /Cannot resume: the mount of subflow 'sf-a\/sf-b' is not reachable from the flowchart/,
    );
    // Nothing ran: no leg was started, no state was written.
    expect(resumer.getCommitCount()).toBe(0);
  });

  it('a hostile path segment (`__proto__`) names no mount in the chart — refused before any lookup by id', async () => {
    const chart = twoDeepChart();
    const first = new FlowChartExecutor(chart);
    await first.run();
    const checkpoint = JSON.parse(JSON.stringify(first.getCheckpoint())) as FlowchartCheckpoint;
    const hostile = { ...checkpoint, subflowPath: ['__proto__', 'sf-a/sf-b'] };

    await expect(new FlowChartExecutor(chart).resume(hostile, { n: 1 })).rejects.toThrow(/Cannot resume/);
  });

  it('a refused resume leaves the executor’s own checkpoint in place (same-executor)', async () => {
    const chart = twoDeepChart();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const good = executor.getCheckpoint()!;
    const bad = { ...JSON.parse(JSON.stringify(good)), subflowPath: ['sf-a/sf-b'] } as FlowchartCheckpoint;

    await expect(executor.resume(bad, { n: 1 })).rejects.toThrow(/Cannot resume/);
    expect(executor.isPaused()).toBe(true);
    expect(executor.getCheckpoint()).toBe(good);
    // …and the good one still resumes.
    await executor.resume(good, { n: 1 });
    expect(executor.getSnapshot().sharedState.trace).toEqual([
      'init',
      'a-pre',
      'b-start',
      'b-ask',
      'b-answer',
      'b-post',
      'a-post',
      'final',
    ]);
  });
});

describe('a pause-path capture is used exactly once', () => {
  it('a capture cannot outlive its re-entry: the next entry of the same subflow is seeded by its inputMapper', async () => {
    const seen: unknown[] = [];
    const inner = flowChart(
      'Start',
      (s: S) => {
        seen.push(s.token);
      },
      'sf-start',
    )
      .addPausableFunction(
        'Ask',
        { execute: (s: S) => (s.pass === 1 ? { question: 'q' } : undefined), resume: () => undefined },
        'sf-ask',
      )
      .build();
    const chart = flowChart(
      'Init',
      (s: S) => {
        s.iter = 0;
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
      .addSubFlowChartNext('sf', inner, 'Inner', {
        inputMapper: (p: Record<string, unknown>) => ({ pass: p.iter, token: `mapped-${p.iter}` }),
      })
      .addDeciderFunction('Route', (s: S) => (s.iter < 2 ? 'again' : 'done'), 'route')
      .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'head' })
      .addFunctionBranch('done', 'Done', () => undefined)
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const checkpoint = JSON.parse(JSON.stringify(executor.getCheckpoint())) as FlowchartCheckpoint;
    // Tamper the ON-path capture: it may seed the re-entry (that is its job) — once.
    (checkpoint.subflowStates as Record<string, Record<string, unknown>>).sf.token = 'forged';

    seen.length = 0;
    await new FlowChartExecutor(chart).resume(checkpoint, {});
    // Pass 2 entered sf fresh: its inputMapper's token, never the forged one.
    expect(seen).toEqual(['mapped-2']);
  });
});

describe('hand-edited paths are refused before anything runs', () => {
  it.each([
    ['a prototype member as the first segment', ['constructor', 'sf-a/sf-b'], /mount of subflow 'constructor'/],
    [
      '`__proto__` in the middle',
      ['sf-a', '__proto__', 'sf-a/sf-b'],
      /mount of subflow '__proto__' is not reachable from subflow 'sf-a'/,
    ],
    [
      'a segment repeated',
      ['sf-a', 'sf-a', 'sf-a/sf-b'],
      /mount of subflow 'sf-a' is not reachable from subflow 'sf-a'/,
    ],
  ])('%s', async (_name, subflowPath, message) => {
    const chart = twoDeepChart();
    const first = new FlowChartExecutor(chart);
    await first.run();
    const checkpoint = { ...JSON.parse(JSON.stringify(first.getCheckpoint())), subflowPath } as FlowchartCheckpoint;

    const resumer = new FlowChartExecutor(chart);
    await expect(resumer.resume(checkpoint, { n: 1 })).rejects.toThrow(message);
    expect(resumer.getCommitCount()).toBe(0);
  });
});

describe('a subflow id mounted TWICE: a pause inside it is refused, loudly, at resume()', () => {
  /** The same subflow chart mounted twice under ONE id — legal to build, ambiguous to resume. */
  function mountedTwice(askOn: number): FlowChart {
    const inner = flowChart('Start', () => undefined, 'sf-start')
      .addPausableFunction(
        'Ask',
        { execute: (s: S) => (s.pass === askOn ? { question: 'q' } : undefined), resume: () => undefined },
        'sf-ask',
      )
      .build();
    return flowChart('Init', () => undefined, 'init')
      .addSubFlowChartNext('sf', inner, 'First', { inputMapper: () => ({ pass: 1 }) })
      .addFunction('Middle', () => undefined, 'middle')
      .addSubFlowChartNext('sf', inner, 'Second', { inputMapper: () => ({ pass: 2 }) })
      .build();
  }

  it.each([
    ['same', 1],
    ['same', 2],
    ['cross', 1],
    ['cross', 2],
  ] as const)(
    '%s-executor, the pause in mount %i: refused, naming both mounts; the checkpoint is kept',
    async (mode, askOn) => {
      const chart = mountedTwice(askOn);
      const first = new FlowChartExecutor(chart);
      await first.run();
      const checkpoint = mode === 'cross' ? JSON.parse(JSON.stringify(first.getCheckpoint())) : first.getCheckpoint()!;
      expect(checkpoint.subflowPath).toEqual(['sf']);
      const executor = mode === 'cross' ? new FlowChartExecutor(chart) : first;

      // Before: the resume re-entered the FIRST mount — a pause in the second
      // one then asked again forever (or, on 9.27.0, ran the wrong mount).
      await expect(executor.resume(checkpoint, {})).rejects.toThrow(
        "Cannot resume: subflow 'sf' is mounted more than once in the flowchart ('First', 'Second')",
      );
      if (mode === 'same') expect(executor.getCheckpoint()).toBe(checkpoint);
    },
  );

  it('dev mode says so at BUILD time — and building stays legal (existing charts do it)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mountedTwice(1); // dev mode off: silent
      expect(warn).not.toHaveBeenCalled();

      enableDevMode();
      const chart = mountedTwice(1);
      expect(chart.root.id).toBe('init');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("subflow id 'sf' is mounted more than once");
    } finally {
      disableDevMode();
      warn.mockRestore();
    }
  });
});

describe('what runs after the paused stage comes from the chart, not the checkpoint', () => {
  it('a legacy continuationStageId, edited, cannot redirect a paused decider branch (the upcaster drops it)', async () => {
    const calls: string[] = [];
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addDeciderFunction('Route', () => 'ask', 'route')
      .addPausableFunctionBranch('ask', 'Ask', {
        execute: () => ({ question: 'q' }),
        resume: () => {
          calls.push('ask-resume');
        },
      })
      .addFunctionBranch('other', 'Other', () => undefined)
      .end()
      .addFunction(
        'After',
        () => {
          calls.push('after');
        },
        'after',
      )
      .addFunction(
        'Payout',
        () => {
          calls.push('payout');
        },
        'payout',
      )
      .build();
    const first = new FlowChartExecutor(chart);
    await first.run();
    const { checkpointVersion: _v, ...unversioned } = JSON.parse(
      JSON.stringify(first.getCheckpoint()),
    ) as FlowchartCheckpoint;
    // A pre-9.39.0 checkpoint carried the field; tamper with it: jump straight to Payout, skipping After.
    const legacy = { ...unversioned, continuationStageId: 'payout' } as FlowchartCheckpoint;
    await new FlowChartExecutor(chart).resume(legacy, {});

    expect(calls).toEqual(['ask-resume', 'after', 'payout']);
  });

  it('a subflow id that shadows an Object.prototype member, its capture LOST: the inputMapper seeds it', async () => {
    // 'toString' is a legal subflow id. With the capture missing, the lookup
    // must not resolve `captures.toString` to Object.prototype.toString (and
    // skip the inputMapper for a function "capture").
    const inner = flowChart('Start', () => undefined, 'start')
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({ question: 'q' }),
          resume: (s: S) => {
            s.resumedWithPass = s.pass ?? 'none';
          },
        },
        'ask',
      )
      .build();
    const chart = flowChart(
      'Init',
      (s: S) => {
        s.iter = 7;
      },
      'init',
    )
      .addSubFlowChartNext('toString', inner, 'Inner', {
        inputMapper: (p: Record<string, unknown>) => ({ pass: p.iter }),
        outputMapper: (sf: Record<string, unknown>) => ({ resumedWithPass: sf.resumedWithPass }),
      })
      .build();
    const first = new FlowChartExecutor(chart);
    await first.run();
    const checkpoint = JSON.parse(JSON.stringify(first.getCheckpoint())) as FlowchartCheckpoint;
    expect(checkpoint.subflowPath).toEqual(['toString']);

    const resumer = new FlowChartExecutor(chart);
    await resumer.resume({ ...checkpoint, subflowStates: {} }, {});

    expect(resumer.getSnapshot().sharedState.resumedWithPass).toBe(7);
  });
});

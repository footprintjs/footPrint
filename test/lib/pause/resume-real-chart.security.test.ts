/**
 * SECURITY — a checkpoint is untrusted input; the one-shot re-entry narrows
 * what it can do (9.27.1).
 *
 * A checkpoint may come back from Redis, Postgres or a client. Before 9.27.1
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
 * cannot walk is refused with nothing executed and nothing wiped.
 *
 * Test type: security.
 */

import { describe, expect, it } from 'vitest';

import type { FlowChart, FlowchartCheckpoint } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
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

  it('a hostile path segment (`__proto__`) is refused, not resolved through the prototype chain', async () => {
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

/**
 * BOUNDARY — the edges of the one-shot resume re-entry (9.28.0).
 *
 *   - the smallest loop budget a resumed loop needs (the budget is per leg);
 *   - a loop back to a paused ROOT stage;
 *   - a pause THREE subflows deep (every outer subflow re-entered at its mount);
 *   - a checkpoint missing a subflow's capture (the inputMapper runs) — at the
 *     leaf (still entered at the paused stage) and at an OUTER level (entered
 *     at its root, so its earlier stages recompute what the capture held);
 *   - a resumed subflow's stages read their args (`$getArgs()`) as on a run;
 *   - a checkpoint from before the counters were carried;
 *   - one checkpoint resumed twice (each resume plans its own re-entry).
 *
 * Test type: boundary. Sibling of resume-real-chart.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { ArrayMergeMode } from '../../../src/advanced.js';
import type { FlowChart, FlowchartCheckpoint } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import {
  type ResumeMode,
  type S,
  askLoopTopLevelChart,
  drive,
  HEALTHY,
  loopPastMountChart,
  pauseInLoopBodySubflowChart,
} from './resume-real-chart-fixture.js';

const MODES: ResumeMode[] = ['same', 'cross'];

describe('the loop budget after a resume', () => {
  it.each(MODES)('%s-executor: maxIterations 1 is enough — each leg counts its own loop edges', async (mode) => {
    // The resumed leg takes ONE loop edge (back to the paused stage, which
    // pauses again) — within a budget of 1, because the budget is per leg.
    const chart = askLoopTopLevelChart();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const checkpoint =
      mode === 'cross' ? JSON.parse(JSON.stringify(executor.getCheckpoint())) : executor.getCheckpoint()!;
    const resumer = mode === 'cross' ? new FlowChartExecutor(chart) : executor;

    const result = await resumer.resume(checkpoint, { n: 1 }, { maxIterations: 1 });
    expect((result as { paused?: boolean }).paused).toBe(true);
    const last = await resumer.resume(resumer.getCheckpoint()!, { n: 2 }, { maxIterations: 1 });
    expect((last as { paused?: boolean } | undefined)?.paused).not.toBe(true);
    expect((resumer.getSnapshot().sharedState as S).trace).toEqual(HEALTHY.askLoopTopLevel.trace);
  });
});

describe('a loop back to a paused ROOT stage', () => {
  function pausableRootChart(): FlowChart {
    return flowChart(
      'Ask',
      {
        execute: (s: S) => {
          s.trace = [...((s.trace as string[] | undefined) ?? []), 'ask'];
          return { question: 'q' };
        },
        resume: (s: S) => {
          s.trace = [...s.trace, 'answer'];
          s.rounds = ((s.rounds as number | undefined) ?? 0) + 1;
        },
      },
      'ask',
    )
      .addDeciderFunction('Bind', (s: S) => ((s.rounds as number) < 3 ? 'again' : 'done'), 'bind')
      .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'ask' })
      .addFunctionBranch('done', 'Done', () => undefined)
      .end()
      .build();
  }

  it.each(MODES)('%s-executor: the root stage pauses on every visit', async (mode) => {
    const run = await drive(pausableRootChart(), mode);

    expect(run.pauses).toBe(3);
    expect(run.trace).toEqual(['ask', 'answer', 'ask', 'answer', 'ask', 'answer']);
  });
});

describe('a pause THREE subflows deep', () => {
  /** Each level records its pre-mount stage's runs; a re-run shows as a count of 2. */
  function threeDeepChart(): FlowChart {
    const c = flowChart(
      'CPre',
      (s: S) => {
        s.cPre = ((s.cPre as number | undefined) ?? 0) + 1;
      },
      'c-pre',
    )
      .addPausableFunction(
        'CAsk',
        {
          execute: () => ({ question: 'q' }),
          resume: (s: S, input: unknown) => {
            s.answer = input;
          },
        },
        'c-ask',
      )
      .build();
    const b = flowChart(
      'BPre',
      (s: S) => {
        s.bPre = ((s.bPre as number | undefined) ?? 0) + 1;
      },
      'b-pre',
    )
      .addSubFlowChartNext('sf-c', c, 'C', {
        outputMapper: (sf: Record<string, unknown>) => ({ answer: sf.answer, cPre: sf.cPre }),
      })
      .addFunction(
        'BPost',
        (s: S) => {
          s.bPost = true;
        },
        'b-post',
      )
      .build();
    const a = flowChart(
      'APre',
      (s: S) => {
        s.aPre = ((s.aPre as number | undefined) ?? 0) + 1;
      },
      'a-pre',
    )
      .addSubFlowChartNext('sf-b', b, 'B', {
        outputMapper: (sf: Record<string, unknown>) => ({
          answer: sf.answer,
          cPre: sf.cPre,
          bPre: sf.bPre,
          bPost: sf.bPost,
        }),
      })
      .addFunction(
        'APost',
        (s: S) => {
          s.aPost = true;
        },
        'a-post',
      )
      .build();
    return flowChart('Init', () => undefined, 'init')
      .addSubFlowChartNext('sf-a', a, 'A', {
        outputMapper: (sf: Record<string, unknown>) => ({
          answer: sf.answer,
          cPre: sf.cPre,
          bPre: sf.bPre,
          bPost: sf.bPost,
          aPre: sf.aPre,
          aPost: sf.aPost,
        }),
      })
      .build();
  }

  it.each(MODES)(
    '%s-executor: every outer subflow re-enters AT its mount — no pre-mount stage runs twice',
    async (mode) => {
      const run = await drive(threeDeepChart(), mode);

      expect(run.checkpoints[0].subflowPath).toEqual(['sf-a', 'sf-a/sf-b', 'sf-a/sf-b/sf-c']);
      expect(run.state).toMatchObject({ answer: { n: 1 }, aPre: 1, bPre: 1, cPre: 1, bPost: true, aPost: true });
    },
  );
});

describe('a checkpoint with a subflow capture missing', () => {
  /** Records what the resume half could see: the mapper's `pass`, and the pre-pause stage's write. */
  function chart(): FlowChart {
    const inner = flowChart(
      'Start',
      (s: S) => {
        s.seen = 'start';
      },
      'sf-start',
    )
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({ question: 'q' }),
          resume: (s: S) => {
            s.resumedWithPass = s.pass;
            s.hadStart = (s.seen as string | undefined) ?? 'none';
          },
        },
        'sf-ask',
      )
      .build();
    return flowChart(
      'Init',
      (s: S) => {
        s.iter = 1;
      },
      'init',
    )
      .addSubFlowChartNext('sf', inner, 'Inner', {
        inputMapper: (p: Record<string, unknown>) => ({ pass: p.iter }),
        outputMapper: (sf: Record<string, unknown>) => ({ resumedWithPass: sf.resumedWithPass, hadStart: sf.hadStart }),
      })
      .build();
  }

  it.each(MODES)(
    '%s-executor: the re-entry runs the inputMapper instead, and still starts at the paused stage',
    async (mode) => {
      const executor = new FlowChartExecutor(chart());
      await executor.run();
      const checkpoint = JSON.parse(JSON.stringify(executor.getCheckpoint())) as FlowchartCheckpoint;
      expect(checkpoint.subflowStates.sf).toMatchObject({ pass: 1, seen: 'start' });
      (checkpoint as { subflowStates: Record<string, unknown> }).subflowStates = {}; // lost in storage

      const resumer = mode === 'cross' ? new FlowChartExecutor(chart()) : executor;
      await resumer.resume(checkpoint, { n: 1 });

      // `pass` came from the mapper; `seen` (written before the pause) is gone,
      // because the subflow re-entered AT the paused stage — 'Start' did not re-run.
      expect(resumer.getSnapshot().sharedState).toMatchObject({ resumedWithPass: 1, hadStart: 'none' });
    },
  );
});

describe('a checkpoint written before the execution counters were carried', () => {
  it('resumes, and the loop after it still reaches the real loop head', async () => {
    const chart = pauseInLoopBodySubflowChart();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const legacy = JSON.parse(JSON.stringify(executor.getCheckpoint())) as Record<string, unknown>;
    delete legacy.executionCount;
    delete legacy.visitCounts;

    const resumer = new FlowChartExecutor(chart);
    await resumer.resume(legacy as unknown as FlowchartCheckpoint, { n: 1 });
    expect((resumer.getSnapshot().sharedState as S).trace).toEqual(HEALTHY.pauseInLoopBodySubflow.trace);
  });
});

describe('one checkpoint resumed twice', () => {
  it('each resume plans its own re-entry — two independent, identical runs', async () => {
    const chart = loopPastMountChart();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const wire = JSON.stringify(executor.getCheckpoint());

    const one = new FlowChartExecutor(chart);
    await one.resume(JSON.parse(wire), { n: 1 });
    const two = new FlowChartExecutor(chart);
    await two.resume(JSON.parse(wire), { n: 1 });

    expect((one.getSnapshot().sharedState as S).trace).toEqual(HEALTHY.loopPastMount.trace);
    expect((two.getSnapshot().sharedState as S).trace).toEqual(HEALTHY.loopPastMount.trace);
  });
});

describe('a subflow mounted in the loop body, paused on its LAST stage', () => {
  it.each(MODES)('%s-executor: the resumed subflow ends at once and the parent loop carries on', async (mode) => {
    const inner = flowChart('Start', () => undefined, 'sf-start')
      .addPausableFunction(
        'Last',
        { execute: (s: S) => (s.pass === 2 ? { question: 'q' } : undefined), resume: () => undefined },
        'sf-last',
      )
      .build();
    const chart = flowChart(
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
          s.trace = [...s.trace, `head${s.iter}`];
        },
        'head',
      )
      .addSubFlowChartNext('sf-inputs', inner, 'Inputs', {
        inputMapper: (p: Record<string, unknown>) => ({ pass: p.iter }),
        arrayMerge: ArrayMergeMode.Replace,
      })
      .addDeciderFunction('Route', (s: S) => (s.iter < 4 ? 'again' : 'final'), 'route')
      .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'head' })
      .addFunctionBranch('final', 'Final', (s: S) => {
        s.trace = [...s.trace, 'final'];
      })
      .end()
      .build();

    const run = await drive(chart, mode);
    expect(run.pauses).toBe(1);
    expect(run.trace).toEqual(['head1', 'head2', 'head3', 'head4', 'final']);
  });
});

describe('a checkpoint with an OUTER subflow’s capture missing', () => {
  /** sf-a's APre computes `cfg`, which APost needs after the paused sf-b. */
  function chart(outerId: string): FlowChart {
    const inner = flowChart('BStart', () => undefined, 'b-start')
      .addPausableFunction(
        'BAsk',
        {
          execute: () => ({ question: 'q' }),
          resume: (s: S, input: unknown) => {
            s.answer = input;
          },
        },
        'b-ask',
      )
      .build();
    const middle = flowChart(
      'APre',
      (s: S) => {
        s.cfg = `cfg-from-${s.seedArg}`;
        s.aPreRuns = ((s.aPreRuns as number | undefined) ?? 0) + 1;
      },
      'a-pre',
    )
      .addSubFlowChartNext('sf-b', inner, 'B', {
        outputMapper: (sf: Record<string, unknown>) => ({ answer: sf.answer }),
      })
      .addFunction(
        'APost',
        (s: S) => {
          s.post = `a-post(${s.cfg})`;
        },
        'a-post',
      )
      .build();
    return flowChart(
      'Init',
      (s: S) => {
        s.arg = 'A1';
      },
      'init',
    )
      .addSubFlowChartNext(outerId, middle, 'A', {
        inputMapper: (p: Record<string, unknown>) => ({ seedArg: p.arg }),
        outputMapper: (sf: Record<string, unknown>) => ({ post: sf.post, answer: sf.answer, aPreRuns: sf.aPreRuns }),
      })
      .build();
  }

  it.each([
    ['same', 'sf-a'],
    ['cross', 'sf-a'],
    ['cross', 'constructor'],
  ] as const)(
    '%s-executor (outer id %s): it re-runs from its ROOT with its inputMapper — nothing it computed is lost',
    async (mode, outerId) => {
      const executor = new FlowChartExecutor(chart(outerId));
      await executor.run();
      const checkpoint = JSON.parse(JSON.stringify(executor.getCheckpoint())) as FlowchartCheckpoint;
      expect(checkpoint.subflowPath).toEqual([outerId, `${outerId}/sf-b`]);
      delete (checkpoint.subflowStates as Record<string, unknown>)[outerId]; // lost in storage

      const resumer = mode === 'cross' ? new FlowChartExecutor(chart(outerId)) : executor;
      await resumer.resume(checkpoint, { n: 1 });

      // Before the fix the outer subflow was entered AT the sf-b mount with
      // nothing seeded: APost read `cfg` undefined.
      expect(resumer.getSnapshot().sharedState).toMatchObject({ post: 'a-post(cfg-from-A1)', answer: { n: 1 } });
    },
  );
});

describe('a resumed subflow’s stages read their args as on a run', () => {
  it.each(MODES)('%s-executor: $getArgs() in the resume half is the inputMapper’s result, not {}', async (mode) => {
    const inner = flowChart(
      'Start',
      (s: S) => {
        s.argsAtStart = JSON.stringify(s.$getArgs());
      },
      'sf-start',
    )
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({ question: 'q' }),
          resume: (s: S) => {
            s.argsAtResume = JSON.stringify(s.$getArgs());
            s.seenAtResume = s.v; // the SEED (the capture) — not overwritten by the mapper
          },
        },
        'sf-ask',
      )
      .build();
    const chart = flowChart(
      'Init',
      (s: S) => {
        s.v = 7;
      },
      'init',
    )
      .addSubFlowChartNext('sf', inner, 'Inner', {
        inputMapper: (p: Record<string, unknown>) => ({ v: p.v }),
        outputMapper: (sf: Record<string, unknown>) => ({
          argsAtStart: sf.argsAtStart,
          argsAtResume: sf.argsAtResume,
          seenAtResume: sf.seenAtResume,
        }),
      })
      .build();

    const run = await drive(chart, mode);

    expect(run.state).toMatchObject({ argsAtStart: '{"v":7}', argsAtResume: '{"v":7}', seenAtResume: 7 });
  });

  it.each(MODES)('%s-executor: the capture seeds the state; the recomputed args never overwrite it', async (mode) => {
    // A mapper that answers differently on each call makes the two sources
    // visible: the STATE is the capture (the first entry's value), the ARGS
    // are the mapper's answer on the re-entry.
    let calls = 0;
    const inner = flowChart('Start', () => undefined, 'sf-start')
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({ question: 'q' }),
          resume: (s: S) => {
            s.stateAtResume = s.v;
            s.argAtResume = (s.$getArgs() as { v: unknown }).v;
          },
        },
        'sf-ask',
      )
      .build();
    const chart = flowChart('Init', () => undefined, 'init')
      .addSubFlowChartNext('sf', inner, 'Inner', {
        inputMapper: () => ({ v: `mapper call ${++calls}` }),
        outputMapper: (sf: Record<string, unknown>) => ({
          stateAtResume: sf.stateAtResume,
          argAtResume: sf.argAtResume,
        }),
      })
      .build();

    const run = await drive(chart, mode);

    expect(run.state).toMatchObject({ stateAtResume: 'mapper call 1', argAtResume: 'mapper call 2' });
  });

  it.each(MODES)(
    '%s-executor: a looping subflow re-entered by the resume sees the same args on every pass',
    async (mode) => {
      const make = (pause: boolean) => {
        const inner = flowChart(
          'InnerHead',
          (s: S) => {
            s.count = ((s.count as number | undefined) ?? 0) + 1;
            s.seen = [...((s.seen as string[] | undefined) ?? []), `${s.count}:${JSON.stringify(s.$getArgs())}`];
          },
          'inner-head',
        )
          .addPausableFunction(
            'InnerAsk',
            { execute: (s: S) => (pause && s.count === 1 ? { q: 1 } : undefined), resume: () => undefined },
            'inner-ask',
          )
          .addDeciderFunction('InnerRoute', (s: S) => ((s.count as number) < 3 ? 'again' : 'out'), 'inner-route')
          .addFunctionBranch('again', 'Again', () => undefined, 'inner-again', { loopTo: 'inner-head' })
          .addFunctionBranch('out', 'Out', () => undefined)
          .end()
          .build();
        return flowChart(
          'Init',
          (s: S) => {
            s.topic = 'x';
          },
          'init',
        )
          .addSubFlowChartNext('sf', inner, 'Loop', {
            inputMapper: (p: Record<string, unknown>) => ({ topic: p.topic }),
            outputMapper: (sf: Record<string, unknown>) => ({ seen: sf.seen }),
          })
          .build();
      };
      const direct = new FlowChartExecutor(make(false));
      await direct.run();

      const run = await drive(make(true), mode);

      expect(run.state.seen).toEqual(direct.getSnapshot().sharedState.seen);
      expect(run.state.seen).toEqual(['1:{"topic":"x"}', '2:{"topic":"x"}', '3:{"topic":"x"}']);
    },
  );
});

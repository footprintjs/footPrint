/**
 * A resume hands control back to the DISPATCHER's continuation at every
 * level (9.28.0) — and a dispatcher that paused itself still dispatches.
 *
 * On the original run, whatever dispatched a child — a decider, a selector, a
 * fork — ran its own continuation once that child's chain ended: the
 * decider's `next`, the fork's join. A resume enters AT the child (the paused
 * stage, or the mount of the next subflow on the pause path), so it must
 * carry that continuation, at the level it belongs to.
 *
 * Before the fix (the first 9.28.0 draft), a pause two subflows deep whose
 * inner mount was a decider branch, a selector branch or a fork child inside
 * the outer subflow re-entered the outer subflow AT that mount — which has no
 * `next` — so the outer dispatcher's continuation silently never ran:
 * `Sequence(Conditional(agent))` lost its Finalize, `Sequence(Parallel(agent,
 * other))` lost its Merge. 9.27.0 ran it (by re-running the outer subflow's
 * earlier stages). And at ONE level deep, 9.27.0 never ran it: a paused
 * subflow mounted as a decider branch ran the parent decider's `next` INSIDE
 * the subflow (its writes stayed there), and a paused fork-child subflow never
 * reached the join.
 *
 * Also pinned here:
 *   - `interrupt()` raised inside a decider, selector or fork-parent FUNCTION
 *     re-runs it on resume and it DISPATCHES (the stand-in is the stage's own
 *     node with its function swapped — before, only fn/next/tags/retry were
 *     copied, so the dispatch was skipped);
 *   - a subflow mounted as a decider branch with `{ loopTo }` LOOPS — on a
 *     normal run as well as after a resume (the mount's `next` is a loop stub;
 *     Phase 0 hopped into the bare stub: one stage ran and the run ended);
 *   - a decider-level `.loopTo()` continuation taken right after a resume is a
 *     LOOP (narrated `onLoop`, counted toward `maxIterations`), as on a run.
 *
 * Test type: functional. Both resume modes.
 */

import { describe, expect, it } from 'vitest';

import { ArrayMergeMode } from '../../../src/advanced.js';
import type { FlowChart, FlowRecorder } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';
import { type ResumeMode, type S, drive } from './resume-real-chart-fixture.js';

const MODES: ResumeMode[] = ['same', 'cross'];
const push = (list: unknown, item: string): string[] => [...((list as string[] | undefined) ?? []), item];

// ── Depth 1: a paused subflow mounted as a branch / a fork child ─────────────

function asks(): FlowChart {
  return flowChart(
    'A',
    (s: S) => {
      s.x = 1;
    },
    'in-a',
  )
    .addPausableFunction(
      'Ask',
      {
        execute: () => ({ question: 'q' }),
        resume: (s: S, input: unknown) => {
          s.answer = input;
        },
      },
      'in-ask',
    )
    .build();
}

const answerOut = { outputMapper: (sf: Record<string, unknown>) => ({ answer: sf.answer }) };
const done = (s: S) => {
  s.done = ((s.done as number | undefined) ?? 0) + 1;
};

describe.each(MODES)('one subflow deep — %s-executor', (mode) => {
  it('mounted as a DECIDER BRANCH: the decider’s `next` runs in the PARENT, after the outputMapper', async () => {
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addDeciderFunction('Route', () => 'x', 'route')
      .addSubFlowChartBranch('x', asks(), 'X', answerOut)
      .addFunctionBranch('y', 'Y', () => undefined)
      .end()
      .addFunction('Done', done, 'done')
      .build();

    const run = await drive(chart, mode);

    expect(run.checkpoints[0]).toMatchObject({ subflowPath: ['x'], invokerStageId: 'route' });
    expect(run.state.answer).toEqual({ n: 1 });
    expect(run.state.done).toBe(1); // 9.27.0: undefined — it ran inside the subflow
  });

  it('mounted as a SELECTOR BRANCH: the selector’s `next` runs in the parent', async () => {
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addSelectorFunction('Pick', () => ['x'], 'pick')
      .addSubFlowChartBranch('x', asks(), 'X', answerOut)
      .addFunctionBranch('y', 'Y', () => undefined)
      .end()
      .addFunction('Done', done, 'done')
      .build();

    const run = await drive(chart, mode);

    expect(run.state.answer).toEqual({ n: 1 });
    expect(run.state.done).toBe(1);
  });

  it('mounted as a FORK CHILD: the fork’s join runs — and the sibling that finished is not re-run', async () => {
    let quietRuns = 0;
    const quiet = flowChart(
      'Q',
      (s: S) => {
        quietRuns += 1;
        s.q = 'q-done';
      },
      'q',
    ).build();
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addSubFlowChart('fa', asks(), 'FA', answerOut)
      .addSubFlowChart('fq', quiet, 'FQ', { outputMapper: (sf: Record<string, unknown>) => ({ q: sf.q }) })
      .addFunction(
        'Join',
        (s: S) => {
          s.joined = { answer: s.answer, q: s.q };
        },
        'join',
      )
      .build();

    const run = await drive(chart, mode);

    expect(run.state.joined).toEqual({ answer: { n: 1 }, q: 'q-done' }); // 9.27.0: the join never ran
    expect(quietRuns).toBe(1);
  });

  it('a decider with NO `next`: nothing to attach — the run ends after the subflow, as it would have', async () => {
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addDeciderFunction('Route', () => 'x', 'route')
      .addSubFlowChartBranch('x', asks(), 'X', answerOut)
      .addFunctionBranch('y', 'Y', done)
      .end()
      .build();

    const run = await drive(chart, mode);

    expect(run.state.answer).toEqual({ n: 1 });
    expect(run.state.done).toBeUndefined();
  });
});

// ── Depth 2: the inner mount is dispatched inside the outer subflow ──────────

function leaf(): FlowChart {
  return flowChart(
    'BStart',
    (s: S) => {
      s.log = push(s.prior, 'b-start');
    },
    'b-start',
  )
    .addPausableFunction(
      'BAsk',
      {
        execute: (s: S) => {
          s.log = push(s.log, 'b-ask');
          return { question: 'q' };
        },
        resume: (s: S) => {
          s.log = push(s.log, 'b-answer');
        },
      },
      'b-ask',
    )
    .addFunction(
      'BPost',
      (s: S) => {
        s.log = push(s.log, 'b-post');
      },
      'b-post',
    )
    .build();
}

const bOpts = {
  inputMapper: (p: Record<string, unknown>) => ({ prior: p.log }),
  outputMapper: (sf: Record<string, unknown>) => ({ log: sf.log }),
  arrayMerge: ArrayMergeMode.Replace,
};

function aPre(s: S) {
  s.aPreRuns = ((s.aPreRuns as number | undefined) ?? 0) + 1;
  s.log = push(s.prior, 'a-pre');
}
function aPost(s: S) {
  s.log = push(s.log, 'a-post');
}

function top(middle: FlowChart): FlowChart {
  return flowChart(
    'Init',
    (s: S) => {
      s.trace = ['init'];
    },
    'init',
  )
    .addSubFlowChartNext('sf-a', middle, 'A', {
      inputMapper: (p: Record<string, unknown>) => ({ prior: p.trace }),
      outputMapper: (sf: Record<string, unknown>) => ({ trace: sf.log, aPreRuns: sf.aPreRuns }),
      arrayMerge: ArrayMergeMode.Replace,
    })
    .addFunction(
      'Final',
      (s: S) => {
        s.trace = push(s.trace, 'final');
      },
      'final',
    )
    .build();
}

const DEPTH_TWO: Record<string, () => FlowChart> = {
  'a decider branch (decider with its own next)': () =>
    top(
      flowChart('APre', aPre, 'a-pre')
        .addDeciderFunction('Route', () => 'sf-b', 'route')
        .addSubFlowChartBranch('sf-b', leaf(), 'B', bOpts)
        .addFunctionBranch('other', 'Other', () => undefined)
        .end()
        .addFunction('APost', aPost, 'a-post')
        .build(),
    ),
  'a selector branch (selector with its own next)': () =>
    top(
      flowChart('APre', aPre, 'a-pre')
        .addSelectorFunction('Pick', () => ['sf-b'], 'pick')
        .addSubFlowChartBranch('sf-b', leaf(), 'B', bOpts)
        .addFunctionBranch('other', 'Other', () => undefined)
        .end()
        .addFunction('APost', aPost, 'a-post')
        .build(),
    ),
  'a fork child (with a sibling and a join)': () =>
    top(
      flowChart('APre', aPre, 'a-pre')
        .addSubFlowChart('sf-b', leaf(), 'B', bOpts)
        .addListOfFunction([{ id: 'sib', name: 'Sib', fn: () => undefined }])
        .addFunction('APost', aPost, 'a-post')
        .build(),
    ),
  'a linear mount (control)': () =>
    top(
      flowChart('APre', aPre, 'a-pre')
        .addSubFlowChartNext('sf-b', leaf(), 'B', bOpts)
        .addFunction('APost', aPost, 'a-post')
        .build(),
    ),
};

describe.each(MODES)('two subflows deep — %s-executor', (mode) => {
  it.each(Object.keys(DEPTH_TWO))('the inner mount is %s: a-post runs, a-pre does not run again', async (name) => {
    const run = await drive(DEPTH_TWO[name](), mode);

    expect(run.pauses).toBe(1);
    expect(run.checkpoints[0].subflowPath).toEqual(['sf-a', 'sf-a/sf-b']);
    expect(run.trace).toEqual(['init', 'a-pre', 'b-start', 'b-ask', 'b-answer', 'b-post', 'a-post', 'final']);
    expect(run.state.aPreRuns).toBe(1);
  });

  it('THREE deep, the middle mount a decider branch: each level’s continuation runs at its own level', async () => {
    const middleLeaf = flowChart(
      'MPre',
      (s: S) => {
        s.log = push(s.prior, 'm-pre');
      },
      'm-pre',
    )
      .addSubFlowChartNext('sf-b', leaf(), 'B', bOpts)
      .addFunction(
        'MPost',
        (s: S) => {
          s.log = push(s.log, 'm-post');
        },
        'm-post',
      )
      .build();
    const chart = top(
      flowChart('APre', aPre, 'a-pre')
        .addDeciderFunction('Route', () => 'sf-m', 'route')
        .addSubFlowChartBranch('sf-m', middleLeaf, 'M', bOpts)
        .addFunctionBranch('other', 'Other', () => undefined)
        .end()
        .addFunction('APost', aPost, 'a-post')
        .build(),
    );

    const run = await drive(chart, mode);

    expect(run.checkpoints[0].subflowPath).toEqual(['sf-a', 'sf-a/sf-m', 'sf-a/sf-m/sf-b']);
    expect(run.trace).toEqual([
      'init',
      'a-pre',
      'm-pre',
      'b-start',
      'b-ask',
      'b-answer',
      'b-post',
      'm-post',
      'a-post',
      'final',
    ]);
    expect(run.state.aPreRuns).toBe(1);
  });
});

// ── The composition shapes a downstream agent package builds ─────────────────

/** An "agent" subflow that asks a person through interrupt() and returns its answer. */
function agent(tag: string): FlowChart {
  return flowChart(
    'Think',
    (s: S) => {
      s.steps = push(s.steps, `${tag}-think`);
    },
    'think',
  )
    .addFunction(
      'Tool',
      (s: S) => {
        s.steps = push(s.steps, `${tag}-tool`);
        const answer = interrupt<{ n: number }>(s, { approve: tag });
        s.answer = `${tag}-approved-${answer.n}`;
      },
      'tool',
    )
    .addFunction(
      'Reply',
      (s: S) => {
        s.steps = push(s.steps, `${tag}-reply`);
        return s.answer;
      },
      'reply',
    )
    .build();
}

const resultOf = (sf: unknown) => (typeof sf === 'string' ? sf : (sf as { answer?: unknown })?.answer);

function conditional(): FlowChart {
  return flowChart('Initialize', () => undefined, 'seed')
    .addDeciderFunction('Route', () => 'agent-a', 'route')
    .addSubFlowChartBranch('agent-a', agent('a'), 'AgentA', {
      outputMapper: (sf: unknown) => ({ result: resultOf(sf) }),
    })
    .addSubFlowChartBranch('agent-b', agent('b'), 'AgentB', {
      outputMapper: (sf: unknown) => ({ result: resultOf(sf) }),
    })
    .setDefault('agent-b')
    .end()
    .addFunction(
      'Finalize',
      (s: S) => {
        s.final = `conditional:${s.result}`;
        return s.final;
      },
      'finalize',
    )
    .build();
}

function parallel(): FlowChart {
  const quiet = flowChart(
    'Q',
    (s: S) => {
      s.answer = 'q-done';
    },
    'q',
  ).build();
  return flowChart('Seed', () => undefined, 'seed')
    .addSubFlowChart('agent-a', agent('a'), 'AgentA', {
      outputMapper: (sf: unknown) => ({ branchResults: { a: resultOf(sf) } }),
    })
    .addSubFlowChart('quiet', quiet, 'Quiet', {
      outputMapper: (sf: unknown) => ({ branchResults: { q: resultOf(sf) } }),
    })
    .addFunction(
      'Merge',
      (s: S) => {
        s.final = `parallel:${JSON.stringify(s.branchResults)}`;
        return s.final;
      },
      'merge',
    )
    .build();
}

function sequence(inner: FlowChart): FlowChart {
  return flowChart(
    'Start',
    (s: S) => {
      s.log = ['start'];
    },
    'start',
  )
    .addSubFlowChartNext('step-1', inner, 'Step1', {
      outputMapper: (sf: unknown) => ({ stepFinal: typeof sf === 'string' ? sf : (sf as { final?: unknown })?.final }),
    })
    .addFunction(
      'Done',
      (s: S) => {
        s.log = push(s.log, `done:${s.stepFinal}`);
      },
      'done',
    )
    .build();
}

describe.each(MODES)('agent composition shapes — %s-executor', (mode) => {
  it('Conditional(agent): Finalize runs', async () => {
    const run = await drive(conditional(), mode);
    expect(run.state.final).toBe('conditional:a-approved-1');
  });

  it('Sequence(Conditional(agent)): Finalize runs, then the sequence goes on', async () => {
    const run = await drive(sequence(conditional()), mode);
    expect(run.checkpoints[0].subflowPath).toEqual(['step-1', 'step-1/agent-a']);
    expect(run.state.log).toEqual(['start', 'done:conditional:a-approved-1']);
  });

  it('Parallel(agent, other): Merge runs with BOTH branches’ results', async () => {
    const run = await drive(parallel(), mode);
    expect(run.state.final).toBe('parallel:{"q":"q-done","a":"a-approved-1"}');
  });

  it('Sequence(Parallel(agent, other)): Merge runs with both results, then the sequence goes on', async () => {
    const run = await drive(sequence(parallel()), mode);
    expect(run.state.log).toEqual(['start', 'done:parallel:{"q":"q-done","a":"a-approved-1"}']);
  });
});

// ── interrupt() inside a dispatcher's own function ────────────────────────────

describe.each(MODES)('interrupt() raised by a DISPATCHER’s function — %s-executor', (mode) => {
  it('a decider re-runs with the answer and dispatches its branch, then its next', async () => {
    const chart = flowChart(
      'Seed',
      (s: S) => {
        s.trace = ['seed'];
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (s: S) => {
          const answer = interrupt<{ n: number }>(s, { q: 'which?' });
          s.trace = push(s.trace, `route-ans${answer.n}`);
          return answer.n === 1 ? 'left' : 'right';
        },
        'route',
      )
      .addFunctionBranch('left', 'Left', (s: S) => {
        s.trace = push(s.trace, 'left');
      })
      .addFunctionBranch('right', 'Right', (s: S) => {
        s.trace = push(s.trace, 'right');
      })
      .end()
      .addFunction(
        'After',
        (s: S) => {
          s.trace = push(s.trace, 'after');
        },
        'after',
      )
      .build();

    const run = await drive(chart, mode);

    expect(run.trace).toEqual(['seed', 'route-ans1', 'left', 'after']); // 9.27.0: no 'left'
  });

  it('the same decider inside a subflow', async () => {
    const inner = flowChart(
      'S',
      (s: S) => {
        s.log = ['s'];
      },
      's',
    )
      .addDeciderFunction(
        'Route',
        (s: S) => {
          const answer = interrupt<{ n: number }>(s, { q: 'which?' });
          s.log = push(s.log, `route-ans${answer.n}`);
          return 'left';
        },
        'route',
      )
      .addFunctionBranch('left', 'Left', (s: S) => {
        s.log = push(s.log, 'left');
      })
      .addFunctionBranch('right', 'Right', () => undefined)
      .end()
      .addFunction(
        'After',
        (s: S) => {
          s.log = push(s.log, 'after');
        },
        'after',
      )
      .build();
    const chart = flowChart(
      'Init',
      (s: S) => {
        s.trace = [];
      },
      'init',
    )
      .addSubFlowChartNext('sf', inner, 'SF', {
        outputMapper: (sf: Record<string, unknown>) => ({ trace: sf.log }),
        arrayMerge: ArrayMergeMode.Replace,
      })
      .build();

    const run = await drive(chart, mode);

    expect(run.trace).toEqual(['s', 'route-ans1', 'left', 'after']);
  });

  it('a selector re-runs with the answer and runs its selected branch, then its next', async () => {
    const chart = flowChart(
      'Seed',
      (s: S) => {
        s.trace = ['seed'];
      },
      'seed',
    )
      .addSelectorFunction(
        'Pick',
        (s: S) => {
          const answer = interrupt<{ n: number }>(s, { q: 'which?' });
          s.trace = push(s.trace, `pick-ans${answer.n}`);
          return ['a'];
        },
        'pick',
      )
      .addFunctionBranch('a', 'A', (s: S) => {
        s.aRan = true;
      })
      .addFunctionBranch('b', 'B', (s: S) => {
        s.bRan = true;
      })
      .end()
      .addFunction(
        'After',
        (s: S) => {
          s.trace = push(s.trace, 'after');
        },
        'after',
      )
      .build();

    const run = await drive(chart, mode);

    expect(run.trace).toEqual(['seed', 'pick-ans1', 'after']);
    // A selected branch writes in its own namespace — and it ran (9.27.0: it did not).
    expect(run.state.runs).toEqual({ a: { aRan: true } });
  });

  it('a fork parent re-runs with the answer and runs its children, then the join', async () => {
    const chart = flowChart(
      'Seed',
      (s: S) => {
        s.trace = push(s.trace, 'seed-top');
        const answer = interrupt<{ n: number }>(s, { q: 'go?' });
        s.trace = push(s.trace, `seed-ans${answer.n}`);
      },
      'seed',
    )
      .addListOfFunction([
        {
          id: 'c1',
          name: 'C1',
          fn: (s: S) => {
            s.c1 = true;
          },
        },
        {
          id: 'c2',
          name: 'C2',
          fn: (s: S) => {
            s.c2 = true;
          },
        },
      ])
      .addFunction(
        'Join',
        (s: S) => {
          s.trace = push(s.trace, 'join');
        },
        'join',
      )
      .build();

    const run = await drive(chart, mode);

    expect(run.trace).toEqual(['seed-top', 'seed-top', 'seed-ans1', 'join']);
    expect(run.state.runs).toEqual({ c1: { c1: true }, c2: { c2: true } }); // 9.27.0: no children ran
  });
});

// ── A subflow mounted as a decider branch with loopTo ────────────────────────

function branchSubflowLoop(pause: boolean): FlowChart {
  const tools = flowChart(
    'TStart',
    (s: S) => {
      s.log = push(s.prior, 't-start');
    },
    't-start',
  )
    .addPausableFunction(
      'TAsk',
      {
        execute: (s: S) => {
          s.log = push(s.log, 't-ask');
          return pause && s.pass === 1 ? { question: 'q' } : undefined;
        },
        resume: (s: S, input: unknown) => {
          s.log = push(s.log, `t-ans${(input as { n: number }).n}`);
        },
      },
      't-ask',
    )
    .build();
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
        s.trace = push(s.trace, `head${s.iter}`);
      },
      'head',
    )
    .addDeciderFunction('Route', (s: S) => (s.iter < 3 ? 'tools' : 'final'), 'route')
    .addSubFlowChartBranch('tools', tools, 'Tools', {
      inputMapper: (p: Record<string, unknown>) => ({ prior: p.trace, pass: p.iter }),
      outputMapper: (sf: Record<string, unknown>) => ({ trace: sf.log }),
      arrayMerge: ArrayMergeMode.Replace,
    })
    .loopTo('head')
    .addFunctionBranch('final', 'Final', (s: S) => {
      s.trace = push(s.trace, 'final');
    })
    .end()
    .build();
}

const LOOPED = ['head1', 't-start', 't-ask', 'head2', 't-start', 't-ask', 'head3', 'final'];

describe('a subflow mounted as a decider branch with loopTo LOOPS', () => {
  it('on a normal run — the loop is an edge (onLoop), bounded by maxIterations', async () => {
    const loops: string[] = [];
    const executor = new FlowChartExecutor(branchSubflowLoop(false));
    executor.attachFlowRecorder({ id: 'loops', onLoop: (e) => loops.push(e.target) } as FlowRecorder);
    await executor.run();

    expect(executor.getSnapshot().sharedState.trace).toEqual(LOOPED); // before: ['head1', 't-start', 't-ask', 'head2']
    expect(loops).toEqual(['Head', 'Head']);

    const bounded = new FlowChartExecutor(branchSubflowLoop(false));
    await expect(bounded.run({ maxIterations: 1 })).rejects.toThrow(
      /Maximum loop iterations \(1\) exceeded for node 'head'/,
    );
  });

  it.each(MODES)('%s-executor: after a resume inside the looping subflow', async (mode) => {
    const run = await drive(branchSubflowLoop(true), mode);

    expect(run.pauses).toBe(1);
    expect(run.trace).toEqual(['head1', 't-start', 't-ask', 't-ans1', 'head2', 't-start', 't-ask', 'head3', 'final']);
  });

  it.each(MODES)('%s-executor: the same, one subflow deeper', async (mode) => {
    const chart = flowChart(
      'Outer',
      (s: S) => {
        s.trace = [];
      },
      'outer',
    )
      .addSubFlowChartNext('agent', branchSubflowLoop(true), 'Agent', {
        outputMapper: (sf: Record<string, unknown>) => ({ trace: sf.trace }),
        arrayMerge: ArrayMergeMode.Replace,
      })
      .addFunction(
        'After',
        (s: S) => {
          s.trace = push(s.trace, 'after-agent');
        },
        'after',
      )
      .build();

    const run = await drive(chart, mode);

    expect(run.checkpoints[0].subflowPath).toEqual(['agent', 'agent/tools']);
    expect(run.trace).toEqual([
      'head1',
      't-start',
      't-ask',
      't-ans1',
      'head2',
      't-start',
      't-ask',
      'head3',
      'final',
      'after-agent',
    ]);
  });
});

// ── A decider-level loopTo continuation right after a resume ─────────────────

function deciderLevelLoop(): FlowChart {
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
        s.trace = push(s.trace, `head${s.iter}`);
      },
      'head',
    )
    .addDeciderFunction('Route', (s: S) => (s.iter < 3 ? 'ask' : 'stop'), 'route')
    .addPausableFunctionBranch(
      'ask',
      'Ask',
      {
        execute: (s: S) => (s.iter === 1 ? { question: 'q' } : undefined),
        resume: (s: S) => {
          s.trace = push(s.trace, 'answer');
        },
      },
      'ask',
    )
    .addFunctionBranch('stop', 'Stop', (s: S) => {
      s.trace = push(s.trace, 'stop');
      s.$break('done');
    })
    .end()
    .loopTo('head')
    .build();
}

describe.each(MODES)('a decider-level loopTo taken right after a resume — %s-executor', (mode) => {
  it('is a LOOP edge: narrated onLoop (not onNext), as on a run', async () => {
    const events: string[] = [];
    const recorder: FlowRecorder = {
      id: 'edges',
      onLoop: (e) => events.push(`loop:${e.target}`),
      onNext: (e) => events.push(`next:${e.from}->${e.to}`),
      onResume: () => events.push('RESUME'),
    };
    const run = await drive(deciderLevelLoop(), mode, {
      newExecutor: (c) => {
        const executor = new FlowChartExecutor(c);
        executor.attachFlowRecorder(recorder);
        return executor;
      },
    });

    expect(run.trace).toEqual(['head1', 'answer', 'head2', 'head3', 'stop']);
    const afterResume = events.slice(events.indexOf('RESUME') + 1);
    expect(afterResume[0]).toBe('loop:Head'); // before: 'next:Ask->Head'
    expect(afterResume).not.toContain('next:Ask->Head');
  });

  it('counts toward maxIterations like any loop edge', async () => {
    const chart = deciderLevelLoop();
    const first = new FlowChartExecutor(chart);
    await first.run();
    const checkpoint = mode === 'cross' ? JSON.parse(JSON.stringify(first.getCheckpoint())) : first.getCheckpoint()!;
    const executor = mode === 'cross' ? new FlowChartExecutor(chart) : first;

    // The resumed leg takes TWO loop edges back to head (after the answer,
    // after head2's pass) — a budget of 1 must stop it at the second.
    await expect(executor.resume(checkpoint, {}, { maxIterations: 1 })).rejects.toThrow(
      /Maximum loop iterations \(1\) exceeded for node 'head'/,
    );
  });
});

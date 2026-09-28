/**
 * The charts and the driver behind the "a resume resolves against the REAL
 * chart" tests (9.28.0).
 *
 * Every chart here pauses somewhere a `loopTo`, or a later entry into a
 * subflow, has to find its way back into the chart AFTER a resume. On 9.27.0
 * the resume's synthetic structure — a stand-in node carrying the paused
 * stage's id, a leaf subflow whose root was swapped for that stand-in, and the
 * checkpoint's per-subflow seeds — stayed in force for the whole resumed run,
 * so:
 *
 *   - a loop back to the PAUSED stage ran its resume half again, and the stage
 *     never paused again (`askLoopInSubflowChart`, `askLoopTopLevelChart`);
 *   - a loop whose target sat UPSTREAM of the resume point hit a bare loop
 *     stub, ran one stage and ended the run silently
 *     (`pauseInLoopBodySubflowChart`, `loopPastTopLevelPauseChart`,
 *     `loopInsideSubflowChart`, `loopPastMountChart`, `pauseEveryPassChart`);
 *   - a pause two subflows deep re-ran the outer subflow's stages before the
 *     inner mount (`twoDeepChart`).
 *
 * The first three charts are the ones a downstream package pins in its own
 * tripwire — the same charts, reformatted to this repo's lint rules.
 * `interruptInLoopingBranchChart` is the placement that already worked and
 * must keep working.
 *
 * Every observation is in shared state (`trace`, counters), so a chart run on
 * a fresh executor from a JSON checkpoint is observed exactly like one resumed
 * on the executor that paused.
 */

import { ArrayMergeMode } from '../../../src/advanced.js';
import type { FlowChart, FlowchartCheckpoint, RuntimeSnapshot } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';

export type S = Record<string, unknown> & { iter: number; trace: string[] };

/** Resume on the executor that paused, or on a fresh one from a JSON round trip. */
export type ResumeMode = 'same' | 'cross';

export interface DriveResult {
  /** `sharedState.trace` after the last leg. */
  trace: string[];
  /** How many pauses were answered. */
  pauses: number;
  /** Final shared state (the last executor's snapshot). */
  state: Record<string, unknown>;
  /** One snapshot per leg — the run, then every resume — taken when the leg ended. */
  legs: RuntimeSnapshot[];
  /** The checkpoint of every pause, in order (JSON round-tripped in `cross` mode). */
  checkpoints: FlowchartCheckpoint[];
  /** The executor that ran the last leg. */
  executor: FlowChartExecutor;
}

function isPaused(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { paused?: unknown }).paused === true;
}

/**
 * Run `chart`, answering every pause with `answer(pauseNumber, checkpoint)`
 * (default `{ n: pauseNumber }`, the downstream tripwire's answer), resuming
 * in `mode`. Stops after `maxPauses` answers so a chart that re-asks forever
 * cannot hang a test.
 */
export async function drive(
  chart: FlowChart,
  mode: ResumeMode,
  options: {
    answer?: (pauseNumber: number, checkpoint: FlowchartCheckpoint) => unknown;
    maxPauses?: number;
    newExecutor?: (chart: FlowChart) => FlowChartExecutor;
  } = {},
): Promise<DriveResult> {
  const { answer = (n: number) => ({ n }), maxPauses = 12, newExecutor = (c) => new FlowChartExecutor(c) } = options;
  let executor = newExecutor(chart);
  let result: unknown = await executor.run();
  const legs: RuntimeSnapshot[] = [executor.getSnapshot()];
  const checkpoints: FlowchartCheckpoint[] = [];
  let pauses = 0;
  while (isPaused(result) && pauses < maxPauses) {
    pauses += 1;
    const raw = executor.getCheckpoint()!;
    const checkpoint: FlowchartCheckpoint = mode === 'cross' ? JSON.parse(JSON.stringify(raw)) : raw;
    checkpoints.push(checkpoint);
    if (mode === 'cross') executor = newExecutor(chart);
    result = await executor.resume(checkpoint, answer(pauses, checkpoint));
    legs.push(executor.getSnapshot());
  }
  const state = executor.getSnapshot().sharedState as Record<string, unknown>;
  return { trace: (state.trace as string[]) ?? [], pauses, state, legs, checkpoints, executor };
}

// ── The three charts a downstream tripwire pins ─────────────────────────────

/**
 * FACT 1 — a decider inside a subflow loops back to the PAUSED stage. The
 * second visit must PAUSE again (a re-ask), not re-run the resume half.
 * Healthy: `['plan','ask','resume-half','ask','resume-half']`, 2 pauses.
 * 9.27.0: `['plan','ask','resume-half','resume-half']`, 1 pause.
 */
export function askLoopInSubflowChart(): FlowChart {
  const inner = flowChart(
    'Plan',
    (s: S) => {
      s.log = ['plan'];
    },
    'plan',
  )
    .addPausableFunction(
      'Ask',
      {
        execute: (s: S) => {
          s.log = [...(s.log as string[]), 'ask'];
          return { question: 'q' };
        },
        resume: (s: S) => {
          s.log = [...(s.log as string[]), 'resume-half'];
          s.rounds = ((s.rounds as number | undefined) ?? 0) + 1;
        },
      },
      'ask',
      'ask',
    )
    .addDeciderFunction('Bind', (s: S) => ((s.rounds as number) < 2 ? 'again' : 'done'), 'bind', 'bind')
    .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'ask' })
    .addFunctionBranch('done', 'Done', () => undefined)
    .end()
    .build();
  return flowChart(
    'Init',
    (s: S) => {
      s.trace = [];
    },
    'init',
  )
    .addSubFlowChartNext('sf', inner, 'Inner', {
      outputMapper: (sf: Record<string, unknown>) => ({ trace: sf.log }),
      arrayMerge: ArrayMergeMode.Replace,
    })
    .build();
}

/**
 * FACT 2 — a pause inside a subflow mounted in a loop body. After the resume
 * the loop must reach its head and pass the mount again as a FRESH entry.
 * Healthy: `['head1','tools1','head2','tools2','head3','final']`.
 * 9.27.0: `['head1','tools1','head2']` — the run ended silently.
 */
export function pauseInLoopBodySubflowChart(): FlowChart {
  const inner = flowChart('Start', () => undefined, 'sf-start')
    .addPausableFunction(
      'Ask',
      {
        execute: (s: S) => (s.pass === 1 ? { question: 'q' } : undefined),
        resume: () => undefined,
      },
      'sf-ask',
      'ask',
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
        s.trace = [...s.trace, `head${s.iter}`];
      },
      'head',
    )
    .addSubFlowChartNext('sf-inputs', inner, 'Inputs', {
      inputMapper: (p: Record<string, unknown>) => ({ pass: p.iter }),
      arrayMerge: ArrayMergeMode.Replace,
    })
    .addDeciderFunction('Route', (s: S) => (s.iter < 3 ? 'tool-calls' : 'final'), 'route')
    .addFunctionBranch(
      'tool-calls',
      'ToolCalls',
      (s: S) => {
        s.trace = [...s.trace, `tools${s.iter}`];
      },
      'tool-calls',
      { loopTo: 'head' },
    )
    .addFunctionBranch('final', 'Final', (s: S) => {
      s.trace = [...s.trace, 'final'];
    })
    .end()
    .build();
}

/**
 * FACT 3 (must stay true) — `interrupt()` raised by the loop's own pausable
 * branch re-runs that branch on resume, and the loop continues.
 * `['head1','tools1','head2','tools2','head3','final']`, 2 pauses.
 */
export function interruptInLoopingBranchChart(): FlowChart {
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
        s.trace = [...s.trace, `head${s.iter}`];
      },
      'head',
    )
    .addDeciderFunction('Route', (s: S) => (s.iter < 3 ? 'tool-calls' : 'final'), 'route')
    .addPausableFunctionBranch(
      'tool-calls',
      'ToolCalls',
      {
        execute: (s: S) => {
          if (s.iter === 1) {
            const rounds = (s.rounds as number | undefined) ?? 0;
            // The re-run a resume makes: the first interrupt() hands back the answer.
            if (rounds > 0) interrupt(s, { reason: 'the answer' });
            if (rounds < 2) {
              s.rounds = rounds + 1; // committed with the pause
              interrupt(s, { reason: `ask ${rounds + 1}` }); // (a re-ask) pauses again
            }
          }
          s.trace = [...s.trace, `tools${s.iter}`];
        },
        resume: (s: S) => {
          s.trace = [...s.trace, 'RESUME-HALF'];
        },
      },
      'tool-calls',
      { loopTo: 'head' },
    )
    .addFunctionBranch('final', 'Final', (s: S) => {
      s.trace = [...s.trace, 'final'];
    })
    .end()
    .build();
}

// ── The same failures without a subflow, and inside one ─────────────────────

/**
 * FACT 1 at the top level — no subflow involved: the loop to the paused id
 * resolved to the stand-in node. Healthy: `['plan','ask','resume-half','ask',
 * 'resume-half']`, 2 pauses.
 */
export function askLoopTopLevelChart(): FlowChart {
  return flowChart(
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
          s.trace = [...s.trace, 'resume-half'];
          s.rounds = ((s.rounds as number | undefined) ?? 0) + 1;
        },
      },
      'ask',
      'ask',
    )
    .addDeciderFunction('Bind', (s: S) => ((s.rounds as number) < 2 ? 'again' : 'done'), 'bind', 'bind')
    .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'ask' })
    .addFunctionBranch('done', 'Done', () => undefined)
    .end()
    .build();
}

/**
 * FACT 2 at the top level — a top-level pause in a loop body whose loop head
 * sits UPSTREAM of the paused stage. Healthy:
 * `['head1','answer','again1','head2','again2','head3','final']`.
 */
export function loopPastTopLevelPauseChart(): FlowChart {
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
        s.trace = [...s.trace, `head${s.iter}`];
      },
      'head',
    )
    .addPausableFunction(
      'Ask',
      {
        execute: (s: S) => (s.iter === 1 ? { question: 'q' } : undefined),
        resume: (s: S) => {
          s.trace = [...s.trace, 'answer'];
        },
      },
      'ask',
    )
    .addDeciderFunction('Route', (s: S) => (s.iter < 3 ? 'again' : 'final'), 'route')
    .addFunctionBranch(
      'again',
      'Again',
      (s: S) => {
        s.trace = [...s.trace, `again${s.iter}`];
      },
      'again',
      { loopTo: 'head' },
    )
    .addFunctionBranch('final', 'Final', (s: S) => {
      s.trace = [...s.trace, 'final'];
    })
    .end()
    .build();
}

/**
 * A pause inside a loop body INSIDE a subflow: the subflow owns the loop, the
 * loop head sits upstream of the paused stage, and the resumed subflow must
 * reach it. Healthy: `['in1','ask1','answer','in2','in3','out','final']`.
 */
export function loopInsideSubflowChart(): FlowChart {
  const inner = flowChart(
    'InnerHead',
    (s: S) => {
      s.count = ((s.count as number | undefined) ?? 0) + 1;
      s.log = [...((s.log as string[] | undefined) ?? (s.prior as string[])), `in${s.count}`];
    },
    'inner-head',
  )
    .addPausableFunction(
      'InnerAsk',
      {
        execute: (s: S) => {
          if (s.count !== 1) return undefined;
          s.log = [...(s.log as string[]), 'ask1'];
          return { question: 'q' };
        },
        resume: (s: S) => {
          s.log = [...(s.log as string[]), 'answer'];
        },
      },
      'inner-ask',
    )
    .addDeciderFunction('InnerRoute', (s: S) => ((s.count as number) < 3 ? 'again' : 'out'), 'inner-route')
    .addFunctionBranch('again', 'Again', () => undefined, 'inner-again', { loopTo: 'inner-head' })
    .addFunctionBranch('out', 'Out', (s: S) => {
      s.log = [...(s.log as string[]), 'out'];
    })
    .end()
    .build();
  return flowChart(
    'Init',
    (s: S) => {
      s.trace = [];
    },
    'init',
  )
    .addSubFlowChartNext('sf-loop', inner, 'Loop', {
      inputMapper: (p: Record<string, unknown>) => ({ prior: p.trace }),
      outputMapper: (sf: Record<string, unknown>) => ({ trace: sf.log }),
      arrayMerge: ArrayMergeMode.Replace,
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

/**
 * Fact 2 with the subflow OBSERVED from inside: after the resume the loop
 * passes the SAME mount again, and that entry must be fresh — the inputMapper
 * runs (`pass` 2, 3), the subflow starts at its real first stage, and neither
 * the checkpoint's seed nor the resume half comes back. Healthy:
 * `['head1','start1','ask1','answer1','tools1','head2','start2','ask2',
 * 'tools2','head3','start3','ask3','final']`.
 */
export function loopPastMountChart(): FlowChart {
  const inner = flowChart(
    'Start',
    (s: S) => {
      s.log = [...(s.prior as string[]), `start${s.pass}`];
    },
    'sf-start',
  )
    .addPausableFunction(
      'Ask',
      {
        execute: (s: S) => {
          s.log = [...(s.log as string[]), `ask${s.pass}`];
          return s.pass === 1 ? { question: 'q' } : undefined;
        },
        resume: (s: S, input: unknown) => {
          s.log = [...(s.log as string[]), `answer${(input as { n: number }).n}`];
        },
      },
      'sf-ask',
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
        s.trace = [...s.trace, `head${s.iter}`];
      },
      'head',
    )
    .addSubFlowChartNext('sf-inputs', inner, 'Inputs', {
      inputMapper: (p: Record<string, unknown>) => ({ pass: p.iter, prior: p.trace }),
      outputMapper: (sf: Record<string, unknown>) => ({ trace: sf.log }),
      arrayMerge: ArrayMergeMode.Replace,
    })
    .addDeciderFunction('Route', (s: S) => (s.iter < 3 ? 'tool-calls' : 'final'), 'route')
    .addFunctionBranch(
      'tool-calls',
      'ToolCalls',
      (s: S) => {
        s.trace = [...s.trace, `tools${s.iter}`];
      },
      'tool-calls',
      { loopTo: 'head' },
    )
    .addFunctionBranch('final', 'Final', (s: S) => {
      s.trace = [...s.trace, 'final'];
    })
    .end()
    .build();
}

/**
 * Two pauses in one run from the SAME mount: the subflow in the loop body
 * asks on every pass, so every resume must enter the right pass. Healthy:
 * `['head1','ask1','answer1','tools1','head2','ask2','answer2','tools2',
 * 'head3','ask3','answer3','final']`, 3 pauses.
 */
export function pauseEveryPassChart(): FlowChart {
  const inner = flowChart(
    'Start',
    (s: S) => {
      s.log = [...(s.prior as string[]), `ask${s.pass}`];
    },
    'sf-start',
  )
    .addPausableFunction(
      'Ask',
      {
        execute: () => ({ question: 'q' }),
        resume: (s: S, input: unknown) => {
          s.log = [...(s.log as string[]), `answer${(input as { n: number }).n}`];
        },
      },
      'sf-ask',
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
        s.trace = [...s.trace, `head${s.iter}`];
      },
      'head',
    )
    .addSubFlowChartNext('sf-inputs', inner, 'Inputs', {
      inputMapper: (p: Record<string, unknown>) => ({ pass: p.iter, prior: p.trace }),
      outputMapper: (sf: Record<string, unknown>) => ({ trace: sf.log }),
      arrayMerge: ArrayMergeMode.Replace,
    })
    .addDeciderFunction('Route', (s: S) => (s.iter < 3 ? 'tool-calls' : 'final'), 'route')
    .addFunctionBranch(
      'tool-calls',
      'ToolCalls',
      (s: S) => {
        s.trace = [...s.trace, `tools${s.iter}`];
      },
      'tool-calls',
      { loopTo: 'head' },
    )
    .addFunctionBranch('final', 'Final', (s: S) => {
      s.trace = [...s.trace, 'final'];
    })
    .end()
    .build();
}

/**
 * A pause TWO subflows deep. `aPreRuns` counts how often sf-a's stage BEFORE
 * the sf-b mount ran; the resume must continue inside sf-b and never re-run
 * it. Healthy: trace `['init','a-pre','b-start','b-ask','b-answer','b-post',
 * 'a-post','final']` with `aPreRuns === 1`. 9.27.0: `aPreRuns === 2`.
 */
export function twoDeepChart(): FlowChart {
  const inner = flowChart(
    'BStart',
    (s: S) => {
      s.log = [...(s.prior as string[]), 'b-start'];
    },
    'b-start',
  )
    .addPausableFunction(
      'BAsk',
      {
        execute: (s: S) => {
          s.log = [...(s.log as string[]), 'b-ask'];
          return { question: 'q' };
        },
        resume: (s: S) => {
          s.log = [...(s.log as string[]), 'b-answer'];
        },
      },
      'b-ask',
    )
    .addFunction(
      'BPost',
      (s: S) => {
        s.log = [...(s.log as string[]), 'b-post'];
      },
      'b-post',
    )
    .build();
  const middle = flowChart(
    'APre',
    (s: S) => {
      s.aPreRuns = ((s.aPreRuns as number | undefined) ?? 0) + 1;
      s.log = [...(s.prior as string[]), 'a-pre'];
    },
    'a-pre',
  )
    .addSubFlowChartNext('sf-b', inner, 'B', {
      inputMapper: (p: Record<string, unknown>) => ({ prior: p.log }),
      outputMapper: (sf: Record<string, unknown>) => ({ log: sf.log }),
      arrayMerge: ArrayMergeMode.Replace,
    })
    .addFunction(
      'APost',
      (s: S) => {
        s.log = [...(s.log as string[]), 'a-post'];
      },
      'a-post',
    )
    .build();
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
        s.trace = [...s.trace, 'final'];
      },
      'final',
    )
    .build();
}

/** Every chart above, by name — the reference-checkpoint test iterates this. */
export const RESUME_CHARTS = {
  askLoopInSubflow: askLoopInSubflowChart,
  pauseInLoopBodySubflow: pauseInLoopBodySubflowChart,
  interruptInLoopingBranch: interruptInLoopingBranchChart,
  askLoopTopLevel: askLoopTopLevelChart,
  loopPastTopLevelPause: loopPastTopLevelPauseChart,
  loopInsideSubflow: loopInsideSubflowChart,
  loopPastMount: loopPastMountChart,
  pauseEveryPass: pauseEveryPassChart,
  twoDeep: twoDeepChart,
} as const;

export type ResumeChartName = keyof typeof RESUME_CHARTS;

/** The healthy outcome of each chart, answered with `{ n: pauseNumber }`. */
export const HEALTHY: Record<ResumeChartName, { trace: string[]; pauses: number }> = {
  askLoopInSubflow: { trace: ['plan', 'ask', 'resume-half', 'ask', 'resume-half'], pauses: 2 },
  pauseInLoopBodySubflow: { trace: ['head1', 'tools1', 'head2', 'tools2', 'head3', 'final'], pauses: 1 },
  interruptInLoopingBranch: { trace: ['head1', 'tools1', 'head2', 'tools2', 'head3', 'final'], pauses: 2 },
  askLoopTopLevel: { trace: ['plan', 'ask', 'resume-half', 'ask', 'resume-half'], pauses: 2 },
  loopPastTopLevelPause: {
    trace: ['head1', 'answer', 'again1', 'head2', 'again2', 'head3', 'final'],
    pauses: 1,
  },
  loopInsideSubflow: { trace: ['in1', 'ask1', 'answer', 'in2', 'in3', 'out', 'final'], pauses: 1 },
  loopPastMount: {
    trace: [
      'head1',
      'start1',
      'ask1',
      'answer1',
      'tools1',
      'head2',
      'start2',
      'ask2',
      'tools2',
      'head3',
      'start3',
      'ask3',
      'final',
    ],
    pauses: 1,
  },
  pauseEveryPass: {
    trace: [
      'head1',
      'ask1',
      'answer1',
      'tools1',
      'head2',
      'ask2',
      'answer2',
      'tools2',
      'head3',
      'ask3',
      'answer3',
      'final',
    ],
    pauses: 3,
  },
  twoDeep: {
    trace: ['init', 'a-pre', 'b-start', 'b-ask', 'b-answer', 'b-post', 'a-post', 'final'],
    pauses: 1,
  },
};

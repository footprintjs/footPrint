import type { FlowChart, FlowchartCheckpoint } from '../../src/index.js';
import { decide, flowChart, FlowChartExecutor, interrupt } from '../../src/index.js';

export type State = Record<string, any>;
export type Mode = 'direct' | 'pause';
export type PauseKind = 'handler' | 'interrupt';
export const answer = (round: number) => `answer-${round}`;

export function report(id: string, status: string, evidence: unknown): void {
  console.log('CHART_LAW_BASELINE ' + JSON.stringify({ id, status, evidence }));
}

/** Every call creates a chart and all input/closure state for one arm. */
export function scenario(mode: Mode, kind: PauseKind, rounds: number, nested = false): FlowChart {
  let body = flowChart<State>(
    'Seed',
    (s) => {
      s.count = 0;
      s.answers = [];
    },
    'seed',
  );
  if (rounds > 0) {
    body = body
      .addFunction(
        'Head',
        (s) => {
          s.count += 1;
        },
        'head',
      )
      .addPausableFunction(
        'Ask',
        {
          execute: (s: State) => {
            if (kind === 'interrupt') {
              const value = mode === 'pause' ? interrupt<string>(s, { round: s.count }) : answer(s.count);
              s.answers = [...s.answers, value];
              return undefined;
            }
            if (mode === 'pause') return { round: s.count };
            s.answers = [...s.answers, answer(s.count)];
            return undefined;
          },
          resume: (s: State, value: unknown) => {
            s.answers = [...s.answers, value];
          },
        },
        'ask',
      )
      .addDeciderFunction('Route', (s) => (s.count < rounds ? 'again' : 'done'), 'route')
      .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'head' })
      .addFunctionBranch('done', 'Done', () => undefined, 'done')
      .end();
  }
  const chart = body.build();
  if (!nested) return chart;
  return flowChart<State>('Outer', () => undefined, 'outer')
    .addSubFlowChartNext('nested', chart, 'Nested', {
      outputMapper: (s: State) => ({ count: s.count, answers: s.answers }),
    })
    .build();
}

export function business(state: Record<string, unknown>) {
  return { count: state.count, answers: state.answers };
}

export function dataChart(hidden = 'fixture-a'): FlowChart {
  return flowChart<State>(
    'Seed',
    (s) => {
      s.present = 1;
      s.deleted = 'temporary';
      s.secret = hidden;
      s.nested = { value: 4 };
    },
    'seed',
  )
    .addFunction(
      'Update',
      (s) => {
        s.present = 2;
        delete s.deleted;
        s.done = true;
      },
      'update',
    )
    .build();
}

export function askChart(): FlowChart {
  return flowChart<State>('Start', () => undefined, 'start')
    .addPausableFunction(
      'Ask',
      {
        execute: () => ({ question: 'q' }),
        resume: (s: State, value: unknown) => {
          s.answer = value;
        },
      },
      'ask',
    )
    .build();
}

export function jsonCheckpoint(executor: FlowChartExecutor): FlowchartCheckpoint {
  const value = executor.getCheckpoint();
  if (!value) throw new Error('The fixture did not reach its declared pause');
  return JSON.parse(JSON.stringify(value));
}

export function describeError(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message } : { value: String(error) };
}

export function choiceScenario(mode: Mode, score: number, picks: string[], mount: boolean): FlowChart {
  const builder = flowChart<State>(
    'Seed',
    (s) => {
      s.score = score;
    },
    'seed',
  )
    .addDeciderFunction(
      'Decide',
      (s) =>
        decide(s, [{ when: { score: { gt: 0 } }, then: 'high', label: 'positive' }], {
          branch: 'low',
          label: 'default',
        }),
      'decide',
    )
    .addFunctionBranch('high', 'High', (s: State) => {
      s.route = 'high';
    })
    .addFunctionBranch('low', 'Low', (s: State) => {
      s.route = 'low';
    })
    .end()
    .addSelectorFunction('Select', () => [...picks], 'select')
    .addFunctionBranch('a', 'A', (s: State) => {
      s.picked = true;
    })
    .addFunctionBranch('b', 'B', (s: State) => {
      s.picked = true;
    })
    .end();
  return builder
    .addDeciderFunction('Mount gate', () => (mount ? 'mount' : 'skip'), 'mount-gate')
    .addSubFlowChartBranch(
      'mount',
      flowChart<State>(
        'Mounted',
        (s) => {
          s.mounted = true;
        },
        'mounted',
      ).build(),
      'Mount',
      {
        outputMapper: (s: State) => ({ mounted: s.mounted }),
      },
    )
    .addFunctionBranch('skip', 'Skip', () => undefined)
    .end()
    .addPausableFunction(
      'Approve',
      {
        execute: (s: State) => {
          if (mode === 'pause') return { approval: true };
          s.approved = true;
          return undefined;
        },
        resume: (s: State) => {
          s.approved = true;
        },
      },
      'approve',
    )
    .build();
}

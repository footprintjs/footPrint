/**
 * The untagged fixture behind `declared-tags-byte-identity.test.ts`.
 *
 * One chart that walks every commit path a declared tag (9.21.0) could touch
 * — a linear seed, an EMPTY commit (a read-only stage), a stage under a
 * declarative `retry` policy that fails twice, a fork with two children and
 * their convergence, a decider with two branches, a subflow seeded by an
 * `inputMapper` and merged back by an `outputMapper`, and a pausable gate so
 * the run PAUSES (checkpoint) and is RESUMED on a fresh executor — declared
 * with NO tags anywhere, then projected to the bytes a consumer keeps for
 * each leg: snapshot state, fold base, commit log, execution tree, subflow
 * results, the checkpoint, and every narrative entry. Non-deterministic
 * fields are dropped by `stableJSON` so two runs of the same code agree byte
 * for byte.
 *
 * A chart that declares no tag must produce exactly these bytes forever —
 * the "absent when empty" law `CommitBundle.untrackedSources?` already keeps.
 */

import type { CommitValuesMode, PausableHandler, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { stableJSON } from './redaction-no-policy-fixture.js';

interface InnerState {
  n: number;
  trail: string[];
  count: number;
  summary: string;
}

interface OuterState {
  n: number;
  trail: string[];
  attempts: number;
  a: number;
  b: number;
  route: string;
  summary: string;
  approved: boolean;
  done: boolean;
}

/** The pausable gate: asks on the first run, records the answer on resume. */
const gate: PausableHandler<any> = {
  execute: async () => ({ question: 'Approve?' }),
  resume: async (scope: TypedScope<OuterState>, input: unknown) => {
    scope.approved = (input as { approved?: boolean } | undefined)?.approved ?? false;
  },
};

/**
 * Build the fixture chart. `flakyCalls` is per BUILD so every run of the
 * fixture sees the same two failures before the third attempt succeeds.
 */
export function buildUntaggedFixtureChart() {
  let flakyCalls = 0;

  const inner = flowChart<InnerState>(
    'Inner seed',
    (scope: TypedScope<InnerState>) => {
      // `n` / `trail` are readonly inputs inside the subflow — write fresh keys.
      scope.count = scope.trail.length + 1;
    },
    'inner-seed',
  )
    .addFunction(
      'Inner summary',
      (scope: TypedScope<InnerState>) => {
        scope.summary = `${scope.n}:${scope.count}`;
      },
      'inner-summary',
    )
    .build();

  return flowChart<OuterState>(
    'Seed',
    (scope: TypedScope<OuterState>) => {
      scope.n = 1;
      scope.trail = ['seed'];
    },
    'seed',
  )
    .addFunction(
      'Idle',
      (scope: TypedScope<OuterState>) => {
        // A read-only stage: its commit is EMPTY by construction.
        if (scope.n === undefined) throw new Error('seed did not run');
      },
      'idle',
    )
    .addFunction(
      'Flaky',
      (scope: TypedScope<OuterState>) => {
        flakyCalls += 1;
        scope.attempts = flakyCalls;
        if (flakyCalls < 3) throw new Error(`flaky attempt ${flakyCalls}`);
      },
      'flaky',
    )
    .retry({ attempts: 3, backoffMs: 0 })
    .addFunction(
      'Fork',
      (scope: TypedScope<OuterState>) => {
        scope.trail = [...scope.trail, 'fork'];
      },
      'fork',
    )
    .addListOfFunction([
      {
        id: 'child-a',
        name: 'Child A',
        fn: (scope: TypedScope<OuterState>) => {
          scope.a = scope.n + 10;
        },
      },
      {
        id: 'child-b',
        name: 'Child B',
        fn: (scope: TypedScope<OuterState>) => {
          scope.b = scope.n + 20;
        },
      },
    ])
    .addFunction(
      'Merge',
      (scope: TypedScope<OuterState>) => {
        scope.n = scope.a + scope.b;
      },
      'merge',
    )
    .addDeciderFunction('Route', (scope: TypedScope<OuterState>) => (scope.n > 30 ? 'high' : 'low'), 'route')
    .addFunctionBranch('high', 'High', (scope: TypedScope<OuterState>) => {
      scope.route = 'high';
    })
    .addFunctionBranch('low', 'Low', (scope: TypedScope<OuterState>) => {
      scope.route = 'low';
    })
    .end()
    .addSubFlowChartNext('sf', inner, 'Sub', {
      inputMapper: (parent: OuterState) => ({ n: parent.n, trail: parent.trail }),
      outputMapper: (out: InnerState) => ({ summary: out.summary, trail: ['sub'] }),
    })
    .addPausableFunction('Gate', gate, 'gate')
    .addFunction(
      'Finish',
      (scope: TypedScope<OuterState>) => {
        scope.done = scope.approved && scope.summary.length > 0;
      },
      'finish',
    )
    .build();
}

/** The bytes a consumer keeps from one leg of the run. */
function project(executor: FlowChartExecutor<any, any>) {
  const snapshot = executor.getSnapshot();
  return {
    sharedState: snapshot.sharedState,
    initialState: snapshot.initialState,
    commitLog: snapshot.commitLog,
    commitValues: snapshot.commitValues,
    executionTree: snapshot.executionTree,
    subflowResults: snapshot.subflowResults,
    narrative: executor.getNarrativeEntries(),
  };
}

/**
 * Run the fixture under one commit-log encoding — pause at the gate, resume
 * on a fresh executor — and return the stable bytes of both legs and the
 * checkpoint between them.
 */
export async function runUntaggedFixture(commitValues: CommitValuesMode): Promise<string> {
  const chart = buildUntaggedFixtureChart();

  const first = new FlowChartExecutor(chart, { commitValues });
  first.enableNarrative();
  await first.run();
  // `pausedAt` is a wall-clock stamp — the one checkpoint field two runs
  // cannot agree on. Everything else in the checkpoint is kept.
  const { pausedAt: _pausedAt, ...checkpoint } = first.getCheckpoint()!;

  const second = new FlowChartExecutor(chart, { commitValues });
  second.enableNarrative();
  await second.resume(first.getCheckpoint()!, { approved: true });

  return stableJSON({ paused: project(first), checkpoint, resumed: project(second) });
}

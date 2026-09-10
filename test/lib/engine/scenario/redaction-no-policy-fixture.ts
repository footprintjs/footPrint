/**
 * The no-policy fixture behind `redaction-no-policy-byte-identity.test.ts`.
 *
 * One chart that walks every path the 9.19.0 redaction law touches — facade
 * writes of scalars / objects / arrays, tracked reads, `$updateValue` merges,
 * `$deleteValue`, a subflow seeded by an `inputMapper` and merged back by an
 * `outputMapper` (scalar, array append, nested object), narrative on — run
 * with NO redaction policy, then projected to the bytes a consumer keeps:
 * the snapshot (state, commit log, execution tree, subflow results) and the
 * narrative entries. Non-deterministic fields (timestamps, run ids) are
 * dropped so two runs of the same code agree byte for byte.
 */

import type { CommitValuesMode, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

interface InnerState {
  profile: { name: string; auth: { token: string } };
  tags: string[];
  count: number;
  summary: string;
}

interface OuterState {
  profile: { name: string; auth: { token: string }; seen?: boolean };
  tags: string[];
  count: number;
  note: string;
  temp: string;
  summary: string;
  finished: boolean;
}

function buildFixtureChart() {
  const inner = flowChart<InnerState>(
    'Inner',
    (scope: TypedScope<InnerState>) => {
      scope.summary = `${scope.profile.name}:${scope.tags.length}:${scope.count}`;
    },
    'inner',
  ).build();

  return flowChart<OuterState>(
    'Seed',
    (scope: TypedScope<OuterState>) => {
      scope.profile = { name: 'Ada', auth: { token: 'tok-1' } };
      scope.tags = ['a', 'b'];
      scope.count = 2;
      scope.note = 'n';
      scope.temp = 't';
    },
    'seed',
  )
    .addFunction(
      'Touch',
      (scope: TypedScope<OuterState>) => {
        scope.$update('profile', { name: 'Ada L.' });
        scope.$delete('temp');
        scope.count = scope.count + scope.tags.length;
      },
      'touch',
    )
    .addSubFlowChartNext('sf', inner, 'Sub', {
      inputMapper: (parent: OuterState) => ({ profile: parent.profile, tags: parent.tags, count: parent.count }),
      outputMapper: (out: InnerState) => ({ summary: out.summary, tags: ['z'], profile: { seen: true } }),
    })
    .addFunction(
      'Finish',
      (scope: TypedScope<OuterState>) => {
        scope.finished = scope.summary.length > 0 && scope.profile.seen === true;
      },
      'finish',
    )
    .build();
}

const VOLATILE_KEYS = new Set(['timestamp', 'runId', 'pipelineId', 'durationMs', 'duration', 'startTime', 'endTime']);

/** JSON with every volatile field dropped — the bytes a consumer would diff. */
export function stableJSON(value: unknown): string {
  return JSON.stringify(value, (key, v) => (VOLATILE_KEYS.has(key) ? undefined : v), 2);
}

/** Run the fixture under one commit-log encoding and return its stable bytes. */
export async function runNoPolicyFixture(commitValues: CommitValuesMode): Promise<string> {
  const executor = new FlowChartExecutor(buildFixtureChart(), { commitValues });
  executor.enableNarrative();
  await executor.run();
  const snapshot = executor.getSnapshot();
  return stableJSON({
    sharedState: snapshot.sharedState,
    commitLog: snapshot.commitLog,
    commitValues: snapshot.commitValues,
    executionTree: snapshot.executionTree,
    subflowResults: snapshot.subflowResults,
    narrative: executor.getNarrativeEntries(),
    report: executor.getRedactionReport(),
  });
}

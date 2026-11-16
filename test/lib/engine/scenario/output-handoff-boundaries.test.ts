/** Native merge-back boundaries: observe only what ran, within the retained budget. */
import { stateAt } from 'foottrace';
import { pathSegments } from 'foottrace/paths';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src';

type State = Record<string, unknown>;
type Mapper = (output: State) => State;

function required<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Missing native ${description}`);
  return value;
}

async function mapped(mapper: Mapper) {
  const child = flowChart<State>(
    'Child',
    (scope) => {
      scope.localSource = 7;
      scope.localOutput = 14;
    },
    'child',
  ).build();
  const chart = flowChart<State>('Start', () => {}, 'start')
    .addSubFlowChartNext('mount', child, 'Mount', { outputMapper: mapper })
    .build();
  const executor = new FlowChartExecutor(chart, { captureOutputHandoff: true });
  await executor.run();
  const snapshot = executor.getSnapshot();
  const commit = required(
    snapshot.commitLog.find((bundle) => bundle.stageId === 'mount' && bundle.trace.length > 0),
    'merge-back commit',
  );
  const childResult = required(snapshot.subflowResults?.[commit.runtimeStageId], 'child result');
  return { snapshot, commit, childResult, handoff: required(childResult.outputHandoff, 'output handoff') };
}

describe('output handoff native boundaries', () => {
  it('a deleted output key is not attributed to the original child value', async () => {
    const { snapshot, childResult, handoff } = await mapped((output) => {
      delete output.localOutput;
      return { renamed: output.localOutput ?? output.localSource };
    });
    expect(snapshot.sharedState.renamed).toBe(7);
    expect(childResult.treeContext.globalContext.localOutput).toBe(14);
    expect(handoff.status).toBe('partial');
    expect(handoff.limitations).toEqual(['output-mutated']);
    expect(handoff.writes).toEqual([{ path: 'renamed', reads: ['localSource'] }]);
  });

  it('a whole child view nested in a mapped value is materialized before observation closes', async () => {
    const { snapshot, childResult, handoff } = await mapped((output) => ({ bundle: [output] }));
    expect(snapshot.sharedState.bundle).toEqual([{ localSource: 7, localOutput: 14 }]);
    expect(childResult.treeContext.globalContext).toEqual({ localSource: 7, localOutput: 14 });
    expect(handoff.status).toBe('captured');
    expect(handoff.limitations).toEqual([]);
    expect(handoff.writes.map((write) => ({ path: pathSegments(write.path), reads: write.reads }))).toEqual([
      { path: ['bundle'], reads: ['localSource', 'localOutput'] },
    ]);
    expect(() => structuredClone(snapshot.sharedState.bundle)).not.toThrow();
    expect(Object.isFrozen(handoff.writes[0].reads)).toBe(true);
  });

  it('the mapped-write ceiling truncates provenance rather than changing successful business writes', async () => {
    const { snapshot, commit, handoff } = await mapped((output) => {
      const value = output.localOutput;
      return Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`result${index}`, value]));
    });
    expect(Object.keys(snapshot.sharedState)).toHaveLength(257);
    expect(snapshot.sharedState.result256).toBe(14);
    expect(stateAt(snapshot, commit.idx).state.result256).toBe(14);
    expect(commit.trace).toHaveLength(257);
    expect(handoff.status).toBe('partial');
    expect(handoff.limitations).toEqual(['budget-exhausted']);
    expect(handoff.writes).toHaveLength(256);
    expect(handoff.writes[0]).toEqual({ path: 'result0', reads: ['localOutput'] });
    expect(handoff.writes.at(-1)).toEqual({ path: 'result255', reads: ['localOutput'] });
    expect(handoff.writes.some((write) => write.path === 'result256')).toBe(false);
  });
});

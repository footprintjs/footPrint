/**
 * Declared tags on a subflow MOUNT (9.21.1) — the RUN-TIME half.
 *
 * The engine side shipped in 9.21.0 (`executeNodeStep` stamps `node.tags`
 * on every node it runs, mounts included; `StageContext.commit` records it
 * once and releases it). What was missing was the builder: no mount method
 * landed `options.tags` on the node, so a mount could never be tagged. These
 * tests read the parent log of each mount shape and pin the four facts a
 * consumer's slot mounts need: the mount's FIRST bundle carries the tags,
 * its exit bundle carries none, the subflow's own log is untouched, and
 * `tagStops` keeps the mount stop with `meta` = the array.
 *
 * Test types: Functional (fork-child mount, linear mount, selector-branch
 * mount, decider-branch mount, lazy mount) · Scenario (a tagged mount beside
 * tagged inner stages — two logs, two vocabularies) · Integration (`tagStops`
 * over the parent axis; `drill` into the mount's own log).
 */
import { describe, expect, it } from 'vitest';

import type { CommitBundle } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { tagStops, timeTravel } from '../../../src/trace.js';

interface State {
  n?: number;
  count?: number;
  summary?: string;
  done?: boolean;
  [key: string]: unknown;
}

/** Bundles of one stage, in log order. */
const bundlesOf = (log: readonly CommitBundle[], stageId: string) => log.filter((b) => b.stageId === stageId);

/** inner-seed[inner:seed] → inner-work — writes `summary` from the seeded `n`. */
function buildInner() {
  return flowChart<State>(
    'Inner seed',
    (s) => {
      s.count = (s.n ?? 0) + 1;
    },
    'inner-seed',
  )
    .tag('inner:seed')
    .addFunction(
      'Inner work',
      (s) => {
        s.summary = `c${s.count}`;
      },
      'inner-work',
    )
    .build();
}

const mountOptions = {
  tags: ['probe', 'slot:context'],
  inputMapper: (parent: State) => ({ n: parent.n }),
  outputMapper: (out: State) => ({ summary: out.summary }),
};

const seedFn = (s: State) => {
  s.n = 1;
};
const finishFn = (s: State) => {
  s.done = s.summary === 'c2';
};

/**
 * The four facts, checked against one parent log for the mount `sf`:
 * first bundle tagged, later bundles not, no other stage tagged, inner log
 * carries only the inner vocabulary.
 */
function expectMountTagged(executor: FlowChartExecutor<any, any>, mountId = 'sf') {
  const snapshot = executor.getSnapshot();
  const mount = bundlesOf(snapshot.commitLog, mountId);
  expect(mount.length).toBeGreaterThanOrEqual(1);
  expect(mount[0].tags).toEqual(['probe', 'slot:context']);
  for (const later of mount.slice(1)) expect(later).not.toHaveProperty('tags');
  expect(snapshot.commitLog.filter((b) => b.tags).map((b) => b.stageId)).toEqual([mountId]);

  const sub = snapshot.subflowResults[mountId] as { treeContext: { history: CommitBundle[] } };
  const innerTagged = sub.treeContext.history.filter((b) => b.tags).map((b) => [b.stageId, b.tags] as const);
  expect(innerTagged).toEqual([[`${mountId}/inner-seed`, ['inner:seed']]]);

  // The reader: `tagStops(['probe'])` keeps exactly the mount stop, as a mount.
  const cursor = timeTravel(snapshot, { strategy: tagStops(['probe']) });
  expect(cursor.stops.map((s) => s.kind)).toEqual(['start', 'mount', 'end']);
  expect(cursor.stops[1].runtimeStageId).toBe(mount[0].runtimeStageId);
  expect(cursor.stops[1].meta).toEqual(['probe', 'slot:context']);
  // `drill` carries the strategy into the subflow's OWN log, where no stage
  // says 'probe' — the mount's tag did not leak in — so the filtered child
  // keeps only its bookends; an unfiltered drill reads the inner vocabulary.
  const filteredChild = cursor.drill(mount[0].runtimeStageId)!;
  expect(filteredChild.stops.map((s) => s.kind)).toEqual(['start', 'end']);
  const child = timeTravel(snapshot, { strategy: tagStops() }).drill(mount[0].runtimeStageId)!;
  expect(child.stops.filter((s) => s.meta).map((s) => s.meta)).toEqual([['inner:seed']]);
  return snapshot;
}

describe('a mount is a taggable stage — options.tags lands on its first bundle', () => {
  it('addSubFlowChart (fork-child mount)', async () => {
    const chart = flowChart<State>('Seed', seedFn, 'seed')
      .addSubFlowChart('sf', buildInner(), 'Sub', mountOptions)
      .addFunction('Finish', finishFn, 'finish')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = expectMountTagged(executor);
    expect(snapshot.sharedState.done).toBe(true);
  });

  it('addSubFlowChartNext (linear mount) — two bundles: the output-mapping commit is tagged, the exit is not', async () => {
    const chart = flowChart<State>('Seed', seedFn, 'seed')
      .addSubFlowChartNext('sf', buildInner(), 'Sub', mountOptions)
      .addFunction('Finish', finishFn, 'finish')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = expectMountTagged(executor);
    const mount = bundlesOf(snapshot.commitLog, 'sf');
    expect(mount.length).toBe(2);
    expect(mount[0].overwrite).toEqual({ summary: 'c2' });
    expect(mount[1]).not.toHaveProperty('tags');
    expect(snapshot.sharedState.done).toBe(true);
  });

  it('SelectorFnList.addSubFlowChartBranch (the consumer’s slot-mount shape)', async () => {
    const chart = flowChart<State>('Seed', seedFn, 'seed')
      .addSelectorFunction('Pick', () => ['sf'], 'pick')
      .addSubFlowChartBranch('sf', buildInner(), 'Sub', mountOptions)
      .addFunctionBranch('other', 'Other', () => undefined)
      .end()
      .addFunction('Finish', finishFn, 'finish')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = expectMountTagged(executor);
    expect(snapshot.sharedState.done).toBe(true);
  });

  it('DeciderList.addSubFlowChartBranch', async () => {
    const chart = flowChart<State>('Seed', seedFn, 'seed')
      .addDeciderFunction('Route', () => 'sf', 'route')
      .addSubFlowChartBranch('sf', buildInner(), 'Sub', mountOptions)
      .addFunctionBranch('other', 'Other', () => undefined)
      .end()
      .addFunction('Finish', finishFn, 'finish')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = expectMountTagged(executor);
    expect(snapshot.sharedState.done).toBe(true);
  });

  it('addLazySubFlowChartNext — the lazy stub is the node that runs, so it carries the tag too', async () => {
    const chart = flowChart<State>('Seed', seedFn, 'seed')
      .addLazySubFlowChartNext('sf', () => buildInner(), 'Sub', mountOptions)
      .addFunction('Finish', finishFn, 'finish')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = expectMountTagged(executor);
    expect(snapshot.sharedState.done).toBe(true);
  });
});

describe('a mount without tags is untouched — the untagged half stays absent', () => {
  it('a mount with other options but no tags records no `tags` key on any bundle', async () => {
    const { tags: _tags, ...untagged } = mountOptions;
    const chart = flowChart<State>('Seed', seedFn, 'seed')
      .addSubFlowChartNext('sf', buildInner(), 'Sub', untagged)
      .addFunction('Finish', finishFn, 'finish')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog;
    for (const b of log) expect(b).not.toHaveProperty('tags');
    expect(JSON.stringify(log)).not.toContain('"tags"');
  });
});

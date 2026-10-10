/**
 * R13 — the merge-back and the seed are recorded under the subflow MOUNT: the engine's own stamps.
 *
 * Moved verbatim from nested-rows.test.ts in E1 (the record's tests run without the engine), with the chart it
 * reads (`mergeBackRun`, copied as it was there): what these tests pin is how the ENGINE names the bundles a
 * subflow mount writes — `SubflowExecutor · executeSubflow` stamps the output mapping and the subflow's seed with
 * the mount's names, for a linear and a decider-branch mount — so they need the engine to write the record. A
 * record written through foottrace/write carries whatever names its writer gives it. (The one edit: `CommitBundle`
 * is imported from src/trace, its door — src/index.ts does not hand it out.)
 */
import { normaliseStateKey } from 'foottrace/paths';

import { flowChart, FlowChartExecutor } from '../../../src';
const DELIM = normaliseStateKey(['', '']);
import type { CommitBundle } from 'foottrace';
import { causalChain, findLastWriter, keysReadFromExecutionTree, timeTravel } from 'foottrace';

const at = (...segments: string[]) => segments.join(DELIM);

/** Seed `cfg = { a: 1 }`; a LINEAR mount whose outputMapper merges `{ cfg: { b: 2 } }` back; a stage that reads cfg. */
async function mergeBackRun() {
  const inner = flowChart(
    'In',
    (s: any) => {
      s.r = 1;
    },
    'in',
  ).build();
  const chart = flowChart(
    'Seed',
    (s: any) => {
      s.cfg = { a: 1 };
    },
    'seed',
  )
    .addSubFlowChart('sub', inner, 'Sub', { inputMapper: () => ({ x: 1 }), outputMapper: () => ({ cfg: { b: 2 } }) })
    .addFunction(
      'Read',
      (s: any) => {
        s.out = Object.keys(s.cfg).join(',');
      },
      'read',
    )
    .build();
  const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix' });
  await executor.run();
  const snap = executor.getSnapshot();
  const log = snap.commitLog as CommitBundle[];
  const mergeBack = log.findIndex((b) => b.trace.some((t) => t.path === at('cfg', 'b')));
  return { snap, log, mergeBack, reads: keysReadFromExecutionTree(snap.executionTree) };
}

describe('R13 — the merge-back and the seed are recorded under the subflow MOUNT', () => {
  // `SubflowExecutor · executeSubflow` stages and commits the output mapping on the MOUNT's frame (at its parent's
  // address, so the values land where they always did), and stamps the subflow's seed with the mount's names.
  // Through 9.33.0 the merge-back was committed on the frame before a branch / fork-child mount — its bundle named
  // the stage before the mount, or the decider — and the seed carried runtimeStageId ''.

  async function linearMountRun() {
    const inner = flowChart(
      'In',
      (s: any) => {
        s.r = 1;
      },
      'in',
    ).build();
    const chart = flowChart(
      'A',
      (s: any) => {
        s.cfg = { a: 1 };
      },
      'a',
    )
      .addFunction(
        'B',
        (s: any) => {
          s.b = 1;
        },
        'b',
      )
      .addSubFlowChart('sub', inner, 'Sub', {
        inputMapper: () => ({ seeded: 1 }),
        outputMapper: () => ({ cfg: { m: 2 } }),
      })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    return executor.getSnapshot();
  }

  it("a fork-child mount: the merge-back is the first of the mount's three bundles", async () => {
    const log = (await linearMountRun()).commitLog as CommitBundle[];
    expect(log.map((b) => [b.runtimeStageId, b.stageId, b.trace.map((t) => t.path)])).toEqual([
      ['a#0', 'a', ['cfg']],
      ['b#1', 'b', ['b']],
      ['sub#2', 'sub', [at('cfg', 'm')]],
      ['sub#2', 'sub', []],
      ['sub#2', 'sub', []],
    ]);
    expect(findLastWriter(log, 'cfg')?.runtimeStageId).toBe('sub#2');
    expect(findLastWriter(log, 'b')?.runtimeStageId).toBe('b#1');
  });

  it('a decider-branch mount: the merge-back bundle names the branch mount, not the decider', async () => {
    const inner = flowChart(
      'In',
      (s: any) => {
        s.r = 1;
      },
      'in',
    ).build();
    const chart = flowChart(
      'A',
      (s: any) => {
        s.cfg = { a: 1 };
      },
      'a',
    )
      .addDeciderFunction('D', () => 'go', 'd')
      .addSubFlowChartBranch('go', inner, 'Go', { inputMapper: () => ({}), outputMapper: () => ({ cfg: { m: 3 } }) })
      .end()
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const log = executor.getSnapshot().commitLog as CommitBundle[];
    const mergeBack = log.find((b) => b.trace.some((t) => t.path === at('cfg', 'm')))!;
    expect([mergeBack.runtimeStageId, mergeBack.stageId, mergeBack.stage]).toEqual(['go#2', 'go', 'Go']);
    expect(log.filter((b) => b.runtimeStageId === 'd#1').every((b) => b.trace.length === 0)).toBe(true);
  });

  it("a causal walk from the reader reaches the merge-back as the mount's own commit", async () => {
    const { log, mergeBack, reads } = await mergeBackRun();
    const readId = log.find((b) => b.stageId === 'read')!.runtimeStageId;
    const root = causalChain(log, readId, reads.lookup);
    expect(log[mergeBack].runtimeStageId).toBe('sub#1');
    expect(root?.parents.map((p) => p.runtimeStageId)).toEqual(['sub#1']);
  });

  it("a subflow's input seed names its mount", async () => {
    const snap = await linearMountRun();
    const history = (snap.subflowResults as Record<string, any>).sub.treeContext.history as CommitBundle[];
    expect([history[0].runtimeStageId, history[0].stageId, history[0].stage]).toEqual(['sub#2', 'sub', 'Sub']);
    expect(findLastWriter(history, 'seeded')?.runtimeStageId).toBe('sub#2');
    // The drilled cursor still folds the seed into its 'start' bookend — the input the subflow began with.
    const inner = timeTravel(snap).drill('sub#2')!;
    expect(inner.stops.map((s) => s.kind)).toEqual(['start', 'commit', 'end']);
    expect(inner.stops[0].lastCommitIdx).toBe(0);
  });
});

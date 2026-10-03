/**
 * R13 — the mount records its own acts: what the review pinned beyond the slice-layer scenarios.
 *
 *   regression  a merge-back that fails to commit (an uncloneable value) is dropped and the run goes on, for a
 *               fork-child and a decider-branch mount — the log the published package records, id for id
 *   boundary    `StageContext · useAddressOf` refuses once the frame has staged at its own address
 *   scenario    a mount's declared tags ride its FIRST bundle — the merge-back — once, branch and fork alike
 *   scenario    the merge-back's tracked writes, reads and `readKeys` sit on the MOUNT, not the stage before
 *   edge        a subflow log that holds ONLY its seed folds the seed into 'start', in both shapes
 */
import * as baseline from 'footprintjs-baseline';
import { describe, expect, it } from 'vitest';

import * as current from '../../../../src';
import { SharedMemory, StageContext } from '../../../../src/advanced';
import type { CommitBundle, StageSnapshot } from '../../../../src/lib/memory/types';
import { commitStops } from '../../../../src/trace';

type Lib = Pick<typeof current, 'flowChart' | 'FlowChartExecutor'>;
const CURRENT: Lib = current;
const PUBLISHED = baseline as unknown as Lib;

const inner = (lib: Lib) =>
  lib
    .flowChart(
      'In',
      (s: any) => {
        s.r = 1;
      },
      'in',
    )
    .build();

function forkChild(lib: Lib, outputMapper: () => Record<string, unknown>, tags?: string[]) {
  return lib
    .flowChart(
      'A',
      (s: any) => {
        s.cfg = { a: 1 };
      },
      'a',
    )
    .addFunction(
      'B',
      (s: any) => {
        s.b = s.cfg.a;
      },
      'b',
    )
    .addSubFlowChart('sub', inner(lib), 'Sub', {
      inputMapper: () => ({ x: 1 }),
      outputMapper,
      ...(tags && { tags }),
    })
    .build();
}

function deciderBranch(lib: Lib, outputMapper: () => Record<string, unknown>, tags?: string[]) {
  return lib
    .flowChart(
      'A',
      (s: any) => {
        s.cfg = { a: 1 };
      },
      'a',
    )
    .addDeciderFunction('D', () => 'go', 'd')
    .addSubFlowChartBranch('go', inner(lib), 'Go', { inputMapper: () => ({}), outputMapper, ...(tags && { tags }) })
    .end()
    .build();
}

const SHAPES = { forkChild, deciderBranch };

async function run(lib: Lib, chart: unknown, options: Record<string, unknown> = {}) {
  const executor = new lib.FlowChartExecutor(chart as any, options);
  await executor.run();
  return executor.getSnapshot();
}

const shape = (log: CommitBundle[]) => log.map((b) => [b.runtimeStageId, b.trace.map((t) => t.path)]);

describe.each(Object.keys(SHAPES) as (keyof typeof SHAPES)[])('R13 on a %s mount', (name) => {
  const build = SHAPES[name];

  it('a merge-back that cannot commit is dropped and the run goes on — the log the published package records', async () => {
    const uncloneable = () => ({ fn: () => 1 });
    const now = await run(CURRENT, build(CURRENT, uncloneable));
    const then = await run(PUBLISHED, build(PUBLISHED, uncloneable));
    expect(shape(now.commitLog as CommitBundle[])).toEqual(shape(then.commitLog as CommitBundle[]));
    expect((now.sharedState as any).fn).toBeUndefined();
    expect(JSON.stringify(now.executionTree)).toContain('outputMapperError');
  });

  it("the mount's declared tags ride its first bundle — the merge-back — once", async () => {
    const snap = await run(
      CURRENT,
      build(CURRENT, () => ({ cfg: { m: 2 } }), ['merge']),
    );
    const log = snap.commitLog as CommitBundle[];
    const mountId = name === 'forkChild' ? 'sub' : 'go';
    const mount = log.filter((b) => b.stageId === mountId);
    expect(mount[0].trace.map((t) => t.path)).toEqual(['cfg\u001fm']);
    expect(mount.map((b) => b.tags)).toEqual([['merge'], ...mount.slice(1).map(() => undefined)]);
    expect(log.filter((b) => b.tags !== undefined)).toHaveLength(1);
  });
});

describe("the merge-back's tracking sits on the MOUNT's node", () => {
  function nodes(tree: StageSnapshot): Map<string, StageSnapshot> {
    const out = new Map<string, StageSnapshot>();
    const work = [tree];
    while (work.length > 0) {
      const n = work.pop()!;
      out.set(n.id, n);
      if (n.next) work.push(n.next);
      if (n.children) work.push(...n.children);
    }
    return out;
  }

  it('stageWrites, stageReads and the rows’ readKeys are the merge-back’s own', async () => {
    const snap = await run(
      CURRENT,
      forkChild(CURRENT, () => ({ cfg: { tags: ['t'] } })),
      { writeProvenance: 'reads-prefix' },
    );
    const byId = nodes(snap.executionTree as StageSnapshot);
    const b = byId.get('b')!;
    const sub = byId.get('sub')!;
    // B wrote `b` and read `cfg`; the merge-back (an append into cfg.tags) wrote and read at cfg.tags.
    expect(Object.keys(b.stageWrites ?? {})).toEqual(['b']);
    expect(Object.keys(b.stageReads ?? {})).toEqual(['cfg']);
    expect(Object.keys(sub.stageWrites ?? {})).toEqual(['cfg.tags']);
    expect(Object.keys(sub.stageReads ?? {})).toEqual(['cfg.tags']);
    const mergeBack = (snap.commitLog as CommitBundle[]).find((x) => x.stageId === 'sub')!;
    expect(mergeBack.trace).toEqual([{ path: 'cfg\u001ftags', verb: 'set', readKeys: ['cfg.tags'] }]);
  });
});

describe('StageContext · useAddressOf', () => {
  it('refuses once the frame has staged at its own address; same address, or nothing staged, is fine', () => {
    const memory = new SharedMemory();
    const parent = new StageContext('', 'B', 'b', memory);
    const child = new StageContext('sub', 'Sub', 'sub', memory);
    child.useAddressOf(parent); // nothing staged yet
    const staged = new StageContext('sub', 'Sub', 'sub', memory);
    staged.setObject([], 'k', 1);
    expect(() => staged.useAddressOf(parent)).toThrow(/already staged writes at its own address/);
    expect(() => staged.useAddressOf(new StageContext('sub', 'X', 'x', memory))).not.toThrow();
  });
});

describe("a log that holds ONLY the subflow's seed folds it into 'start'", () => {
  const seed = (runtimeStageId: string): CommitBundle =>
    ({
      overwrite: { x: 1 },
      updates: {},
      redactedPaths: [],
      trace: [{ path: 'x', verb: 'set' }],
      stage: 'Sub',
      stageId: 'sub',
      runtimeStageId,
      idx: 0,
    } as unknown as CommitBundle);
  // The subflow ran no stage; its tree is rooted at its own first stage, under the mount's path.
  const tree = { id: 'sub/in', name: 'In' } as unknown as StageSnapshot;

  it.each([
    ['R13', 'sub#2'],
    ['through 9.33.0', ''],
  ])('%s shape', (_label, id) => {
    const stops = commitStops([seed(id)], tree);
    expect(stops.map((s) => s.kind)).toEqual(['start', 'end']);
    expect(stops[0].lastCommitIdx).toBe(0);
  });

  it('a one-stage RUN log is still a stop — its tree is not rooted under its id', () => {
    const run = { ...seed('a#0'), stage: 'A', stageId: 'a' } as CommitBundle;
    const own = { id: 'a', name: 'A', runtimeStageId: 'a#0' } as unknown as StageSnapshot;
    expect(commitStops([run], own).map((s) => s.kind)).toEqual(['start', 'commit', 'end']);
  });
});

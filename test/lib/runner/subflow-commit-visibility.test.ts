/**
 * subflow-commit-visibility — the retain-per-loop fix
 * (design: docs/design/subflow-commit-visibility.md).
 *
 * A deep subflow runs in an isolated runtime with its OWN commit log; the run-level
 * `commitLog` carries only the mount boundary. `subflowResults` used to be keyed ONLY by
 * the path-prefixed subflowId, so a LOOPING subflow re-entering with the same id OVERWROTE
 * the previous iteration — only the last survived (a visible eui drill-down bug + per-loop
 * backtracking gap for the grouped agent).
 *
 * The fix is ADDITIVE + non-breaking: dual-key `subflowResults` — keep `subflowId → last`
 * (back-compat) AND add `mountRuntimeStageId → this iteration` (unique → every loop retained).
 * Plus: expose `history` on `getSubtreeSnapshot`; keep `listSubflowPaths` path-only; keep the
 * pause checkpoint lean (resume never reads subflowResults).
 *
 * Convention-3 coverage: unit · functional · integration · security/robustness · pause/resume.
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../src';
import { flowChart, FlowChartExecutor, getSubtreeSnapshot, listSubflowPaths } from '../../../src';

interface Loose {
  [key: string]: unknown;
}

/** Seed i=0 → sf-body (i→iNext=i+1) → Check loops back to sf-body while i<2. Runs 2 mounts. */
function buildLoopingSubflowChart() {
  const body = flowChart<Loose>(
    'BodyStage',
    async (scope) => {
      const i = (scope.$getValue('i') as number) ?? 0;
      scope.$setValue('iNext', i + 1);
    },
    'body-stage',
  ).build();

  return flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('i', 0);
    },
    'seed',
  )
    .addSubFlowChartNext('sf-body', body, 'BodyMount', {
      inputMapper: (s: Loose) => ({ i: s.i }),
      outputMapper: (out: Loose) => ({ i: out.iNext }),
    })
    .addDeciderFunction('Check', async (scope) => ((scope.$getValue('i') as number) < 2 ? 'again' : 'done'), 'check')
    .addFunctionBranch('again', 'Again', async () => undefined, undefined, { loopTo: 'sf-body' })
    .addFunctionBranch('done', 'Done', async () => undefined)
    .setDefault('done')
    .end()
    .build();
}

const execEntries = (sr: Record<string, unknown>) => Object.keys(sr).filter((k) => k.includes('#'));
const pathEntries = (sr: Record<string, unknown>) => Object.keys(sr).filter((k) => !k.includes('#'));
const iNextOf = (sr: Record<string, unknown>, key: string) =>
  (sr[key] as { treeContext?: { globalContext?: { iNext?: number } } }).treeContext?.globalContext?.iNext;

// ─── 1. UNIT / FUNCTIONAL — the overwrite is fixed ───────────────────
describe('retain-per-loop — a looping subflow keeps EVERY iteration', () => {
  it('snapshot.subflowResults dual-keys: path → last, runtimeStageId → each iteration', async () => {
    const executor = new FlowChartExecutor(buildLoopingSubflowChart());
    await executor.run();
    const sr = executor.getSnapshot().subflowResults as Record<string, unknown>;

    // back-compat: the path key still exists, holding the LAST iteration
    expect(pathEntries(sr)).toContain('sf-body');
    expect(iNextOf(sr, 'sf-body')).toBe(2);

    // the fix: BOTH iterations retained under unique per-execution keys
    const execKeys = execEntries(sr);
    expect(execKeys.length).toBe(2);
    expect(execKeys.every((k) => k.startsWith('sf-body#'))).toBe(true);
    const iNexts = execKeys.map((k) => iNextOf(sr, k)).sort();
    expect(iNexts).toEqual([1, 2]); // iteration 1 wrote iNext=1, iteration 2 wrote iNext=2
  });
});

// ─── 2. INTEGRATION — getSubtreeSnapshot exposes history + per-iteration ─
describe('getSubtreeSnapshot — the public door to subflow commits', () => {
  it('exposes the subflow’s own commit log (history) — previously unreachable', async () => {
    const executor = new FlowChartExecutor(buildLoopingSubflowChart());
    await executor.run();
    const snap = executor.getSnapshot();

    const sub = getSubtreeSnapshot(snap, 'sf-body');
    expect(sub).toBeDefined();
    expect(Array.isArray(sub!.history)).toBe(true);
    expect(sub!.history!.length).toBeGreaterThan(0); // the body-stage commit(s)
    expect((sub!.sharedState as { iNext?: number }).iNext).toBe(2); // path → last iteration
  });

  it('addressing a SPECIFIC iteration by its mount runtimeStageId', async () => {
    const executor = new FlowChartExecutor(buildLoopingSubflowChart());
    await executor.run();
    const snap = executor.getSnapshot();
    const sr = snap.subflowResults as Record<string, unknown>;

    const iter1Key = execEntries(sr).find((k) => iNextOf(sr, k) === 1)!;
    const sub1 = getSubtreeSnapshot(snap, iter1Key);
    expect(sub1).toBeDefined();
    expect((sub1!.sharedState as { iNext?: number }).iNext).toBe(1); // the EARLIER iteration
    expect(Array.isArray(sub1!.history)).toBe(true);
  });
});

// ─── 3. SECURITY / CONTRACT — listSubflowPaths stays path-only ───────
describe('listSubflowPaths — path-only contract preserved', () => {
  it('does NOT leak the per-execution (#) keys the snapshot dual-keys', async () => {
    const executor = new FlowChartExecutor(buildLoopingSubflowChart());
    await executor.run();
    const paths = listSubflowPaths(executor.getSnapshot());
    expect(paths).toEqual(['sf-body']);
    expect(paths.some((p) => p.includes('#'))).toBe(false);
  });
});

// ─── 4. PAUSE/RESUME — the checkpoint stays lean ─────────────────────
describe('pause checkpoint — lean (no per-iteration keys, no per-subflow history)', () => {
  function buildCompletedSubflowThenPauseChart() {
    const work = flowChart<Loose>('Work', async (scope) => scope.$setValue('w', 1), 'work').build();
    const hold: PausableHandler<Loose> = {
      execute: async () => ({ question: 'hold?' }),
      resume: async () => undefined,
    };
    return flowChart<Loose>('Seed', async (scope) => scope.$setValue('seeded', true), 'seed')
      .addSubFlowChartNext('sf-work', work, 'WorkMount', { inputMapper: () => ({}), outputMapper: () => ({}) })
      .addPausableFunction('Hold', hold, 'hold')
      .build();
  }

  it('checkpoint.subflowResults drops # keys + strips treeContext.history; resume still works', async () => {
    const executor = new FlowChartExecutor(buildCompletedSubflowThenPauseChart());
    await executor.run();
    expect(executor.isPaused()).toBe(true);

    const cp = executor.getCheckpoint()!;
    expect(cp.subflowResults).toBeDefined();
    const sr = cp.subflowResults as Record<string, unknown>;
    // lean: only the path key, no per-iteration (#) duplication
    expect(Object.keys(sr)).toEqual(['sf-work']);
    // lean: the per-subflow commit log is stripped (resume never reads it)
    const treeCtx = (sr['sf-work'] as { treeContext?: Record<string, unknown> }).treeContext!;
    expect(Object.prototype.hasOwnProperty.call(treeCtx, 'history')).toBe(false);
    expect(treeCtx.globalContext).toBeDefined(); // the rest of treeContext survives

    // the whole point: resume works WITHOUT the stripped history
    await executor.resume(cp, {});
    expect(executor.isPaused()).toBe(false);
  });
});

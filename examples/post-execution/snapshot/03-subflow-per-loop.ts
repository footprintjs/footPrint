/**
 * Snapshot — Per-Loop Subflow Drill-Down (subflow-commit-visibility)
 *
 * A subflow runs in an isolated runtime with its OWN commit log; the run-level commitLog
 * carries only the mount boundary. A LOOPING subflow re-enters with the same subflowId, so
 * `subflowResults` is dual-keyed: the PATH key holds the last iteration (back-compat), and a
 * per-execution `runtimeStageId` key holds EACH iteration — so every loop is retained, not
 * just the last. `getSubtreeSnapshot` exposes each iteration's own commit log via `.history`.
 *
 * Run: npx tsx examples/post-execution/snapshot/03-subflow-per-loop.ts
 */

import { flowChart, FlowChartExecutor, getSubtreeSnapshot, listSubflowPaths } from 'footprintjs';

interface State { [k: string]: unknown }

// The loop body: read i, write i+1 under iNext (mapped back out as i).
const body = flowChart<State>('BodyStage', async (scope) => {
  const i = (scope.$getValue('i') as number) ?? 0;
  scope.$setValue('iNext', i + 1);
}, 'body-stage').build();

const chart = flowChart<State>('Seed', async (scope) => { scope.$setValue('i', 0); }, 'seed')
  .addSubFlowChartNext('sf-body', body, 'BodyMount', {
    inputMapper: (s: State) => ({ i: s.i }),
    outputMapper: (out: State) => ({ i: out.iNext }),
  })
  .addDeciderFunction('Check', async (scope) => ((scope.$getValue('i') as number) < 3 ? 'again' : 'done'), 'check')
  .addFunctionBranch('again', 'Again', async () => undefined, undefined, { loopTo: 'sf-body' })
  .addFunctionBranch('done', 'Done', async () => undefined)
  .setDefault('done')
  .end()
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  const snap = executor.getSnapshot();
  const sr = (snap.subflowResults ?? {}) as Record<string, { treeContext?: { globalContext?: { iNext?: number } } }>;

  // listSubflowPaths stays path-only (the per-execution '#' keys are filtered out)
  console.log('Subflow paths:', listSubflowPaths(snap)); // ['sf-body']

  // Every loop iteration is retained under its own per-execution key
  const execKeys = Object.keys(sr).filter((k) => k.includes('#'));
  console.log(`\nLoop iterations retained: ${execKeys.length}`); // 3
  for (const key of execKeys) {
    const sub = getSubtreeSnapshot(snap, key);
    console.log(
      `  ${key}  →  iNext=${sr[key].treeContext?.globalContext?.iNext}  ` +
        `(own commit log: ${sub?.history?.length ?? 0} entries)`,
    );
  }

  // The PATH key still resolves the last iteration (back-compat)
  const last = getSubtreeSnapshot(snap, 'sf-body');
  console.log(`\nsf-body (path key) → last iteration iNext=${(last?.sharedState as { iNext?: number })?.iNext}`);
})().catch(console.error);

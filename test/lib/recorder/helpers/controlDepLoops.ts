/**
 * Shared pieces of the control-dependence loop tests: one loop shape, its stage functions, and a runner
 * that records which executions ran (each id once — a fork parent reports `onStageExecuted` twice) and
 * checks that the stored snapshot bundle says what the live lookup says.
 */
import type { ControlDependency } from 'foottrace';
import { expect } from 'vitest';

import { decide, flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { controlDepRecorder } from '../../../../src/lib/recorder/ControlDepRecorder.js';

export type Loose = Record<string, unknown>;
export type S = Loose & { $getValue(k: string): unknown; $setValue(k: string, v: unknown): void };

export const seed = (passes: number) => async (s: S) => s.$setValue('left', passes);
export const work = async (s: S) => s.$setValue('done', ((s.$getValue('done') as number | undefined) ?? 0) + 1);
export const more = async (s: S) =>
  decide(s as never, [{ when: { left: { gt: 0 } }, then: 'again', label: 'Left to do' }], {
    branch: 'leave',
    label: 'All done',
  });
export const again = async (s: S) => s.$setValue('left', (s.$getValue('left') as number) - 1);
export const noop = async () => undefined;

/** `seed → work → more ─ again (loopTo work) | leave`, then more's own next: after1 → after2. */
export function loopChart(passes: number) {
  return flowChart<Loose>('Seed', seed(passes) as never, 'seed')
    .addFunction('Work', work as never, 'work')
    .addDeciderFunction('More', more as never, 'more')
    .addFunctionBranch('again', 'Again', again as never, undefined, { loopTo: 'work' })
    .addFunctionBranch('leave', 'Leave', noop)
    .end()
    .addFunction('After 1', noop, 'after1')
    .addFunction('After 2', noop, 'after2');
}

type Built = ReturnType<ReturnType<typeof loopChart>['build']>;

/** Runs `chart`; `onStep` sees each execution's id and parent as it is reported. */
export async function record(chart: Built, onStep?: (step: { id: string; parent?: string }) => void) {
  const ctrl = controlDepRecorder();
  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(ctrl);
  const ran: string[] = [];
  executor.attachFlowRecorder({
    id: 'ran',
    onStageExecuted: (e) => {
      const id = e.traversalContext?.runtimeStageId;
      if (id === undefined) return;
      onStep?.({ id, parent: e.traversalContext?.parentRuntimeStageId });
      if (!ran.includes(id)) ran.push(id);
    },
  });
  await executor.run();
  const row = executor.getSnapshot().recorders?.find((r) => r.id === ctrl.id);
  expect(row).toBeDefined();
  const saved = JSON.parse(JSON.stringify(row?.data)) as { controlDeps: Record<string, ControlDependency> };
  for (const id of ran) expect(saved.controlDeps[id]).toEqual(ctrl.lookup(id));
  /** Every execution of a stage id, in run order. */
  const find = (stageId: string) => ran.filter((id) => id.startsWith(`${stageId}#`));
  return { ctrl, ran, find };
}

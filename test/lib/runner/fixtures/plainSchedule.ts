import type { PausableHandler, TypedScope } from '../../../../src/index.js';
import { createRunLifecycle, flowChart, FlowChartExecutor } from '../../../../src/index.js';

export const scheduleShapes = ['run', 'mount', 'resume', 'same-resume', 'owned', 'owned-empty'] as const;
export type ScheduleShape = (typeof scheduleShapes)[number];
export interface ScheduleSample {
  ticks: number;
  table: string[];
}

async function operation(shape: ScheduleShape, declared: boolean): Promise<() => Promise<unknown>> {
  const handler: PausableHandler<TypedScope<Record<string, unknown>>> = {
    execute: async () => ({ question: 'continue?' }),
    resume: async () => 'answer',
  };
  const leaf =
    shape === 'resume' || shape === 'same-resume'
      ? flowChart('pause', handler, 'pause').build()
      : flowChart('leaf', () => 'answer', 'leaf').build();
  const owner = createRunLifecycle(leaf, { runnerId: 'schedule-leaf' });
  if (declared) owner.slot('component');
  if (shape === 'owned-empty') return Object.assign(() => owner.withRun(() => undefined), { owner });
  if (shape === 'owned') return Object.assign(() => owner.withRun((run) => run.execute({ kind: 'run' })), { owner });
  if (shape === 'resume' || shape === 'same-resume') {
    const paused = new FlowChartExecutor(leaf);
    await paused.run();
    const checkpoint = paused.getCheckpoint()!;
    const fresh = shape === 'same-resume' ? paused : new FlowChartExecutor(leaf);
    return Object.assign(() => fresh.resume(checkpoint, 'yes'), { owner });
  }
  const chart =
    shape === 'mount'
      ? flowChart('parent', () => undefined, 'parent')
          .addSubFlowChartNext('leaf', leaf, 'leaf')
          .build()
      : leaf;
  // The closure retains the owner even when no setup is installed.
  return Object.assign(() => new FlowChartExecutor(chart).run(), { owner });
}

/** Capture the same public operations on the unchanged base and the candidate. */
export async function sampleSchedule(shape: ScheduleShape, declared = false): Promise<ScheduleSample> {
  const execute = await operation(shape, declared);
  let ticks = 0;
  let done = false;
  const pending = execute().then(() => {
    done = true;
  });
  // eslint-disable-next-line no-unmodified-loop-condition -- execution settles done.
  while (!done && ticks < 100) {
    ticks++;
    await Promise.resolve();
  }
  await pending;
  const table: string[] = [];
  for (let offset = 0; offset <= 40; offset++) {
    const invoke = await operation(shape, declared);
    const order: string[] = [];
    const chart = flowChart('start', () => undefined, 'start')
      .addSelectorFunction('fork', () => ['nested', 'sibling'], 'fork')
      .addFunctionBranch('nested', 'nested', async () => {
        await invoke();
        order.push('nested');
      })
      .addFunctionBranch('sibling', 'sibling', async () => {
        for (let i = 0; i < offset; i++) await Promise.resolve();
        order.push('sibling');
      })
      .end()
      .build();
    await new FlowChartExecutor(chart).run();
    table.push(order.join(','));
  }
  return { ticks, table };
}

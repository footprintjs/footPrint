/**
 * Deferred Observers — Terminal flush: nothing is lost at exit (RFC-001)
 *
 * "One beat behind" raises an obvious worry: what about the LAST beat?
 * The executor drains the queue synchronously at every terminal boundary —
 * run resolve, run REJECT (a crashing stage), and PAUSE — before control
 * returns to you. A crash report and a checkpoint handoff always come with
 * the complete observer record.
 *
 * For async listeners (e.g. shipping events to a collector), follow with
 * `await executor.drainObservers({ timeoutMs })` before process exit /
 * serverless freeze — it settles in-flight continuations and reports an
 * honest `pending` count if the deadline cuts it off.
 *
 * Run: npm run example -- examples/runtime-features/deferred-observers/03-terminal-flush.ts
 * (build first: npm run build)
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { PausableHandler, WriteEvent } from 'footprintjs';

type Loose = Record<string, unknown>;

async function crashScenario() {
  const chart = flowChart<Loose>(
    'Prepare',
    async (scope) => {
      scope.$setValue('step', 'prepared');
    },
    'prepare',
  )
    .addFunction(
      'Explode',
      async (scope) => {
        scope.$setValue('lastWords', 'about to throw');
        throw new Error('downstream service 500');
      },
      'explode',
    )
    .build();

  const delivered: string[] = [];
  const executor = new FlowChartExecutor(chart);
  executor.attachCombinedRecorder(
    {
      id: 'crash-audit',
      onWrite: (e) => delivered.push(`write ${(e as WriteEvent).key}`),
      onError: () => delivered.push('error event'),
    },
    { delivery: 'deferred', capture: 'clone' },
  );

  try {
    await executor.run();
  } catch (err) {
    // The rejection reached us — and the deferred record is ALREADY complete,
    // including the write made inside the crashing stage and the error event.
    console.log('── crash scenario ──');
    console.log(`caught: ${(err as Error).message}`);
    console.log(`record at the moment of catch: [${delivered.join(', ')}]`);
    if (!delivered.includes('write lastWords') || !delivered.includes('error event')) {
      throw new Error('terminal flush must deliver everything before the rejection');
    }
  }
}

async function pauseScenario() {
  const approval: PausableHandler<Loose> = {
    execute: async () => ({ question: 'Approve the order?' }),
    resume: async (scope) => {
      (scope as Loose & { $setValue(k: string, v: unknown): void }).$setValue('approved', true);
    },
  };
  const chart = flowChart<Loose>(
    'Stage1',
    async (scope) => {
      scope.$setValue('amount', 12_000);
    },
    'stage-1',
  )
    .addPausableFunction('Approval', approval, 'approval')
    .build();

  const delivered: string[] = [];
  const executor = new FlowChartExecutor(chart);
  executor.attachCombinedRecorder(
    {
      id: 'pause-audit',
      onWrite: (e) => delivered.push(`write ${(e as WriteEvent).key}`),
      onPause: () => delivered.push('pause boundary'),
    },
    { delivery: 'deferred', capture: 'clone' },
  );

  await executor.run();
  // The checkpoint is available AND the observer record is complete — store
  // both, discard the executor, resume hours later on another machine.
  console.log('\n── pause scenario ──');
  console.log(`paused: ${executor.isPaused()}, checkpoint ready: ${executor.getCheckpoint() !== undefined}`);
  console.log(`record at the moment run() returned: [${delivered.join(', ')}]`);
  if (!delivered.includes('write amount') || !delivered.includes('pause boundary')) {
    throw new Error('terminal flush must complete before the checkpoint is handed over');
  }
}

async function asyncDrainScenario() {
  const chart = flowChart<Loose>(
    'Emit',
    async (scope) => {
      scope.$setValue('k', 1);
    },
    'emit',
  ).build();
  let shipped = 0;
  const executor = new FlowChartExecutor(chart);
  executor.attachScopeRecorder(
    {
      id: 'async-exporter',
      onWrite: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20)); // simulate network export
        shipped += 1;
      },
    },
    { delivery: 'deferred' },
  );
  await executor.run();
  const result = await executor.drainObservers({ timeoutMs: 5_000 }); // SIGTERM / serverless pattern
  console.log('\n── async drain scenario ──');
  console.log(`drained: done=${result.done} failed=${result.failed} pending=${result.pending}; shipped=${shipped}`);
  if (result.pending !== 0 || shipped === 0) throw new Error('drainObservers must settle async exports');
}

async function main() {
  await crashScenario();
  await pauseScenario();
  await asyncDrainScenario();
  console.log('\n"one beat behind" never becomes "lost at exit".');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

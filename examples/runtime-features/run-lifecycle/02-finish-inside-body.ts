/**
 * Finish an owned run from inside its body.
 *
 * WHY: `withRun` normally runs the run's finalizers after the body returns. Code that wraps the body
 * in an async context (here an AsyncLocalStorage "turn") then cannot see what those finalizers file.
 * `run.finish()` runs them from inside the body, once, while the run lease is still held.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { createRunLifecycle, flowChart } from 'footprintjs';

type Filed = { turn: string | undefined; end: string; commits: number };

async function example() {
  const turn = new AsyncLocalStorage<string>();
  const chart = flowChart<{ answer?: number }>(
    'Answer',
    (scope) => {
      scope.answer = 42;
    },
    'answer',
  ).build();
  const owner = createRunLifecycle(chart, { runnerId: 'turn-runner' });

  /** A wrapper that wants the turn's record filed before its own code continues. */
  async function aroundTurn(work: () => Promise<void>): Promise<Filed[]> {
    const filed: Filed[] = [];
    await turn.run('turn-1', async () => {
      await work();
      // Without finish(), this list would still be empty here.
      filed.push(...records.splice(0));
    });
    return filed;
  }

  const records: Filed[] = [];
  const filed = await owner.withRun(async (run) => {
    // The finalizer files the run's record. It sees the end and the async context it runs in.
    run.onFinalize((end) => {
      records.push({ turn: turn.getStore(), end: end.kind, commits: owner.view()?.getCommitCount() ?? 0 });
    });
    return aroundTurn(async () => {
      await run.execute({ kind: 'run' });
      await run.finish(); // Finalizers run now, inside the turn, still under the lease.
    });
  });

  if (filed.length !== 1 || filed[0].turn !== 'turn-1' || filed[0].end !== 'completed' || filed[0].commits < 1) {
    throw new Error('Expected the record to be filed inside the turn');
  }
  console.log('filed inside the turn:', filed[0].turn, filed[0].end);
}

example().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

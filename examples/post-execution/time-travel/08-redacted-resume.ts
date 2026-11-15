/**
 * A fresh resumed leg keeps its public replay base without exposing secrets.
 * Run: npx tsx examples/post-execution/time-travel/08-redacted-resume.ts
 */
import { flowChart, FlowChartExecutor, type PausableHandler, type TypedScope } from 'footprintjs';
import { stateAt } from 'foottrace';

interface Reading {
  window?: string;
  apiKey?: string;
  answer?: string;
}

const confirm: PausableHandler<TypedScope<Reading>, unknown> = {
  execute: async () => ({ question: 'Confirm this reading?' }),
  resume: async (scope, answer) => {
    if (typeof answer !== 'string') throw new Error('The confirmation must be a string.');
    scope.answer = answer;
  },
};

const chart = flowChart<Reading>('Read', (scope) => {
  scope.window = 'last 2 hours';
  scope.apiKey = 'example-only-secret';
}, 'read')
  .addPausableFunction('Confirm', confirm, 'confirm')
  .build();

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const paused = new FlowChartExecutor(chart);
  paused.setRedactionPolicy({ keys: ['apiKey'] });
  await paused.run();
  const checkpoint = paused.getCheckpoint();
  if (!checkpoint) throw new Error('The chart must pause before resuming.');
  check(checkpoint.sharedState.apiKey === 'example-only-secret', 'The operational checkpoint keeps its real key.');

  const resumed = new FlowChartExecutor(chart);
  resumed.setRedactionPolicy({ keys: ['apiKey'] });
  await resumed.resume(checkpoint, 'confirmed');
  const safe = resumed.getSnapshot({ redact: true });
  const before = stateAt(safe, -1);
  const after = stateAt(safe, safe.commitLog.length - 1);
  check(before.basis === 'initial+log', 'The safe record must carry its original base.');
  check(before.state.window === 'last 2 hours', 'The inherited public reading must survive.');
  check(before.state.apiKey === 'REDACTED', 'The inherited private key must be masked.');
  check(before.state.answer === undefined, 'The later answer must be absent from the base.');
  check(after.state.answer === 'confirmed', 'The resumed commit must contain the answer.');
  check(!JSON.stringify(safe).includes('example-only-secret'), 'The served record must contain no raw key.');

  console.log(`Before resume: ${before.state.window}`);
  console.log(`Answer before resume: ${String(before.state.answer)}`);
  console.log(`Answer after resume: ${String(after.state.answer)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Output:
// Before resume: last 2 hours
// Answer before resume: undefined
// Answer after resume: confirmed

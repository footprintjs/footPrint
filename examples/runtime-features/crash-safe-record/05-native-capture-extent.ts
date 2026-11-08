/** Observe a failed native invocation locally; no model, cloud or closure claim. */
import { flowChart, FlowChartExecutor } from 'footprintjs';

async function main(): Promise<void> {
  const failure = new Error('synthetic rejection');
  const ignoreLog = () => undefined;
  let calls = 0;
  const chart = flowChart(
    'Reject',
    () => {
      calls++;
      throw failure;
    },
    'reject',
  )
    .setLogger({ info: ignoreLog, log: ignoreLog, debug: ignoreLog, error: ignoreLog, warn: ignoreLog })
    .build();
  const executor = new FlowChartExecutor(chart, {
    captureCoverage: true,
    captureExtent: true,
  });
  let escaped: unknown;
  try {
    await executor.run();
  } catch (error) {
    escaped = error;
  }
  const snapshot = executor.getSnapshot();
  const extent = snapshot.captureExtent;
  if (escaped !== failure || calls !== 1) throw new Error('The original failure was not preserved');
  if (snapshot.capture?.boundary.status !== 'failed') throw new Error('The failed outcome changed');
  if (extent?.status !== 'unverified') throw new Error('Expected an unverified terminal observation');
  if (extent.invocations.started !== 1 || extent.invocations.settled !== 1 || extent.invocations.pending !== 0) {
    throw new Error('Unexpected native invocation counts');
  }
  console.log('Original failure preserved: true');
  console.log(`Native work: ${extent.status}; pending: ${extent.invocations.pending}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

// Output:
// Original failure preserved: true
// Native work: unverified; pending: 0

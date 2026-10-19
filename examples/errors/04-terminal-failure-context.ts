/** Native terminal context: no model, provider, retry-record join or external I/O. */
import { flowChart, FlowChartExecutor, type TerminalFailureContext } from 'footprintjs';

async function main(): Promise<void> {
  let attempts = 0;
  const original = Object.assign(new Error('synthetic private payment detail'), { status: 503 });
  const chart = flowChart(
    'Recover inventory',
    () => {
      if (++attempts === 1) throw Object.assign(new Error('synthetic earlier auth failure'), { status: 401 });
    },
    'inventory',
  )
    .retry({ attempts: 2 })
    .addFunction(
      'Payment',
      () => {
        throw original;
      },
      'payment',
    )
    .retry({ attempts: 1, timeoutMs: 1000 })
    .setLogger({ info() {}, log() {}, debug() {}, error() {}, warn() {} })
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.setRedactionPolicy({ diagnostics: { keys: ['errors.stageExecutionError'] } });
  let eventContext: TerminalFailureContext | undefined;
  executor.attachFlowRecorder({
    id: 'native-terminal',
    onRunFailed(event) {
      eventContext = event.failure;
    },
  });
  try {
    await executor.run();
    throw new Error('expected the synthetic payment to fail');
  } catch (error) {
    if (error !== original) throw new Error('the original rejection changed');
  }
  const failure = executor.getFailureContext();
  if (failure?.category !== 'server' || failure.stage?.runtimeStageId !== 'payment#1') {
    throw new Error('terminal context borrowed another operation');
  }
  if (eventContext !== failure || !Object.isFrozen(failure.stage)) {
    throw new Error('event and accessor must share immutable safe context');
  }
  console.log(JSON.stringify(failure));

  // Admission failures own no native stage. They never reuse the previous failed stage.
  try {
    await executor.run({ env: { traceparent: 'invalid-synthetic-header' } });
  } catch {
    /* expected */
  }
  const admission = executor.getFailureContext();
  if (admission?.category !== 'unknown' || admission.stage !== undefined) {
    throw new Error('admission failure must remain unknown');
  }
  console.log('✓ native failure category and identity survive masking; unowned failures stay unknown');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

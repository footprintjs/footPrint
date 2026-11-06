// Retry a stage, record a call inside a stage, and bound the time.
import { flowChart, FlowChartExecutor } from 'footprintjs';

interface QuoteState {
  rate?: number;
  stock?: number;
}

// Local stand-ins for outside services: busy once, then they answer.
const busyOnce = <T>(value: T) => {
  let calls = 0;
  return async (signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted();
    if (++calls === 1) throw Object.assign(new Error('service busy'), { status: 503 });
    return value;
  };
};
const fetchRate = busyOnce(1.09);
const lookupStock = busyOnce(7);

const chart = flowChart<QuoteState>('Fetch rate', async (scope) => {
    // Pass the signal on, so a timeout stops the work and not only the wait.
    scope.rate = await fetchRate(scope.$attempt().signal);
  }, 'fetch-rate')
  .retry({ attempts: 3, backoffMs: 10, timeoutMs: 1_000 }) // attempts counts the first run too
  .addFunction('Check stock', async (scope) => {
    // Every attempt of a call is recorded, even with no policy.
    scope.stock = await scope.$call('inventory.lookup', (t) => lookupStock(t.signal), { attempts: 2, backoffMs: 10 });
  }, 'check-stock')
  .budget(5_000) // build() refuses a chart whose declared policies allow longer
  .build();

console.log('declared worst case', chart.timeBudget().knownMs);

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder({
  id: 'attempts',
  onAttempt: ({ stageId, record }) =>
    console.log(stageId, record.kind, record.target ?? '-', `${record.attempt}/${record.of}`, record.outcome, record.reason),
});
await executor.run({ timeoutMs: 5_000 }); // one deadline for the whole run

// Output:
// declared worst case 3020
// fetch-rate stage - 1/3 failed retryable
// fetch-rate stage - 2/3 ok answered
// check-stock call inventory.lookup 1/2 failed retryable
// check-stock call inventory.lookup 2/2 ok answered
// check-stock stage - 1/1 ok answered

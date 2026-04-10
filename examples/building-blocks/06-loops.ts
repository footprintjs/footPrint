/**
 * Flowchart: Loops (loopTo + $break)
 *
 * Use `.loopTo(stageId)` to jump back to an earlier stage.
 * Call `scope.$break()` inside a stage to exit the loop.
 *
 *   CallAPI <----+
 *       |        |
 *   EvaluateResult ---+  (retries with backoff until success or max attempts)
 * Try it: https://footprintjs.github.io/footprint-playground/samples/loops
 */

import { flowChart,  FlowChartExecutor } from 'footprintjs';

interface LoopState {
  city: string;
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
  weather?: { city: string; tempC: number; condition: string; humidity: number };
  success: boolean;
  outcome: string;
}

(async () => {

// -- Mock Unstable API --------------------------------------------------------

let callCount = 0;

const weatherAPI = {
  fetch: (city: string) => {
    callCount++;
    // Fails first 2 attempts, succeeds on 3rd
    if (callCount < 3) {
      throw new Error(`Service unavailable (attempt ${callCount})`);
    }
    return { city, tempC: 22, condition: 'partly cloudy', humidity: 65 };
  },
};

// -- Flowchart ----------------------------------------------------------------

const chart = flowChart<LoopState>('InitRetry', async (scope) => {
  scope.city = 'Portland';
  scope.attempt = 0;
  scope.maxAttempts = 5;
  scope.lastError = null;
}, 'init-retry')

  .addFunction('CallAPI', async (scope) => {
    const city = scope.city;
    const attempt = scope.attempt + 1;
    scope.attempt = attempt;

    try {
      const data = weatherAPI.fetch(city);
      scope.weather = data;
      scope.success = true;
      console.log(`  Attempt ${attempt}: success -- ${data.tempC}C, ${data.condition}`);
    } catch (err: any) {
      scope.success = false;
      scope.lastError = err.message;
      console.log(`  Attempt ${attempt}: ${err.message}`);
    }
  }, 'call-api')
  .addFunction('EvaluateResult', async (scope) => {
    const success = scope.success;
    const attempt = scope.attempt;
    const maxAttempts = scope.maxAttempts;

    if (success) {
      scope.outcome = 'fetched';
      scope.$break();
      return;
    }

    if (attempt >= maxAttempts) {
      const lastError = scope.lastError;
      scope.outcome = `failed after ${attempt} attempts: ${lastError}`;
      scope.$break();
      return;
    }

    // Exponential backoff: 50ms, 100ms, 200ms, ...
    const delay = 50 * Math.pow(2, attempt - 1);
    await new Promise((r) => setTimeout(r, delay));
  }, 'evaluate-result')
  .loopTo('call-api')
  .build();

// -- Run ----------------------------------------------------------------------

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();

console.log('\n=== Loops (Retry with Backoff) ===\n');
executor.getNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);

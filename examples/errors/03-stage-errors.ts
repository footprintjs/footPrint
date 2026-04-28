/**
 * Feature: Error Handling Patterns
 *
 * Demonstrates how to handle errors in footprint pipelines:
 * - try/catch around executor.run()
 * - DebugRecorder captures error details
 * - Partial metrics — see which stages ran before the crash
 * - Custom error recorder for production alerting
 *
 * Run:  npm run feature:errors
 * Try it: https://footprintjs.github.io/footprint-playground/samples/error-handling
 */

import {
  flowChart,
  FlowChartExecutor,
  MetricRecorder,
  DebugRecorder,
  type Recorder,
  type ErrorEvent,
  type WriteEvent,
} from 'footprintjs';

// ── Custom error alerting recorder ──────────────────────────────────────

class AlertRecorder implements Recorder {
  readonly id = 'alert';
  readonly alerts: Array<{ stage: string; error: string; timestamp: number }> = [];
  readonly writes: Array<{ stage: string; key: string }> = [];

  onWrite(event: WriteEvent): void {
    this.writes.push({ stage: event.stageId, key: event.key });
  }

  onError(event: ErrorEvent): void {
    this.alerts.push({
      stage: event.stageId,
      error: event.error?.message ?? String(event.error),
      timestamp: event.timestamp,
    });
  }
}

// ── State ───────────────────────────────────────────────────────────────

interface TransferState {
  userId: string;
  payload: { action: string; amount: number };
  limitExceeded?: boolean;
  status?: string;
}

interface FallbackState {
  source?: string;
  data?: { cached: boolean; score: number };
  result?: string;
}

(async () => {

console.log('=== Error Handling Patterns ===\n');
console.log('--- Scenario 1: Stage throws an error ---\n');

const metrics = new MetricRecorder();
const debug = new DebugRecorder({ verbosity: 'verbose' });
const alerts = new AlertRecorder();

const chart = flowChart<TransferState>('ValidateInput', async (scope) => {
  await new Promise((r) => setTimeout(r, 15));
  scope.userId = 'user-42';
  scope.payload = { action: 'transfer', amount: 50000 };
}, 'validate-input')
  .addFunction('CheckLimits', async (scope) => {
    await new Promise((r) => setTimeout(r, 25));
    if (scope.payload.amount > 10000) {
      scope.limitExceeded = true;
      throw new Error(
        `Transfer amount $${scope.payload.amount.toLocaleString()} exceeds daily limit of $10,000`,
      );
    }
    scope.limitExceeded = false;
  }, 'check-limits')
  .addFunction('ExecuteTransfer', async (scope) => {
    scope.status = 'completed';
  }, 'execute-transfer')
  .build();

const executor = new FlowChartExecutor(chart);
executor.attachRecorder(metrics);
executor.attachRecorder(debug);
executor.attachRecorder(alerts);

try {
  await executor.run();
} catch (err: any) {
  console.log(`  Pipeline failed: ${err.message}`);
}

const m = metrics.getMetrics();
console.log(`\n  Stages that ran (${m.stageMetrics.size} of 3):`);
for (const [stage, sm] of m.stageMetrics) {
  console.log(`    ${stage}: ${sm.totalDuration}ms (${sm.writeCount} writes)`);
}

console.log(`\n  Writes before crash:`);
for (const w of alerts.writes) {
  console.log(`    ${w.stage} -> ${w.key}`);
}

// ── Scenario 2: Graceful degradation ──────────────────────────────────

console.log('\n--- Scenario 2: Graceful error inside a stage ---\n');

const chart2 = flowChart<FallbackState>('FetchPrimary', async (scope) => {
  try {
    await new Promise((r) => setTimeout(r, 30));
    throw new Error('Primary API unavailable');
  } catch {
    scope.source = 'cache';
    scope.data = { cached: true, score: 720 };
  }
}, 'fetch-primary')
  .addFunction('Process', async (scope) => {
    scope.result = `Processed from ${scope.source}: score=${scope.data!.score}`;
  }, 'process')
  .build();

const executor2 = new FlowChartExecutor(chart2);
await executor2.run();

console.log('  Pipeline completed with fallback');

})().catch(console.error);

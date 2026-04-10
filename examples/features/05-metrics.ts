/**
 * Feature: MetricRecorder — Full Observability
 *
 * MetricRecorder tracks per-stage metrics:
 * - Read/write/commit counts
 * - Stage duration (latency) via onStageStart/onStageEnd
 *
 * Run:  npm run feature:metrics
 * Try it: https://footprintjs.github.io/footprint-playground/samples/metrics
 */

import {
  flowChart,
  FlowChartExecutor,
  MetricRecorder,
  DebugRecorder,
} from 'footprintjs';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── State ──────────────────────────────────────────────────────────────

interface OrderState {
  user: { id: number; name: string; tier: string };
  price?: number;
  discount?: number;
  tax?: number;
  total?: number;
  orderId?: string;
  confirmation?: string;
}

interface ErrorState {
  apiUrl: string;
  retries: number;
  result?: string;
}

(async () => {

// ── Pipeline 1: Happy path ─────────────────────────────────────────────

console.log('=== Pipeline 1: Happy Path ===\n');

const metrics = new MetricRecorder();

const happyChart = flowChart<OrderState>('FetchUser', async (scope) => {
  await delay(60);
  scope.user = { id: 1, name: 'Alice', tier: 'premium' };
}, 'fetch-user')
  .addFunction('CallPricingAPI', async (scope) => {
    await delay(120);
    scope.price = scope.user.tier === 'premium' ? 79.99 : 99.99;
    scope.discount = scope.user.tier === 'premium' ? 20 : 0;
  }, 'call-pricing-api')
  .addFunction('CalculateTax', async (scope) => {
    await delay(10);
    scope.tax = Math.round(scope.price! * 0.08 * 100) / 100;
    scope.total = Math.round((scope.price! * 1.08) * 100) / 100;
  }, 'calculate-tax')
  .addFunction('SaveOrder', async (scope) => {
    await delay(45);
    scope.orderId = `ORD-${Date.now()}`;
    scope.confirmation = `${scope.user.name}: $${scope.total}`;
  }, 'save-order')
  .build();

const happyExecutor = new FlowChartExecutor(happyChart);
happyExecutor.attachRecorder(metrics);
await happyExecutor.run();

const happyMetrics = metrics.getMetrics();
for (const [stage, m] of happyMetrics.stageMetrics) {
  const bar = '#'.repeat(Math.max(1, Math.round(m.totalDuration / 5)));
  console.log(`  ${stage.padEnd(16)} ${bar} ${m.totalDuration}ms  (r:${m.readCount} w:${m.writeCount})`);
}
console.log(`\n  Total: ${happyMetrics.totalDuration}ms | ${happyMetrics.totalReads} reads, ${happyMetrics.totalWrites} writes`);

// ── Pipeline 2: Error path ─────────────────────────────────────────────

console.log('\n=== Pipeline 2: Error Handling ===\n');

const errorMetrics = new MetricRecorder();
const debug = new DebugRecorder({ verbosity: 'verbose' });
const silentLogger = { info() {}, log() {}, debug() {}, warn() {}, error() {} };

const errorChart = flowChart<ErrorState>('LoadConfig', async (scope) => {
  await delay(20);
  scope.apiUrl = 'https://api.example.com';
  scope.retries = 3;
}, 'load-config')
  .addFunction('CallExternalAPI', async (scope) => {
    await delay(80);
    throw new Error(`503 Service Unavailable: ${scope.apiUrl} timed out after 80ms`);
  }, 'call-external-api')
  .addFunction('ProcessResponse', async (scope) => {
    scope.result = 'processed';
  }, 'process-response')
  .build();

const errorExecutor = new FlowChartExecutor(errorChart);
errorExecutor.attachRecorder(errorMetrics);
errorExecutor.attachRecorder(debug);

try {
  await errorExecutor.run();
} catch (err: any) {
  console.log(`  Caught error: ${err.message}`);
}

const errResult = errorMetrics.getMetrics();
console.log('\n  Per-stage breakdown:');
for (const [stage, m] of errResult.stageMetrics) {
  const bar = '#'.repeat(Math.max(1, Math.round(m.totalDuration / 5)));
  console.log(`    ${stage.padEnd(18)} ${bar} ${m.totalDuration}ms  (r:${m.readCount} w:${m.writeCount})`);
}

const debugEntries = debug.getEntries();
const errorEntries = debugEntries.filter(e => e.type === 'error');
const writeEntries = debugEntries.filter(e => e.type === 'write');
console.log(`\n  DebugRecorder captured: ${writeEntries.length} writes, ${errorEntries.length} errors`);

})().catch(console.error);

/**
 * Detach — From Outside Any Chart (bare executor entry)
 *
 * The host process holds a FlowChartExecutor and wants to fire several
 * side-effect charts (analytics, audit, health check) AROUND the main
 * chart's run. No parent stage available — uses the executor's bare
 * `detachAndJoinLater` / `detachAndForget` methods.
 *
 * Run: npx tsx examples/runtime-features/detach/03-bare-executor.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { microtaskBatchDriver } from 'footprintjs/detach';

// ── Two side-effect charts: analytics + audit log ─────────────────────

const collected: string[] = [];

const analyticsChart = flowChart('ShipAnalytics', async (scope) => {
  const tag = scope.$getArgs<{ tag: string }>().tag;
  collected.push(`analytics:${tag}`);
}, 'ship-analytics').build();

const auditChart = flowChart('WriteAudit', async (scope) => {
  const tag = scope.$getArgs<{ tag: string }>().tag;
  collected.push(`audit:${tag}`);
  return tag;
}, 'write-audit').build();

// ── Trivial main chart (the executor is the unit under test here) ─────

const mainChart = flowChart('Main', async (scope) => {
  scope.$setValue('mainRan', true);
}, 'main').build();

(async () => {
  const exec = new FlowChartExecutor(mainChart);

  // Side-effect BEFORE run (forget) — discard handle.
  exec.detachAndForget(microtaskBatchDriver, analyticsChart, { tag: 'before' });

  // Side-effect WITH a handle (joinLater) — we want to await its result.
  const auditHandle = exec.detachAndJoinLater(microtaskBatchDriver, auditChart, { tag: 'mid' });

  // Now run the main chart.
  await exec.run();

  // Side-effect AFTER run (forget).
  exec.detachAndForget(microtaskBatchDriver, analyticsChart, { tag: 'after' });

  // Await the joinable side-effect.
  const auditResult = await auditHandle.wait();

  // Yield twice to let the forget detaches flush.
  await Promise.resolve();
  await Promise.resolve();

  console.log(`Collected: ${collected.sort().join(', ')}`);
  console.log(`Audit handle: status=${auditHandle.status}, result=${JSON.stringify(auditResult)}`);
  console.log(`Audit refId: ${auditHandle.id}`);

  // ── Regression guards ──
  const sorted = collected.sort();
  if (sorted.length !== 3) {
    console.error(`REGRESSION: expected 3 collected events, got ${sorted.length}.`);
    process.exit(1);
  }
  if (
    sorted[0] !== 'analytics:after' ||
    sorted[1] !== 'analytics:before' ||
    sorted[2] !== 'audit:mid'
  ) {
    console.error('REGRESSION: collected events wrong.', sorted);
    process.exit(1);
  }
  if (auditResult.result !== 'mid') {
    console.error('REGRESSION: audit result wrong.', auditResult);
    process.exit(1);
  }
  if (!auditHandle.id.startsWith('__executor__:detach:')) {
    console.error(`REGRESSION: audit refId should start with __executor__:detach:, got ${auditHandle.id}`);
    process.exit(1);
  }

  console.log('OK — bare-executor detach paths all behaved correctly.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Feature: CompositeRecorder — One-Call Observability Bundles
 *
 * A payment processing pipeline needs three kinds of observability:
 *   1. SLA monitoring — did ValidatePayment exceed 200ms?
 *   2. Compliance audit — who approved what, when?
 *   3. Debug diagnostics — what went wrong if it fails?
 *
 * Without CompositeRecorder, the consumer attaches 3 recorders manually.
 * With CompositeRecorder, the platform team ships a "paymentObservability()"
 * preset — one call, all concerns covered.
 *
 * Run:  npx tsx examples/features/18-composite-recorder.ts
 */

import {
  flowChart,
  FlowChartExecutor,
  MetricRecorder,
  DebugRecorder,
  CompositeRecorder,
  type Recorder,
  type WriteEvent,
  type StageEvent,
} from 'footprintjs';

// ── Business recorders ─────────────────────────────────────────────────

/** Compliance audit: captures who approved/rejected and why. */
class ComplianceRecorder implements Recorder {
  readonly id = 'compliance';
  private trail: Array<{ stage: string; key: string; value: unknown; timestamp: number }> = [];

  onWrite(event: WriteEvent): void {
    // Only audit business decisions — skip internal plumbing
    if (['approved', 'reason', 'riskScore', 'fraudCheck'].includes(event.key)) {
      this.trail.push({
        stage: event.stageId,
        key: event.key,
        value: event.value,
        timestamp: event.timestamp,
      });
    }
  }

  getAuditTrail() {
    return this.trail;
  }

  toSnapshot() {
    return { name: 'Compliance', data: this.trail };
  }

  clear() {
    this.trail = [];
  }
}

/** SLA monitor: flags stages that exceed a threshold. */
class SLARecorder implements Recorder {
  readonly id = 'sla';
  private starts = new Map<string, number>();
  private violations: Array<{ stage: string; durationMs: number; thresholdMs: number }> = [];

  constructor(private thresholdMs: number = 200) {}

  onStageStart(event: StageEvent): void {
    this.starts.set(event.runtimeStageId, event.timestamp);
  }

  onStageEnd(event: StageEvent): void {
    const start = this.starts.get(event.runtimeStageId);
    if (start === undefined) return;
    const duration = event.timestamp - start;
    if (duration > this.thresholdMs) {
      this.violations.push({
        stage: event.stageId,
        durationMs: Math.round(duration),
        thresholdMs: this.thresholdMs,
      });
    }
    this.starts.delete(event.runtimeStageId);
  }

  getViolations() {
    return this.violations;
  }

  toSnapshot() {
    return { name: 'SLA', data: this.violations };
  }

  clear() {
    this.violations = [];
    this.starts.clear();
  }
}

// ── Domain preset ──────────────────────────────────────────────────────

/**
 * paymentObservability() — one-call preset for the payments team.
 *
 * Bundles SLA monitoring, compliance audit, stage metrics, and debug
 * into a single CompositeRecorder. The consumer never needs to know
 * which individual recorders are inside.
 */
function paymentObservability(options?: { slaThresholdMs?: number }) {
  return new CompositeRecorder('payment-observability', [
    new MetricRecorder('metrics'),           // timing per stage
    new SLARecorder(options?.slaThresholdMs ?? 200),  // SLA violations
    new ComplianceRecorder(),                 // audit trail
    new DebugRecorder({ verbosity: 'minimal' }), // errors only
  ]);
}

// ── Payment pipeline ───────────────────────────────────────────────────

interface PaymentState {
  merchantId: string;
  amount: number;
  currency: string;
  fraudCheck?: string;
  riskScore?: number;
  approved?: boolean;
  reason?: string;
}

(async () => {
  const chart = flowChart<PaymentState>(
    'ReceivePayment',
    async (scope) => {
      scope.merchantId = 'merchant-42';
      scope.amount = 2500;
      scope.currency = 'USD';
    },
    'receive',
    undefined,
    'Accept incoming payment request',
  )
    .addFunction(
      'FraudCheck',
      async (scope) => {
        // Simulate a slow fraud check (250ms > 200ms SLA threshold)
        await new Promise((r) => setTimeout(r, 250));
        scope.fraudCheck = scope.amount > 5000 ? 'flagged' : 'clear';
        scope.riskScore = scope.amount > 5000 ? 0.85 : 0.12;
      },
      'fraud-check',
      'Run fraud detection model',
    )
    .addFunction(
      'Approve',
      async (scope) => {
        scope.approved = scope.fraudCheck === 'clear';
        scope.reason = scope.approved
          ? `Approved: $${scope.amount} ${scope.currency} for ${scope.merchantId}`
          : `Rejected: fraud score ${scope.riskScore}`;
      },
      'approve',
      'Make approval decision',
    )
    .build();

  // ── One call — full observability ──────────────────────────────────

  const obs = paymentObservability({ slaThresholdMs: 200 });
  const executor = new FlowChartExecutor(chart, { enrichSnapshots: true });
  executor.attachRecorder(obs);
  await executor.run();

  // ── Extract results from child recorders by type ───────────────────

  const metrics = obs.get(MetricRecorder)!;
  const sla = obs.get(SLARecorder)!;
  const compliance = obs.get(ComplianceRecorder)!;

  console.log('=== Payment Processing — CompositeRecorder Demo ===\n');

  // 1. Stage timing (MetricRecorder)
  console.log('Stage Timing:');
  const allMetrics = metrics.getMetrics();
  for (const [name, stage] of allMetrics.stageMetrics) {
    console.log(`  ${name}: ${Math.round(stage.totalDuration)}ms (${stage.writeCount} writes)`);
  }
  console.log(`  Total: ${Math.round(allMetrics.totalDuration)}ms\n`);

  // 2. SLA violations (SLARecorder)
  const violations = sla.getViolations();
  if (violations.length > 0) {
    console.log('SLA Violations:');
    for (const v of violations) {
      console.log(`  ${v.stage}: ${v.durationMs}ms (threshold: ${v.thresholdMs}ms)`);
    }
  } else {
    console.log('SLA Violations: none');
  }
  console.log();

  // 3. Compliance audit trail (ComplianceRecorder)
  console.log('Compliance Audit Trail:');
  for (const entry of compliance.getAuditTrail()) {
    console.log(`  [${entry.stage}] ${entry.key} = ${JSON.stringify(entry.value)}`);
  }
  console.log();

  // 4. Snapshot includes all child data
  const snapshot = obs.toSnapshot();
  console.log('Composite Snapshot:');
  console.log(`  Children: ${snapshot.data.children.map((c) => c.name).join(', ')}`);
  console.log(`  (Metrics + SLA + Compliance + Debug — all in one snapshot)`);
})().catch(console.error);

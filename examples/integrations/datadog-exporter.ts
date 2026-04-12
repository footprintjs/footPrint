/**
 * Integration: Datadog Exporter (Sample FlowRecorder)
 *
 * Shows how to export flowchart execution events to Datadog using
 * TraversalContext. This is a SAMPLE — no real Datadog SDK dependency.
 * Replace the mock functions with actual dd-trace/dogstatsd calls.
 *
 * Run:  npm run int:datadog
 */

import {
  flowChart,
  FlowChartExecutor,
  type FlowRecorder,
  type FlowStageEvent,
  type FlowDecisionEvent,
  type FlowErrorEvent,
  type FlowSubflowEvent,
  type FlowLoopEvent,
} from 'footprintjs';

// ── Mock Datadog SDK (replace with real dd-trace in production) ─────────

const dd = {
  tracer: {
    startSpan(name: string, opts?: { childOf?: string; tags?: Record<string, string> }) {
      const spanId = `span-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      console.log(`  [dd] startSpan: ${name} (parent: ${opts?.childOf ?? 'root'})`);
      if (opts?.tags) {
        for (const [k, v] of Object.entries(opts.tags)) {
          console.log(`        tag: ${k} = ${v}`);
        }
      }
      return {
        spanId,
        finish() {
          console.log(`  [dd] finishSpan: ${name}`);
        },
        setTag(key: string, value: string) {
          console.log(`  [dd] setTag: ${key} = ${value}`);
        },
      };
    },
  },
  dogstatsd: {
    increment(metric: string, tags?: string[]) {
      console.log(`  [dd] increment: ${metric} ${tags ? `[${tags.join(', ')}]` : ''}`);
    },
    gauge(metric: string, value: number, tags?: string[]) {
      console.log(`  [dd] gauge: ${metric} = ${value} ${tags ? `[${tags.join(', ')}]` : ''}`);
    },
  },
};

// ── Datadog FlowRecorder ────────────────────────────────────────────────

class DatadogFlowRecorder implements FlowRecorder {
  readonly id = 'datadog-exporter';

  private spans = new Map<string, ReturnType<typeof dd.tracer.startSpan>>();
  private prefix: string;

  constructor(metricPrefix = 'flowchart') {
    this.prefix = metricPrefix;
  }

  onStageExecuted(event: FlowStageEvent): void {
    const ctx = event.traversalContext;
    const span = dd.tracer.startSpan(`${this.prefix}.stage`, {
      childOf: ctx?.parentStageId,
      tags: {
        'stage.name': event.stageName,
        'stage.id': ctx?.stageId ?? 'unknown',
        'subflow.id': ctx?.subflowId ?? 'root',
        'subflow.depth': String(ctx?.depth ?? 0),
      },
    });

    if (ctx?.stageId) {
      this.spans.set(ctx.stageId, span);
    }

    dd.dogstatsd.increment(`${this.prefix}.stage.executed`, [
      `stage:${event.stageName}`,
      `subflow:${ctx?.subflowId ?? 'root'}`,
    ]);

    // Auto-close the span (in real usage, close on next event or stage end)
    span.finish();
  }

  onDecision(event: FlowDecisionEvent): void {
    dd.dogstatsd.increment(`${this.prefix}.decision`, [
      `decider:${event.decider}`,
      `branch:${event.chosen}`,
    ]);
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    const ctx = event.traversalContext;
    dd.tracer.startSpan(`${this.prefix}.subflow`, {
      tags: {
        'subflow.name': event.name,
        'subflow.id': event.subflowId ?? 'unknown',
        'subflow.depth': String(ctx?.depth ?? 0),
      },
    });
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    dd.dogstatsd.increment(`${this.prefix}.subflow.completed`, [
      `subflow:${event.subflowId ?? event.name}`,
    ]);
  }

  onLoop(event: FlowLoopEvent): void {
    dd.dogstatsd.gauge(`${this.prefix}.loop.iteration`, event.iteration, [
      `target:${event.target}`,
    ]);
  }

  onError(event: FlowErrorEvent): void {
    dd.dogstatsd.increment(`${this.prefix}.error`, [
      `stage:${event.stageName}`,
    ]);

    const span = event.traversalContext?.stageId
      ? this.spans.get(event.traversalContext.stageId)
      : undefined;
    if (span) {
      span.setTag('error', 'true');
      span.setTag('error.message', event.message);
    }
  }

  clear(): void {
    this.spans.clear();
  }
}

// ── State types ─────────────────────────────────────────────────────────

interface PaymentState {
  paymentValid: boolean;
  charged: boolean;
}

interface OrderState {
  orderId: string;
  approved: boolean;
  flagged: boolean;
  confirmed: boolean;
}

// ── Demo flowchart ──────────────────────────────────────────────────────

const subChart = flowChart<PaymentState>('ValidatePayment', (scope) => {
  scope.paymentValid = true;
}, 'validate-payment', undefined, 'Validates payment details')
  .addFunction('ChargeCard', (scope) => {
    scope.charged = true;
  }, 'charge-card', 'Charges the credit card')
  .build();

const chart = flowChart<OrderState>('ReceiveOrder', (scope) => {
  scope.orderId = 'ORD-12345';
}, 'receive-order', undefined, 'Receives incoming order')
  .addDeciderFunction('RiskCheck', (scope) => {
    return scope.orderId ? 'low' : 'high';
  }, 'risk-check', 'Evaluates order risk')
    .addFunctionBranch('low', 'Approve', (scope) => {
      scope.approved = true;
    })
    .addFunctionBranch('high', 'ManualReview', (scope) => {
      scope.flagged = true;
    })
    .setDefault('high')
    .end()
  .addSubFlowChartNext('sf-payment', subChart, 'PaymentSubflow')
  .addFunction('Confirm', (scope) => {
    scope.confirmed = true;
  }, 'confirm', 'Sends confirmation')

  .build();

// ── Run ─────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== Datadog Exporter Sample ===\n');

  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(new DatadogFlowRecorder('order-pipeline'));
  await executor.run();

  console.log('\n--- Execution complete ---');
  console.log('Narrative:', executor.getNarrative().join('\n  '));
})().catch(console.error);

/**
 * Integration: Elastic APM Exporter (Sample FlowRecorder)
 *
 * Shows how to export flowchart execution as Elastic APM transactions
 * and spans using TraversalContext. This is a SAMPLE — no real
 * elastic-apm-node dependency. Replace mocks with the real agent.
 *
 * Key mapping:
 *   Root flow         → APM Transaction
 *   Each stage        → APM Span (child of transaction)
 *   Each subflow      → Nested APM Span (parent-child via traversalContext)
 *   Errors            → apm.captureError()
 *
 * Run:  npm run int:elastic
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

// ── Mock Elastic APM Agent (replace with elastic-apm-node) ──────────────

interface MockTransaction {
  name: string;
  type: string;
  labels: Record<string, string | number>;
  spans: MockAPMSpan[];
  result: string;
}

interface MockAPMSpan {
  name: string;
  type: string;
  subtype?: string;
  labels: Record<string, string | number>;
}

const mockApm = {
  transactions: [] as MockTransaction[],
  currentTransaction: null as MockTransaction | null,

  startTransaction(name: string, type: string): MockTransaction {
    const txn: MockTransaction = { name, type, labels: {}, spans: [], result: 'success' };
    this.transactions.push(txn);
    this.currentTransaction = txn;
    return txn;
  },

  startSpan(name: string, type: string, subtype?: string): MockAPMSpan {
    const span: MockAPMSpan = { name, type, subtype, labels: {} };
    this.currentTransaction?.spans.push(span);
    return span;
  },

  captureError(error: { message: string; [key: string]: unknown }) {
    console.log(`  [apm] captureError: ${error.message}`);
  },

  setLabel(obj: { labels: Record<string, string | number> }, key: string, value: string | number) {
    obj.labels[key] = value;
  },
};

// ── Elastic APM FlowRecorder ────────────────────────────────────────────

class ElasticAPMFlowRecorder implements FlowRecorder {
  readonly id = 'elastic-apm-exporter';

  private transactionName: string;

  constructor(transactionName = 'flowchart-execution') {
    this.transactionName = transactionName;
  }

  onStageExecuted(event: FlowStageEvent): void {
    const ctx = event.traversalContext;

    // Start transaction on first root stage
    if (!mockApm.currentTransaction && (ctx?.depth ?? 0) === 0) {
      const txn = mockApm.startTransaction(this.transactionName, 'flowchart');
      mockApm.setLabel(txn, 'flowchart.root', event.stageName);
    }

    const subtype = ctx?.subflowId ? 'subflow-stage' : 'stage';
    const span = mockApm.startSpan(event.stageName, 'flowchart', subtype);

    mockApm.setLabel(span, 'stage.id', ctx?.stageId ?? 'unknown');
    mockApm.setLabel(span, 'depth', ctx?.depth ?? 0);

    if (ctx?.subflowId) {
      mockApm.setLabel(span, 'subflow.id', ctx.subflowId);
    }
    if (ctx?.subflowPath) {
      mockApm.setLabel(span, 'subflow.path', ctx.subflowPath);
    }
    if (event.description) {
      mockApm.setLabel(span, 'description', event.description);
    }
  }

  onDecision(event: FlowDecisionEvent): void {
    const span = mockApm.startSpan(`decision:${event.decider}`, 'flowchart', 'decision');
    mockApm.setLabel(span, 'branch', event.chosen);
    if (event.rationale) {
      mockApm.setLabel(span, 'rationale', event.rationale);
    }
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    const ctx = event.traversalContext;
    const span = mockApm.startSpan(`subflow:${event.name}`, 'flowchart', 'subflow');
    mockApm.setLabel(span, 'subflow.id', event.subflowId ?? event.name);
    mockApm.setLabel(span, 'depth', ctx?.depth ?? 0);
  }

  onLoop(event: FlowLoopEvent): void {
    const span = mockApm.startSpan(`loop:${event.target}`, 'flowchart', 'loop');
    mockApm.setLabel(span, 'iteration', event.iteration);
  }

  onError(event: FlowErrorEvent): void {
    mockApm.captureError({
      message: event.message,
      stage: event.stageName,
      stageId: event.traversalContext?.stageId,
      subflowId: event.traversalContext?.subflowId,
    });

    if (mockApm.currentTransaction) {
      mockApm.currentTransaction.result = 'error';
    }
  }

  clear(): void {
    // In production, reset is handled by the APM agent lifecycle.
    // For the mock, reset module-level state so re-runs start fresh.
    mockApm.currentTransaction = null;
    mockApm.transactions = [];
  }

  /** For demo — print collected transactions. */
  printResults(): void {
    for (const txn of mockApm.transactions) {
      console.log(`\n  Transaction: ${txn.name} (${txn.type}) → ${txn.result}`);
      const txnLabels = Object.entries(txn.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      if (txnLabels) console.log(`    labels: ${txnLabels}`);

      console.log(`    ${txn.spans.length} spans:`);
      for (const span of txn.spans) {
        const labels = Object.entries(span.labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        console.log(`      - ${span.name} [${span.type}${span.subtype ? '/' + span.subtype : ''}]`);
        if (labels) console.log(`        ${labels}`);
      }
    }
  }
}

// ── State types ─────────────────────────────────────────────────────────

interface ValidationState {
  formatOk: boolean;
  rulesOk: boolean;
}

interface RequestState {
  requestId: string;
  processed: boolean;
  rejected: boolean;
  responded: boolean;
}

// ── Demo flowchart ──────────────────────────────────────────────────────

const validationFlow = flowChart<ValidationState>('CheckFormat', (scope) => {
  scope.formatOk = true;
}, 'check-format', undefined, 'Validates input format')
  .addFunction('CheckRules', (scope) => {
    scope.rulesOk = true;
  }, 'check-rules', 'Applies business rules')
  .build();

const chart = flowChart<RequestState>('Receive', (scope) => {
  scope.requestId = 'REQ-001';
}, 'receive', undefined, 'Receives incoming request')
  .addSubFlowChartNext('sf-validate', validationFlow, 'Validation')
  .addDeciderFunction('Route', (scope) => {
    return scope.requestId ? 'process' : 'reject';
  }, 'route', 'Routes based on validation result')
    .addFunctionBranch('process', 'Process', (scope) => {
      scope.processed = true;
    })
    .addFunctionBranch('reject', 'Reject', (scope) => {
      scope.rejected = true;
    })
    .setDefault('reject')
    .end()
  .addFunction('Respond', (scope) => {
    scope.responded = true;
  }, 'respond', 'Sends response')

  .build();

// ── Run ─────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== Elastic APM Exporter Sample ===\n');

  const apm = new ElasticAPMFlowRecorder('request-pipeline');
  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(apm);
  await executor.run();

  apm.printResults();

  console.log('\n--- Narrative ---');
  executor.getNarrativeEntries().map(e => e.text).forEach(line => console.log(`  ${line}`));
})().catch(console.error);

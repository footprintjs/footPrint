/**
 * Feature: Subflow PII Boundary
 *
 * Demonstrates that redaction carries across subflow boundaries automatically.
 *
 * Pattern: the payment subflow marks `cardNumber` as redacted using a per-call
 * flag (no executor-level policy needed). When `outputMapper` transfers the value
 * to the parent scope — without any explicit shouldRedact flag — the parent's
 * narrative still shows [REDACTED].
 *
 * How it works:
 *   - Parent and subflow share the same `_redactedKeys` Set (via the same ScopeFactory).
 *   - Once `cardNumber` is in that set, every subsequent `setValue('cardNumber', ...)`
 *     fires as redacted — including the implicit write from `outputMapper`.
 *   - Runtime business logic always receives the real value.
 *
 * Run:  npm run feature:subflow-redaction
 */

import { flowChart, FlowChartBuilder, FlowChartExecutor } from 'footprintjs';
import type { TypedScope } from 'footprintjs';

// ── Types ──────────────────────────────────────────────────────────────────

interface PaymentSubflowState {
  cardNumber: string;  // written with per-call redaction — never appears in narrative
  charged: boolean;
  transactionId: string;
}

interface CheckoutState {
  orderId: string;
  total: number;
  cardLast4: string;   // last 4 digits — safe to show in narrative
  cardNumber: string;  // full number — redacted after subflow marks it
  charged: boolean;
  transactionId: string;
  status: string;
}

// ── Subflow ────────────────────────────────────────────────────────────────
// The payment subflow owns the PII boundary.
// It receives a raw card number as an input arg and immediately marks it redacted.

const paymentSubflow = new FlowChartBuilder<any, TypedScope<PaymentSubflowState>>()
  .start(
    'CaptureCard',
    async (scope) => {
      // rawCard comes in as a readonly input arg (from inputMapper).
      // We write it to cardNumber — a mutable scope key — with per-call redaction.
      // This marks 'cardNumber' in the shared _redactedKeys set for the entire run.
      const { rawCard } = scope.$getArgs<{ rawCard: string }>();
      scope.$setValue('cardNumber', rawCard, true);
    },
    'capture-card',
    'Capture and redact the full card number',
  )
  .addFunction(
    'ChargeCard',
    async (scope) => {
      // Business logic works on the real value — scope.cardNumber is the actual number.
      // Only recorders (narrative, debug, metrics) see [REDACTED].
      const valid = scope.cardNumber.startsWith('4');
      scope.charged = valid;
      scope.transactionId = valid ? `TXN-${Date.now()}` : 'TXN-DECLINED';
    },
    'charge-card',
    'Charge the customer card',
  )
  .build();

// ── Parent Chart ───────────────────────────────────────────────────────────

const chart = flowChart<CheckoutState>(
  'CreateOrder',
  async (scope) => {
    scope.orderId = 'ORD-100';
    scope.total = 149.99;
    scope.cardLast4 = '1111';
    scope.status = 'pending';
  },
  'create-order',
  undefined,
  'Initialize the checkout order',
)
  .addSubFlowChartNext('payment', paymentSubflow, 'ProcessPayment', {
    inputMapper: (parentScope: any) => ({
      // rawCard is the input key — becomes readonly inside the subflow
      rawCard: '4111-1111-1111-1111',
      // In a real app this would come from a secure tokenization service,
      // not the parent scope directly.
    }),
    outputMapper: (subflowOutput: any) => ({
      // cardNumber was marked redacted in the subflow.
      // The parent writes it WITHOUT a shouldRedact flag — the shared _redactedKeys
      // set ensures the onWrite event still fires as redacted. No flag needed here.
      cardNumber: subflowOutput.cardNumber,
      charged: subflowOutput.charged,
      transactionId: subflowOutput.transactionId,
    }),
  })
  .addFunction(
    'ConfirmOrder',
    async (scope) => {
      scope.status = scope.charged ? 'confirmed' : 'payment-failed';
    },
    'confirm-order',
    'Finalize order status',
  )
  .build();

// ── Run ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== Subflow PII Boundary ===\n');
  console.log('The payment subflow marks cardNumber redacted per-call.');
  console.log('outputMapper transfers it to the parent — no explicit flag needed.\n');

  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log('Narrative (cardNumber auto-redacted throughout):');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));

  const report = executor.getRedactionReport();
  console.log(`\nRedaction report — keys redacted: [${report.redactedKeys.join(', ')}]`);

  const snapshot = executor.getSnapshot();
  const state = snapshot.sharedState as unknown as CheckoutState;
  console.log(`\nFinal state:`);
  console.log(`  orderId:       ${state.orderId}`);
  console.log(`  charged:       ${state.charged}`);
  console.log(`  transactionId: ${state.transactionId}`);
  console.log(`  status:        ${state.status}`);
  console.log(`  cardNumber:    (runtime value available — [REDACTED] only in recorders)`);

  console.log(
    '\nKey insight: once a key is marked redacted anywhere in a pipeline,',
  );
  console.log('all writes to that key — including via outputMapper — are redacted.');
  console.log('No per-call flags needed on the parent side.');
})().catch(console.error);

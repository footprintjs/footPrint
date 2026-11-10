/**
 * Feature: Subflow PII Boundary
 *
 * Demonstrates redaction across a subflow boundary.
 *
 * Two selectors work together:
 *   - A policy (`setRedactionPolicy({ keys: ['rawCard'] })`) names the input
 *     arg the subflow receives. The subflow's `Input:` line shows it as
 *     [REDACTED]. A per-call flag cannot cover it: the subflow never writes it.
 *   - The subflow writes `cardNumber` with the per-call flag
 *     (`$setValue('cardNumber', value, true)`). That marks the NAME `cardNumber`
 *     for the rest of the run, so the parent's copy (written by `outputMapper`
 *     with no flag) is served as redacted too, e.g. by `getSnapshot({ redact: true })`.
 *
 * The rule lives in one place (`RedactionRule`): a mark is a name, run-wide,
 * across parent and subflow. Recorders, narrative and served snapshots see the
 * placeholder; runtime business logic always receives the real value.
 *
 * Run:  npx tsx examples/runtime-features/redaction/02-subflow.ts
 */

import { flowChart, FlowChartBuilder, FlowChartExecutor } from 'footprintjs';
import type { TypedScope } from 'footprintjs';

// ── Types ──────────────────────────────────────────────────────────────────

interface PaymentSubflowState {
  cardNumber: string;  // written with per-call redaction — never appears in the narrative
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
      // rawCard comes in as a readonly input arg (from inputMapper); the policy redacts it.
      // We write it to cardNumber — a mutable scope key — with per-call redaction.
      // This marks the name 'cardNumber' for the rest of the run.
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
  { description: 'Initialize the checkout order' },
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
      // The parent writes it WITHOUT a per-call flag — the run-wide mark on the
      // name still applies. No flag needed here.
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
  console.log('The policy redacts the rawCard input; the subflow marks cardNumber per-call.');
  console.log('outputMapper transfers cardNumber to the parent — no explicit flag needed.\n');

  const executor = new FlowChartExecutor(chart);
  executor.setRedactionPolicy({ keys: ['rawCard'] });
  executor.enableNarrative();
  await executor.run();

  console.log('Narrative (rawCard and cardNumber redacted throughout):');
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
  console.log(`  cardNumber:    ${state.cardNumber === '4111-1111-1111-1111' ? '(live state holds the real value)' : state.cardNumber}`);

  const served = executor.getSnapshot({ redact: true }).sharedState as unknown as CheckoutState;
  console.log(`\nServed snapshot (redact: true) — cardNumber: ${served.cardNumber}`);

  console.log(
    '\nKey insight: once a key is marked redacted anywhere in a pipeline,',
  );
  console.log('the parent copy written by outputMapper is served as redacted too.');
  console.log('No per-call flags needed on the parent side.');
})().catch(console.error);

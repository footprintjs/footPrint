/**
 * Security test: subflow PII boundary — redaction carries across outputMapper.
 *
 * Verifies:
 *   1. A key marked redacted per-call inside a subflow stage does NOT appear
 *      as raw PII in the parent pipeline's narrative after outputMapper.
 *   2. The fix in ScopeFacade.setValue (_redactedKeys.has check) is exercised
 *      through the real FlowChartExecutor + subflow path.
 *   3. Runtime business logic still receives the real value.
 *   4. Other (non-redacted) keys transferred via outputMapper are visible.
 */

import type { TypedScope } from '../../../../src/index';
import { flowChart, FlowChartBuilder, FlowChartExecutor } from '../../../../src/index';

const RAW_CARD = '4111-1111-1111-1111';

interface SubflowState {
  // rawCard comes in as readonly input (from inputMapper) — never written to scope
  cardNumber: string; // written to scope with per-call redaction, NOT an input key
  charged: boolean;
  transactionId: string;
}

interface ParentState {
  orderId: string;
  total: number;
  cardNumber: string;
  charged: boolean;
  transactionId: string;
  status: string;
}

function buildSubflow() {
  return new FlowChartBuilder<any, TypedScope<SubflowState>>()
    .start(
      'ValidateCard',
      async (scope) => {
        // rawCard is the readonly input key (from inputMapper) — different name from scope key.
        // We write cardNumber (a new scope key) with per-call redaction.
        // This is the key scenario: cardNumber is NOT in any executor policy —
        // only in _redactedKeys dynamically. The fix ensures parent writes also redact.
        const { rawCard } = scope.$getArgs<{ rawCard: string }>();
        scope.$setValue('cardNumber', rawCard, true);
      },
      'validate-card',
    )
    .addFunction(
      'ChargeCard',
      async (scope) => {
        // Runtime gets the real (unredacted) value — business logic works normally
        const ok = (scope.cardNumber as string).startsWith('4');
        scope.charged = ok;
        scope.transactionId = ok ? 'TXN-SAFE' : 'TXN-NONE';
      },
      'charge-card',
    )
    .build();
}

function buildParentChart(subflow: ReturnType<typeof buildSubflow>) {
  return flowChart<ParentState>(
    'CreateOrder',
    async (scope) => {
      scope.orderId = 'ORD-1';
      scope.total = 99.99;
      scope.status = 'pending';
    },
    'create-order',
  )
    .addSubFlowChartNext('payment', subflow, 'ProcessPayment', {
      inputMapper: (_parentScope: any) => ({
        rawCard: RAW_CARD, // readonly input key — different from the scope key 'cardNumber'
      }),
      outputMapper: (subflowOutput: any) => ({
        // outputMapper writes cardNumber to parent WITHOUT shouldRedact.
        // Before the fix: parent onWrite event fired unredacted.
        // After the fix: _redactedKeys.has('cardNumber') is true → fires redacted.
        cardNumber: subflowOutput.cardNumber,
        charged: subflowOutput.charged,
        transactionId: subflowOutput.transactionId,
      }),
    })
    .addFunction(
      'ConfirmOrder',
      async (scope) => {
        scope.status = scope.charged ? 'confirmed' : 'failed';
      },
      'confirm-order',
    )
    .build();
}

describe('Security: subflow PII boundary — redaction via outputMapper', () => {
  it('raw card number never appears in parent narrative after subflow outputMapper', async () => {
    const executor = new FlowChartExecutor(buildParentChart(buildSubflow()));
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative().join('\n');
    expect(narrative).not.toContain(RAW_CARD);
    expect(narrative).toContain('[REDACTED]');
  });

  it('runtime receives real card value — business logic is unaffected by redaction', async () => {
    const executor = new FlowChartExecutor(buildParentChart(buildSubflow()));
    executor.enableNarrative();
    await executor.run();

    // charged=true proves ChargeCard read the real cardNumber (starts with '4')
    const snapshot = executor.getSnapshot();
    expect((snapshot.sharedState as any).charged).toBe(true);
    expect((snapshot.sharedState as any).transactionId).toBe('TXN-SAFE');
  });

  it('non-redacted outputMapper keys remain visible in narrative', async () => {
    const executor = new FlowChartExecutor(buildParentChart(buildSubflow()));
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative().join('\n');
    // transactionId is not redacted — should appear in narrative
    expect(narrative).toContain('TXN-SAFE');
    // status is not redacted
    expect(narrative).toContain('confirmed');
  });

  it('redaction report lists cardNumber as redacted', async () => {
    const executor = new FlowChartExecutor(buildParentChart(buildSubflow()));
    executor.enableNarrative();
    await executor.run();

    const report = executor.getRedactionReport();
    expect(report.redactedKeys).toContain('cardNumber');
  });
});

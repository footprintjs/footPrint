/**
 * retry — side effects and idempotency: `.touches()`, the key, `effect`, `UnknownEffectError`
 *
 * ## Why this exists
 *
 * Retrying a read is free. Retrying a CHARGE is a double charge — unless the
 * payment system can tell a retry from a new request. It can, by an
 * idempotency key: the same key twice is one operation. And a charge that
 * TIMED OUT is the worst case of all: nobody knows whether it went through,
 * so "it failed, try again" is exactly the wrong conclusion.
 *
 * So a stage that changes an outside system says so: `.touches('payments',
 * { idempotencyKey })`. Then:
 *
 *   1. The builder refuses a touching stage that may retry without a key rule —
 *      a double charge cannot be written by accident.
 *   2. The key rule runs ONCE per execution; every attempt gets the same key
 *      (`scope.$attempt().idempotencyKey`) to send.
 *   3. Every attempt record says what it did there: `effect: 'applied'`,
 *      `'none'` (the adapter's error says nothing was sent), or `'unknown'`.
 *   4. When the LAST attempt's effect is unknown, the run fails with
 *      `UnknownEffectError` — reconcile by the key, never retry blindly.
 *
 * Run: npx tsx examples/runtime-features/retry/04-side-effects-and-idempotency.ts
 */

import { type AttemptRecord, flowChart, FlowChartExecutor, type TypedScope, UnknownEffectError } from 'footprintjs';

/**
 * A local "payments service" that honours idempotency keys: the same key twice
 * returns the first charge. `slowCalls` requests are applied but answered too
 * late — the caller times out on a charge that DID happen.
 */
function paymentsService(slowCalls: number) {
  const charges = new Map<string, { id: string; amount: number }>();
  let calls = 0;
  return {
    charges,
    charge(key: string, amount: number, signal: AbortSignal): Promise<{ id: string; amount: number }> {
      calls += 1;
      if (amount <= 0) {
        // Refused before anything was applied — the adapter says so.
        return Promise.reject(Object.assign(new Error('invalid amount'), { effect: 'none' }));
      }
      const charge = charges.get(key) ?? { id: `ch_${charges.size + 1}`, amount };
      charges.set(key, charge);
      if (calls <= slowCalls) {
        // Applied — but the answer never arrives before the caller gives up.
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      }
      return Promise.resolve(charge);
    },
    lookup: (key: string) => charges.get(key),
  };
}

interface Order {
  chargeId?: string;
  [key: string]: unknown;
}

function chartFor(payments: ReturnType<typeof paymentsService>, keysSeen: string[]) {
  return flowChart<Order>('Load order', () => undefined, 'load')
    .addFunction(
      'Charge card',
      async (scope: TypedScope<Order>) => {
        const { idempotencyKey, signal } = scope.$attempt();
        keysSeen.push(idempotencyKey as string);
        const { amount } = scope.$getArgs<{ orderId: string; amount: number }>();
        const charge = await payments.charge(idempotencyKey as string, amount, signal);
        scope.chargeId = charge.id;
      },
      'charge',
    )
    .touches('payments', { idempotencyKey: ({ args }) => `order-${(args as { orderId: string }).orderId}` })
    .retry({ attempts: 2, timeoutMs: 30 })
    .build();
}

function chargeAttempts(executor: FlowChartExecutor): readonly AttemptRecord[] {
  return executor.getSnapshot().executionTree.next?.attempts ?? [];
}

async function main() {
  // Part 1 — the build law: a retried touch without a key is refused.
  let refusal = '';
  try {
    flowChart<Order>('Charge card', () => undefined, 'charge').touches('payments').retry({ attempts: 3 });
  } catch (error) {
    refusal = (error as Error).message;
  }
  console.log(`Refused at build:\n  ${refusal.split(' — ')[0]}`);

  // Part 2 — the first attempt is applied but times out; the retry sends the SAME key and gets the same charge.
  const recovering = paymentsService(1);
  const keys: string[] = [];
  const executor = new FlowChartExecutor(chartFor(recovering, keys));
  executor.enableNarrative();
  await executor.run({ input: { orderId: '77', amount: 40 } });
  console.log('\nA timeout, then a safe retry under one key:');
  for (const line of executor.getNarrativeEntries().filter((e) => e.type === 'attempt')) console.log(`  ${line.text}`);
  const records = chargeAttempts(executor);
  console.log(`  keys sent: ${keys.join(', ')} → charges in the system: ${recovering.charges.size}`);

  // Part 3 — every attempt times out: the effect is unknown, so the run says so — and the caller reconciles.
  const stuck = paymentsService(Infinity);
  const stuckKeys: string[] = [];
  const failing = new FlowChartExecutor(chartFor(stuck, stuckKeys));
  failing.enableNarrative();
  const rejection = await failing.run({ input: { orderId: '78', amount: 40 } }).catch((error: unknown) => error);
  console.log('\nEvery attempt timed out:');
  for (const line of failing.getNarrativeEntries().filter((e) => e.type === 'attempt')) console.log(`  ${line.text}`);
  const unknown = rejection as UnknownEffectError;
  const found = unknown instanceof UnknownEffectError ? stuck.lookup(unknown.idempotencyKey as string) : undefined;
  console.log(`  run() rejected with ${unknown.name}; reconcile by key ${unknown.idempotencyKey} → ${found?.id}`);

  // Part 4 — the adapter declares nothing was sent (`effect: 'none'`): the stage keeps its own error.
  const declined = new FlowChartExecutor(chartFor(paymentsService(0), []));
  const declinedError = await declined.run({ input: { orderId: '79', amount: 0 } }).catch((error: unknown) => error);
  console.log(`\nA refusal the adapter marked effect none: ${(declinedError as Error).message}`);

  // ── Assertions (the example is also a test) ──
  if (!/touches "payments"/.test(refusal) || !/idempotencyKey/.test(refusal)) throw new Error('build law missing');
  if (keys.join() !== 'order-77,order-77') throw new Error('one key per execution, sent by every attempt');
  if (records.map((r) => `${r.outcome}:${r.effect}`).join() !== 'timeout:unknown,ok:applied') {
    throw new Error('each attempt must say what it did');
  }
  if (recovering.charges.size !== 1) throw new Error('a retry under the same key must not charge twice');
  if (!(rejection instanceof UnknownEffectError) || rejection.idempotencyKey !== 'order-78' || !found) {
    throw new Error('an unknown last effect must fail with UnknownEffectError, reconcilable by its key');
  }
  if (chargeAttempts(failing).some((r) => r.effect !== 'unknown')) throw new Error('a timeout is never applied');
  if (declinedError instanceof UnknownEffectError || (declinedError as Error).message !== 'invalid amount') {
    throw new Error("the adapter's effect: 'none' keeps the stage's own error");
  }
  console.log('\n  ✓ no blind retry: refused without a key, unknown effects reconciled by the key');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

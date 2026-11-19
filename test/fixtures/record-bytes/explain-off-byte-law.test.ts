import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor, stringifySnapshot } from '../../../src/index.js';
import { _resetRunIdStateForTesting } from '../../../src/lib/runner/runId.js';
import { fileSink } from '../../../src/sinks.js';

// Independent proof captured at a6a1fdf3cfab2725855f4f565104ada721d19200.
// Clock and run IDs are fixed at production. No fields are projected out.
const BASELINE = {
  raw: 'c605bad1757e80b005678105a932f6af236870cc30eecb9b236378d064060c42',
  redacted: 'db3810a01764697462bfa9ffdade773cf722af26aa65624b512a508c2c236eca',
  sink: 'd79b591a4dbb6fcdbf9ae090d09e9fe1403908647ab1f715992f31503060dee5',
};

type Parent = { amount: number; txnId: string; receipt?: string; shipped?: boolean };
type Child = { chargedAmount: number; txnId?: string };

function paymentChart() {
  const payment = flowChart<Child>(
    'Charge',
    (s) => {
      s.txnId = `TXN-${s.chargedAmount}`;
    },
    'charge',
  ).build();
  return flowChart<Parent>(
    'Seed',
    (s) => {
      s.amount = 99;
      s.txnId = 'UNRELATED-PARENT-VALUE';
    },
    'seed',
  )
    .addSubFlowChartNext('payment', payment, 'Payment', {
      inputMapper: (p) => ({ chargedAmount: p.amount }),
      outputMapper: (c: Child) => ({ receipt: c.txnId }),
    })
    .addFunction(
      'Ship',
      (s) => {
        s.shipped = s.receipt !== undefined;
      },
      'ship',
    )
    .build();
}

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const unchanged = <T>(options: T): T => options;

async function capture(optionsFor = unchanged) {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  _resetRunIdStateForTesting();
  const tmp = mkdtempSync(join(tmpdir(), 'footprint-explain-off-'));
  const path = join(tmp, 'trace.ndjson');
  try {
    const executor = new FlowChartExecutor(paymentChart(), optionsFor({ sink: fileSink(path) }));
    executor.setRedactionPolicy({ keys: ['txnId', 'receipt'] });
    await executor.run();
    const raw = stringifySnapshot(executor.getSnapshot());
    const redacted = stringifySnapshot(executor.getSnapshot({ redact: true }));
    const sink = readFileSync(path);
    expect(raw).toContain('TXN-99');
    expect(raw).toContain('payment/charge');
    for (const served of [redacted, sink.toString()]) {
      expect(served).not.toContain('TXN-99');
      expect(served).not.toContain('UNRELATED-PARENT-VALUE');
    }
    return { raw: hash(raw), redacted: hash(redacted), sink: hash(sink) };
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

afterEach(() => vi.restoreAllMocks());

it('omitting explain preserves pinned raw, redacted and sink bytes', async () => {
  expect(await capture()).toEqual(BASELINE);
});

it('explicit explain(false) preserves pinned raw, redacted and sink bytes', async () => {
  // Keep the unchanged-path check runnable even before the new entry exists.
  const door = '../../../src/explain.js';
  const { explain } = await import(door);
  expect(await capture((options) => explain(false, options))).toEqual(BASELINE);
});

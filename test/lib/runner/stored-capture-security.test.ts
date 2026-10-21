import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { controlDepRecorder, readStoredCapture } from '../../../src/trace.js';
import { historyChart, savedFixture } from '../../helpers/storedCapture.js';

it('masks seeded and diagnostic secrets before automatic evidence export', async () => {
  const adapter = memorySink();
  const ex = new FlowChartExecutor(
    flowChart<{ secret: string }>(
      'Read',
      (s) => {
        const secret = s.secret;
        s.$debug('secret', 'PRIVATE_HISTORY');
      },
      'read',
    ).build(),
    {
      initialContext: { secret: 'PRIVATE_HISTORY' },
      captureCoverage: true,
      sink: { adapter, capture: { acknowledge: async (r) => ({ ...r, durability: 'durable' }) } },
    },
  );
  ex.setRedactionPolicy({ keys: ['secret'], diagnostics: { keys: ['secret'] } });
  ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
  await ex.run();
  expect(JSON.stringify(adapter.entries)).not.toContain('PRIVATE_HISTORY');
  const result = await readStoredCapture(adapter.entries, { runId: ex.getSnapshot().runId });
  expect(result.status).toBe('acknowledged');
  expect(result.history!.capture.limitations).toContain('redaction-active');
});

it.each(['getter', 'toJSON', 'Date', 'Map', 'NaN', 'negativeZero', 'cycle'])(
  'refuses %s data without invoking hidden code or claiming complete serialization',
  async (kind) => {
    let invoked = 0;
    const adapter = memorySink();
    let data: unknown;
    if (kind === 'getter')
      data = Object.defineProperty({}, 'hidden', {
        enumerable: true,
        get() {
          invoked++;
          return 'PRIVATE_HISTORY';
        },
      });
    if (kind === 'toJSON')
      data = {
        toJSON() {
          invoked++;
          return 'PRIVATE_HISTORY';
        },
      };
    if (kind === 'Date') data = new Date();
    if (kind === 'Map') data = new Map([['private', 'PRIVATE_HISTORY']]);
    if (kind === 'NaN') data = NaN;
    if (kind === 'negativeZero') data = -0;
    if (kind === 'cycle') {
      const cyclic: any = {};
      cyclic.next = cyclic;
      data = cyclic;
    }
    const ex = new FlowChartExecutor(historyChart(), {
      captureCoverage: true,
      sink: { adapter, capture: { acknowledge: async (r) => ({ ...r, durability: 'durable' }) } },
    });
    ex.attachFlowRecorder({ id: 'host', toSnapshot: () => ({ name: 'host', data }) });
    await ex.run();
    expect(invoked).toBe(0);
    expect(ex.getSnapshot().sink!.capture!.status).toBe('unknown');
    expect(adapter.entries.some((e) => e.kind === 'note' && e.note === 'capture-receipt')).toBe(false);
  },
);

it('refuses stored capture getters without executing them', async () => {
  const { entries, runId } = await savedFixture();
  let reads = 0;
  const evidence = entries.find((e) => e.note === 'capture-history');
  Object.defineProperty(evidence.data.capture, 'boundary', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('PRIVATE_HISTORY');
    },
  });
  const result = await readStoredCapture(entries, { runId });
  expect(result.status).toBe('unknown');
  expect(reads).toBe(0);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_HISTORY');
});

it('does not publish a late receipt after timeout or overwrite a newer invocation result', async () => {
  let release!: (r: any) => void;
  let first: any;
  let calls = 0;
  const adapter = memorySink();
  const ex = new FlowChartExecutor(historyChart(), {
    captureCoverage: true,
    sink: {
      adapter,
      capture: {
        timeoutMs: 10,
        acknowledge: async (r) => {
          calls++;
          if (calls === 1) {
            first = r;
            return new Promise((resolve) => (release = resolve));
          }
          return { ...r, durability: 'durable' };
        },
      },
    },
  });
  await ex.run();
  const oldRun = ex.getSnapshot().runId;
  await ex.run();
  const newRun = ex.getSnapshot().runId;
  release({ ...first, durability: 'durable' });
  await Promise.resolve();
  await Promise.resolve();
  expect((await readStoredCapture(adapter.entries, { runId: oldRun })).status).toBe('unknown');
  expect((await readStoredCapture(adapter.entries, { runId: newRun })).status).toBe('unknown');
  expect(ex.getSnapshot().sink!.capture).toMatchObject({ status: 'unknown', reason: 'acknowledgement-pending' });
  expect(calls).toBe(1);
  await ex.run();
  expect(ex.getSnapshot().sink!.capture!.status).toBe('acknowledged');
});

it('does not execute a stored entry kind accessor before the record reader sees it', async () => {
  let reads = 0;
  const entry = Object.defineProperty({}, 'kind', {
    enumerable: true,
    get() {
      reads++;
      return 'closed';
    },
  });
  expect((await readStoredCapture([entry], { runId: 'any' })).status).toBe('unknown');
  expect(reads).toBe(0);
});

it('refuses undefined tracked values instead of silently losing read keys in JSON', async () => {
  const adapter = memorySink();
  const ex = new FlowChartExecutor(
    flowChart<{ absent?: number }>(
      'Read missing',
      (scope) => {
        const read = scope.absent;
      },
      'read',
    ).build(),
    {
      captureCoverage: true,
      sink: { adapter, capture: { acknowledge: async (r) => ({ ...r, durability: 'durable' }) } },
    },
  );
  await ex.run();
  expect(ex.getSnapshot().sink!.capture!.status).toBe('unknown');
  expect(adapter.entries.some((e) => e.kind === 'note' && e.note === 'capture-receipt')).toBe(false);
});

it('refuses an accessor on an adapter receipt without reading its value', async () => {
  let reads = 0;
  const sink = memorySink();
  const ex = new FlowChartExecutor(historyChart(), {
    captureCoverage: true,
    sink: {
      adapter: sink,
      capture: {
        acknowledge: async (r) =>
          Object.defineProperty({ ...r }, 'durability', {
            get() {
              reads++;
              return 'durable';
            },
          }) as any,
      },
    },
  });
  await ex.run();
  expect(reads).toBe(0);
  expect(ex.getSnapshot().sink!.capture!.status).toBe('unknown');
});

it('refuses capture protocol fields hidden by the configured policy', async () => {
  const sink = memorySink();
  let calls = 0;
  const ex = new FlowChartExecutor(historyChart(), {
    captureCoverage: true,
    sink: {
      adapter: sink,
      capture: {
        acknowledge: async (r) => {
          calls++;
          return { ...r, durability: 'durable' };
        },
      },
    },
  });
  ex.setRedactionPolicy({ keys: ['runId'] });
  await ex.run();
  expect(calls).toBe(0);
  expect(ex.getSnapshot().sink!.capture!.status).toBe('unknown');
});

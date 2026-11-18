import { MessageChannel } from 'node:worker_threads';

import { expect, it, vi } from 'vitest';

import {
  type DetachDriver,
  type DetachHandle,
  createMicrotaskBatchDriver,
  createSendBeaconDriver,
  createWorkerThreadDriver,
} from '../../../src/detach.js';
import { explain } from '../../../src/explain.js';
import { type RuntimeSnapshot, flowChart, FlowChartExecutor } from '../../../src/index.js';

const child = flowChart<{ received: number; answer: number }>(
  'Receive',
  (scope) => {
    scope.received = scope.$getArgs<{ value: number }>().value;
  },
  'receive',
)
  .addFunction(
    'Calculate',
    (scope) => {
      scope.answer = scope.received * 2;
    },
    'calculate',
  )
  .build();

type Endpoint = Pick<RuntimeSnapshot, 'runId' | 'capture'> & { commitCount: number };

function endpoint(snapshot: RuntimeSnapshot): Endpoint {
  return { runId: snapshot.runId, capture: snapshot.capture, commitCount: snapshot.commitLog.length };
}

async function runChild(chart: typeof child, input: unknown) {
  const executor = new FlowChartExecutor(chart, explain(true));
  await executor.run({ input });
  const snapshot = executor.getSnapshot();
  return { ...endpoint(snapshot), answer: snapshot.sharedState.answer };
}

async function runParent(driver: DetachDriver) {
  let handle: DetachHandle | undefined;
  const chart = flowChart<{ value: number }>(
    'Seed',
    (scope) => {
      scope.value = 21;
    },
    'seed',
  )
    .addDetachAndJoinLater('detach', child, {
      driver,
      inputMapper: (scope) => ({ value: scope.value }),
      onHandle: (issued) => {
        handle = issued;
      },
    })
    .build();
  const executor = new FlowChartExecutor(chart, explain(true));
  await executor.run();
  if (!handle) throw new Error('The detach stage did not deliver a handle');
  const { result } = await handle.wait();
  const snapshot = executor.getSnapshot();
  expect(handle.status).toBe('done');
  expect(snapshot.sharedState).toEqual({ value: 21 });
  return { parent: endpoint(snapshot), result };
}

const collectedHandoff = { mode: 'on', status: 'collected', reasons: [] };

function expectWireNote({ capture, commitCount, runId }: Endpoint) {
  expect(capture).toStrictEqual({
    version: 3,
    scope: 'log',
    runId,
    logAddress: { logRunId: runId, drillPath: [] },
    commits: { from: 0, to: commitCount },
    boundary: { status: 'completed' },
    persistence: 'memory-only',
    channels: {
      reads: { mode: 'full', status: 'collected', reasons: [] },
      writes: expect.any(Object),
      commitWrites: expect.any(Object),
      writePrefixes: expect.any(Object),
      nestedReads: expect.any(Object),
      readSources: expect.any(Object),
      inputHandoff: expect.any(Object),
      outputHandoff: expect.any(Object),
      fanoutHandoff: expect.any(Object),
      attention: expect.any(Object),
      control: expect.any(Object),
    },
  });
  expect(JSON.parse(JSON.stringify(capture))).toEqual(capture);
}

function expectIndependentChild(result: unknown, parent: Endpoint) {
  expect(result).toMatchObject({ answer: 42, runId: expect.any(String) });
  const received = result as Awaited<ReturnType<typeof runChild>>;
  expect(received.runId).not.toBe(parent.runId);
  expectWireNote(received);
  expect(received.capture?.channels).toMatchObject({
    inputHandoff: collectedHandoff,
    outputHandoff: collectedHandoff,
  });
}

function expectCrossing(parent: Endpoint, reason: 'worker-boundary' | 'transport-boundary') {
  expectWireNote(parent);
  const gap = { mode: 'on', status: 'partial', reasons: [reason] };
  expect(parent.capture?.channels).toMatchObject({ inputHandoff: gap, outputHandoff: gap });
}

it('retains local read coverage without assigning a network boundary to in-process detach', async () => {
  const { parent, result } = await runParent(createMicrotaskBatchDriver(runChild));
  expect(result).toMatchObject({ answer: 42 });
  expectWireNote(parent);
  expect(JSON.stringify(parent.capture)).not.toMatch(/worker-boundary|transport-boundary/);
  expectIndependentChild(result, parent);
});

it('keeps a worker-protocol gap even when the reply contains an independent capture note', async () => {
  // Real structured-clone message ports with a test endpoint for the consumer-owned worker code.
  const { port1, port2 } = new MessageChannel();
  port2.once('message', async ({ messageId, input }: { messageId: number; input: unknown }) => {
    try {
      const result = await runChild(child, input);
      port2.postMessage({ messageId, ok: true, result });
    } catch (error) {
      port2.postMessage({ messageId, ok: false, error: String(error) });
    }
  });
  const driver = createWorkerThreadDriver({
    worker: {
      on: (event, listener) => {
        port1.on(event, listener);
      },
      postMessage: (message) => port1.postMessage(message),
    },
  });
  try {
    const { parent, result } = await runParent(driver);
    expect(result).toMatchObject({ answer: 42 });
    expectCrossing(parent, 'worker-boundary');
    expectIndependentChild(result, parent);
  } finally {
    port1.close();
    port2.close();
  }
});

it('keeps a transport gap when the browser accepts a beacon payload', async () => {
  const url = 'https://telemetry.example/collect';
  const sendBeacon = vi.fn((_url: string, _body: Blob) => true);
  vi.stubGlobal('navigator', { sendBeacon });
  try {
    const { parent, result } = await runParent(createSendBeaconDriver({ url }));
    expect(result).toEqual({ accepted: true, url });
    expect(sendBeacon).toHaveBeenCalledExactlyOnceWith(url, expect.any(Blob));
    expect(await sendBeacon.mock.calls[0]?.[1].text()).toBe('{"value":21}');
    expectCrossing(parent, 'transport-boundary');
  } finally {
    vi.unstubAllGlobals();
  }
});

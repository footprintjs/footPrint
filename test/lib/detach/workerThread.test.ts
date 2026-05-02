/**
 * detach/drivers/workerThread — 7-pattern tests.
 *
 *   P1 Unit         — schedule postMessage's the input
 *   P2 Boundary     — handle terminal once worker replies
 *   P3 Scenario     — multiple in-flight, each tagged with messageId
 *   P4 Property     — order of replies need not match send order
 *   P5 Security     — validate() requires worker or workerScript
 *   P6 Performance  — N/A (worker startup dominated)
 *   P7 ROI          — capabilities advertise cpuIsolated + nodeSafe
 *
 * The driver is tested with a MOCK worker that satisfies WorkerLike —
 * no actual thread is spawned, but the protocol (postMessage in,
 * 'message' event out) is exercised end-to-end.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createWorkerThreadDriver } from '../../../src/lib/detach/drivers/workerThread.js';
import { _resetForTests } from '../../../src/lib/detach/registry.js';

afterEach(() => _resetForTests());

const fakeChart = { root: {}, subflows: {} } as unknown as FlowChart;

// ── Mock worker that mirrors postMessage to its 'message' listener ───

function makeMockWorker() {
  let listener: ((msg: unknown) => void) | undefined;
  return {
    sent: [] as unknown[],
    on(event: string, fn: (msg: unknown) => void) {
      if (event === 'message') listener = fn;
    },
    postMessage(msg: unknown) {
      this.sent.push(msg);
    },
    /** Test-only: simulate the worker thread responding. */
    reply(messageId: number, ok: boolean, result?: unknown, error?: string) {
      listener?.({ messageId, ok, result, error });
    },
  };
}

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/drivers/workerThread — P1 unit', () => {
  it('P1 schedule sends postMessage with input + refId', () => {
    const worker = makeMockWorker();
    const driver = createWorkerThreadDriver({ worker });
    driver.schedule(fakeChart, { tag: 'hello' }, 'w-1');
    expect(worker.sent).toHaveLength(1);
    const msg = worker.sent[0] as { refId: string; input: unknown };
    expect(msg.refId).toBe('w-1');
    expect(msg.input).toEqual({ tag: 'hello' });
  });
});

// ─── P2 Boundary ─────────────────────────────────────────────────────

describe('detach/drivers/workerThread — P2 boundary', () => {
  it('P2 worker reply ok → handle.done with result', async () => {
    const worker = makeMockWorker();
    const driver = createWorkerThreadDriver({ worker });
    const h = driver.schedule(fakeChart, { x: 1 }, 'w-2');
    expect(h.status).toBe('running');
    // Worker replies asynchronously.
    const msg = worker.sent[0] as { messageId: number };
    setTimeout(() => worker.reply(msg.messageId, true, 42), 0);
    const result = await h.wait();
    expect(result).toEqual({ result: 42 });
    expect(h.status).toBe('done');
  });

  it('P2 worker reply !ok → handle.failed with error', async () => {
    const worker = makeMockWorker();
    const driver = createWorkerThreadDriver({ worker });
    const h = driver.schedule(fakeChart, undefined, 'w-3');
    const msg = worker.sent[0] as { messageId: number };
    setTimeout(() => worker.reply(msg.messageId, false, undefined, 'parse failure'), 0);
    await expect(h.wait()).rejects.toThrow('parse failure');
    expect(h.status).toBe('failed');
  });
});

// ─── P3 Scenario ─────────────────────────────────────────────────────

describe('detach/drivers/workerThread — P3 scenario', () => {
  it('P3 multiple in-flight resolve independently', async () => {
    const worker = makeMockWorker();
    const driver = createWorkerThreadDriver({ worker });
    const handles = [
      driver.schedule(fakeChart, 'a', 'w-a'),
      driver.schedule(fakeChart, 'b', 'w-b'),
      driver.schedule(fakeChart, 'c', 'w-c'),
    ];
    const sent = worker.sent as Array<{ messageId: number; input: unknown }>;
    setTimeout(() => {
      // Reply out of order — tests messageId routing.
      worker.reply(sent[1]!.messageId, true, 'B');
      worker.reply(sent[0]!.messageId, true, 'A');
      worker.reply(sent[2]!.messageId, true, 'C');
    }, 0);
    const results = await Promise.all(handles.map((h) => h.wait()));
    expect(results.map((r) => r.result)).toEqual(['A', 'B', 'C']);
  });
});

// ─── P4 Property — out-of-order replies ──────────────────────────────

describe('detach/drivers/workerThread — P4 property', () => {
  it('P4 reply order independent of send order', async () => {
    const worker = makeMockWorker();
    const driver = createWorkerThreadDriver({ worker });
    const h1 = driver.schedule(fakeChart, undefined, 'p-1');
    const h2 = driver.schedule(fakeChart, undefined, 'p-2');
    const sent = worker.sent as Array<{ messageId: number }>;
    setTimeout(() => {
      worker.reply(sent[1]!.messageId, true, 'second-first');
      worker.reply(sent[0]!.messageId, true, 'first-second');
    }, 0);
    const [r1, r2] = await Promise.all([h1.wait(), h2.wait()]);
    expect(r1.result).toBe('first-second');
    expect(r2.result).toBe('second-first');
  });
});

// ─── P5 Security — env guard ─────────────────────────────────────────

describe('detach/drivers/workerThread — P5 security', () => {
  it('P5 validate() throws when neither worker nor workerScript provided', () => {
    const driver = createWorkerThreadDriver({});
    expect(() => driver.validate?.()).toThrow(/either/i);
  });
});

// ─── P7 ROI ──────────────────────────────────────────────────────────

describe('detach/drivers/workerThread — P7 ROI', () => {
  it('P7 capabilities advertise cpuIsolated + nodeSafe', () => {
    const worker = makeMockWorker();
    const driver = createWorkerThreadDriver({ worker });
    expect(driver.capabilities.cpuIsolated).toBe(true);
    expect(driver.capabilities.nodeSafe).toBe(true);
  });
});

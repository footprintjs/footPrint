import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AttemptTimeoutError, errorCategory, flowChart, FlowChartExecutor } from '../../../../src/index.js';

const silent = { info() {}, log() {}, debug() {}, warn() {}, error() {} };

describe('platform error metadata without caller accessors', () => {
  const server = createServer(() => {});
  let url: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback fixture requires a TCP address');
    url = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('keeps a real fetch AbortSignal.timeout failure and its native context as network', async () => {
    let rejection: unknown;
    const chart = flowChart(
      'Request source',
      async () => {
        try {
          await fetch(url, { signal: AbortSignal.timeout(1) });
        } catch (error) {
          rejection = error;
          throw error;
        }
      },
      'request',
    )
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart);
    const caught = await executor.run().catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DOMException);
    expect(caught).toBe(rejection);
    expect(errorCategory(rejection)).toBe('network');
    expect(executor.getFailureContext()).toMatchObject({ category: 'network', stage: { runtimeStageId: 'request#0' } });
  });

  it.each(['AbortError', 'TimeoutError'])('recognizes a genuine DOMException %s', (name) => {
    expect(errorCategory(new DOMException('platform transport failure', name))).toBe('network');
  });

  it.each(['own', 'subclass'])('never runs a %s name override on a genuine platform error', (placement) => {
    const getter = vi.fn(() => 'AbortError');
    class CustomException extends DOMException {}
    const error =
      placement === 'own'
        ? new DOMException('platform timeout', 'TimeoutError')
        : new CustomException('platform timeout', 'TimeoutError');
    Object.defineProperty(placement === 'own' ? error : CustomException.prototype, 'name', { get: getter });
    expect(errorCategory(error)).toBe('unknown');
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not trust a forged platform prototype or a proxy around an exception', () => {
    expect(errorCategory(Object.create(DOMException.prototype))).toBe('unknown');
    expect(errorCategory(new Proxy(new DOMException('platform timeout', 'TimeoutError'), {}))).toBe('unknown');
  });

  it('does not run a replacement getter installed after the platform intrinsic was captured', () => {
    const original = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name');
    if (!original) throw new Error('Platform name descriptor is required');
    const getter = vi.fn(() => 'TimeoutError');
    try {
      Object.defineProperty(DOMException.prototype, 'name', { ...original, get: getter });
      expect(errorCategory(new DOMException('platform timeout', 'TimeoutError'))).toBe('unknown');
      expect(getter).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(DOMException.prototype, 'name', original);
    }
  });

  it('keeps an engine-owned timeout distinct from transport timeouts and caller cancellation', async () => {
    expect(errorCategory(new AttemptTimeoutError(1, 1))).toBe('timeout');
    expect(errorCategory(new DOMException('run cancelled', 'AbortError'), 'aborted')).toBe('unknown');
    expect(errorCategory(new DOMException('run deadline', 'TimeoutError'), 'timeout')).toBe('timeout');
    const chart = flowChart('Wait for source', () => new Promise<void>(() => {}), 'request')
      .retry({ attempts: 1, timeoutMs: 1 })
      .setLogger(silent)
      .build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toBeInstanceOf(AttemptTimeoutError);
    expect(executor.getFailureContext()).toMatchObject({ category: 'timeout' });
  });

  it.each([Error, TypeError, RangeError, EvalError, ReferenceError, SyntaxError, URIError, AggregateError])(
    '%s retains a stored prototype name',
    (Type) => {
      expect(Object.getOwnPropertyDescriptor(Type.prototype, 'name')).toHaveProperty('value', Type.name);
    },
  );

  it('retains real Node system codes and undici TypeError messages as data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'footprint-platform-error-'));
    try {
      const error: unknown = await readFile(join(directory, 'missing')).catch((failure: unknown) => failure);
      expect(Object.getOwnPropertyDescriptor(error, 'code')).toHaveProperty('value', 'ENOENT');
      expect(errorCategory(error)).toBe('unknown');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    // Port 1 is forbidden by fetch, so this produces a real undici TypeError without a remote request.
    const error: unknown = await fetch('http://127.0.0.1:1').catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(TypeError);
    expect(Object.getOwnPropertyDescriptor(error, 'message')).toHaveProperty('value', 'fetch failed');
    expect(errorCategory(error)).toBe('network');
  });
});

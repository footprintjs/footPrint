import { expect, it } from 'vitest';

import { captureNative, captureNativeSync } from './capture.js';
import { BufferPort, hooks, StagePort } from './portsFixture.js';

it('sync and async lifetimes preserve value identity and restore descriptors', async () => {
  const before = Object.getOwnPropertyDescriptors(StagePort.prototype);
  const value = {};
  const sync = captureNativeSync(hooks, 'sync', () => value);
  expect(sync.value).toBe(value);
  const async = await captureNative(hooks, 'async', async () => {
    await Promise.resolve();
    const b = new BufferPort();
    b.readResult = 7;
    const s = new StagePort(b);
    s.setObject([], 'cfg', undefined);
    s.getValue([], 'cfg');
    return value;
  });
  expect(async.value).toBe(value);
  expect(async.native.leg).toBe('async');
  expect(async.native.events.length).toBeGreaterThan(0);
  expect(Object.getOwnPropertyDescriptors(StagePort.prototype)).toEqual(before);
});
it.each([null, undefined, new Error('inert')])('preserves an escaping raw throw and restores: %s', async (error) => {
  const before = Object.getOwnPropertyDescriptors(StagePort.prototype);
  let sync: unknown = Symbol('uncaught');
  try {
    captureNativeSync(hooks, 'sync', () => {
      throw error;
    });
  } catch (actual) {
    sync = actual;
  }
  expect(sync).toBe(error);
  let async: unknown = Symbol('uncaught');
  try {
    await captureNative(hooks, 'async', async () => {
      throw error;
    });
  } catch (actual) {
    async = actual;
  }
  expect(async).toBe(error);
  expect(Object.getOwnPropertyDescriptors(StagePort.prototype)).toEqual(before);
});
it('forwards a Proxy result without reading any of its properties', () => {
  let invoked = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        invoked++;
        throw new Error('must not read');
      },
      ownKeys() {
        invoked++;
        throw new Error('must not enumerate');
      },
    },
  );
  const seen = captureNativeSync(hooks, 'proxy', () => {
    const b = new BufferPort();
    b.readResult = proxy;
    const s = new StagePort(b);
    s.setObject([], 'cfg', undefined);
    return s.getValue([], 'cfg');
  });
  expect(seen.value).toBe(proxy);
  expect(invoked).toBe(0);
  expect(seen.native.issues).toEqual([]);
});

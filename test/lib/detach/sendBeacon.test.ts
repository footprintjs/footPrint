/**
 * detach/drivers/sendBeacon — 7-pattern tests.
 *
 *   P1 Unit         — schedule POSTs to navigator.sendBeacon synchronously
 *   P2 Boundary     — handle terminal immediately when accepted
 *   P3 Scenario     — page-unload analytics POST shipped
 *   P4 Property     — payload serialized as JSON Blob by default
 *   P5 Security     — validate() throws helpfully when navigator absent
 *   P6 Performance  — N/A (sendBeacon is OS-level)
 *   P7 ROI          — capabilities advertise survivesUnload
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowChart } from '../../../src/lib/builder/types.js';
import { createSendBeaconDriver } from '../../../src/lib/detach/drivers/sendBeacon.js';
import { _resetForTests } from '../../../src/lib/detach/registry.js';

afterEach(() => _resetForTests());

const fakeChart = { root: {}, subflows: {} } as unknown as FlowChart;

let beaconCalls: Array<{ url: string; body: BodyInit | null | undefined }> = [];

function installNavigator(impl: { sendBeacon: (url: string, body?: BodyInit | null) => boolean } | undefined): void {
  // `navigator` may be a getter-only global on the runtime — use
  // defineProperty so we can swap it across tests.
  Object.defineProperty(globalThis, 'navigator', {
    value: impl,
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  beaconCalls = [];
  installNavigator({
    sendBeacon(url: string, body?: BodyInit | null): boolean {
      beaconCalls.push({ url, body });
      return true;
    },
  });
});

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/drivers/sendBeacon — P1 unit', () => {
  it('P1 schedule POSTs to the configured URL synchronously', () => {
    const driver = createSendBeaconDriver({ url: 'https://x.example/ingest' });
    const h = driver.schedule(fakeChart, { event: 'click' }, 'b-1');
    expect(h.status).toBe('done');
    expect(beaconCalls).toHaveLength(1);
    expect(beaconCalls[0]?.url).toBe('https://x.example/ingest');
  });

  it('P1 validate() does not throw when navigator is present', () => {
    const driver = createSendBeaconDriver({ url: 'https://x' });
    expect(() => driver.validate?.()).not.toThrow();
  });
});

// ─── P2 Boundary ─────────────────────────────────────────────────────

describe('detach/drivers/sendBeacon — P2 boundary', () => {
  it('P2 missing url throws at factory time', () => {
    expect(() => createSendBeaconDriver({ url: '' as never })).toThrow(TypeError);
  });

  it('P2 sendBeacon rejection (over 64KB) → handle.failed', () => {
    installNavigator({ sendBeacon: () => false }); // browser refuses
    const driver = createSendBeaconDriver({ url: 'https://x' });
    const h = driver.schedule(fakeChart, { huge: 'x' }, 'b-2');
    expect(h.status).toBe('failed');
    expect(h.error?.message).toMatch(/refused/);
  });
});

// ─── P3 Scenario ─────────────────────────────────────────────────────

describe('detach/drivers/sendBeacon — P3 scenario', () => {
  it('P3 page-unload analytics POST ships with JSON payload', () => {
    const driver = createSendBeaconDriver({ url: 'https://analytics.example/v1/events' });
    driver.schedule(fakeChart, { event: 'page.unload', sessionId: 'sess-42' }, 'b-3');
    expect(beaconCalls).toHaveLength(1);
    expect(beaconCalls[0]?.body).toBeInstanceOf(Blob);
  });
});

// ─── P4 Property — JSON serialization ────────────────────────────────

describe('detach/drivers/sendBeacon — P4 property', () => {
  it('P4 default serializer produces application/json Blob', async () => {
    const driver = createSendBeaconDriver({ url: 'https://x' });
    driver.schedule(fakeChart, { foo: 'bar' }, 'b-4');
    const body = beaconCalls[0]?.body as Blob;
    expect(body.type).toBe('application/json');
    const text = await body.text();
    expect(JSON.parse(text)).toEqual({ foo: 'bar' });
  });

  it('P4 custom serializer is honored', () => {
    const driver = createSendBeaconDriver({
      url: 'https://x',
      serialize: (input) => `custom:${JSON.stringify(input)}`,
    });
    driver.schedule(fakeChart, { x: 1 }, 'b-5');
    expect(beaconCalls[0]?.body).toBe('custom:{"x":1}');
  });
});

// ─── P5 Security — env guard ─────────────────────────────────────────

describe('detach/drivers/sendBeacon — P5 security', () => {
  it('P5 validate() throws when navigator.sendBeacon is missing', () => {
    installNavigator(undefined);
    const driver = createSendBeaconDriver({ url: 'https://x' });
    expect(() => driver.validate?.()).toThrow(/browser/i);
  });
});

// ─── P7 ROI ──────────────────────────────────────────────────────────

describe('detach/drivers/sendBeacon — P7 ROI', () => {
  it('P7 capabilities advertise survivesUnload + browserSafe', () => {
    const driver = createSendBeaconDriver({ url: 'https://x' });
    expect(driver.capabilities.browserSafe).toBe(true);
    expect(driver.capabilities.survivesUnload).toBe(true);
    expect(driver.capabilities.nodeSafe).toBeUndefined();
  });
});

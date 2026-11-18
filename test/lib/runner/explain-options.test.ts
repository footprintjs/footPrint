import { expect, it } from 'vitest';

import { type FlowChartExecutorOptions, flowChart, FlowChartExecutor } from '../../../src/index.js';
import { subflowCapture } from '../../../src/subflow-capture.js';

async function loadExplain(): Promise<(on: boolean, options?: FlowChartExecutorOptions) => FlowChartExecutorOptions> {
  // Load at test time so the pinned release can run the same gates with the door absent.
  const modulePath = '../../../src/explain.ts';
  return (await import(modulePath)).explain;
}

const chart = flowChart('Start', () => undefined, 'start').build();

it('passes the original options object through when disabled', async () => {
  const explain = await loadExplain();
  const options = Object.freeze({ captureCoverage: false, readTracking: 'summary' } as const);
  expect(explain(false, options)).toBe(options);
  expect(explain(false)).toEqual({});
});

it('fills the missing collection settings with a same-instance handoff capability', async () => {
  const explain = await loadExplain();
  const options = explain(true, {
    readTracking: undefined,
    readSources: undefined,
    captureCoverage: undefined,
    subflowCapture: undefined,
  });
  expect(options).toMatchObject({
    readTracking: 'full',
    writeProvenance: 'reads-prefix',
    nestedReadTracking: true,
    captureOutputHandoff: true,
    captureInputHandoff: true,
    captureFanoutHandoff: true,
    readSources: true,
    captureCoverage: true,
  });
  expect(() => new FlowChartExecutor(chart, options)).not.toThrow();
  expect(structuredClone(options)).not.toHaveProperty('captureExtent');
  expect(options).not.toHaveProperty('captureClosure');
});

const sources = { limits: { maxOccurrences: 2 } };
const initialContext = { initial: 'host-owned' };
const explicitHostSettings = {
  readTracking: 'summary',
  writeProvenance: 'off',
  nestedReadTracking: false,
  captureOutputHandoff: false,
  captureInputHandoff: false,
  captureFanoutHandoff: false,
  readSources: false,
  captureCoverage: true,
  writeTracking: 'off',
  commitValues: 'delta',
  captureExtent: false,
  captureClosure: false,
  initialContext,
} as const satisfies FlowChartExecutorOptions;

it.each(Object.entries(explicitHostSettings))('preserves the explicit %s value', async (setting, value) => {
  const explain = await loadExplain();
  const host = Object.freeze({ [setting]: value });
  const result = explain(true, host);
  expect(result).toHaveProperty(setting, value);
  expect(Object.keys(host)).toEqual([setting]);
  if (setting === 'captureInputHandoff') expect(result.captureFanoutHandoff).toBe(true);
  if (setting === 'captureFanoutHandoff') expect(result.captureInputHandoff).toBe(true);
  expect(() => new FlowChartExecutor(chart, result)).not.toThrow();
});

it('keeps a host source bound and an existing local capability by identity', async () => {
  const explain = await loadExplain();
  const host = subflowCapture({ input: true });
  const result = explain(true, { ...host, readSources: sources });
  expect(result.readSources).toBe(sources);
  expect(result.subflowCapture).toBe(host.subflowCapture);
  expect(result.captureInputHandoff).toBe(true);
  expect(result.captureFanoutHandoff).toBe(false);
  expect(() => new FlowChartExecutor(chart, result)).not.toThrow();
});

it('refuses disabling required coverage when enabled', async () => {
  const explain = await loadExplain();
  expect(() => explain(true, { captureCoverage: false })).toThrow('captureCoverage');
});

it("preserves the executor's plain-data admission for read-source and handoff settings", async () => {
  const explain = await loadExplain();
  let called = false;
  const readSources = Object.defineProperty({}, 'readSources', {
    get() {
      called = true;
      return true;
    },
  });
  expect(() => new FlowChartExecutor(chart, explain(true, readSources))).toThrow('readSources must be plain data');
  const handoff = Object.defineProperty({}, 'captureInputHandoff', {
    get() {
      called = true;
      return true;
    },
  });
  expect(() => new FlowChartExecutor(chart, explain(true, handoff))).toThrow('Invalid subflow capture configuration');
  expect(called).toBe(false);
});

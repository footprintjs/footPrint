import { memorySink } from 'foottrace/write';
import { expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import type { CaptureHistoryTarget } from '../../../src/lib/capture/historyTypes.js';
import type { RecorderBundle } from '../../../src/lib/recorder/snapshot.js';
import { controlDepRecorder } from '../../../src/trace.js';

const silent = { info() {}, log() {}, debug() {}, warn() {}, error() {} };
const capture = { captureCoverage: true, captureExtent: true, captureClosure: true };
const failedChart = (error: unknown) =>
  flowChart(
    'Fail',
    () => {
      throw error;
    },
    'fail',
  )
    .setLogger(silent)
    .build();

function returnedBundle(kind: 'nested' | 'field', read: () => unknown): RecorderBundle {
  if (kind === 'field')
    return Object.defineProperty({ name: 'Hostile' }, 'data', { get: read, enumerable: true }) as RecorderBundle;
  const data = Object.defineProperty({}, 'payload', { get: read, enumerable: true });
  return { name: 'Hostile', data };
}

it.each(['nested', 'field'] as const)(
  'automatic closure refuses a returned %s accessor before active privacy sees it',
  async (kind) => {
    const original = Object.freeze({ native: 'original' });
    const read = vi.fn(() => 'PRIVATE_GETTER_RESULT');
    const ex = new FlowChartExecutor(failedChart(original), capture);
    ex.setRedactionPolicy({ keys: ['payload'] });
    ex.attachFlowRecorder({ id: 'hostile', toSnapshot: () => returnedBundle(kind, read) });
    await expect(ex.run()).rejects.toBe(original);
    expect(read).not.toHaveBeenCalled();
    expect(ex.getClosedCapture()).toEqual({ status: 'unknown', reason: 'evidence-refused' });
  },
);

it('closure off does not implicitly ask a recorder for a snapshot', async () => {
  const original = new Error('native');
  const read = vi.fn(() => 'PRIVATE_GETTER_RESULT');
  const snapshot = vi.fn(() => returnedBundle('nested', read));
  const ex = new FlowChartExecutor(failedChart(original), { captureCoverage: true, captureExtent: true });
  ex.setRedactionPolicy({ keys: ['payload'] });
  ex.attachFlowRecorder({ id: 'hostile', toSnapshot: snapshot });
  await expect(ex.run()).rejects.toBe(original);
  expect(snapshot).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it.each(['nested', 'field'] as const)(
  'automatic durable history refuses a returned %s accessor before privacy or acknowledgement',
  async (kind) => {
    const original = new Error('native');
    const read = vi.fn(() => 'PRIVATE_GETTER_RESULT');
    const acknowledge = vi.fn(async (target: CaptureHistoryTarget) => ({ ...target, durability: 'durable' as const }));
    const ex = new FlowChartExecutor(failedChart(original), {
      captureCoverage: true,
      captureExtent: true,
      sink: { adapter: memorySink(), capture: { acknowledge } },
    });
    ex.setRedactionPolicy({ keys: ['payload'] });
    ex.attachFlowRecorder({ id: 'hostile', toSnapshot: () => returnedBundle(kind, read) });
    await expect(ex.run()).rejects.toBe(original);
    expect(read).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    ex.detachFlowRecorder('hostile');
    expect(ex.getSnapshot().sink?.capture).toEqual({ status: 'unknown', reason: 'evidence-refused' });
  },
);

it('plain recorder data is still admitted and selected payload values stay hidden', async () => {
  const original = new Error('native');
  const ex = new FlowChartExecutor(failedChart(original), capture);
  ex.setRedactionPolicy({ keys: ['payload'] });
  ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
  ex.attachFlowRecorder({
    id: 'plain',
    toSnapshot: () => ({ name: 'Plain', data: { payload: 'PRIVATE_VALUE', kept: 4 } }),
  });
  await expect(ex.run()).rejects.toBe(original);
  const cut = ex.getClosedCapture();
  expect(cut.status).toBe('closed');
  expect(JSON.stringify(cut)).not.toContain('PRIVATE_VALUE');
  if (cut.status === 'closed')
    expect(cut.record.recorders?.find((row) => row.id === 'plain')?.data).toMatchObject({ kept: 4 });
});

it.each(['name', 'description', 'preferredOperation', 'data', 'meta', 'capture'] as const)(
  'automatic capture refuses returned %s field accessors without executing them',
  async (key) => {
    const original = new Error('native');
    const read = vi.fn(() => 'PRIVATE_FIELD');
    const ex = new FlowChartExecutor(failedChart(original), capture);
    ex.setRedactionPolicy({ keys: ['payload'] });
    const bundle = Object.defineProperty({ name: 'Hostile', data: {} }, key, { get: read, enumerable: true });
    ex.attachFlowRecorder({ id: 'hostile', toSnapshot: () => bundle });
    await expect(ex.run()).rejects.toBe(original);
    expect(read).not.toHaveBeenCalled();
    expect(ex.getClosedCapture()).toEqual({ status: 'unknown', reason: 'evidence-refused' });
  },
);

it('does not turn a selected missing value into a pre-policy absence receipt', async () => {
  const original = new Error('native');
  const chart = flowChart<{ secret?: string; count?: number; blank?: unknown }>(
    'Fail',
    (scope) => {
      expect(scope.secret).toBeUndefined();
      scope.secret = undefined;
      expect(scope.count).toBeUndefined();
      scope.blank = undefined;
      throw original;
    },
    'fail',
  )
    .setLogger(silent)
    .build();
  const ex = new FlowChartExecutor(chart, capture);
  ex.setRedactionPolicy({ keys: ['secret'] });
  ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
  await expect(ex.run()).rejects.toBe(original);
  const cut = ex.getClosedCapture();
  expect(cut.status).toBe('closed');
  if (cut.status !== 'closed') throw new Error('fixture');
  expect(cut.record.absent).toContainEqual(['executionTree', 'stageReads', 'count']);
  expect(cut.record.absent).toContainEqual(['executionTree', 'stageWrites', 'blank']);
  expect(cut.record.absent?.some((path) => path.at(-1) === 'secret')).toBe(false);
  expect(cut.record.executionTree.stageReads?.secret).toBe('REDACTED');
  expect(cut.record.executionTree.stageWrites?.secret).toBe('REDACTED');
});

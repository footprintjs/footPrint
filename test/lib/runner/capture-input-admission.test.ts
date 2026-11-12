import { memorySink } from 'foottrace/write';
import { expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { HistoryDataError } from '../../../src/lib/capture/historyData.js';
import type { CaptureHistoryTarget } from '../../../src/lib/capture/historyTypes.js';
import type { FlowRecorder } from '../../../src/lib/engine/narrative/types.js';
import type { RecorderBundle } from '../../../src/lib/recorder/snapshot.js';
import { RunObservers } from '../../../src/lib/runner/attach.js';
import { collectRecorderSnapshots } from '../../../src/lib/runner/snapshot.js';
import { CompositeRecorder } from '../../../src/recorders.js';
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
  expect(cut.record.absent).toContainEqual(['executionTree', '0', 'stageReads', 'count']);
  expect(cut.record.absent).toContainEqual(['executionTree', '0', 'stageWrites', 'blank']);
  expect(cut.record.absent?.some((path) => path.at(-1) === 'secret')).toBe(false);
  expect(cut.record.executionTree[0].stageReads?.secret).toBe('REDACTED');
  expect(cut.record.executionTree[0].stageWrites?.secret).toBe('REDACTED');
});

it.each([
  ['nested', 1],
  ['field', 1],
  ['nested', 2],
  ['field', 2],
] as const)('automatic capture propagates %s admission through %s built-in composite levels', async (kind, depth) => {
  const original = new Error('native');
  const read = vi.fn(() => ({ payload: 'PRIVATE' }));
  const child = { id: 'child', toSnapshot: () => returnedBundle(kind, read) };
  let composite = new CompositeRecorder('level-0', [child]);
  for (let i = 1; i < depth; i++) composite = new CompositeRecorder(`level-${i}`, [composite]);
  const ex = new FlowChartExecutor(failedChart(original), capture);
  ex.setRedactionPolicy({ keys: ['payload'] });
  ex.attachFlowRecorder(composite);
  await expect(ex.run()).rejects.toBe(original);
  expect(read).not.toHaveBeenCalled();
  expect(ex.getClosedCapture()).toEqual({ status: 'unknown', reason: 'evidence-refused' });
});

it('ordinary explicit composite snapshots keep their existing field-getter semantics', () => {
  const read = vi.fn(() => ({ payload: 'explicit' }));
  const composite = new CompositeRecorder('explicit', [
    { id: 'child', toSnapshot: () => returnedBundle('field', read) },
  ]);
  expect(composite.toSnapshot().data.children[0]?.data).toEqual({ payload: 'explicit' });
  expect(read).toHaveBeenCalledOnce();
});

it('capture honors an overridden composite hook rather than bypassing it', async () => {
  const original = new Error('native');
  const child = vi.fn(() => {
    throw new Error('overridden child must not run');
  });
  let overrides = 0;
  class CustomComposite extends CompositeRecorder {
    override toSnapshot() {
      overrides++;
      return { name: 'Override', data: { children: [] } };
    }
  }
  const composite = new CustomComposite('override', [{ id: 'child', toSnapshot: child }]);
  const ex = new FlowChartExecutor(failedChart(original), capture);
  ex.attachFlowRecorder(composite);
  await expect(ex.run()).rejects.toBe(original);
  expect(overrides).toBe(1);
  expect(child).not.toHaveBeenCalled();
  expect(ex.getClosedCapture().status).toBe('closed');
});

it.each(['nested', 'field'] as const)(
  'durable history refuses a composite child %s accessor before acknowledgement',
  async (kind) => {
    const original = new Error('native');
    const read = vi.fn(() => 'PRIVATE');
    const acknowledge = vi.fn(async (target: CaptureHistoryTarget) => ({ ...target, durability: 'durable' as const }));
    const child = { id: 'child', toSnapshot: () => returnedBundle(kind, read) };
    const composite = new CompositeRecorder('outer', [new CompositeRecorder('inner', [child])]);
    const ex = new FlowChartExecutor(failedChart(original), {
      captureCoverage: true,
      captureExtent: true,
      sink: { adapter: memorySink(), capture: { acknowledge } },
    });
    ex.setRedactionPolicy({ keys: ['payload'] });
    ex.attachFlowRecorder(composite);
    await expect(ex.run()).rejects.toBe(original);
    expect(read).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    ex.detachFlowRecorder('outer');
    expect(ex.getSnapshot().sink?.capture).toEqual({ status: 'unknown', reason: 'evidence-refused' });
  },
);

it('valid nested composite data remains admitted and redacted', async () => {
  const original = new Error('native');
  const child = { id: 'child', toSnapshot: () => ({ name: 'Plain', data: { payload: 'PRIVATE', kept: 4 } }) };
  const composite = new CompositeRecorder('outer', [new CompositeRecorder('inner', [child])]);
  const ex = new FlowChartExecutor(failedChart(original), capture);
  ex.setRedactionPolicy({ keys: ['payload'] });
  ex.attachFlowRecorder(composite);
  await expect(ex.run()).rejects.toBe(original);
  const cut = ex.getClosedCapture();
  expect(cut.status).toBe('closed');
  expect(JSON.stringify(cut)).not.toContain('PRIVATE');
  expect(JSON.stringify(cut)).toContain('"kept":4');
});

function collectAutomatic(composite: CompositeRecorder) {
  const observers = new RunObservers();
  observers.flowRecorders = [composite];
  return collectRecorderSnapshots(observers, undefined, false, true);
}

it('automatic composite collection uses private children, not an author access helper', () => {
  class CustomAccess extends CompositeRecorder {
    override getChildren(): readonly FlowRecorder[] {
      throw new Error('public helper must not run');
    }
  }
  const child = { id: 'child', toSnapshot: () => ({ name: 'Plain', data: 4 }) };
  const composite = new CustomAccess('outer', [child]);
  expect(collectAutomatic(composite)[0]?.data).toEqual({
    children: [expect.objectContaining({ id: 'child', data: 4 })],
  });
});

it('automatic built-in composite collection refuses a cycle instead of recurring', () => {
  const composite = new CompositeRecorder('cycle', []);
  (composite.getChildren() as FlowRecorder[]).push(composite);
  expect(() => collectAutomatic(composite)).toThrow(HistoryDataError);
});

it('automatic built-in composite collection refuses excessive nesting', () => {
  let composite = new CompositeRecorder('leaf', []);
  for (let depth = 0; depth < 257; depth++) composite = new CompositeRecorder(`depth-${depth}`, [composite]);
  expect(() => collectAutomatic(composite)).toThrow(HistoryDataError);
});

it('automatic built-in composite collection shares its budget across repeated DAG children', () => {
  let leafCalls = 0;
  const leaf = {
    id: 'leaf',
    toSnapshot: () => {
      leafCalls++;
      return { name: 'Leaf', data: 4 };
    },
  };
  let composite = new CompositeRecorder('level-0', [leaf, leaf]);
  for (let level = 1; level < 16; level++) composite = new CompositeRecorder(`level-${level}`, [composite, composite]);
  expect(() => collectAutomatic(composite)).toThrow(HistoryDataError);
  expect(leafCalls).toBeGreaterThan(1000);
  expect(leafCalls).toBeLessThan(50001);
});

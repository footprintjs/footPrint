import { expect, it, vi } from 'vitest';

import { CAPTURE_CLOSURE_LIMITATIONS, copyCaptureClosure } from '../../../src/lib/capture/nativeClosure/format.js';
import { NativeCapture } from '../../../src/lib/capture/nativeCoverage.js';
import { NativeExtent } from '../../../src/lib/capture/nativeExtent/collector.js';

function fixture(failed = true) {
  const address = { logRunId: 'run', drillPath: [] };
  const capture = new NativeCapture('run', address, 0, {
    readTracking: 'full',
    writeTracking: 'full',
    commitValues: 'full',
    writeProvenance: 'reads-prefix',
  });
  capture.end(
    failed ? 'failed' : 'completed',
    failed ? { category: 'permanent', stage: { runId: 'run', runtimeStageId: 'work#1' } } : undefined,
  );
  const book = new NativeExtent('run', address, 0);
  for (let index = 0; index < 3; index++) book.begin()!.settle();
  book.seal(2);
  const binding = capture.snapshot(2, 'captured');
  const extent = book.snapshot(2);
  const marker = {
    version: 1,
    policy: 'native-root-prefix-v1',
    runId: 'run',
    scope: 'root-log',
    logAddress: address,
    commits: { from: 0, to: 2 },
    status: 'closed',
    boundary: failed ? 'failed' : 'completed',
    ...(failed && {
      selectedFailure: { kind: 'invocation', runId: 'run', runtimeStageId: 'work#1', attemptId: 'work#1@2' },
    }),
    limitations: [...CAPTURE_CLOSURE_LIMITATIONS],
  };
  return { marker: structuredClone(marker), binding, extent };
}

it.each([true, false])('copies the exact failed=%s fixed native prefix without changing its outcome', (failed) => {
  const { marker, binding, extent } = fixture(failed);
  const copied = copyCaptureClosure(marker, binding, extent);
  expect(copied).toEqual(marker);
  expect(copied).not.toBe(marker);
  expect(Object.isFrozen(copied)).toBe(true);
  expect(Object.isFrozen(copied?.logAddress)).toBe(true);
  expect(Object.isFrozen(copied?.logAddress.drillPath)).toBe(true);
  expect(Object.isFrozen(copied?.commits)).toBe(true);
  expect(Object.isFrozen(copied?.limitations)).toBe(true);
  expect(failed ? Object.isFrozen(copied?.selectedFailure) : copied?.selectedFailure === undefined).toBe(true);
  marker.commits.to = 9;
  marker.logAddress.drillPath.push('foreign' as never);
  marker.limitations.length = 0;
  expect(copied?.commits.to).toBe(2);
  expect(copied?.logAddress.drillPath).toEqual([]);
  expect(copied?.limitations).toEqual(CAPTURE_CLOSURE_LIMITATIONS);
  expect(extent.status).toBe('unverified');
  expect(binding.boundary.status).toBe(failed ? 'failed' : 'completed');
});

it.each([
  ['unknown format', (v: any): unknown => (v.version = 2)],
  ['unknown policy', (v: any): unknown => (v.policy = 'whole-workflow')],
  ['unearned success', (v: any): unknown => (v.boundary = 'completed')],
  ['paused boundary', (v: any): unknown => (v.boundary = 'paused')],
  ['open status', (v: any): unknown => (v.status = 'running')],
  ['another run', (v: any): unknown => (v.runId = 'other')],
  ['another log', (v: any): unknown => (v.logAddress.logRunId = 'other')],
  ['child log', (v: any): unknown => v.logAddress.drillPath.push('child')],
  ['child scope', (v: any): unknown => (v.scope = 'child-log')],
  ['another prefix', (v: any): unknown => (v.commits.from = 1)],
  ['later end', (v: any): unknown => v.commits.to++],
  ['negative zero', (v: any): unknown => (v.commits.from = -0)],
  ['unsafe offset', (v: any): unknown => (v.commits.to = Number.MAX_SAFE_INTEGER + 1)],
  ['missing failure', (v: any): unknown => delete v.selectedFailure],
  ['commit mistaken for invocation', (v: any): unknown => (v.selectedFailure.kind = 'commit')],
  ['wrong failure run', (v: any): unknown => (v.selectedFailure.runId = 'other')],
  ['wrong failure stage', (v: any): unknown => (v.selectedFailure.runtimeStageId = 'other#1')],
  ['wrong attempt owner', (v: any): unknown => (v.selectedFailure.attemptId = 'other#1@2')],
  ['noncanonical attempt', (v: any): unknown => (v.selectedFailure.attemptId = 'work#1@02')],
  ['call attempt', (v: any): unknown => (v.selectedFailure.attemptId = 'work#1@2.1@1')],
  ['attempt beyond observed entries', (v: any): unknown => (v.selectedFailure.attemptId = 'work#1@4')],
  ['raw error text', (v: any): unknown => (v.selectedFailure.message = 'PRIVATE')],
  ['unknown limitation', (v: any): unknown => v.limitations.push('PRIVATE')],
  ['missing limitation', (v: any): unknown => v.limitations.pop()],
  ['duplicate limitation', (v: any): unknown => (v.limitations[1] = v.limitations[0])],
  ['extra property', (v: any): unknown => (v.private = true)],
  ['nonenumerable extra', (v: any): unknown => Object.defineProperty(v, 'private', { value: true })],
  ['symbol extra', (v: any): unknown => (v[Symbol('private')] = true)],
  ['extra address', (v: any): unknown => (v.logAddress.private = true)],
  ['extra range', (v: any): unknown => (v.commits.private = true)],
  ['extra drill value', (v: any): unknown => (v.logAddress.drillPath.private = true)],
  ['inherited marker', (v: any): unknown => Object.setPrototypeOf(v, {})],
  ['null-prototype marker', (v: any): unknown => Object.setPrototypeOf(v, null)],
  ['inherited failure', (v: any): unknown => Object.setPrototypeOf(v.selectedFailure, {})],
] as const)('refuses %s instead of increasing evidence authority', (_name, mutate) => {
  const { marker, binding, extent } = fixture();
  mutate(marker);
  expect(copyCaptureClosure(marker, binding, extent)).toBeUndefined();
});

it('forbids selected failure metadata on a completed prefix', () => {
  const { marker, binding, extent } = fixture(false);
  (marker as any).selectedFailure = fixture().marker.selectedFailure;
  expect(copyCaptureClosure(marker, binding, extent)).toBeUndefined();
});

it('accepts independently admitted source-enabled notes without changing source channel authority', () => {
  const { marker, binding, extent } = fixture();
  const sourceBinding = {
    ...binding,
    version: 2 as const,
    channels: { ...binding.channels, readSources: 'unknown' as const },
  };
  expect(copyCaptureClosure(marker, sourceBinding, extent)).toEqual(marker);
  expect(sourceBinding.channels.readSources).toBe('unknown');
});

it.each([
  ['child binding', (v: any): unknown => (v.scope = 'child-log')],
  ['unearned binding persistence', (v: any): unknown => (v.persistence = 'durable')],
  ['foreign bound log', (v: any): unknown => (v.logAddress.logRunId = 'other')],
  ['non-root bound address', (v: any): unknown => v.logAddress.drillPath.push('child')],
] as const)('refuses %s even when the marker itself is well formed', (_name, mutate) => {
  const { marker, binding, extent } = fixture();
  const changed = structuredClone(binding);
  mutate(changed);
  expect(copyCaptureClosure(marker, changed, extent)).toBeUndefined();
});

it('refuses a completed binding that still names a terminal failure', () => {
  const { marker, binding, extent } = fixture(false);
  const changed = { ...binding, boundary: { ...binding.boundary, failure: fixture().binding.boundary.failure } };
  expect(copyCaptureClosure(marker, changed, extent)).toBeUndefined();
});

it.each([
  [
    'pending native invocation',
    (v: any): void => {
      v.invocations.settled--;
      v.invocations.pending++;
      v.limitations.push('pending-native-invocations');
    },
  ],
  [
    'abandoned native wait',
    (v: any): void => {
      v.invocations.abandoned++;
      v.limitations.push('abandoned-native-invocations');
    },
  ],
  ['unsettled counts', (v: any): unknown => v.invocations.settled--],
  ['running native book', (v: any): unknown => (v.status = 'running')],
  ['unsupported child work', (v: any): unknown => v.limitations.push('child-work-not-tracked')],
  ['custom scope', (v: any): unknown => v.limitations.push('custom-scope')],
  ['another extent', (v: any): unknown => (v.extentId = 'other')],
  ['unknown native-book version', (v: any): unknown => (v.version = 2)],
] as const)('refuses %s in the accompanying native book', (_name, mutate) => {
  const { marker, binding, extent } = fixture();
  const changed = structuredClone(extent);
  mutate(changed);
  expect(copyCaptureClosure(marker, binding, changed)).toBeUndefined();
});

it.each(['version', 'boundary', 'status', 'identity', 'failure', 'attempt', 'limitation', 'range'])(
  'does not evaluate a %s getter',
  (field) => {
    const { marker, binding, extent } = fixture();
    const getter = vi.fn(() => {
      throw new Error('PRIVATE');
    });
    const target =
      field === 'identity'
        ? marker.logAddress
        : field === 'attempt'
        ? marker.selectedFailure!
        : field === 'limitation'
        ? marker.limitations
        : field === 'range'
        ? marker.commits
        : marker;
    const key =
      field === 'identity'
        ? 'logRunId'
        : field === 'failure'
        ? 'selectedFailure'
        : field === 'attempt'
        ? 'attemptId'
        : field === 'limitation'
        ? '0'
        : field === 'range'
        ? 'to'
        : field;
    Object.defineProperty(target, key, { enumerable: true, get: getter });
    expect(copyCaptureClosure(marker, binding, extent)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  },
);

it.each(['sparse', 'sparse-with-expando', 'extra', 'wrong-prototype', 'nonarray'])(
  'refuses %s limitation collections',
  (shape) => {
    const { marker, binding, extent } = fixture();
    if (shape === 'sparse' || shape === 'sparse-with-expando') delete marker.limitations[1];
    if (shape === 'sparse-with-expando' || shape === 'extra') (marker.limitations as any).extra = 'PRIVATE';
    if (shape === 'wrong-prototype') Object.setPrototypeOf(marker.limitations, null);
    if (shape === 'nonarray') (marker as any).limitations = {};
    expect(copyCaptureClosure(marker, binding, extent)).toBeUndefined();
  },
);

it('refuses unknown capture versions and foreign bound failure metadata', () => {
  const { marker, binding, extent } = fixture();
  expect(copyCaptureClosure(marker, { ...binding, version: 3 } as any, extent)).toBeUndefined();
  expect(copyCaptureClosure(marker, { ...binding, boundary: { status: 'failed' } }, extent)).toBeUndefined();
  expect(copyCaptureClosure(marker, { ...binding, boundary: { status: 'cancelled' } }, extent)).toBeUndefined();
  expect(
    copyCaptureClosure(
      marker,
      {
        ...binding,
        boundary: {
          status: 'failed',
          failure: { category: 'unknown', stage: { runId: 'run', runtimeStageId: 'other#1' } },
        },
      },
      extent,
    ),
  ).toBeUndefined();
});

it('defensively refuses revoked unsupported input without invoking application getters', () => {
  const { marker, binding, extent } = fixture();
  const unsupported = Proxy.revocable(marker, {});
  unsupported.revoke();
  expect(copyCaptureClosure(unsupported.proxy, binding, extent)).toBeUndefined();
});

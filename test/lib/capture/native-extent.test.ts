import { expect, it, vi } from 'vitest';

import { NativeExtent } from '../../../src/lib/capture/nativeExtent/collector.js';
import {
  copyNativeCaptureExtent,
  NATIVE_EXTENT_MAX_INVOCATIONS,
} from '../../../src/lib/capture/nativeExtent/format.js';

const address = { logRunId: 'run', drillPath: [] };
const binding = { runId: 'run', logAddress: address, commits: { from: 0, to: 1 } };
const fixture = () => {
  const book = new NativeExtent('run', address, 0);
  book.begin()!.settle();
  book.seal(1);
  return structuredClone(book.snapshot(1));
};

it.each(['idle', 'pending', 'settled', 'abandoned', 'answered-after-abandon'])(
  'admits each running/terminal %s producer state under the corresponding policy',
  (state) => {
    const book = new NativeExtent('run', address, 0);
    if (state !== 'idle') {
      const invocation = book.begin()!;
      if (state === 'abandoned' || state === 'answered-after-abandon') invocation.abandon();
      if (state === 'settled' || state === 'answered-after-abandon') invocation.settle();
    }
    const running = book.snapshot(1);
    expect(copyNativeCaptureExtent(structuredClone(running), binding)).toEqual(running);
    expect(copyNativeCaptureExtent(running, binding, true)).toBeUndefined();
    book.seal(1);
    const terminal = book.snapshot(1);
    expect(copyNativeCaptureExtent(structuredClone(terminal), binding, true)).toEqual(terminal);
    expect(terminal.status).toBe('unverified');
  },
);

it('keeps counters bounded and discloses sustained saturation without retaining refused owners', () => {
  const book = new NativeExtent('run', address, 0);
  for (let i = 0; i < NATIVE_EXTENT_MAX_INVOCATIONS; i++) book.begin()!.settle();
  expect(book.snapshot(1).limitations).not.toContain('counter-saturated');
  for (let i = 0; i < 100; i++) expect(book.begin()).toBeUndefined();
  book.seal(1);
  const note = book.snapshot(2);
  expect(note.invocations).toEqual({
    started: NATIVE_EXTENT_MAX_INVOCATIONS,
    settled: NATIVE_EXTENT_MAX_INVOCATIONS,
    pending: 0,
    abandoned: 0,
  });
  expect(note.commits.to).toBe(1);
  expect(note.limitations.filter((gap) => gap === 'counter-saturated')).toHaveLength(1);
  expect(copyNativeCaptureExtent(note, binding, true)).toEqual(note);
});

it('makes duplicate dispositions harmless and never revises a terminal cut after late settlement', () => {
  const book = new NativeExtent('run', address, 0);
  const invocation = book.begin()!;
  invocation.abandon();
  invocation.abandon();
  book.seal(1);
  const terminal = book.snapshot(1);
  invocation.settle();
  invocation.settle();
  book.limit('custom-scope');
  expect(book.begin()).toBeUndefined();
  expect(book.snapshot(99)).toBe(terminal);
  expect(terminal.invocations).toEqual({ started: 1, settled: 0, pending: 1, abandoned: 1 });
});

it.each([
  [
    'version',
    (n: any) => {
      n.version = 2;
    },
  ],
  [
    'closed authority',
    (n: any) => {
      n.status = 'closed';
    },
  ],
  [
    'running persisted state',
    (n: any) => {
      n.status = 'running';
    },
  ],
  [
    'foreign owner',
    (n: any) => {
      n.runId = 'other';
    },
  ],
  [
    'foreign extent',
    (n: any) => {
      n.extentId = 'other';
    },
  ],
  [
    'foreign log',
    (n: any) => {
      n.logAddress.logRunId = 'other';
    },
  ],
  [
    'child scope',
    (n: any) => {
      n.logAddress.drillPath = ['child'];
    },
  ],
  [
    'commit cut',
    (n: any) => {
      n.commits.to++;
    },
  ],
  [
    'unearned persistence',
    (n: any) => {
      n.persistence = 'durable';
    },
  ],
  [
    'unknown reason',
    (n: any) => {
      n.limitations.push('PRIVATE');
    },
  ],
  [
    'duplicate reason',
    (n: any) => {
      n.limitations.push(n.limitations[0]);
    },
  ],
  [
    'missing fixed gap',
    (n: any) => {
      n.limitations.shift();
    },
  ],
  [
    'missing pending gap',
    (n: any) => {
      n.invocations.pending = 1;
      n.invocations.started = 2;
    },
  ],
  [
    'counter relation',
    (n: any) => {
      n.invocations.pending = 1;
    },
  ],
  [
    'counter overflow',
    (n: any) => {
      n.invocations.started = Number.MAX_SAFE_INTEGER;
    },
  ],
  [
    'negative zero',
    (n: any) => {
      n.invocations.pending = -0;
    },
  ],
  [
    'extra field',
    (n: any) => {
      n.private = true;
    },
  ],
  [
    'extra count field',
    (n: any) => {
      n.invocations.complete = true;
    },
  ],
  [
    'extra drill field',
    (n: any) => {
      n.logAddress.drillPath.private = true;
    },
  ],
  [
    'symbol field',
    (n: any) => {
      n[Symbol('private')] = true;
    },
  ],
] as const)('refuses %s without promoting a stored claim', (_name, mutate) => {
  const note = fixture();
  mutate(note);
  expect(copyNativeCaptureExtent(note, binding, true)).toBeUndefined();
});

it.each(['status', 'invocations', 'count', 'reason', 'address'])(
  'never invokes a %s getter while admitting a sidecar',
  (field) => {
    const note: any = fixture();
    const getter = vi.fn(() => {
      throw new Error('PRIVATE');
    });
    const target =
      field === 'count'
        ? note.invocations
        : field === 'reason'
        ? note.limitations
        : field === 'address'
        ? note.logAddress
        : note;
    const key = field === 'count' ? 'started' : field === 'reason' ? '0' : field === 'address' ? 'logRunId' : field;
    Object.defineProperty(target, key, { enumerable: true, get: getter });
    expect(copyNativeCaptureExtent(note, binding, true)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  },
);

it.each(['hole', 'hole-with-expando', 'accessor-entry', 'wrong-prototype', 'non-array'])(
  'refuses %s limitation collections without evaluating entry getters',
  (shape) => {
    const note: any = fixture();
    const getter = vi.fn(() => 'closure-not-attested');
    if (shape === 'hole' || shape === 'hole-with-expando') delete note.limitations[1];
    if (shape === 'hole-with-expando') note.limitations.extra = 'channels-not-fenced';
    if (shape === 'accessor-entry') Object.defineProperty(note.limitations, '1', { get: getter });
    if (shape === 'wrong-prototype') Object.setPrototypeOf(note.limitations, null);
    if (shape === 'non-array') note.limitations = {};
    expect(copyNativeCaptureExtent(note, binding, true)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  },
);

it('returns unknown when shape inspection of an unsupported revoked input throws', () => {
  // This exercises defensive refusal only; the stored codec normally receives an inert history projection.
  const unsupported = Proxy.revocable(fixture(), {});
  unsupported.revoke();
  expect(copyNativeCaptureExtent(unsupported.proxy, binding, true)).toBeUndefined();
});

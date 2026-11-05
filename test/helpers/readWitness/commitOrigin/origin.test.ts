import { describe, expect, it } from 'vitest';

import { installCommitOrigins } from './index.js';
describe('native producer observation — inert forwarding port', () => {
  it.each(['full', 'delta'] as const)('captures %s below a later outer rewrite, restores exact methods', (mode) => {
    class NativePort {
      toChangeOnlyPayload() {
        return { overwrite: { x: 1 }, updates: {}, redactedPaths: [], trace: [{ path: 'x' }] };
      }

      toDeltaPayload() {
        return this.toChangeOnlyPayload();
      }
    }
    // Use disjoint native methods: the real encoders do not call one another.
    NativePort.prototype.toDeltaPayload = function () {
      return { overwrite: { x: 1 }, updates: {}, redactedPaths: [], trace: [{ path: 'x' }] };
    };
    const old = Object.getOwnPropertyDescriptor(
      NativePort.prototype,
      mode === 'full' ? 'toChangeOnlyPayload' : 'toDeltaPayload',
    );
    let clock = 1;
    const origin = installCommitOrigins(NativePort.prototype, 'baseline-full-payload', {
      tick: () => ++clock,
      snapshotRows: JSON.stringify,
      snapshotPaths: JSON.stringify,
    });
    try {
      const receiver = new NativePort();
      origin.begin(receiver, 1, mode);
      const returned = mode === 'full' ? receiver.toChangeOnlyPayload() : receiver.toDeltaPayload();
      returned.trace.push({ path: 'unrelated-corruption' });
      const proof = origin.finish(receiver)!;
      expect(proof.bytes).not.toContain('unrelated-corruption');
      expect(JSON.stringify(returned)).toContain('unrelated-corruption');
    } finally {
      origin.restore();
    }
    expect(
      Object.getOwnPropertyDescriptor(NativePort.prototype, mode === 'full' ? 'toChangeOnlyPayload' : 'toDeltaPayload'),
    ).toEqual(old);
  });
  it('joins actual rows and actual surviving-path output; wrong/repeated/missing output supplies no proof', () => {
    class NativePort {
      toChangeOnlyPayload() {
        return { overwrite: {}, updates: {}, trace: [] };
      }

      toDeltaPayload() {
        return { overwrite: {}, updates: {}, trace: [] };
      }

      survivingRedactedPaths() {
        return ['x'];
      }
    }
    let clock = 1;
    const origin = installCommitOrigins(NativePort.prototype, 'rows-plus-redacted-paths', {
      tick: () => ++clock,
      snapshotRows: JSON.stringify,
      snapshotPaths: JSON.stringify,
    });
    try {
      const receiver = new NativePort();
      origin.begin(receiver, 1, 'full');
      receiver.toChangeOnlyPayload();
      receiver.survivingRedactedPaths();
      expect(JSON.parse(origin.finish(receiver)!.bytes).redactedPaths).toEqual(['x']);
      origin.begin(receiver, clock, 'full');
      receiver.toChangeOnlyPayload();
      expect(origin.finish(receiver)).toBeUndefined();
      origin.begin(receiver, clock, 'full');
      receiver.toDeltaPayload();
      receiver.survivingRedactedPaths();
      expect(origin.finish(receiver)).toBeUndefined();
    } finally {
      origin.restore();
    }
  });
});

/** Real private encoder seams: no alternate commit/encoding/replay is executed. */
import { describe, expect, it } from 'vitest';

import { BASELINE, BUILD, bytes } from '../../lib/memory/property/copy-on-write-fixture.js';
import { installReadLawObservation } from './observation.js';

const snapshotRows = (value: any) =>
  bytes({ ...value, trace: value.trace.map(({ readKeys: _readKeys, ...row }: any) => row) });
const producer = (engine: typeof BUILD) => ({
  profile: engine === BASELINE ? ('baseline-full-payload' as const) : ('rows-plus-redacted-paths' as const),
  snapshotRows,
  snapshotPaths: bytes,
});

describe.each([BASELINE, BUILD])('actual native producer on $label', (engine) => {
  it.each(['full', 'delta'] as const)('joins the actual %s encoder output to its real receiver', (mode) => {
    const observer = installReadLawObservation(engine, 'producer0', producer(engine));
    try {
      const buffer = new engine.TransactionBuffer({ x: 1 }, mode);
      buffer.set(['x'], 2);
      const payload = buffer.commit();
      const commit = observer.commitOf(buffer);
      observer.assertUsable();
      expect(commit?.method).toBe('commit');
      expect(commit?.encoder?.mode).toBe(mode);
      expect(commit?.encoder?.method).toBe(mode === 'full' ? 'toChangeOnlyPayload' : 'toDeltaPayload');
      expect(commit?.encoder?.bytes).toBe(snapshotRows(payload));
      expect(observer.receipt().events.find((event) => event.id === commit?.id)).toBe(commit);
    } finally {
      observer.restore();
    }
  });

  it('observes below a preinstalled outer duplicate-row rewrite and preserves that fault for the judge', () => {
    const prototype = engine.TransactionBuffer.prototype;
    const original = Object.getOwnPropertyDescriptor(prototype, 'commit')!;
    Object.defineProperty(prototype, 'commit', {
      ...original,
      value: function (this: object, ...args: unknown[]) {
        const payload = Reflect.apply(original.value, this, args);
        payload.trace.push({ path: 'unrelated-corruption', verb: 'set' });
        return payload;
      },
    });
    let observer: ReturnType<typeof installReadLawObservation> | undefined;
    try {
      observer = installReadLawObservation(engine, 'producer-fault0', producer(engine));
      const buffer = new engine.TransactionBuffer({ x: 1 }, 'full');
      buffer.set(['x'], 2);
      const corrupted = buffer.commit();
      const commit = observer.commitOf(buffer);
      observer.assertUsable();
      expect(commit?.encoder).toBeDefined();
      expect(commit?.encoder?.bytes).not.toContain('unrelated-corruption');
      expect(snapshotRows(corrupted)).toContain('unrelated-corruption');
      expect(commit?.encoder?.bytes).not.toBe(snapshotRows(corrupted));
    } finally {
      try {
        observer?.restore();
      } finally {
        Object.defineProperty(prototype, 'commit', original);
      }
    }
    expect(Object.getOwnPropertyDescriptor(prototype, 'commit')).toEqual(original);
  });
});

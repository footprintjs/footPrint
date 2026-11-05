/** RED-only current APIs: a dynamic domain needs neither a baseSnapshot nor a value inspector. */
import { expect, it } from 'vitest';

import { installReadLawObservation, sameStageDeletedReadInputs } from './observation.js';
import { BufferPort, hooks, StagePort } from './portsFixture.js';

it('selects the observed same-frame tombstone/read without a private baseSnapshot', () => {
  const storage = new BufferPort();
  storage.readResult = 7;
  const stage = new StagePort(storage);
  const observer = installReadLawObservation(hooks, 'missing-base');
  try {
    stage.setObject([], 'cfg', undefined);
    expect(stage.getValue([], 'cfg')).toBe(7);
    expect(sameStageDeletedReadInputs(observer.receipt())).toHaveLength(1);
  } finally {
    observer.restore();
  }
});
it.each(['accessor', 'symbol'] as const)(
  'any defined %s return is classified without inspecting its content',
  (kind) => {
    let invoked = 0;
    const value =
      kind === 'symbol'
        ? Symbol('defined')
        : Object.defineProperty({}, 'private', {
            enumerable: true,
            get() {
              invoked++;
              return 1;
            },
          });
    const storage = new BufferPort();
    Object.defineProperty(storage, 'baseSnapshot', { value: { cfg: 7 } });
    storage.readResult = value;
    const stage = new StagePort(storage);
    const observer = installReadLawObservation(hooks, 'any-defined');
    try {
      stage.setObject([], 'cfg', undefined);
      expect(stage.getValue([], 'cfg')).toBe(value);
      expect(invoked).toBe(0);
      expect(() => sameStageDeletedReadInputs(observer.receipt())).not.toThrow();
      expect(sameStageDeletedReadInputs(observer.receipt())).toHaveLength(1);
    } finally {
      observer.restore();
    }
  },
);

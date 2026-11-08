import { describe, expect, it } from 'vitest';

import { callsEndedReason } from './index.js';

describe('ended call reason', () => {
  it('creates a fresh fixed error for each stopped call', () => {
    const first = callsEndedReason();
    const second = callsEndedReason();
    expect(first).toBeInstanceOf(Error);
    expect(second).not.toBe(first);
    expect(first.message).toBe(
      '[footprint] $call: the stage attempt that made this call has ended — the call stops, and nothing it records ' +
        'lands on the stage. Await every call the stage makes.',
    );
    expect(second.message).toBe(first.message);
  });
});

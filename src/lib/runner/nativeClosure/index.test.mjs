import { expect, it } from 'vitest';

import { closeNativeCapture, NO_CLOSED_CAPTURE } from './record.js';

it('keeps missing producer capture unknown and never invokes the serving callback', () => {
  let calls = 0;
  const result = closeNativeCapture({}, undefined, (value) => {
    calls++;
    return value;
  });
  expect(result).toEqual({ status: 'unknown', reason: 'capture-unavailable' });
  expect(calls).toBe(0);
  expect(NO_CLOSED_CAPTURE).toEqual({ status: 'unknown', reason: 'not-collected' });
  expect(Object.isFrozen(NO_CLOSED_CAPTURE)).toBe(true);
});

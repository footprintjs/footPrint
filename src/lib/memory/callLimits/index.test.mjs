import { expect, it } from 'vitest';
import { MAX_CALL_RECORDS } from '../StageContext.js';
import { MAX_LATE_WRITES } from './index.js';

it('keeps the existing call and late-write ceilings', () => {
  expect(MAX_CALL_RECORDS).toBe(1000);
  expect(MAX_LATE_WRITES).toBe(100);
});

import { expect, it } from 'vitest';

import { RedactionRule, SCOPE_PLACEHOLDER } from './redaction.js';
import * as facade from './redaction.js';
import * as values from './redactionValues.js';

it('keeps the original facade and leaf on the same frozen value identities and shapes', () => {
  expect(facade.SCOPE_PLACEHOLDER).toBe(values.SCOPE_PLACEHOLDER);
  expect(facade.CLEAR).toBe(values.CLEAR);
  expect(facade.THRESHOLD_HOLE).toBe(values.THRESHOLD_HOLE);
  expect(values.CLEAR).toEqual({ kind: 'clear' });
  expect(values.THRESHOLD_HOLE).toEqual({ threshold: SCOPE_PLACEHOLDER, thresholdRedacted: true });
  expect(Object.isFrozen(values.CLEAR)).toBe(true);
  expect(Object.isFrozen(values.THRESHOLD_HOLE)).toBe(true);
});

it('keeps the scope placeholder and real selected-value serving unchanged', () => {
  expect(SCOPE_PLACEHOLDER).toBe('[REDACTED]');
  expect(new RedactionRule({ keys: ['secret'] }).retainRecord({ secret: 42, public: 3 })).toEqual({
    secret: SCOPE_PLACEHOLDER,
    public: 3,
  });
});

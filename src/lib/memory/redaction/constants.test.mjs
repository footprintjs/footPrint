import { expect, it } from 'vitest';
import { RedactionRule, SCOPE_PLACEHOLDER } from '../redaction.js';

it('keeps the scope placeholder and real selected-value serving unchanged', () => {
  expect(SCOPE_PLACEHOLDER).toBe('[REDACTED]');
  expect(new RedactionRule({ keys: ['secret'] }).retainRecord({ secret: 42, public: 3 })).toEqual({
    secret: SCOPE_PLACEHOLDER,
    public: 3,
  });
});

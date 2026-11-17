import { expect, it } from 'vitest';

import { observeOwnedRule, RedactionRule } from '../redaction.js';
import { DEFAULT_RUN_POLICY, derivePolicy, runPolicy } from '../runPolicy.js';
import { observePolicy } from './policyObservation.js';

it('observes actual frozen native carriers without minting a structural lookalike', () => {
  const rule = new RedactionRule({ keys: ['secret'] });
  const policy = runPolicy({}, rule);
  expect(observePolicy(DEFAULT_RUN_POLICY, observeOwnedRule)).toBe(true);
  expect(observePolicy(policy, observeOwnedRule)).toBe(false);
  rule.setPolicy(undefined);
  expect(observePolicy(policy, observeOwnedRule)).toBe(true);
  expect(observePolicy(derivePolicy(policy, { redaction: undefined }), observeOwnedRule)).toBe(true);
  expect(observePolicy(Object.freeze({ ...policy }), observeOwnedRule)).toBeUndefined();
});

it('rejects a Proxy carrier before reflection or rule observation', () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error('foreign policy');
  };
  const proxy = new Proxy(runPolicy(), { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  expect(observePolicy(proxy, trap)).toBeUndefined();
  expect(calls).toBe(0);
});

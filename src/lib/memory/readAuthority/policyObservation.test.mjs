import { SharedMemory } from 'foottrace/write';
import { expect, it } from 'vitest';

import { subflowCapture } from '../../../subflow-capture.js';
import { bindSubflowCapture, resolveSubflowCapture, subflowCaptureFor } from '../../capture/subflowCapability.js';

import { observeOwnedRule, RedactionRule } from '../redaction.js';
import { DEFAULT_RUN_POLICY, derivePolicy, runPolicy } from '../runPolicy.js';
import { observeOwnedContext, StageContext } from '../StageContext.js';
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

it('keeps native carrier admission and capture on the same derived policy through child and next frames', () => {
  const port = resolveSubflowCapture(subflowCapture({ input: true, fanout: true }));
  expect(port).toBeDefined();
  const rule = new RedactionRule({ keys: ['secret'] });
  const policy = bindSubflowCapture(runPolicy({}, rule), port);
  const keys = Reflect.ownKeys(policy);
  const derived = derivePolicy(policy, { readTracking: 'summary' });
  expect(derived).not.toBe(policy);
  expect(Object.isFrozen(derived)).toBe(true);
  expect(Reflect.ownKeys(derived)).toEqual(keys);
  expect(policy.readTracking).toBe('full');
  expect(derived.readTracking).toBe('summary');
  expect(subflowCaptureFor(policy)).toBe(port);
  expect(subflowCaptureFor(derived)).toBe(port);
  expect(observePolicy(derived, observeOwnedRule)).toBe(false);

  const root = new StageContext('run', 'root', 'root', new SharedMemory());
  root.usePolicy(derived);
  const frames = [root, root.createChild('run', 'branch', 'child', 'child'), root.createNext('', 'next', 'next')];
  for (const frame of frames) {
    expect(frame.getPolicy()).toBe(derived);
    expect(subflowCaptureFor(frame.getPolicy())).toBe(port);
    expect(observeOwnedContext(frame)).toBe(false);
  }
  rule.setPolicy(undefined);
  for (const frame of frames) expect(observeOwnedContext(frame)).toBe(true);
  const nextPolicy = derivePolicy(derived, { writeTracking: 'off' });
  root.usePolicy(nextPolicy);
  expect(observeOwnedContext(root)).toBe(true);
  expect(subflowCaptureFor(root.getPolicy())).toBe(port);
  expect(frames[1].getPolicy()).toBe(derived);
  expect(derived.writeTracking).toBe('full');
  expect(nextPolicy.writeTracking).toBe('off');
  const lookalike = Object.freeze({ ...derived });
  expect(observePolicy(lookalike, observeOwnedRule)).toBeUndefined();
  expect(subflowCaptureFor(lookalike)).toBeUndefined();
});

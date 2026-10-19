import { describe, expect, it } from 'vitest';

import { NativeFailureState } from '../../../src/lib/errors/terminalFailure.js';

const stage = { runId: 'synthetic-unit-run', runtimeStageId: 'synthetic-stage#1' };

describe('native failure ownership state', () => {
  it('captures identity defensively and exposes only a frozen, clone-safe context', () => {
    const state = new NativeFailureState();
    const identity = { ...stage };
    const original = new Error('synthetic private exception');
    expect(state.result).toBeUndefined();
    state.capture(original, 'server', identity);
    identity.runtimeStageId = 'forged#2';
    expect(state.result).toBeUndefined();
    state.finish(original);
    const expected = { category: 'server', stage };
    expect(state.result).toEqual(expected);
    expect(Object.isFrozen(state.result)).toBe(true);
    expect(Object.isFrozen(state.result?.stage)).toBe(true);
    expect(structuredClone(state.result)).toEqual(expected);
    expect(JSON.parse(JSON.stringify(state.result))).toEqual(expected);
    expect(JSON.stringify(state.result)).not.toContain(original.message);
  });

  it.each([null, undefined, false, 0, -0, NaN, '', 'synthetic-primitive'])(
    'preserves native ownership of %s',
    (error) => {
      const state = new NativeFailureState();
      state.capture(error, 'unknown', stage);
      expect(state.owns(error)).toBe(true);
      state.finish(error);
      expect(state.result).toEqual({ category: 'unknown', stage });
      expect(state.owns(error)).toBe(false);
    },
  );

  it('adopts only the selected child even when another child threw the same primitive', () => {
    const parent = new NativeFailureState();
    const ignored = new NativeFailureState();
    const chosen = new NativeFailureState();
    const error = 'same synthetic primitive';
    ignored.capture(error, 'network', { ...stage, runtimeStageId: 'ignored#1' });
    chosen.capture(error, 'auth', { ...stage, runtimeStageId: 'chosen#2' });
    parent.adopt(chosen, error);
    ignored.complete();
    parent.finish(error);
    expect(parent.result).toEqual({ category: 'auth', stage: { ...stage, runtimeStageId: 'chosen#2' } });
    expect(chosen.owns(error)).toBe(false);
  });

  it('does not transfer an unrelated child failure or preserve an earlier parent candidate', () => {
    const parent = new NativeFailureState();
    const child = new NativeFailureState();
    const earlier = new Error('synthetic earlier');
    const owned = new Error('synthetic child');
    const escaping = new Error('synthetic global');
    parent.capture(earlier, 'server', stage);
    child.capture(owned, 'auth', stage);
    parent.adopt(child, escaping);
    parent.finish(escaping);
    expect(parent.result).toEqual({ category: 'unknown' });
    expect(child.owns(owned)).toBe(false);
  });

  it('success and pause seal away both pending identity and future late captures', () => {
    const state = new NativeFailureState();
    const original = new Error('synthetic abandoned');
    state.capture(original, 'server', stage);
    state.complete();
    state.capture(original, 'auth', stage);
    state.finish(original);
    expect(state.result).toBeUndefined();
    expect(state.owns(original)).toBe(false);
  });

  it('sealing a failure is idempotent against later announcements and completions', () => {
    const state = new NativeFailureState();
    const original = new Error('synthetic terminal');
    state.capture(original, 'server', stage);
    expect(state.announce(original)).toEqual({ category: 'server', stage });
    state.finish(original);
    const retained = state.result;
    state.capture(new Error('synthetic late stage'), 'auth', stage);
    state.finish(new Error('synthetic late terminal'));
    state.announce(new Error('synthetic late announcement'));
    state.complete();
    expect(state.result).toBe(retained);
    expect(state.result).toEqual({ category: 'server', stage });
  });
});

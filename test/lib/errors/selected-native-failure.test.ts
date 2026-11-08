import { describe, expect, it } from 'vitest';

import { NativeFailureState } from '../../../src/lib/errors/terminalFailure.js';

const stage = { runId: 'selected-native-unit', runtimeStageId: 'invoke#4' };
const invocation = { ...stage, kind: 'invocation' as const, attemptId: 'invoke#4@2' };

describe('selected native failure is separate from legacy failure context', () => {
  it('selects only the exact invocation error and keeps legacy context unchanged', () => {
    const state = new NativeFailureState();
    const original = new Error('private original');
    state.observeInvocationFailure(original, invocation);
    state.capture(original, 'server', stage);
    expect(state.selected).toBeUndefined();
    state.finish(original);
    expect(state.result).toEqual({ category: 'server', stage });
    expect(state.selected).toEqual(invocation);
    expect(Object.isFrozen(state.selected)).toBe(true);
    expect(JSON.stringify(state.selected)).not.toContain(original.message);
  });

  it('does not borrow an invocation from a different escaping error or execution', () => {
    const state = new NativeFailureState();
    const invocationError = new Error('private invocation');
    const escaping = new Error('private different error');
    state.observeInvocationFailure(invocationError, invocation);
    state.capture(escaping, 'unknown', stage);
    state.finish(escaping);
    expect(state.selected).toBeUndefined();

    const other = new NativeFailureState();
    other.observeInvocationFailure(invocationError, invocation);
    other.capture(invocationError, 'unknown', { ...stage, runtimeStageId: 'other#5' });
    other.finish(invocationError);
    expect(other.selected).toBeUndefined();
  });

  it('copies actual-entry facts before callers mutate the token', () => {
    const state = new NativeFailureState();
    const original = new Error('private invocation');
    const mutable = { ...invocation };
    state.observeInvocationFailure(original, mutable);
    mutable.attemptId = 'forged#9@99';
    state.capture(original, 'server', stage);
    state.finish(original);
    expect(state.selected).toEqual(invocation);
  });

  it('a commit supersedes invocation origin even when it throws the same object', () => {
    const state = new NativeFailureState();
    const original = new Error('private shared error');
    state.observeInvocationFailure(original, invocation);
    state.capture(original, 'server', stage);
    state.selectCommit(original, stage);
    state.finish(original);
    expect(state.result).toEqual({ category: 'server', stage });
    expect(state.selected).toEqual({ ...stage, kind: 'commit' });
    expect(state.selected).not.toHaveProperty('attemptId');
  });

  it('does not select an unrelated commit or a cleared recovered invocation', () => {
    const state = new NativeFailureState();
    const original = new Error('private shared error');
    state.observeInvocationFailure(original, invocation);
    state.clearInvocationFailure();
    state.capture(original, 'server', stage);
    state.selectCommit(new Error('unrelated commit'), stage);
    state.finish(original);
    expect(state.selected).toBeUndefined();
  });

  it('a same-object commit in a different frame removes any borrowed invocation authority', () => {
    const state = new NativeFailureState();
    const original = new Error('private selected child');
    state.observeInvocationFailure(original, invocation);
    state.capture(original, 'server', stage);
    state.selectCommit(original, { ...stage, runtimeStageId: 'parent#5' });
    state.finish(original);
    expect(state.selected).toBeUndefined();
    // The original public terminal-context policy is unchanged; the stronger proof refuses the mismatch.
    expect(state.result).toEqual({ category: 'server', stage });
  });

  it('adopts only the explicitly selected child and seals against late callbacks', () => {
    const parent = new NativeFailureState();
    const child = new NativeFailureState();
    const original = new Error('private child');
    child.observeInvocationFailure(original, invocation);
    child.capture(original, 'server', stage);
    parent.adopt(child, original);
    parent.finish(original);
    expect(parent.selected).toEqual(invocation);
    expect(child.selected).toBeUndefined();
    parent.observeInvocationFailure(original, { ...invocation, attemptId: 'invoke#4@3' });
    parent.selectCommit(original, stage);
    parent.capture(original, 'auth', stage);
    parent.announce(original);
    parent.complete();
    expect(parent.selected).toEqual(invocation);
    expect(parent.result).toEqual({ category: 'server', stage });
  });

  it('successful completion clears a contained invocation and discloses no selection', () => {
    const state = new NativeFailureState();
    const original = new Error('private contained');
    state.observeInvocationFailure(original, invocation);
    state.capture(original, 'server', stage);
    state.complete();
    state.finish(original);
    expect(state.result).toBeUndefined();
    expect(state.selected).toBeUndefined();
  });
});

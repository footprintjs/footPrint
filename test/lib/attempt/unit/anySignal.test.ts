/**
 * `attempt/anySignal.ts` — one signal that aborts when any of its inputs does (design §3.1: not `AbortSignal.any`,
 * so a browser without it works). The attempt runner composes the run's signal with an attempt's own timer on it.
 *
 * Test types: Unit (the first input to abort decides, with its reason; an input already aborted) · Boundary (no
 * inputs; `undefined` entries) · Performance/cleanup (every listener it added is removed — on abort and on
 * dispose — so a long run of attempts leaks nothing onto the run's signal).
 */
import { describe, expect, it, vi } from 'vitest';

import { anySignal } from '../../../../src/lib/attempt/anySignal.js';

describe('anySignal', () => {
  it('aborts when any input aborts, with that input’s reason', () => {
    const a = new AbortController();
    const b = new AbortController();
    const composed = anySignal([a.signal, b.signal]);
    expect(composed.signal.aborted).toBe(false);
    const reason = new Error('b stopped');
    b.abort(reason);
    expect(composed.signal.aborted).toBe(true);
    expect(composed.signal.reason).toBe(reason);
    // A later abort of another input changes nothing.
    a.abort(new Error('a stopped'));
    expect(composed.signal.reason).toBe(reason);
  });

  it('is aborted at once when an input already is — and adds no listener', () => {
    const a = new AbortController();
    const b = new AbortController();
    a.abort('already');
    const add = vi.spyOn(b.signal, 'addEventListener');
    const composed = anySignal([a.signal, b.signal]);
    expect(composed.signal.aborted).toBe(true);
    expect(composed.signal.reason).toBe('already');
    expect(add).not.toHaveBeenCalled();
  });

  it('with no inputs (or only undefined ones) it never aborts', () => {
    expect(anySignal([]).signal.aborted).toBe(false);
    const composed = anySignal([undefined, undefined]);
    expect(composed.signal.aborted).toBe(false);
    composed.dispose();
    expect(composed.signal.aborted).toBe(false);
  });

  it('removes every listener it added once it aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const removeA = vi.spyOn(a.signal, 'removeEventListener');
    const removeB = vi.spyOn(b.signal, 'removeEventListener');
    anySignal([a.signal, b.signal]);
    a.abort();
    expect(removeA).toHaveBeenCalledTimes(1);
    expect(removeB).toHaveBeenCalledTimes(1);
  });

  it('dispose removes every listener, and a later input abort no longer reaches it', () => {
    const a = new AbortController();
    const remove = vi.spyOn(a.signal, 'removeEventListener');
    const composed = anySignal([a.signal, undefined]);
    composed.dispose();
    composed.dispose(); // idempotent
    expect(remove).toHaveBeenCalledTimes(1);
    a.abort();
    expect(composed.signal.aborted).toBe(false);
  });
});

/**
 * `runner/deadline.ts · armRun` — the run's ONE effective signal and its deadline (design §3.1, P1b).
 *
 * WHY: before 10.1 a run had two cancellation inputs that did not compose — `timeoutMs` was ignored when a
 * `signal` was given, and `env.signal` was readable but never raced — and no stage could ask how much time was
 * left. `armRun` composes `options.signal`, `env.signal` and the deadline timer into one signal, and stamps
 * `env.deadline` (epoch ms) and `env.signal` (that one signal) so a stage reads one number and one signal.
 *
 * Test types: Unit (each input alone and together; the deadline's minimum; env stamping) · Boundary (a deadline
 * already past; non-finite and zero inputs; dispose idempotent) · Byte identity (no input → the caller's own
 * objects, untouched — an env-less run with only a signal keeps an empty env).
 */
import { describe, expect, it, vi } from 'vitest';

import { isDeadlineReason } from '../../../../src/lib/attempt/deadline.js';
import { armRun } from '../../../../src/lib/runner/deadline.js';

describe('armRun — nothing asked, nothing changed', () => {
  it('no signal, no timeout, no deadline: no signal, the env as given', () => {
    const env = { traceId: 't' };
    const armed = armRun({ env }, () => 0);
    expect(armed.signal).toBeUndefined();
    expect(armed.env).toBe(env);
    expect(armed.deadline).toBeUndefined();
    armed.dispose();
  });

  it('only options.signal: that same signal, and an absent env stays absent', () => {
    const controller = new AbortController();
    const armed = armRun({ signal: controller.signal }, () => 0);
    expect(armed.signal).toBe(controller.signal);
    expect(armed.env).toBeUndefined();
  });

  it('timeoutMs 0, Infinity or NaN and a non-finite deadline arm nothing', () => {
    for (const bad of [
      { timeoutMs: 0 },
      { timeoutMs: Infinity },
      { timeoutMs: NaN },
      { deadline: Infinity },
      { deadline: NaN },
    ]) {
      const armed = armRun(bad, () => 0);
      expect(armed.deadline).toBeUndefined();
      expect(armed.signal).toBeUndefined();
    }
  });
});

describe('armRun — the deadline', () => {
  it('timeoutMs becomes a deadline: env.deadline = now + timeoutMs, env.signal the run signal', () => {
    vi.useFakeTimers();
    try {
      const armed = armRun({ timeoutMs: 1_000, env: { traceId: 't' } }, () => 5_000);
      expect(armed.deadline).toBe(6_000);
      expect(armed.env).toEqual({ traceId: 't', deadline: 6_000, signal: armed.signal });
      expect(Object.isFrozen(armed.env)).toBe(false); // the facade freezes its own copy
      expect(armed.signal!.aborted).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(armed.signal!.aborted).toBe(true);
      expect(isDeadlineReason(armed.signal!.reason)).toBe(true);
      // The message a run({ timeoutMs }) has always rejected with.
      expect((armed.signal!.reason as Error).message).toBe('Execution timed out after 1000ms');
      armed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deadline, timeoutMs and env.deadline: the EARLIEST wins', () => {
    vi.useFakeTimers();
    try {
      expect(armRun({ deadline: 9_000, timeoutMs: 2_000, env: { deadline: 8_000 } }, () => 5_000).deadline).toBe(7_000);
      expect(armRun({ deadline: 6_000, timeoutMs: 2_000 }, () => 5_000).deadline).toBe(6_000);
      expect(armRun({ env: { deadline: 5_500 } }, () => 5_000).deadline).toBe(5_500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a deadline already past aborts the signal at once (the run then stops before its first stage)', () => {
    const armed = armRun({ deadline: 100 }, () => 5_000);
    expect(armed.signal!.aborted).toBe(true);
    expect(isDeadlineReason(armed.signal!.reason)).toBe(true);
    expect((armed.signal!.reason as Error).message).toMatch(/deadline/);
  });

  it('a deadline with no env gives the env the deadline and the signal', () => {
    vi.useFakeTimers();
    try {
      const armed = armRun({ deadline: 9_000 }, () => 5_000);
      expect(armed.env).toEqual({ deadline: 9_000, signal: armed.signal });
      armed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose clears the timer: a disposed run never aborts later; dispose is idempotent', () => {
    vi.useFakeTimers();
    try {
      const armed = armRun({ timeoutMs: 10 }, () => 0);
      armed.dispose();
      armed.dispose();
      vi.advanceTimersByTime(100);
      expect(armed.signal!.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('armRun — env.signal honoured, and every input composed', () => {
  it('env.signal alone is the run signal (it used to be readable only)', () => {
    const controller = new AbortController();
    const armed = armRun({ env: { signal: controller.signal } }, () => 0);
    controller.abort(new Error('stop'));
    expect(armed.signal!.aborted).toBe(true);
    expect((armed.signal!.reason as Error).message).toBe('stop');
  });

  it('options.signal and env.signal: either aborts the run; env.signal is the composed one', () => {
    const a = new AbortController();
    const b = new AbortController();
    const armed = armRun({ signal: a.signal, env: { signal: b.signal, traceId: 't' } }, () => 0);
    expect(armed.env!.signal).toBe(armed.signal);
    expect(armed.env!.traceId).toBe('t');
    b.abort(new Error('from env'));
    expect((armed.signal!.reason as Error).message).toBe('from env');
    armed.dispose();
  });

  it('a signal AND timeoutMs: both are honoured (timeoutMs used to be ignored beside a signal)', () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const armed = armRun({ signal: controller.signal, timeoutMs: 50 }, () => 0);
      vi.advanceTimersByTime(50);
      expect(armed.signal!.aborted).toBe(true);
      expect(isDeadlineReason(armed.signal!.reason)).toBe(true);
      armed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose releases the listeners composition added to the caller signals', () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const armed = armRun({ signal: controller.signal, env: { signal: new AbortController().signal } }, () => 0);
    armed.dispose();
    expect(remove).toHaveBeenCalled();
  });
});

describe('armRun — review fixes', () => {
  it('an env.signal that is not a signal stays readable-only: no throw, and no timer is left behind', () => {
    vi.useFakeTimers();
    try {
      const armed = armRun({ timeoutMs: 50, env: { signal: {} as AbortSignal } }, () => 0);
      expect(armed.deadline).toBe(50);
      armed.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a deadline past the host timer limit is waited in chunks, not fired at once', () => {
    vi.useFakeTimers();
    try {
      const armed = armRun({ timeoutMs: 3e9 }, () => 0);
      vi.advanceTimersByTime(2_147_483_647 + 10);
      expect(armed.signal!.aborted).toBe(false);
      vi.advanceTimersByTime(3e9);
      expect(armed.signal!.aborted).toBe(true);
      armed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

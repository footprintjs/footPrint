/**
 * `attempt/effect.ts` and the runner's side-effect law (design §3.3, packet P3), unit-tested without the engine.
 *
 * A target that TOUCHES an outside system gets an `effect` on every attempt record: `ok → 'applied'`; a timeout, an
 * abort or a pause → `'unknown'`; a failure → `'none'` only when the error itself declares `effect: 'none'` (the
 * adapter's word: nothing was sent), otherwise `'unknown'`. When the LAST attempt's effect is unknown the series
 * fails with `UnknownEffectError` — never the attempt's own error, so nothing downstream reads "failed" and retries
 * blindly. A touching series that may retry must carry an idempotency key; the runner refuses one that does not.
 *
 * Test types: Unit (`effectOf`, `touchesProblem`, `admitIdempotencyKey`, the runner's records and its stop error) ·
 * Boundary (a key at the length limit; a hostile `effect` getter; a pause; a cut wait).
 */
import { describe, expect, it } from 'vitest';

import {
  admitIdempotencyKey,
  effectOf,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  touchesProblem,
} from '../../../../src/lib/attempt/effect.js';
import { AttemptTimeoutError, UnknownEffectError } from '../../../../src/lib/attempt/errors.js';
import { runAttempts } from '../../../../src/lib/attempt/runner.js';
import type { AttemptRecord } from '../../../../src/lib/attempt/types.js';
import { PauseSignal } from '../../../../src/lib/pause/types.js';

const noEffect = (message: string) => Object.assign(new Error(message), { effect: 'none' as const });

describe('effectOf — what an attempt did to the outside system', () => {
  it('ok is applied; timeout, aborted and paused are unknown', () => {
    expect(effectOf('ok', undefined)).toBe('applied');
    expect(effectOf('timeout', new AttemptTimeoutError(1, 10))).toBe('unknown');
    expect(effectOf('aborted', new Error('cancelled'))).toBe('unknown');
    expect(effectOf('paused', undefined)).toBe('unknown');
  });

  it("a failure is 'none' only when the error declares it; anything else is unknown", () => {
    expect(effectOf('failed', noEffect('card declined'))).toBe('none');
    expect(effectOf('failed', new Error('socket hang up'))).toBe('unknown');
    expect(effectOf('failed', Object.assign(new Error('x'), { effect: 'None' }))).toBe('unknown');
    expect(effectOf('failed', Object.assign(new Error('x'), { effect: 'applied' }))).toBe('unknown');
    expect(effectOf('failed', 'a string')).toBe('unknown');
    expect(effectOf('failed', null)).toBe('unknown');
    expect(effectOf('failed', undefined)).toBe('unknown');
  });

  it("a timeout stays unknown even when its error says 'none' — no answer came back", () => {
    expect(effectOf('timeout', noEffect('late'))).toBe('unknown');
  });

  it('a throwing effect getter or a hostile Proxy reads as unknown, never a second throw', () => {
    const getter = Object.defineProperty(new Error('x'), 'effect', {
      get() {
        throw new Error('nope');
      },
    });
    expect(effectOf('failed', getter)).toBe('unknown');
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    expect(effectOf('failed', proxy)).toBe('unknown');
  });
});

describe('touchesProblem — the build law, one rule for every door', () => {
  const key = () => 'k';

  it('a valid declaration is accepted with or without a retry', () => {
    expect(touchesProblem({ system: 'stripe' }, undefined)).toBeUndefined();
    expect(touchesProblem({ system: 'stripe' }, { attempts: 1 })).toBeUndefined();
    expect(touchesProblem({ system: 'stripe', idempotencyKey: key }, { attempts: 3 })).toBeUndefined();
  });

  it('a retried touch without a key is refused, by name', () => {
    const problem = touchesProblem({ system: 'stripe' }, { attempts: 3 });
    expect(problem).toMatch(/touches "stripe"/);
    expect(problem).toMatch(/idempotencyKey/);
  });

  it('a malformed declaration is refused: not an object, a bad system name, a key that is not a function', () => {
    expect(touchesProblem(null, undefined)).toMatch(/touches/);
    expect(touchesProblem('stripe', undefined)).toMatch(/touches/);
    expect(touchesProblem({ system: '' }, undefined)).toMatch(/system/);
    expect(touchesProblem({ system: 'a\nb' }, undefined)).toMatch(/system/);
    expect(touchesProblem({ system: 7 }, undefined)).toMatch(/system/);
    expect(touchesProblem({ system: 'stripe', idempotencyKey: 'fixed' }, undefined)).toMatch(/function/);
  });
});

describe('admitIdempotencyKey — the key is a name-like value from code or state', () => {
  it('accepts printable ASCII up to the limit', () => {
    expect(admitIdempotencyKey('x', 'order-77')).toBe('order-77');
    const longest = 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH);
    expect(admitIdempotencyKey('x', longest)).toBe(longest);
  });

  it('refuses anything else with a TypeError that never echoes the value', () => {
    const secret = 'sk_live_SECRET';
    for (const bad of [
      '',
      'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1),
      `${secret} with space`,
      `${secret}\r\nX-Injected: 1`,
      `${secret}‮`,
      `${secret}é`,
      42,
      undefined,
      null,
      { toString: () => secret },
    ]) {
      let thrown: unknown;
      try {
        admitIdempotencyKey('stage charge', bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as Error).message).toMatch(/idempotencyKey/);
      expect((thrown as Error).message).not.toContain(secret);
    }
  });
});

describe('runAttempts with a touching target', () => {
  const now = (() => {
    let t = 0;
    return () => (t += 5);
  })();

  async function series(
    fails: (n: number) => unknown,
    attempts: number,
    touches: { system: string; idempotencyKey?: string; recordedKey?: string },
  ) {
    const records: AttemptRecord[] = [];
    let error: unknown;
    let value: unknown;
    try {
      value = await runAttempts(
        (n) => {
          const failure = fails(n);
          if (failure !== undefined) throw failure;
          return `ok ${n}`;
        },
        { attempts },
        { series: 'charge#1', now, effect: touches, onAttempt: (record) => records.push(record) },
      );
    } catch (thrown) {
      error = thrown;
    }
    return { records, error, value };
  }

  it('stamps system, the recorded key and the effect on every record; ok is applied', async () => {
    const { records, value } = await series((n) => (n < 2 ? noEffect('declined') : undefined), 3, {
      system: 'stripe',
      idempotencyKey: 'order-1',
      recordedKey: 'order-1',
    });
    expect(value).toBe('ok 2');
    expect(records.map((r) => [r.system, r.idempotencyKey, r.effect])).toEqual([
      ['stripe', 'order-1', 'none'],
      ['stripe', 'order-1', 'applied'],
    ]);
  });

  it('the record carries the RECORDED key (the served form), never the raw one', async () => {
    const { records } = await series(() => undefined, 1, {
      system: 'stripe',
      idempotencyKey: 'order-raw',
      recordedKey: '[REDACTED]',
    });
    expect(records[0].idempotencyKey).toBe('[REDACTED]');
    expect(JSON.stringify(records)).not.toContain('order-raw');
  });

  it('the decision reads keyPresent — never the key', async () => {
    const { records } = await series(() => new Error('x'), 2, { system: 'stripe', idempotencyKey: 'order-2' });
    const decision = JSON.stringify(records[0].decision);
    expect(decision).not.toContain('order-2');
    expect(records[0].next).toBe('retry');
  });

  it('a last attempt of unknown effect fails the series with UnknownEffectError, the attempt error its cause', async () => {
    const boom = new Error('socket hang up');
    const { records, error } = await series(() => boom, 2, {
      system: 'stripe',
      idempotencyKey: 'order-3',
      recordedKey: 'order-3',
    });
    expect(records.map((r) => r.effect)).toEqual(['unknown', 'unknown']);
    expect(error).toBeInstanceOf(UnknownEffectError);
    const unknown = error as UnknownEffectError;
    expect(unknown.system).toBe('stripe');
    expect(unknown.idempotencyKey).toBe('order-3');
    expect(unknown.attempts).toBe(2);
    expect(unknown.cause).toBe(boom);
    expect(unknown.message).not.toContain('order-3');
  });

  it('a last attempt the adapter declared effect none fails with its OWN error', async () => {
    const declined = noEffect('card declined');
    const { error, records } = await series(() => declined, 1, { system: 'stripe' });
    expect(error).toBe(declined);
    expect(records[0].effect).toBe('none');
  });

  it('a non-touching series keeps its own error and records no effect fields (byte identity)', async () => {
    const boom = new Error('boom');
    const records: AttemptRecord[] = [];
    await expect(
      runAttempts(
        () => {
          throw boom;
        },
        { attempts: 1 },
        { series: 's', now, onAttempt: (r) => records.push(r) },
      ),
    ).rejects.toBe(boom);
    expect(Object.keys(records[0])).not.toContain('effect');
    expect(Object.keys(records[0])).not.toContain('system');
    expect(Object.keys(records[0])).not.toContain('idempotencyKey');
  });

  it('a pause stays a pause: effect unknown on the record, the PauseSignal rethrown', async () => {
    const pause = new PauseSignal({ ask: 1 }, 'charge');
    const { error, records } = await series(() => pause, 1, { system: 'stripe' });
    expect(error).toBe(pause);
    expect(records[0].effect).toBe('unknown');
  });

  it('refuses a touching series that may retry with no key — before anything runs', async () => {
    let ran = 0;
    await expect(
      runAttempts(
        () => {
          ran += 1;
        },
        { attempts: 2 },
        { series: 's', effect: { system: 'stripe' } },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(ran).toBe(0);
  });

  it('a wait the run cancelled ends the series with UnknownEffectError when the last effect is unknown', async () => {
    const controller = new AbortController();
    const records: AttemptRecord[] = [];
    const promise = runAttempts(
      () => {
        queueMicrotask(() => controller.abort(new Error('cancelled')));
        throw new Error('socket hang up');
      },
      { attempts: 3, backoffMs: 10_000 },
      {
        series: 's',
        signal: controller.signal,
        effect: { system: 'stripe', idempotencyKey: 'k1', recordedKey: 'k1' },
        onAttempt: (r) => records.push(r),
      },
    );
    await expect(promise).rejects.toBeInstanceOf(UnknownEffectError);
    expect(records).toHaveLength(1);
  });

  it('the summary names the last effect', async () => {
    let summary: unknown;
    await runAttempts(
      () => 'ok',
      { attempts: 1 },
      {
        series: 's',
        effect: { system: 'stripe' },
        onEnd: (s) => (summary = s),
      },
    );
    expect((summary as { last: { effect?: string } }).last.effect).toBe('applied');
  });

  it("the attempt's context carries the system and the RAW key — the function needs the real one", async () => {
    let seen: unknown;
    await runAttempts(
      (_n, context) => {
        seen = [context.system, context.idempotencyKey];
      },
      { attempts: 2 },
      { series: 's', effect: { system: 'stripe', idempotencyKey: 'order-raw', recordedKey: '[REDACTED]' } },
    );
    expect(seen).toEqual(['stripe', 'order-raw']);
  });
});

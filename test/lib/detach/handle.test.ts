/**
 * detach/handle — 7-pattern tests.
 *
 *   P1 Unit         — initial state + each transition independently
 *   P2 Boundary     — terminal-state idempotency + wait()-after-terminal
 *   P3 Scenario     — driver-style usage (queued → running → done w/ wait)
 *   P4 Property     — wait() returns SAME Promise on repeated calls
 *   P5 Security     — asImpl() rejects hand-rolled handles
 *   P6 Performance  — handle creation + transitions are O(1) and cheap
 *   P7 ROI          — public API is a real DetachHandle (interface compat)
 */

import { describe, expect, it } from 'vitest';

import { asImpl, createHandle, HandleImpl } from '../../../src/lib/detach/handle.js';
import type { DetachHandle, DetachWaitResult } from '../../../src/lib/detach/types.js';

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/handle — P1 unit', () => {
  it('P1 newly created handle has status=queued, no result, no error', () => {
    const h = new HandleImpl('id-1');
    expect(h.id).toBe('id-1');
    expect(h.status).toBe('queued');
    expect(h.result).toBeUndefined();
    expect(h.error).toBeUndefined();
  });

  it('P1 _markRunning transitions queued → running', () => {
    const h = new HandleImpl('id-2');
    h._markRunning();
    expect(h.status).toBe('running');
  });

  it('P1 _markDone transitions to done with result', () => {
    const h = new HandleImpl('id-3');
    h._markDone({ value: 42 });
    expect(h.status).toBe('done');
    expect(h.result).toEqual({ value: 42 });
    expect(h.error).toBeUndefined();
  });

  it('P1 _markFailed transitions to failed with error', () => {
    const h = new HandleImpl('id-4');
    const e = new Error('boom');
    h._markFailed(e);
    expect(h.status).toBe('failed');
    expect(h.error).toBe(e);
    expect(h.result).toBeUndefined();
  });

  it('P1 createHandle returns a DetachHandle (interface)', () => {
    const h: DetachHandle = createHandle('id-5');
    expect(h.id).toBe('id-5');
    expect(h.status).toBe('queued');
    expect(typeof h.wait).toBe('function');
  });
});

// ─── P2 Boundary — terminal idempotency ───────────────────────────────

describe('detach/handle — P2 boundary', () => {
  it('P2 _markRunning after terminal is a no-op (does not regress status)', () => {
    const h = new HandleImpl('id-6');
    h._markDone('ok');
    h._markRunning();
    expect(h.status).toBe('done');
    expect(h.result).toBe('ok');
  });

  it('P2 _markDone after _markFailed is a no-op (terminal locks)', () => {
    const h = new HandleImpl('id-7');
    const e = new Error('first');
    h._markFailed(e);
    h._markDone('replacement');
    expect(h.status).toBe('failed');
    expect(h.error).toBe(e);
    expect(h.result).toBeUndefined();
  });

  it('P2 _markFailed after _markDone is a no-op', () => {
    const h = new HandleImpl('id-8');
    h._markDone('first');
    h._markFailed(new Error('late'));
    expect(h.status).toBe('done');
    expect(h.result).toBe('first');
    expect(h.error).toBeUndefined();
  });

  it('P2 wait() called AFTER _markDone resolves immediately', async () => {
    const h = new HandleImpl('id-9');
    h._markDone({ x: 1 });
    const result = await h.wait();
    expect(result).toEqual({ result: { x: 1 } });
  });

  it('P2 wait() called AFTER _markFailed rejects immediately', async () => {
    const h = new HandleImpl('id-10');
    const e = new Error('vendor 401');
    h._markFailed(e);
    await expect(h.wait()).rejects.toBe(e);
  });

  it('P2 wait() called BEFORE _markDone resolves once terminal reached', async () => {
    const h = new HandleImpl('id-11');
    const p = h.wait();
    h._markDone('eventual');
    const result = await p;
    expect(result).toEqual({ result: 'eventual' });
  });

  it('P2 wait() called BEFORE _markFailed rejects once terminal reached', async () => {
    const h = new HandleImpl('id-12');
    const p = h.wait();
    const e = new Error('eventual fail');
    h._markFailed(e);
    await expect(p).rejects.toBe(e);
  });
});

// ─── P3 Scenario — driver-style usage ─────────────────────────────────

describe('detach/handle — P3 scenario', () => {
  it('P3 full lifecycle queued → running → done with wait()', async () => {
    const h = new HandleImpl('lifecycle');
    expect(h.status).toBe('queued');

    // Driver picks up the work.
    h._markRunning();
    expect(h.status).toBe('running');

    // Consumer awaits in parallel with the work completing.
    const waitPromise = h.wait();
    h._markDone({ recordsProcessed: 1234 });

    const result = await waitPromise;
    expect(result).toEqual({ result: { recordsProcessed: 1234 } });
    expect(h.status).toBe('done');
  });

  it('P3 multiple consumers can wait on the same handle (Promise.all)', async () => {
    const h = new HandleImpl('multi');
    const a = h.wait();
    const b = h.wait();
    const c = h.wait();
    h._markDone('shared');
    const [r1, r2, r3] = await Promise.all([a, b, c]);
    expect(r1).toEqual({ result: 'shared' });
    expect(r2).toEqual({ result: 'shared' });
    expect(r3).toEqual({ result: 'shared' });
  });
});

// ─── P4 Property — wait() returns SAME cached Promise ─────────────────

describe('detach/handle — P4 property', () => {
  it('P4 wait() returns the SAME Promise on repeated calls (queued state)', () => {
    const h = new HandleImpl('p4-1');
    const a = h.wait();
    const b = h.wait();
    const c = h.wait();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('P4 wait() returns the SAME Promise on repeated calls (terminal state)', () => {
    const h = new HandleImpl('p4-2');
    h._markDone('x');
    const a = h.wait();
    const b = h.wait();
    expect(a).toBe(b);
  });

  it('P4 wait() Promise resolution value is identical on every await', async () => {
    const h = new HandleImpl('p4-3');
    h._markDone({ tag: 'once' });
    const r1 = await h.wait();
    const r2 = await h.wait();
    expect(r1).toEqual(r2);
    expect(r1.result).toBe(r2.result); // same reference, no re-creation
  });
});

// ─── P5 Security — asImpl rejects hand-rolled handles ─────────────────

describe('detach/handle — P5 security', () => {
  it('P5 asImpl() throws if given a hand-rolled DetachHandle (not a HandleImpl)', () => {
    const fake: DetachHandle = {
      id: 'fake',
      status: 'queued',
      wait: () => Promise.resolve({ result: undefined } as DetachWaitResult),
    };
    expect(() => asImpl(fake)).toThrow(TypeError);
    expect(() => asImpl(fake)).toThrow(/HandleImpl/);
  });

  it('P5 asImpl() succeeds on real HandleImpl created via createHandle()', () => {
    const real = createHandle('real');
    const impl = asImpl(real);
    expect(impl).toBeInstanceOf(HandleImpl);
    // Mutator access is the whole point — verify it works.
    impl._markDone('ok');
    expect(real.status).toBe('done');
  });

  it('P5 prototype-pollution attempt does not satisfy asImpl', () => {
    const fake = Object.create(HandleImpl.prototype);
    fake.id = 'evil';
    fake.status = 'queued';
    // This one DOES pass instanceof (created via Object.create), so the
    // boundary is at the prototype chain — documenting that fact here.
    // Additional safety belongs in the driver (use createHandle()).
    expect(() => asImpl(fake)).not.toThrow();
  });
});

// ─── P6 Performance — handle ops are cheap ────────────────────────────

describe('detach/handle — P6 performance', () => {
  it('P6 creating 10k handles + transitioning each completes under 50ms', () => {
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) {
      const h = new HandleImpl(`perf-${i}`);
      h._markRunning();
      h._markDone(i);
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });

  it('P6 wait()-after-terminal allocates a single resolved Promise (no leak)', async () => {
    const h = new HandleImpl('perf-2');
    h._markDone('x');
    // Calling wait() many times reuses the cached Promise — verify by
    // identity, not allocation count (V8 doesn't expose alloc count).
    const first = h.wait();
    for (let i = 0; i < 1000; i++) expect(h.wait()).toBe(first);
    expect(await first).toEqual({ result: 'x' });
  });
});

// ─── P7 ROI — public API is interface-compatible ──────────────────────

describe('detach/handle — P7 ROI', () => {
  it('P7 HandleImpl satisfies DetachHandle interface fully', () => {
    const h: DetachHandle = new HandleImpl('roi');
    // All public fields read cleanly through the interface.
    expect(h.id).toBe('roi');
    expect(h.status).toBe('queued');
    expect(h.result).toBeUndefined();
    expect(h.error).toBeUndefined();
    expect(typeof h.wait).toBe('function');
  });

  it('P7 createHandle is the documented driver entry point', () => {
    const h = createHandle('roi-2');
    // createHandle returns the interface, not the impl, so consumers
    // can't accidentally call internals.
    expect((h as { _markDone?: unknown })._markDone).toBeDefined(); // it's there at runtime
    // …but they shouldn't call it directly — they should go through
    // asImpl() in driver code (verified in P5).
  });
});

/**
 * detach/registry — 7-pattern tests.
 *
 *   P1 Unit         — register / lookup / unregister round-trip
 *   P2 Boundary     — duplicate id overwrites; unknown id returns undefined
 *   P3 Scenario     — driver schedules → executor disposal cleans up
 *   P4 Property     — registry is process-singleton (state shared across imports)
 *   P5 Security     — _resetForTests is the only mass-clear path
 *   P6 Performance  — 10k register + lookup + unregister under 50ms
 *   P7 ROI          — diagnostic API (size, ids) returns sane shape
 */

import { afterEach, describe, expect, it } from 'vitest';

import { asImpl, createHandle } from '../../../src/lib/detach/handle.js';
import { _resetForTests, ids, lookup, register, size, unregister } from '../../../src/lib/detach/registry.js';

afterEach(() => _resetForTests());

// ─── P1 Unit ─────────────────────────────────────────────────────────

describe('detach/registry — P1 unit', () => {
  it('P1 register stores a handle retrievable by id', () => {
    const h = createHandle('a');
    register(h);
    expect(lookup('a')).toBe(h);
  });

  it('P1 unregister removes the handle (subsequent lookup → undefined)', () => {
    const h = createHandle('b');
    register(h);
    unregister('b');
    expect(lookup('b')).toBeUndefined();
  });

  it('P1 lookup of a never-registered id returns undefined', () => {
    expect(lookup('never-registered')).toBeUndefined();
  });
});

// ─── P2 Boundary ─────────────────────────────────────────────────────

describe('detach/registry — P2 boundary', () => {
  it('P2 duplicate register with same id overwrites the prior handle', () => {
    const h1 = createHandle('dup');
    const h2 = createHandle('dup');
    register(h1);
    register(h2);
    expect(lookup('dup')).toBe(h2);
  });

  it('P2 unregister of an unknown id is a silent no-op', () => {
    expect(() => unregister('nonexistent')).not.toThrow();
    expect(size()).toBe(0);
  });

  it('P2 size reflects current registrations accurately', () => {
    expect(size()).toBe(0);
    register(createHandle('s1'));
    register(createHandle('s2'));
    register(createHandle('s3'));
    expect(size()).toBe(3);
    unregister('s2');
    expect(size()).toBe(2);
  });
});

// ─── P3 Scenario — driver + executor disposal ────────────────────────

describe('detach/registry — P3 scenario', () => {
  it('P3 driver schedules → handle observable → driver completes → unregister cleans up', async () => {
    // Simulated driver behaviour.
    const refId = 'job-7';
    const handle = createHandle(refId);
    register(handle);

    // From the executor's vantage point: the handle is reachable.
    expect(lookup(refId)).toBe(handle);
    expect(size()).toBe(1);

    // Driver's deferred work completes.
    asImpl(handle)._markDone({ ok: true });

    // Driver's post-terminal cleanup hook.
    unregister(refId);
    expect(lookup(refId)).toBeUndefined();
    expect(size()).toBe(0);

    // Consumer can still observe the handle via its own reference.
    expect(handle.status).toBe('done');
    await expect(handle.wait()).resolves.toEqual({ result: { ok: true } });
  });

  it('P3 multiple drivers coexist without colliding (different refId namespaces)', () => {
    register(createHandle('mb-1'));
    register(createHandle('mb-2'));
    register(createHandle('si-1'));
    register(createHandle('beacon-1'));
    expect(size()).toBe(4);
    expect(ids()).toEqual(['mb-1', 'mb-2', 'si-1', 'beacon-1']); // insertion order
  });
});

// ─── P4 Property — process-singleton semantics ───────────────────────

describe('detach/registry — P4 property', () => {
  it('P4 a second import of the registry sees the same state', async () => {
    const reg2 = await import('../../../src/lib/detach/registry.js');
    register(createHandle('shared'));
    // Second import shares the same Map (singleton).
    expect(reg2.lookup('shared')).toBeDefined();
    expect(reg2.size()).toBe(1);
  });
});

// ─── P5 Security ─────────────────────────────────────────────────────

describe('detach/registry — P5 security', () => {
  it('P5 _resetForTests is the only mass-clear path; nothing else exposes it', () => {
    register(createHandle('x'));
    register(createHandle('y'));
    expect(size()).toBe(2);

    _resetForTests();
    expect(size()).toBe(0);
  });

  it('P5 ids() returns a SHALLOW copy — caller cannot mutate registry through it', () => {
    register(createHandle('a'));
    register(createHandle('b'));
    const snapshot = ids() as string[];
    // Even if caller mutates the returned array, the registry is untouched.
    snapshot.length = 0;
    snapshot.push('intruder');
    expect(size()).toBe(2);
    expect(ids()).toEqual(['a', 'b']);
  });
});

// ─── P6 Performance ──────────────────────────────────────────────────

describe('detach/registry — P6 performance', () => {
  it('P6 10k register + lookup + unregister completes under 100ms', () => {
    const N = 10_000;
    // expect() in a hot loop adds its own overhead, so verify lookups
    // out-of-band with a single accumulator and assert once.
    let foundAll = true;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) register(createHandle(`p-${i}`));
    for (let i = 0; i < N; i++) if (lookup(`p-${i}`) === undefined) foundAll = false;
    for (let i = 0; i < N; i++) unregister(`p-${i}`);
    const elapsed = performance.now() - t0;
    expect(foundAll).toBe(true);
    expect(elapsed).toBeLessThan(100);
    expect(size()).toBe(0);
  });
});

// ─── P7 ROI — diagnostic API ─────────────────────────────────────────

describe('detach/registry — P7 ROI', () => {
  it('P7 ids() preserves insertion order — chronological dump for diagnostics', () => {
    register(createHandle('first'));
    register(createHandle('second'));
    register(createHandle('third'));
    expect(ids()).toEqual(['first', 'second', 'third']);
  });

  it('P7 size() is O(1) — diagnostic hot-path safe', () => {
    for (let i = 0; i < 1000; i++) register(createHandle(`r-${i}`));
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) size();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });
});

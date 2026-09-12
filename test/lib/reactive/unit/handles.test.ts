/**
 * reactive/handles — the registry and the copy-on-write walk, in isolation.
 *
 * Test types: Unit (each function) · Edge (leaves, cycles, empty containers) ·
 * Integration-lite (a real typed scope's handles resolve to the live value).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { isHandle, rememberHandle, unwrapHandles, valueBehind } from '../../../../src/lib/reactive/handles.js';

describe('rememberHandle / isHandle / valueBehind', () => {
  it('a registered object is a handle whose value is what its reader returns NOW', () => {
    let current = { n: 1 };
    const handle = rememberHandle(new Proxy({}, {}), () => current);
    expect(isHandle(handle)).toBe(true);
    expect(valueBehind(handle)).toBe(current);
    current = { n: 2 };
    expect(valueBehind(handle)).toBe(current); // live, not captured
  });

  it('anything else is not a handle and comes back as itself', () => {
    const plain = { a: 1 };
    expect(isHandle(plain)).toBe(false);
    expect(isHandle(null)).toBe(false);
    expect(isHandle(7)).toBe(false);
    expect(valueBehind(plain)).toBe(plain);
    expect(valueBehind(null)).toBe(null);
    expect(valueBehind('s')).toBe('s');
  });
});

describe('unwrapHandles — copy-on-write', () => {
  const raw = { id: 'x', when: new Date('2026-01-01T00:00:00Z') };
  const handle = () => rememberHandle(new Proxy({}, {}), () => raw);

  it('a handle-free value is returned as the SAME reference, however deep', () => {
    const value = { a: [1, { b: new Map([['k', 1]]), c: new Set([1]) }], d: new Date(0) };
    expect(unwrapHandles(value)).toBe(value);
  });

  it('a handle is replaced by the value behind it, in O(1), and NOT entered', () => {
    const h = handle();
    expect(unwrapHandles(h)).toBe(raw);
  });

  it('a container holding a handle is copied along the path only; untouched siblings share', () => {
    const sibling = { s: 1 };
    const inner = [handle(), 2];
    const value = { sibling, inner, tail: 'x' };
    const out = unwrapHandles(value);
    expect(out).not.toBe(value);
    expect(out.sibling).toBe(sibling); // shared
    expect(out.inner).not.toBe(inner); // copied — it held the handle
    expect(out.inner[0]).toBe(raw);
    expect(out.inner[1]).toBe(2);
    expect(out.tail).toBe('x');
    expect(value.inner[0]).not.toBe(raw); // the input is never mutated
  });

  it('a Date, Map, Set or class instance is a leaf — never walked, never copied', () => {
    class Box {
      constructor(public held: unknown) {}
    }
    const box = new Box(handle());
    const map = new Map([['h', handle()]]);
    const value = { box, map };
    const out = unwrapHandles(value);
    expect(out).toBe(value); // nothing the walk enters changed
    expect(out.box.held).not.toBe(raw); // and the leaf's inside is left alone (a commit of it still refuses, loudly)
  });

  it('a cycle among plain containers is tolerated (structuredClone handles cycles; only a Proxy stops it)', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(unwrapHandles(a)).toBe(a);
    const b: Record<string, unknown> = { name: 'b', h: handle() };
    b.self = b;
    const out = unwrapHandles(b);
    expect(out.h).toBe(raw);
    expect(out.self).toBe(b); // the back-edge still points at the input — not re-walked
  });

  it('empty containers, null and primitives pass through', () => {
    const empty = {};
    const none: unknown[] = [];
    expect(unwrapHandles(empty)).toBe(empty);
    expect(unwrapHandles(none)).toBe(none);
    expect(unwrapHandles(null)).toBe(null);
    expect(unwrapHandles(undefined)).toBe(undefined);
    expect(unwrapHandles(3)).toBe(3);
  });
});

describe('a real typed scope hands out handles the registry knows', () => {
  it('nested, element and array handles resolve to the live raw value; a primitive read is not a handle', async () => {
    const seen: Record<string, unknown> = {};
    const chart = flowChart<any>(
      'Write',
      (s: any) => {
        s.doc = { meta: { v: 1 }, rows: [{ id: 'r0' }] };
        seen.docIsHandle = isHandle(s.doc);
        seen.metaIsHandle = isHandle(s.doc.meta);
        seen.rowsIsHandle = isHandle(s.doc.rows);
        seen.rowIsHandle = isHandle(s.doc.rows[0]);
        seen.primitive = isHandle(s.doc.meta.v);
        s.doc.meta.v = 2; // the handle reads live: the value behind it is the NEW meta
        seen.metaBehind = valueBehind(s.doc.meta);
        seen.rowsBehind = unwrapHandles(s.doc.rows);
      },
      'write',
    ).build();
    await new FlowChartExecutor(chart).run();
    expect(seen.docIsHandle).toBe(true);
    expect(seen.metaIsHandle).toBe(true);
    expect(seen.rowsIsHandle).toBe(true);
    expect(seen.rowIsHandle).toBe(true);
    expect(seen.primitive).toBe(false);
    expect(seen.metaBehind).toEqual({ v: 2 });
    expect(isHandle(seen.metaBehind)).toBe(false); // the value behind a handle holds no handles
    expect(seen.rowsBehind).toEqual([{ id: 'r0' }]);
    expect(isHandle((seen.rowsBehind as unknown[])[0])).toBe(false);
  });
});

/**
 * reactive/liveView — what a proxy stands for, AS IT STANDS NOW.
 *
 * Every write through the typed scope rebuilds the root immutably
 * (`structuralWrite.setInPath`, a fresh merge), so the object a proxy was
 * created over is the PRE-write value for ever after. A held proxy that read
 * from it saw its own writes vanish: `o.x += 1` twice gave 2, `o.b = o.a * 10`
 * used the old `a`, `'x' in o` was false right after `o.x = 1` (9.22.0 — first
 * found on element proxies, then the same root on nested and terminal ones).
 * So every read trap resolves through the CURRENT value and falls back to the
 * captured object only when the path is gone or no longer holds an object.
 *
 * The READ side of every object proxy lives here — {@link liveObject},
 * {@link liveGetTrap}, {@link liveInspectionTraps}, and the ONE per-member
 * proxy cache {@link cachedMember} (9.23.2); the WRITE side is
 * `writeTraps.ts`. A factory only wires them (9.23.1).
 */

import { toJSONView } from './jsonProjection.js';

/**
 * A proxy per member NAME under one parent proxy, validated by the raw
 * member's identity. The map is allocated on the FIRST insert: an element
 * proxy over `{ id, n }` reads only primitives and must not pay for one
 * (10,000 of them in the naive re-read loop — measured, `bench/nested-reads.ts`).
 */
export class MemberCache {
  private entries?: Map<string, { ref: object; proxy: unknown }>;

  /** The proxy cached under `prop`, if it was built over exactly this raw `value`. */
  hit(prop: string, value: object): unknown {
    const cached = this.entries?.get(prop);
    return cached !== undefined && cached.ref === value ? cached.proxy : undefined;
  }

  remember(prop: string, value: object, proxy: unknown): void {
    (this.entries ??= new Map()).set(prop, { ref: value, proxy });
  }

  /** Forget `prop` — a write replaced its value, so the next read must build over the new one. */
  delete(prop: string): void {
    this.entries?.delete(prop);
  }
}

/**
 * WHY the cache: `o.arr === o.arr` must hold within a stage, and
 * `for (i < N) s.k.arr[i]` must build ONE array proxy — whose element cache
 * then serves every index — not N (the 9.22.0 perf review, finding 4: the
 * nested get trap built a fresh array proxy, with a fresh empty element
 * cache, on every `.arr`). The top-level scope has cached its child proxies
 * this way since before 9.22.0; this is that leaf, shared by all four.
 *
 * Validated by IDENTITY, invalidated by replacement: every write through a
 * proxy rebuilds the containers on its path (`structuralWrite.setInPath`),
 * so after `s.k.arr[0].n = 1` the raw `arr` is a new array, the ref check
 * misses, and the next read builds a proxy over the NEW value. A hit can
 * never be stale — every proxy reads live (`liveGetTrap`), so the cached one
 * and a fresh one answer the same.
 *
 * Keyed by NAME under THIS parent, never by the raw value alone: a diamond
 * (one array under `k.a` and `k.b`) needs two proxies, each bound to its own
 * path and sink. Only what `build` actually WRAPPED is kept — a member handed
 * back raw (a `Date`, a frozen object, a cycle edge) is not worth an entry.
 * `build` is the caller's stable child step, not a closure made per read: a
 * hit allocates nothing, and a primitive member skips the cache entirely.
 */
export function cachedMember(
  cache: MemberCache,
  prop: string,
  value: unknown,
  build: (value: unknown, path: string[]) => unknown,
  segments: readonly string[],
): unknown {
  if (value === null || typeof value !== 'object') return build(value, [...segments, prop]);
  const hit = cache.hit(prop, value);
  if (hit !== undefined) return hit;
  const proxy = build(value, [...segments, prop]);
  if (proxy !== value) cache.remember(prop, value, proxy);
  return proxy;
}

/** The object at `segments` under the current root, or `raw` when it is gone. */
export function liveObject(raw: Record<string, unknown>, current: unknown): Record<string, unknown> {
  return current !== null && typeof current === 'object' && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : raw;
}

/**
 * WHY one get trap: the names a proxy answers ITSELF (promise/matcher guards,
 * `constructor`, and the JSON law — serializing a proxied value equals
 * serializing the raw one, `jsonProjection.ts`) must be the same three lines
 * on every object proxy; any other member is handed to `child` with its full
 * path — through the parent's {@link cachedMember} — and only THAT step
 * differs per factory (the cycle policy).
 */
export function liveGetTrap(
  live: () => Record<string, unknown>,
  segments: readonly string[],
  child: (value: unknown, path: string[]) => unknown,
  members: MemberCache,
): ProxyHandler<object>['get'] {
  return (_target, prop) => {
    const raw = live();
    if (typeof prop === 'symbol') return (raw as any)[prop];
    if (prop === 'then' || prop === 'asymmetricMatch') return undefined;
    if (prop === 'constructor') return Object;
    if (prop === 'toJSON') return () => toJSONView(raw);
    return cachedMember(members, prop, raw[prop], child, segments);
  };
}

/**
 * The three inspection traps (`in`, `Object.keys`, descriptors) answered from
 * the live object. The one Proxy invariant that could bite — a non-extensible
 * target must report exactly its own keys, and a property the target lacks
 * must be reported configurable — is honoured: the allowlist already refuses
 * frozen and sealed values, so the `preventExtensions`-only corner answers
 * from the target, and a live descriptor is always reported configurable.
 */
export function liveInspectionTraps(
  live: () => object,
): Pick<ProxyHandler<object>, 'has' | 'ownKeys' | 'getOwnPropertyDescriptor'> {
  return {
    has(target, prop) {
      return Reflect.has(Object.isExtensible(target) ? live() : target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(Object.isExtensible(target) ? live() : target);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (!Object.isExtensible(target)) return Object.getOwnPropertyDescriptor(target, prop);
      const descriptor = Object.getOwnPropertyDescriptor(live(), prop);
      return descriptor && !descriptor.configurable ? { ...descriptor, configurable: true } : descriptor;
    },
  };
}

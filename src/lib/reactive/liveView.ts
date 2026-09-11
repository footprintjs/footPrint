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
 * {@link liveGetTrap}, {@link liveInspectionTraps}; the WRITE side is
 * `writeTraps.ts`. A factory only wires them (9.23.1).
 */

import { toJSONView } from './jsonProjection.js';

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
 * path, and only THAT step differs per factory (the cycle policy).
 */
export function liveGetTrap(
  live: () => Record<string, unknown>,
  segments: readonly string[],
  child: (value: unknown, path: string[]) => unknown,
): ProxyHandler<object>['get'] {
  return (_target, prop) => {
    const raw = live();
    if (typeof prop === 'symbol') return (raw as any)[prop];
    if (prop === 'then' || prop === 'asymmetricMatch') return undefined;
    if (prop === 'constructor') return Object;
    if (prop === 'toJSON') return () => toJSONView(raw);
    return child(raw[prop], [...segments, prop]);
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

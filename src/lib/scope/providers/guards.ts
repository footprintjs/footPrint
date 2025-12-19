/**
 * Guards — Heuristic functions for detecting input types
 *
 * Used by the registry to determine whether an input is a class constructor,
 * factory function, or ScopeFacade subclass.
 */

import { ScopeFacade } from '../ScopeFacade';

type CallableFunction = (...args: unknown[]) => unknown;

/** Heuristic: class constructor vs. plain function */
export function looksLikeClassCtor(fn: unknown): fn is CallableFunction {
  if (typeof fn !== 'function') return false;

  try {
    const src = Function.prototype.toString.call(fn);
    if (/^\s*class\s/.test(src)) return true;
  } catch {
    /* ignore */
  }

  const proto = (fn as any).prototype;
  if (!proto || proto.constructor !== fn) return false;

  const ownNames = Object.getOwnPropertyNames(proto);
  return ownNames.length > 1;
}

/** Heuristic: factory function (a function that is NOT a class ctor) */
export function looksLikeFactory(fn: unknown): fn is CallableFunction {
  return typeof fn === 'function' && !looksLikeClassCtor(fn);
}

/** True iff `ctor` is a class that extends ScopeFacade (checks prototype chain) */
export function isSubclassOfScopeFacade(ctor: unknown): boolean {
  if (!looksLikeClassCtor(ctor)) return false;
  const baseProto = ScopeFacade.prototype;
  let p: any = (ctor as any).prototype;
  while (p) {
    if (p === baseProto) return true;
    p = Object.getPrototypeOf(p);
  }
  return false;
}

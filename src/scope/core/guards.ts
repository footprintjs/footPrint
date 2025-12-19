import { BaseState } from './BaseState';

/** Heuristic: class constructor vs. plain function */
export function looksLikeClassCtor(fn: unknown): fn is Function {
    if (typeof fn !== "function") return false;

    // Primary: Native classes stringify starting with "class "
    try {
        const src = Function.prototype.toString.call(fn);
        if (/^\s*class\s/.test(src)) return true;
    } catch {
        /* ignore */
    }

    // Fallback: functions that behave like classes usually have a prototype object
    // with more than just "constructor" (i.e., instance methods defined).
    const proto = (fn as any).prototype;
    if (!proto || proto.constructor !== fn) return false;

    // If there are instance methods, it's definitely a class-like ctor.
    const ownNames = Object.getOwnPropertyNames(proto);
    if (ownNames.length > 1) return true;

    // As a last resort, treat functions with a "prototype" as NOT classes
    // unless the stringify check already caught them. This keeps arrows/normal fns out.
    return false;
}

/** Heuristic: factory function (a function that is NOT a class ctor) */
export function looksLikeFactory(fn: unknown): fn is Function {
    return typeof fn === "function" && !looksLikeClassCtor(fn);
}

/** True iff `ctor` is a class that extends BaseState (checks prototype chain) */
export function isSubclassOfStateScope(ctor: unknown): boolean {
    if (!looksLikeClassCtor(ctor)) return false;
    const baseProto = BaseState.prototype;
    let p: any = (ctor as any).prototype;
    while (p) {
        if (p === baseProto) return true;
        p = Object.getPrototypeOf(p);
    }
    return false;
}

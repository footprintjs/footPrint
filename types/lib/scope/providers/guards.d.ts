/**
 * Guards — Heuristic functions for detecting input types
 *
 * Used by the registry to determine whether an input is a class constructor,
 * factory function, or ScopeFacade subclass.
 */
type CallableFunction = (...args: unknown[]) => unknown;
/** Heuristic: class constructor vs. plain function */
export declare function looksLikeClassCtor(fn: unknown): fn is CallableFunction;
/** Heuristic: factory function (a function that is NOT a class ctor) */
export declare function looksLikeFactory(fn: unknown): fn is CallableFunction;
/** True iff `ctor` is a class that extends ScopeFacade (checks prototype chain) */
export declare function isSubclassOfScopeFacade(ctor: unknown): boolean;
export {};

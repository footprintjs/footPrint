/**
 * attachScopeMethods — Attach ScopeFacade-compatible methods onto any target object.
 *
 * Gives non-class scopes (like Zod-generated proxies) the same convenience
 * methods as ScopeFacade subclasses: getValue, setValue, addDebugInfo, etc.
 *
 * API matches ScopeFacade's simplified signatures (no path arrays).
 */
import type { StageContextLike } from './types.js';
/** Attach ScopeFacade-compatible methods onto any target (e.g., a proxy scope). */
export declare function attachScopeMethods<T extends object>(target: T, ctx: StageContextLike, stageName: string, readOnly?: unknown): T & {
    addDebugInfo(k: string, v: unknown): void;
    addDebugMessage(v: unknown): void;
    addErrorInfo(k: string, v: unknown): void;
    addMetric(name: string, v: unknown): void;
    addEval(name: string, v: unknown): void;
    getInitialValueFor(k: string): unknown;
    getValue(key?: string): unknown;
    setValue(key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
    updateValue(key: string, value: unknown, description?: string): void;
    setObjectInRoot(key: string, value: unknown): void;
    getArgs<T = Record<string, unknown>>(): T;
    getPipelineId(): string | undefined;
};

/**
 * attachScopeMethods — Attach ScopeFacade-compatible methods onto any target object.
 *
 * Gives non-class scopes (like Zod-generated proxies) the same convenience
 * methods as ScopeFacade subclasses: getValue, setValue, addDebugInfo, etc.
 *
 * API matches ScopeFacade's simplified signatures (no path arrays).
 */

import type { StageContextLike } from './types';

/** @deprecated Use attachScopeMethods instead. */
export const attachBaseStateCompat = attachScopeMethods;

/** Attach ScopeFacade-compatible methods onto any target (e.g., a proxy scope). */
export function attachScopeMethods<T extends object>(
  target: T,
  ctx: StageContextLike,
  stageName: string,
  readOnly?: unknown,
): T & {
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
  getReadOnlyValues(): unknown;
  getPipelineId(): string | undefined;
} {
  const methods = {
    addDebugInfo: (k: string, v: unknown) => ctx.addLog?.(k, v),
    addDebugMessage: (v: unknown) => ctx.addLog?.('messages', [v]),
    addErrorInfo: (k: string, v: unknown) => ctx.addError?.(k, v),
    addMetric: (name: string, v: unknown) => ctx.addLog?.(`metric:${name}`, v),
    addEval: (name: string, v: unknown) => ctx.addLog?.(`eval:${name}`, v),

    getInitialValueFor: (k: string) => ctx.getFromGlobalContext?.(k),
    getValue: (key?: string) => ctx.getValue([], key),
    setValue: (key: string, value: unknown, shouldRedact = false, description?: string) =>
      (ctx as any).setObject([], key, value, shouldRedact, description),
    updateValue: (key: string, value: unknown, description?: string) => ctx.updateObject([], key, value, description),
    setObjectInRoot: (key: string, value: unknown) => ctx.setRoot?.(key, value),

    getReadOnlyValues: () => readOnly,
    getPipelineId: () => ctx.pipelineId ?? ctx.runId,
  };

  return Object.assign(target, methods);
}

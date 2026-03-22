/**
 * reactive/types -- Type definitions for the TypedScope<T> reactive proxy system.
 *
 * TypedScope<T> wraps a ReactiveTarget (ScopeFacade) in a Proxy that provides
 * typed property access. All scope infrastructure methods are $-prefixed to
 * avoid collisions with user state keys.
 *
 * Dependency: type-only imports from engine/ and scope/ (zero runtime cost).
 */

import type { ExecutionEnv } from '../engine/types.js';
import type { Recorder } from '../scope/types.js';

// -- ReactiveTarget ----------------------------------------------------------
// Minimum protocol required by TypedScope -- a curated subset of ScopeFacade's
// public API. Not a full mirror: excludes internal/redaction methods that are
// handled at the executor level (useRedactionPolicy, useSharedRedactedKeys, etc.)
// and infrastructure methods (getPipelineId, setGlobal, getGlobal, etc.).

export interface ReactiveTarget {
  // State access (tracked by recorders)
  getValue(key?: string): unknown;
  setValue(key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
  updateValue(key: string, value: unknown, description?: string): void;
  deleteValue(key: string, description?: string): void;

  // Non-tracking state inspection (for proxy internals — no recorder dispatch)
  /** Returns all state keys without firing onRead. Used by ownKeys/has traps. */
  getStateKeys?(): string[];
  /** Check key existence without firing onRead. Used by has trap. */
  hasKey?(key: string): boolean;

  // Input & environment (readonly, NOT tracked)
  getArgs<T = Record<string, unknown>>(): T;
  getEnv(): Readonly<ExecutionEnv>;

  // Recorder management
  attachRecorder(recorder: Recorder): void;
  detachRecorder(recorderId: string): void;
  getRecorders(): Recorder[];

  // Diagnostics
  addDebugInfo(key: string, value: unknown): void;
  addDebugMessage(value: unknown): void;
  addErrorInfo(key: string, value: unknown): void;
  addMetric(name: string, value: unknown): void;
  addEval(name: string, value: unknown): void;
}

// -- ScopeMethods ------------------------------------------------------------
// $-prefixed escape hatches. Non-enumerable on the proxy -- don't appear in
// Object.keys(), destructuring, or for...in. Only state keys are visible.

export interface ScopeMethods {
  // State (untyped escape hatch -- for dynamic keys, redaction, description)
  $getValue(key: string): unknown;
  $setValue(key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
  $update(key: string, value: unknown, description?: string): void;
  $delete(key: string, description?: string): void;
  /** Proxy-synthesized: calls getValue(rootKey) then lodash.get for nested path. Not a direct delegation. */
  $read(dotPath: string): unknown;

  // Input & environment (readonly)
  $getArgs<T = Record<string, unknown>>(): T;
  $getEnv(): Readonly<ExecutionEnv>;

  // Observability
  $debug(key: string, value: unknown): void;
  $log(value: unknown): void;
  $error(key: string, value: unknown): void;
  $metric(name: string, value: unknown): void;
  $eval(name: string, value: unknown): void;

  // Recorder management
  $attachRecorder(recorder: Recorder): void;
  $detachRecorder(recorderId: string): void;
  $getRecorders(): Recorder[];

  // Pipeline control
  $break(): void;

  // Escape hatch -- unwrap to underlying ReactiveTarget
  $toRaw(): ReactiveTarget;
}

// -- TypedScope<T> -----------------------------------------------------------
// The consumer-facing type. T is the user's state interface.
// Property access is typed; $-methods provide escape hatches.

export type TypedScope<T extends Record<string, unknown> = Record<string, unknown>> = T & ScopeMethods;

// -- ReactiveOptions ---------------------------------------------------------
// Configuration passed to createTypedScope.

export interface ReactiveOptions {
  /** Pipeline break function -- injected by StageRunner after scope creation. */
  breakPipeline?: () => void;
}

// -- Internal: $-method name set ---------------------------------------------
// Used by the Proxy get trap to distinguish $-methods from state keys.

export const SCOPE_METHOD_NAMES = new Set<string>([
  '$getValue',
  '$setValue',
  '$update',
  '$delete',
  '$read',
  '$getArgs',
  '$getEnv',
  '$debug',
  '$log',
  '$error',
  '$metric',
  '$eval',
  '$attachRecorder',
  '$detachRecorder',
  '$getRecorders',
  '$break',
  '$toRaw',
]);

// -- Internal: Symbol for deferred break injection ---------------------------
// StageRunner sets this after scope creation so $break() works.
// Private Symbol (not Symbol.for) to prevent cross-module tampering.

export const BREAK_SETTER = Symbol('footprint:reactive:setBreak');

// -- Internal: Symbol for TypedScope detection -------------------------------
// Used by StageRunner to skip createProtectedScope for TypedScope instances.
// Private Symbol prevents string-tag spoofing.

export const IS_TYPED_SCOPE = Symbol('footprint:reactive:isTypedScope');

// -- Internal: executor method allowlist -------------------------------------
// ScopeFacade methods called by FlowChartExecutor wrapping code and StageRunner
// THROUGH a TypedScope proxy. Only add methods with confirmed call sites.
// Shared between createTypedScope.ts and StageRunner.ts to prevent drift.

export const EXECUTOR_INTERNAL_METHODS = new Set([
  'notifyStageStart', // StageRunner.run() line 59
  'notifyStageEnd', // StageRunner.run() line 79
  'attachRecorder', // FlowChartExecutor.createTraverser() — narrative + user recorders
  'detachRecorder', // FlowChartExecutor.detachRecorder()
  'getRecorders', // FlowChartExecutor.getRecorders()
  'useSharedRedactedKeys', // FlowChartExecutor.createTraverser() — redaction wrapping
  'useRedactionPolicy', // FlowChartExecutor.createTraverser() — redaction wrapping
]);

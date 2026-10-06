/**
 * The scope ↔ engine protocol. A user-facing scope may be a strict schema
 * proxy: asking it for an infrastructure member is a state access, not a
 * capability check. Registration keeps that boundary entirely out of band.
 *
 * This module owns identity and capabilities, not their implementation.
 * ScopeFacade owns recording, redaction and state access; custom scopes may
 * explicitly supply a smaller port (including `{}` for data-only scopes).
 */

import type { RedactionPolicy, ScopeRecorder } from './types.js';

/** Engine-facing capabilities. Never use a strict user-field proxy as this port. */
export interface ScopeRuntimeTarget {
  attachScopeRecorder?(recorder: ScopeRecorder): void;
  detachScopeRecorder?(recorderId: string): void;
  getScopeRecorders?(): ScopeRecorder[];
  useSharedRedactedKeys?(keys: Set<string>): void;
  useRedactionPolicy?(policy: RedactionPolicy): void;
  getRedactedKeys?(): Set<string>;
  notifyStageStart?(): void;
  notifyStageEnd?(duration?: number): void;
  notifyPause?(data?: unknown): void;
  getValue?(key?: string): unknown;
  setValue?(key: string, value: unknown, shouldRedact?: boolean, description?: string): void;
}

export interface ScopeRuntime {
  readonly target: ScopeRuntimeTarget;
  /** The scope already routes property assignments into managed state. */
  readonly handlesAssignments: boolean;
  /** Install this execution's break callback, if the scope exposes one. */
  readonly setBreak?: (breakPipeline: (reason?: string) => void) => void;
}

const runtimes = new WeakMap<object, Readonly<ScopeRuntime>>();

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * Register a custom scope's engine-facing port and return the SAME scope.
 * Registration never reads, writes or enumerates properties on `scope`.
 * Re-registering explicitly replaces its binding. The descriptor is copied
 * and frozen; the target itself remains live and belongs to its provider.
 *
 * @example
 * const facade = new ScopeFacade(context, stageName, input, env);
 * return registerScopeRuntime(myProxy, { target: facade, handlesAssignments: true });
 */
export function registerScopeRuntime<T extends object>(scope: T, runtime: ScopeRuntime): T {
  if (!isObject(scope)) throw new TypeError('registerScopeRuntime: scope must be an object');
  if (!runtime || !isObject(runtime.target) || typeof runtime.handlesAssignments !== 'boolean') {
    throw new TypeError('registerScopeRuntime: provide a target port and boolean handlesAssignments');
  }
  if (runtime.setBreak !== undefined && typeof runtime.setBreak !== 'function') {
    throw new TypeError('registerScopeRuntime: setBreak must be a function when supplied');
  }
  runtimes.set(
    scope,
    Object.freeze({
      target: runtime.target,
      handlesAssignments: runtime.handlesAssignments,
      setBreak: runtime.setBreak,
    }),
  );
  return scope;
}

/** @internal Optional only for wrappers that also work outside the engine. */
export function scopeRuntimeFor(scope: unknown): Readonly<ScopeRuntime> | undefined {
  return isObject(scope) ? runtimes.get(scope) : undefined;
}

const UNREGISTERED =
  '[footprint] Unregistered scope. Custom scope factories must call registerScopeRuntime(scope, ' +
  '{ target, handlesAssignments }) from footprintjs/advanced. ScopeFacade and built-in scope factories register automatically.';

const UNREGISTERED_DECISION =
  "[footprint] decide()/select() needs the stage's scope (the object your stage function receives), " +
  'not a plain object. A hand-built scope must be registered with registerScopeRuntime(scope, ' +
  '{ target, handlesAssignments }) from footprintjs/advanced.';

/** @internal No method-name guessing: a missing registration is an explicit migration error. */
export function requireScopeRuntime(scope: unknown, message: string = UNREGISTERED): Readonly<ScopeRuntime> {
  const runtime = scopeRuntimeFor(scope);
  if (runtime) return runtime;
  throw new TypeError(message);
}

/** @internal decide()/select() asked outside a stage: name THEM, not the custom-factory migration. */
export function requireDecisionScopeRuntime(scope: unknown): Readonly<ScopeRuntime> {
  return requireScopeRuntime(scope, UNREGISTERED_DECISION);
}

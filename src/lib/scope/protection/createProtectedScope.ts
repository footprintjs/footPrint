/**
 * Scope Protection — Proxy-based protection layer
 *
 * Intercepts direct property assignments on scope objects and provides
 * clear error messages guiding developers to use setValue() instead.
 */

import type { ScopeProtectionOptions } from './types';

export function createErrorMessage(propertyName: string, stageName: string): string {
  return `[Scope Access Error] Direct property assignment detected in stage "${stageName}".

Incorrect: scope.${propertyName} = value

Correct: scope.setValue('${propertyName}', value)

Why this matters:
Each stage receives a NEW scope instance from ScopeFactory. Direct property
assignments are lost when the next stage executes. Use setValue()
to persist data to the shared GlobalStore.`;
}

export function createProtectedScope<T extends object>(
  scope: T,
  options: ScopeProtectionOptions = {},
): T {
  const {
    mode = 'error',
    stageName = 'unknown',
    logger = console.warn,
    allowedInternalProperties = [
      'writeBuffer', 'next', 'children', 'parent', 'executionHistory',
      'branchId', 'isDecider', 'isFork', 'debug', 'stageName', 'pipelineId',
      'globalStore',
    ],
  } = options;

  if (mode === 'off') {
    return scope;
  }

  const allowedInternals = new Set<string | symbol>(allowedInternalProperties);

  return new Proxy(scope, {
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver);
    },

    set(target, prop, value, receiver) {
      if (allowedInternals.has(prop)) {
        return Reflect.set(target, prop, value, receiver);
      }

      const propName = String(prop);
      const message = createErrorMessage(propName, stageName);

      if (mode === 'error') {
        throw new Error(message);
      } else if (mode === 'warn') {
        logger(message);
        return Reflect.set(target, prop, value, receiver);
      }

      return Reflect.set(target, prop, value, receiver);
    },
  });
}

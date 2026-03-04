/**
 * Scope Protection Implementation
 * 
 * Provides a Proxy-based protection layer that intercepts direct property
 * assignments on scope objects and provides clear error messages.
 */

import { ScopeProtectionOptions } from './types';

/**
 * Creates a descriptive error message for direct property assignment.
 * 
 * @param propertyName - The property that was being assigned
 * @param stageName - The stage where the error occurred
 * @returns A formatted error message with guidance
 */
export function createErrorMessage(propertyName: string, stageName: string): string {
  return `[Scope Access Error] Direct property assignment detected in stage "${stageName}".

❌ Incorrect: scope.${propertyName} = value

✅ Correct: scope.setValue('${propertyName}', value)

Why this matters:
Each stage receives a NEW scope instance from ScopeFactory. Direct property
assignments are lost when the next stage executes. Use setValue()
to persist data to the shared GlobalStore.`;
}

/**
 * Wraps a scope object in a Proxy that intercepts direct property assignments.
 * 
 * This function provides a defensive programming mechanism that prevents
 * developers from accidentally using direct property assignment on scope
 * objects, which silently fails to persist data across pipeline stages.
 * 
 * @param scope - The raw scope object to protect
 * @param options - Protection options including mode and stage name
 * @returns A Proxy-wrapped scope that intercepts direct assignments
 * 
 * @example
 * ```typescript
 * const rawScope = scopeFactory(context, 'myStage');
 * const scope = createProtectedScope(rawScope, { 
 *   mode: 'error', 
 *   stageName: 'myStage' 
 * });
 * 
 * // This will throw an error:
 * scope.config = { foo: 'bar' };
 * 
 * // This works correctly:
 * scope.setValue('config', { foo: 'bar' });
 * ```
 */
export function createProtectedScope<T extends object>(
  scope: T,
  options: ScopeProtectionOptions = {}
): T {
  const { 
    mode = 'error', 
    stageName = 'unknown', 
    logger = console.warn,
    // Default allowed internal properties for StageContext compatibility
    allowedInternalProperties = [
      'writeBuffer', 'next', 'children', 'parent', 'executionHistory',
      'branchId', 'isDecider', 'isFork', 'debug', 'stageName', 'pipelineId',
      'globalStore'
    ]
  } = options;
  
  // If protection is off, return the scope unchanged
  if (mode === 'off') {
    return scope;
  }
  
  // Create a set of allowed internal properties for fast lookup
  const allowedInternals = new Set<string | symbol>(allowedInternalProperties);
  
  return new Proxy(scope, {
    /**
     * Get trap - passes through to the underlying object unchanged.
     * This allows normal property reads and method calls.
     */
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver);
    },
    
    /**
     * Set trap - intercepts property assignments.
     * 
     * Blocks ALL property assignments except for explicitly allowed internal
     * properties (needed for StageContext compatibility).
     * 
     * In 'error' mode, throws an error with a descriptive message.
     * In 'warn' mode, logs a warning but allows the assignment.
     */
    set(target, prop, value, receiver) {
      // Allow assignments to explicitly allowed internal properties
      // This handles lazy initialization of class properties like writeBuffer
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
      
      // Fallback (shouldn't reach here with current modes)
      return Reflect.set(target, prop, value, receiver);
    }
  });
}

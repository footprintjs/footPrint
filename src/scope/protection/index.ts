/**
 * Scope Protection Module
 * 
 * Provides a Proxy-based protection layer that intercepts direct property
 * assignments on scope objects and provides clear error messages.
 * 
 * This prevents the common mistake of using `scope.property = value` instead
 * of `scope.setValue()`, which silently fails to persist data across pipeline
 * stages.
 */

export { createProtectedScope, createErrorMessage } from './createProtectedScope';
export { ScopeProtectionMode, ScopeProtectionOptions } from './types';

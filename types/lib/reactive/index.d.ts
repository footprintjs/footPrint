/**
 * reactive/ -- Deep Proxy system for TypedScope<T>.
 *
 * Provides typed property access to footprintjs scope state:
 *   scope.creditTier = 'A'  instead of  scope.setValue('creditTier', 'A')
 *   scope.customer.address.zip = '90210'  instead of  scope.updateValue(...)
 *   scope.tags.push('vip')  instead of  scope.setValue('tags', [...tags, 'vip'])
 */
export type { ReactiveOptions, ReactiveTarget, ScopeMethods, TypedScope } from './types.js';
export { BREAK_SETTER, EXECUTOR_INTERNAL_METHODS, IS_TYPED_SCOPE, SCOPE_METHOD_NAMES } from './types.js';
export { createTypedScope } from './createTypedScope.js';
export { shouldWrapWithProxy } from './allowlist.js';
export { createArrayProxy } from './arrayTraps.js';
export { buildNestedPatch, joinPath } from './pathBuilder.js';

/**
 * Scope Protection — Proxy-based protection layer
 *
 * Intercepts direct property assignments on scope objects and provides
 * clear error messages guiding developers to use setValue() instead.
 */
import type { ScopeProtectionOptions } from './types.js';
export declare function createErrorMessage(propertyName: string, stageName: string): string;
export declare function createProtectedScope<T extends object>(scope: T, options?: ScopeProtectionOptions): T;

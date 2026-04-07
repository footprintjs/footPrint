/**
 * Scope Protection Types
 *
 * Types for the Proxy-based protection system that prevents
 * direct property assignment on scope objects.
 */
export type ScopeProtectionMode = 'error' | 'warn' | 'off';
export interface ScopeProtectionOptions {
    mode?: ScopeProtectionMode;
    stageName?: string;
    logger?: (message: string) => void;
    allowedInternalProperties?: (string | symbol)[];
}

/**
 * Scope Protection Types
 * 
 * Types for the scope access protection system that prevents
 * direct property assignment on scope objects.
 */

/**
 * Protection mode for scope access.
 * - 'error': Throw an error on direct property assignment (default)
 * - 'warn': Log a warning but allow the assignment
 * - 'off': No protection, allow all assignments
 */
export type ScopeProtectionMode = 'error' | 'warn' | 'off';

/**
 * Options for scope protection.
 */
export interface ScopeProtectionOptions {
  /** Protection mode (default: 'error') */
  mode?: ScopeProtectionMode;
  /** Stage name for error messages */
  stageName?: string;
  /** Custom logger for warnings (default: console.warn) */
  logger?: (message: string) => void;
  /**
   * List of property names that are allowed to be assigned.
   * Use this for internal class properties that need lazy initialization.
   * Default: StageContext internal properties (writeBuffer, next, children, parent)
   */
  allowedInternalProperties?: (string | symbol)[];
}

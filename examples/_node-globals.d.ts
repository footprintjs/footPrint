/**
 * Minimal ambient declarations for Node.js globals used by examples.
 *
 * The examples tsconfig doesn't pull in `@types/node` to keep
 * dependencies lean. The few Node globals examples use (`process`,
 * `setImmediate`) are declared here just enough for type-check.
 *
 * If new examples need additional Node globals, add their minimal
 * shape here rather than installing `@types/node` (which would add
 * ~20MB of types we don't otherwise use).
 */

declare const process: {
  readonly env: Record<string, string | undefined>;
  exit(code?: number): never;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
};

declare function setImmediate(callback: () => void): unknown;

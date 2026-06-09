/**
 * Minimal Node.js ambient types for the bench scripts ONLY.
 *
 * The library deliberately ships WITHOUT @types/node — the core is
 * environment-agnostic and the root tsconfig's typeRoots would leak Node
 * globals into src/ if we installed it. Benches run under Node (tsx), so the
 * few globals they use are declared here, scoped to bench/tsconfig.json.
 */

declare const process: {
  version: string;
  platform: string;
  arch: string;
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number; external: number };
  exitCode?: number;
};

declare const global: { gc?: () => void };

declare const require: { main?: unknown };

// eslint-disable-next-line no-var
declare var module: unknown;

declare module 'os' {
  export function cpus(): { model: string }[];
  export function totalmem(): number;
}

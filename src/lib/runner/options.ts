/**
 * options — the executor's construction options and how they resolve (F9).
 *
 * `FlowChartExecutorOptions` is the public options object;
 * `resolveExecutorArgs` turns either constructor form (options object, or a
 * bare `ScopeFactory`) into the `ExecutorArgs` the executor keeps for every leg.
 */

import type { FlowChart } from '../builder/types.js';
import type { ScopeFactory, StreamHandlers } from '../engine/types.js';
import type { RunDials } from '../memory/runPolicy.js';
import { pickDials } from '../memory/runPolicy.js';
import type { ScopeProtectionMode } from '../scope/protection/types.js';
import { ScopeFacade } from '../scope/ScopeFacade.js';

/** Default scope factory — creates a plain ScopeFacade for each stage. */
const defaultScopeFactory: ScopeFactory = (ctx, stageName, readOnly, env) =>
  new ScopeFacade(ctx, stageName, readOnly, env);

/**
 * Options object for `FlowChartExecutor` — preferred over positional params.
 *
 * ```typescript
 * const ex = new FlowChartExecutor(chart, {
 *   scopeFactory: myFactory,
 *   defaultValuesForContext: { ... },
 * });
 * ```
 *
 * **Sync note for maintainers:** a field added here must also be added to
 * `ExecutorArgs` and `resolveExecutorArgs` below, or it is accepted and never
 * applied. The DIALS are the exception: they come from `RunDials` and travel
 * whole as `dials`.
 *
 * **TScope inference note:** When using the options-object form with a custom scope,
 * TypeScript cannot infer `TScope` through the options object. Pass the type
 * explicitly: `new FlowChartExecutor<TOut, MyScope>(chart, { scopeFactory })`.
 */
export interface FlowChartExecutorOptions<TScope = any> extends RunDials {
  // ── Common options (most callers need only these) ────────────────────────

  /** Custom scope factory. Defaults to TypedScope or ScopeFacade auto-detection. */
  scopeFactory?: ScopeFactory<TScope>;

  // ── Context options ──────────────────────────────────────────────────────

  /**
   * Default values pre-populated into the shared context before **each** stage
   * (re-applied every stage, acting as baseline defaults).
   */
  defaultValuesForContext?: unknown;
  /**
   * Initial context values merged into the shared context **once** at startup
   * (applied before the first stage, not repeated on subsequent stages).
   * Distinct from `defaultValuesForContext`, which is re-applied every stage.
   */
  initialContext?: unknown;
  /** Read-only input accessible via `scope.getArgs()` — never tracked or written. */
  readOnlyContext?: unknown;

  // ── Observability cost options ────────────────────────────────────────────
  // The four dials — `readTracking`, `writeTracking`, `commitValues`,
  // `writeProvenance` — are inherited from `RunDials` (memory/runPolicy.ts,
  // where each is documented): the executor picks them off this object and
  // builds the run's ONE policy from them (F5).

  // ── Advanced / escape-hatch options (most callers do not need these) ─────

  /**
   * Custom error classifier for throttling detection. Return `true` if a fork
   * child's error represents a rate-limit or backpressure condition; the
   * executor then fires `FlowRecorder.onThrottled` for that child (9.39.0 —
   * an EVENT, not a state key: the `monitor.isThrottled` write it replaced
   * never landed). The child's failure is otherwise handled as before.
   * Defaults to no throttling classification.
   */
  throttlingErrorChecker?: (error: unknown) => boolean;
  /** Handlers for streaming stage lifecycle events (see `addStreamingFunction`). */
  streamHandlers?: StreamHandlers;
  /** Scope protection mode for TypedScope direct-assignment detection. */
  scopeProtectionMode?: ScopeProtectionMode;
}

/** What the executor keeps from construction — read by every leg (`run()` / `resume()`). */
export interface ExecutorArgs<TOut, TScope> {
  flowChart: FlowChart<TOut, TScope>;
  scopeFactory: ScopeFactory<TScope>;
  defaultValuesForContext?: unknown;
  initialContext?: unknown;
  readOnlyContext?: unknown;
  throttlingErrorChecker?: (error: unknown) => boolean;
  streamHandlers?: StreamHandlers;
  scopeProtectionMode?: ScopeProtectionMode;
  /** The dials as given (absent = default) — the run's policy is built from them per leg. */
  dials: RunDials;
}

/**
 * Resolve either constructor form. The 2-param form is the options form with
 * only `scopeFactory`; the scope factory falls back to the chart's, then to a
 * plain `ScopeFacade`.
 */
export function resolveExecutorArgs<TOut, TScope>(
  flowChart: FlowChart<TOut, TScope>,
  factoryOrOptions: ScopeFactory<TScope> | FlowChartExecutorOptions<TScope> | undefined,
): ExecutorArgs<TOut, TScope> {
  const opts: FlowChartExecutorOptions<TScope> =
    typeof factoryOrOptions === 'function' ? { scopeFactory: factoryOrOptions } : factoryOrOptions ?? {};
  return {
    flowChart,
    scopeFactory: opts.scopeFactory ?? flowChart.scopeFactory ?? (defaultScopeFactory as ScopeFactory<TScope>),
    defaultValuesForContext: opts.defaultValuesForContext,
    initialContext: opts.initialContext,
    readOnlyContext: opts.readOnlyContext,
    throttlingErrorChecker: opts.throttlingErrorChecker,
    streamHandlers: opts.streamHandlers,
    scopeProtectionMode: opts.scopeProtectionMode,
    dials: pickDials(opts),
  };
}

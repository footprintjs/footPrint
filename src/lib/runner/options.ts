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
import { type RecordSinkOption, type ResolvedRecordSink, resolveRecordSink } from './recordSink.js';

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

  // ── The crash-safe record (10.1, P6) ─────────────────────────────────────

  /**
   * Where the run's record goes AS IT LANDS, so a run that never finishes still leaves it: every log of the run
   * (the root and each subflow mount) hands the sink its `opened` base, each commit, a note per attempt that ended,
   * and its `closed` outcome. `fileSink(path)` (`footprintjs/sinks`, Node) or `memorySink()` (`foottrace/write`);
   * read it back with `readStoredRecord` (`foottrace`). The redaction policy applies before any entry is written.
   * A failing sink never stops the run (`onFailure: 'report'`, the default) — `getSnapshot().sink` counts what was
   * lost. See the guide's "A crash-safe record".
   *
   * @example
   * ```typescript
   * const executor = new FlowChartExecutor(chart, { sink: fileSink('/var/footprint/run.jsonl') });
   * ```
   */
  sink?: RecordSinkOption;

  /** Opt in to a versioned, memory-only root-log capture note on snapshots (#111 stage 1). */
  captureCoverage?: boolean;

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
  /** The record sink, resolved and checked at construction (10.1, P6). */
  sink?: ResolvedRecordSink;
  captureCoverage?: boolean;
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
  if (opts.captureCoverage !== undefined && typeof opts.captureCoverage !== 'boolean') {
    throw new TypeError('captureCoverage must be a boolean');
  }
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
    ...(opts.captureCoverage === true && { captureCoverage: true }),
    ...(opts.sink !== undefined && { sink: resolveRecordSink(opts.sink) }),
  };
}

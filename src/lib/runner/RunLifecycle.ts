import type { CombinedNarrativeRecorderOptions } from '../engine/narrative/CombinedNarrativeRecorder.js';
import type { CombinedNarrativeEntry } from '../engine/narrative/narrativeTypes.js';
import type { ExecutorResult, RunOptions } from '../engine/types.js';
import type { NativeComponentEntry, NativeRunOrigin } from '../memory/RunFrame.js';
import type { FlowchartCheckpoint } from '../pause/types.js';
import type { CombinedRecorder } from '../recorder/CombinedRecorder.js';
import type { RedactionPolicy } from '../scope/types.js';
import type { AttachRecorderOptions, ObserverDrainResult } from './DeferredObserverTier.js';
import type { RuntimeSnapshot } from './ExecutionRuntime.js';
import type { FlowChartExecutorOptions } from './options.js';

export type { NativeRunOrigin } from '../memory/RunFrame.js';
export type { ComponentSetup, InlineComponentRecorder } from '../recorder/ComponentRunControl.js';
export type { ComponentEnd } from '../recorder/FinalizationBook.js';
import type { ComponentSetup } from '../recorder/ComponentRunControl.js';
import type { ComponentEnd } from '../recorder/FinalizationBook.js';

/** One captured component occurrence: private cells plus joined terminal control.
 * WHY: mounted components have no public run wrapper to own cleanup.
 * entry.ordinal is a native occurrence coordinate, never application identity.
 */
export interface ComponentRun extends RunCells {
  readonly origin: NativeRunOrigin;
  /** Native occurrence within this leg, not application identity, resume identity or authority. */
  readonly entry: NativeComponentEntry;
  /** Register before resource effects. Native control joins callbacks once in reverse order;
   * owned roots settle after postprocessing, raw roots at native terminal. A failFast sibling
   * mount can settle later than its rejected parent. Cleanup must bound its own time;
   * the run signal/deadline do not cover it. A pause wins over cleanup failure (count logged).
   * Observation has closed before cleanup; a prior body/native failure keeps precedence.
   */
  onFinalize(cleanup: (end: ComponentEnd) => void | Promise<void>): void;
}

declare const slotBrand: unique symbol;
declare const continuationBrand: unique symbol;

/** Owner-issued key. Neither serialization nor a structural copy creates a valid key. */
export interface RunSlot<T> {
  readonly [slotBrand]: (value: T) => T;
}

export type CellValue<T> = { readonly present: false } | { readonly present: true; readonly value: T };

export interface RunCells {
  read<T>(slot: RunSlot<T>): CellValue<T>;
  local<T>(slot: RunSlot<T>, initialize: () => T): T;
  set<T>(slot: RunSlot<T>, value: T): void;
  take<T>(slot: RunSlot<T>): CellValue<T>;
}

export interface BoundRun extends RunCells {
  readonly origin: NativeRunOrigin;
  readonly retired: boolean;
}

export interface PausedContinuation {
  readonly [continuationBrand]: true;
  checkpoint(): FlowchartCheckpoint;
}

export type ResumeOptions = Pick<
  RunOptions,
  'signal' | 'env' | 'maxDepth' | 'maxIterations' | 'deadline' | 'timeoutMs'
>;

export type RunEntry =
  | { readonly kind: 'run'; readonly options?: RunOptions }
  | {
      readonly kind: 'resume';
      readonly mode: 'same';
      readonly continuation: PausedContinuation;
      readonly input?: unknown;
      readonly options?: ResumeOptions;
    }
  | {
      readonly kind: 'resume';
      readonly mode: 'fresh';
      readonly checkpoint: FlowchartCheckpoint;
      readonly input?: unknown;
      readonly options?: ResumeOptions;
    };

export interface RunSetup {
  readonly attachments?: readonly { readonly recorder: CombinedRecorder; readonly options?: AttachRecorderOptions }[];
  readonly redaction?: RedactionPolicy;
  readonly narrative?: CombinedNarrativeRecorderOptions;
  readonly onOrigin?: (cells: RunCells, origin: NativeRunOrigin) => void;
}

export interface OwnedRun extends RunCells {
  readonly origin: NativeRunOrigin | undefined;
  execute(entry: RunEntry, setup?: RunSetup): Promise<ExecutorResult>;
  /** Cleanup joined once, in reverse order, under the lease; it receives the run's end. Refused after `finish()`. */
  onFinalize(cleanup: (end: ComponentEnd) => void | Promise<void>): void;
  /**
   * Run the finalizers now, from inside the body, while the lease is still held.
   * WHY: cleanup that files the run's results then runs in the body's own async context,
   * and resolves before the body's caller continues.
   * It waits for a started execution, then decides the end from it: failed (cancellation
   * included), paused or completed. Calling it is the body's word that its own part did not
   * fail; a body that throws afterwards still rejects `withRun`, but the end stays as given.
   * Once only: a second call shares the first. Rejects with the first cleanup failure unless
   * the run paused. Afterwards `execute` and `onFinalize` refuse; `withRun` finalizes nothing again.
   */
  finish(): Promise<void>;
  snapshot(options?: { redact?: boolean }): RuntimeSnapshot | undefined;
}

export type RunPhase = 'preparing' | 'executing' | 'postprocessing' | 'settled';

/** Captures one execution; methods refuse after its executor begins another native leg. */
export interface RunView {
  readonly phase: RunPhase;
  readonly origin: NativeRunOrigin | undefined;
  snapshot(options?: { redact?: boolean }): RuntimeSnapshot | undefined;
  getNarrativeEntries(): readonly CombinedNarrativeEntry[];
  getCommitCount(): number;
  isPaused(): boolean;
  drainObservers(options?: { timeoutMs?: number }): Promise<ObserverDrainResult>;
  /** Borrowed internal computation values, never an automatically redacted serving surface. */
  liveState(): Record<string, unknown> | undefined;
}

export interface RunLifecycle {
  /**
   * Private per-leg, per-runtime or per-component storage. A component slot
   * declares this chart's entry root: internal unregistered subcharts share
   * it; every separately mounted declared root gets a fresh bank.
   * Declare before entry. An already-captured frame never follows a later
   * declaration, and mismatched component access refuses. Every new leg,
   * including same-executor resume, starts with fresh component values.
   * Keep this lifecycle strongly reachable: a slot alone does not retain its weak component port.
   */
  slot<T>(lifetime: 'leg' | 'runtime' | 'component'): RunSlot<T>;
  withRun<T>(body: (run: OwnedRun) => T | Promise<T>): Promise<T>;
  forScope(scope: unknown): BoundRun;
  view(): RunView | undefined;
  /** One-shot SAME token; setup refusal spends it. Save its checkpoint for FRESH recovery.
   * A failed withRun body withdraws the offered continuation.
   */
  continuation(): PausedContinuation | undefined;
}

export interface RunLifecycleOptions {
  readonly runnerId: string;
  readonly executorOptions?: FlowChartExecutorOptions;
  /** Capture wiring only for a declared component slot; retain this lifecycle while the chart runs.
   * Recorders are inline only; registering the same object globally deferred also delivers it there.
   * bindScope runs once per scope/attempt and a throwing binder may be retried by stage policy.
   * WHY: mid-run consumers must see prior events and mounts need joined cleanup.
   */
  readonly componentSetup?: (component: ComponentRun) => ComponentSetup;
}

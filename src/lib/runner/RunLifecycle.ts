import type { CombinedNarrativeRecorderOptions } from '../engine/narrative/CombinedNarrativeRecorder.js';
import type { CombinedNarrativeEntry } from '../engine/narrative/narrativeTypes.js';
import type { ExecutorResult, RunOptions } from '../engine/types.js';
import type { NativeRunOrigin } from '../memory/RunFrame.js';
import type { FlowchartCheckpoint } from '../pause/types.js';
import type { CombinedRecorder } from '../recorder/CombinedRecorder.js';
import type { RedactionPolicy } from '../scope/types.js';
import type { AttachRecorderOptions, ObserverDrainResult } from './DeferredObserverTier.js';
import type { RuntimeSnapshot } from './ExecutionRuntime.js';
import type { FlowChartExecutorOptions } from './options.js';

export type { NativeRunOrigin } from '../memory/RunFrame.js';

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
  onFinalize(cleanup: () => void | Promise<void>): void;
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
   */
  slot<T>(lifetime: 'leg' | 'runtime' | 'component'): RunSlot<T>;
  withRun<T>(body: (run: OwnedRun) => T | Promise<T>): Promise<T>;
  forScope(scope: unknown): BoundRun;
  view(): RunView | undefined;
  continuation(): PausedContinuation | undefined;
}

export interface RunLifecycleOptions {
  readonly runnerId: string;
  readonly executorOptions?: FlowChartExecutorOptions;
}

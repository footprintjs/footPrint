import { anySignal } from '../attempt/anySignal.js';
import type { FlowChart } from '../builder/types.js';
import { type ExecutorResult, type RunOptions, defaultLogger } from '../engine/types.js';
import type { RunBanks, RunFrame } from '../memory/RunFrame.js';
import type { FlowchartCheckpoint } from '../pause/types.js';
import { FlowChartExecutor } from './FlowChartExecutor.js';
import { attachNativeRun, nativeRunFrame, nativeRunReady } from './nativeRunBinding.js';
import type { FlowChartExecutorOptions } from './options.js';
import type { ResumeOptions, RunSetup } from './RunLifecycle.js';

export type NativeEntry =
  | { readonly kind: 'run'; readonly options?: RunOptions }
  | {
      readonly kind: 'resume';
      readonly checkpoint: FlowchartCheckpoint;
      readonly input?: unknown;
      readonly options?: ResumeOptions;
    };

export interface NativeAdmission {
  readonly legBanks: RunBanks;
  readonly runtimeBanks: RunBanks;
  readonly signal: AbortSignal;
  bindOrigin(frame: RunFrame): void;
  initialize(callback: RunSetup['onOrigin']): void;
  cleanup(callback: () => void): void;
}

/** The sole production executor adapter. No raw executor crosses this boundary. */
export class NativeRunAdapter {
  private readonly executor: FlowChartExecutor;

  constructor(chart: FlowChart, options?: FlowChartExecutorOptions) {
    this.executor = new FlowChartExecutor(chart, options);
  }

  execute(entry: NativeEntry, setup: RunSetup | undefined, admission: NativeAdmission): Promise<ExecutorResult> {
    const redaction = setup?.redaction;
    const narrative = setup?.narrative;
    const attachments = setup?.attachments?.map((attachment) => ({
      recorder: attachment.recorder,
      options: attachment.options,
    }));
    const initialize = setup?.onOrigin;
    // The native options type is closed. Read every field once, including inherited getters,
    // under logical ownership; reuse the existing signal composer and native deadline engine.
    const source = entry.options;
    const signal = source?.signal;
    const options: RunOptions = {
      ...(entry.kind === 'run' && { input: entry.options?.input }),
      env: source?.env,
      timeoutMs: source?.timeoutMs,
      deadline: source?.deadline,
      maxDepth: source?.maxDepth,
      maxIterations: source?.maxIterations,
    };
    const composed = anySignal([signal, admission.signal]);
    admission.cleanup(() => composed.dispose());
    options.signal = composed.signal;
    const detach = attachNativeRun(this.executor, {
      legBanks: admission.legBanks,
      runtimeBanks: admission.runtimeBanks,
      onOrigin: (frame) => {
        admission.bindOrigin(frame);
        if (redaction !== undefined) this.executor.setRedactionPolicy(redaction);
        if (narrative !== undefined) this.executor.enableNarrative(narrative);
        for (const attachment of attachments ?? []) {
          this.executor.attachCombinedRecorder(attachment.recorder, attachment.options);
        }
        admission.initialize(initialize);
      },
    });
    admission.cleanup(detach);
    return entry.kind === 'run'
      ? this.executor.run(options)
      : this.executor.resume(entry.checkpoint, entry.input, options);
  }

  ready(frame: RunFrame | undefined): boolean {
    if (!frame) return false;
    if (nativeRunFrame(this.executor) !== frame) throw new TypeError('Run view belongs to an earlier native leg');
    return nativeRunReady(this.executor, frame);
  }

  snapshot(frame: RunFrame | undefined, options?: { redact?: boolean }) {
    return this.ready(frame) ? this.executor.getSnapshot(options) : undefined;
  }

  narrative(frame: RunFrame | undefined) {
    return this.ready(frame) ? this.executor.getNarrativeEntries() : [];
  }

  commits(frame: RunFrame | undefined): number {
    return this.ready(frame) ? this.executor.getCommitCount() : 0;
  }

  paused(frame: RunFrame | undefined): boolean {
    return this.ready(frame) && this.executor.isPaused();
  }

  drain(frame: RunFrame | undefined, options?: { timeoutMs?: number }) {
    return this.ready(frame)
      ? this.executor.drainObservers(options)
      : Promise.resolve({ done: 0, failed: 0, pending: 0 });
  }

  liveState(frame: RunFrame | undefined): Record<string, unknown> | undefined {
    return this.ready(frame) ? this.executor.getRuntime().globalStore.getState() : undefined;
  }

  checkpoint(frame: RunFrame | undefined): FlowchartCheckpoint | undefined {
    if (!this.paused(frame)) return undefined;
    const checkpoint = this.executor.getCheckpoint();
    return checkpoint === undefined ? undefined : structuredClone(checkpoint);
  }
}

/** Existing logger only; also covers cleanup on an admission that never opened an executor. */
export function reportRunFailures(chart: FlowChart, secondaryPhaseFailures: number, cleanupFailures: number): void {
  if (secondaryPhaseFailures === 0 && cleanupFailures === 0) return;
  try {
    const logger = chart.logger ?? defaultLogger;
    const returned: unknown = logger.warn('Run finalization observed failures', {
      secondaryPhaseFailures,
      cleanupFailures,
    });
    // ILogger is void-returning. Observe a nonconforming thenable without making
    // diagnostics an awaited dependency or recursively reporting its failure.
    Promise.resolve(returned).catch(() => undefined);
  } catch {
    // Reporting cannot replace the primary failure or prevent lease release.
  }
}

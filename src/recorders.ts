/**
 * footprintjs/recorders — Factory functions for built-in recorders.
 *
 * Prefer these factory functions over constructing recorder classes directly.
 * Each factory returns the recorder instance enriched with short convenience methods.
 *
 * ```ts
 * import { narrative, metrics, debug, manifest } from 'footprintjs/recorders';
 *
 * const result = await chart
 *   .recorder(narrative())
 *   .recorder(metrics())
 *   .run();
 * ```
 *
 * @module recorders
 */
/**
 * footprintjs/recorders -- Factory functions for built-in recorders.
 *
 * Import: import { narrative, metrics, debug, manifest } from 'footprintjs/recorders';
 *
 * Each factory returns the raw recorder instance with added short convenience methods.
 * Pass directly to chart.recorder(). No wrapping, no proxying -- just the class + shortcuts.
 */

import type { CombinedNarrativeRecorderOptions } from './lib/engine/narrative/CombinedNarrativeRecorder.js';
import { CombinedNarrativeRecorder } from './lib/engine/narrative/CombinedNarrativeRecorder.js';
import type {
  BreakRenderContext,
  CombinedNarrativeEntry,
  DecisionRenderContext,
  EmitRenderContext,
  ErrorRenderContext,
  ForkRenderContext,
  LoopRenderContext,
  NarrativeFormatter,
  NarrativeRenderer,
  OpRenderContext,
  SelectedRenderContext,
  StageRenderContext,
  SubflowRenderContext,
} from './lib/engine/narrative/narrativeTypes.js';
import { AdaptiveNarrativeFlowRecorder } from './lib/engine/narrative/recorders/AdaptiveNarrativeFlowRecorder.js';
import type { ManifestEntry } from './lib/engine/narrative/recorders/ManifestFlowRecorder.js';
import { ManifestFlowRecorder } from './lib/engine/narrative/recorders/ManifestFlowRecorder.js';
import { MilestoneNarrativeFlowRecorder } from './lib/engine/narrative/recorders/MilestoneNarrativeFlowRecorder.js';
import { WindowedNarrativeFlowRecorder } from './lib/engine/narrative/recorders/WindowedNarrativeFlowRecorder.js';
import type { EmitEvent, EmitRecorder } from './lib/recorder/EmitRecorder.js';
import type { DebugEntry, DebugRecorderOptions } from './lib/scope/recorders/DebugRecorder.js';
import { DebugRecorder } from './lib/scope/recorders/DebugRecorder.js';
import type { AggregatedMetrics, MetricRecorderOptions, StageMetrics } from './lib/scope/recorders/MetricRecorder.js';
import { MetricRecorder } from './lib/scope/recorders/MetricRecorder.js';

// ---- Narrative ----

/**
 * Recorder factory for combined flow+data narrative.
 *
 * The returned recorder is a `CombinedNarrativeRecorder` — attach it to a
 * chart/executor, then read structured entries via `.getEntries()` after
 * the run. For flat strings, call `.getEntries().map(e => e.text)` locally.
 */
export type NarrativeInstance = CombinedNarrativeRecorder;

export function narrative(options?: CombinedNarrativeRecorderOptions): NarrativeInstance {
  return new CombinedNarrativeRecorder(options);
}

// ---- Metrics ----

export type MetricsInstance = MetricRecorder & {
  reads(): number;
  writes(): number;
  commits(): number;
  stage(name: string): StageMetrics | undefined;
  all(): AggregatedMetrics;
};

export function metrics(options?: MetricRecorderOptions): MetricsInstance {
  const rec = new MetricRecorder(options) as MetricsInstance;
  rec.reads = function (this: MetricRecorder) {
    return this.getMetrics().totalReads;
  };
  rec.writes = function (this: MetricRecorder) {
    return this.getMetrics().totalWrites;
  };
  rec.commits = function (this: MetricRecorder) {
    return this.getMetrics().totalCommits;
  };
  rec.stage = function (this: MetricRecorder, name: string) {
    return this.getStageMetrics(name);
  };
  rec.all = function (this: MetricRecorder) {
    return this.getMetrics();
  };
  return rec;
}

// ---- Debug ----

export type DebugInstance = DebugRecorder & {
  logs(): DebugEntry[];
};

export function debug(options?: DebugRecorderOptions): DebugInstance {
  const rec = new DebugRecorder(options) as DebugInstance;
  rec.logs = function (this: DebugRecorder) {
    return this.getEntries();
  };
  return rec;
}

// ---- Manifest ----

export type ManifestInstance = ManifestFlowRecorder & {
  entries(): ManifestEntry[];
};

export function manifest(): ManifestInstance {
  const rec = new ManifestFlowRecorder() as ManifestInstance;
  rec.entries = function (this: ManifestFlowRecorder) {
    return this.getManifest();
  };
  return rec;
}

// ---- Flow recorder strategies ----

export function adaptive() {
  return new AdaptiveNarrativeFlowRecorder();
}
export function milestone() {
  return new MilestoneNarrativeFlowRecorder();
}
export function windowed(maxEntries?: number) {
  return new WindowedNarrativeFlowRecorder(maxEntries);
}

// ---- Re-exported types ----
export type {
  BreakRenderContext,
  CombinedNarrativeRecorderOptions,
  DecisionRenderContext,
  EmitEvent,
  EmitRecorder,
  EmitRenderContext,
  ErrorRenderContext,
  ForkRenderContext,
  LoopRenderContext,
  NarrativeFormatter,
  NarrativeRenderer,
  OpRenderContext,
  SelectedRenderContext,
  StageRenderContext,
  SubflowRenderContext,
};
export type { AggregatedMetrics, MetricRecorderOptions, StageMetrics };
export type { CompositeSnapshot } from './lib/recorder/index.js';
export { CompositeRecorder } from './lib/recorder/index.js';

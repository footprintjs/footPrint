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
import type { BreakRenderContext, CombinedNarrativeEntry, DecisionRenderContext, ErrorRenderContext, ForkRenderContext, LoopRenderContext, NarrativeRenderer, OpRenderContext, SelectedRenderContext, StageRenderContext, SubflowRenderContext } from './lib/engine/narrative/narrativeTypes.js';
import { AdaptiveNarrativeFlowRecorder } from './lib/engine/narrative/recorders/AdaptiveNarrativeFlowRecorder.js';
import type { ManifestEntry } from './lib/engine/narrative/recorders/ManifestFlowRecorder.js';
import { ManifestFlowRecorder } from './lib/engine/narrative/recorders/ManifestFlowRecorder.js';
import { MilestoneNarrativeFlowRecorder } from './lib/engine/narrative/recorders/MilestoneNarrativeFlowRecorder.js';
import { WindowedNarrativeFlowRecorder } from './lib/engine/narrative/recorders/WindowedNarrativeFlowRecorder.js';
import type { DebugEntry, DebugRecorderOptions } from './lib/scope/recorders/DebugRecorder.js';
import { DebugRecorder } from './lib/scope/recorders/DebugRecorder.js';
import type { AggregatedMetrics, MetricRecorderOptions, StageMetrics } from './lib/scope/recorders/MetricRecorder.js';
import { MetricRecorder } from './lib/scope/recorders/MetricRecorder.js';
export type NarrativeInstance = CombinedNarrativeRecorder & {
    lines(): string[];
    structured(): CombinedNarrativeEntry[];
};
export declare function narrative(options?: CombinedNarrativeRecorderOptions): NarrativeInstance;
export type MetricsInstance = MetricRecorder & {
    reads(): number;
    writes(): number;
    commits(): number;
    stage(name: string): StageMetrics | undefined;
    all(): AggregatedMetrics;
};
export declare function metrics(options?: MetricRecorderOptions): MetricsInstance;
export type DebugInstance = DebugRecorder & {
    logs(): DebugEntry[];
};
export declare function debug(options?: DebugRecorderOptions): DebugInstance;
export type ManifestInstance = ManifestFlowRecorder & {
    entries(): ManifestEntry[];
};
export declare function manifest(): ManifestInstance;
export declare function adaptive(): AdaptiveNarrativeFlowRecorder;
export declare function milestone(): MilestoneNarrativeFlowRecorder;
export declare function windowed(maxEntries?: number): WindowedNarrativeFlowRecorder;
export type { BreakRenderContext, CombinedNarrativeRecorderOptions, DecisionRenderContext, ErrorRenderContext, ForkRenderContext, LoopRenderContext, NarrativeRenderer, OpRenderContext, SelectedRenderContext, StageRenderContext, SubflowRenderContext, };
export type { AggregatedMetrics, MetricRecorderOptions, StageMetrics };
export type { CompositeSnapshot } from './lib/recorder/index.js';
export { CompositeRecorder } from './lib/recorder/index.js';

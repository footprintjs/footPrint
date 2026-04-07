/**
 * RunContext -- d3-style chainable run configuration.
 *
 * Returned by chart.recorder() and chart.redact().
 * Accumulates recorders and redaction policy, then creates
 * a FlowChartExecutor internally when .run() is called.
 *
 * The chart is immutable. RunContext is ephemeral per-run config.
 */
import type { FlowRecorder } from '../engine/narrative/types.js';
import type { FlowChart, RunOptions } from '../engine/types.js';
import type { Recorder, RedactionPolicy } from '../scope/types.js';
/** Result from RunContext.run() — owns state and output. */
export interface RunResult {
    /** Raw scope state after execution. */
    state: Record<string, unknown>;
    /** Mapped output via contract mapper (if declared). */
    output: unknown;
    /** Narrative lines (if narrative was enabled). */
    narrative: string[];
    /** Full execution tree for debugging. */
    executionTree: unknown;
    /** Commit log for time-travel. */
    commitLog: unknown[];
}
export declare class RunContext<TOut = any, TScope = any> {
    private readonly chart;
    private readonly scopeRecorders;
    private readonly flowRecorders;
    private redactionPolicy?;
    constructor(chart: FlowChart<TOut, TScope>);
    /** Attach a recorder. Auto-detects scope vs flow recorder. Chainable. */
    recorder(r: Recorder | FlowRecorder): RunContext<TOut, TScope>;
    /** Set redaction policy for this run. Chainable. */
    redact(policy: RedactionPolicy): RunContext<TOut, TScope>;
    /** Execute the chart with accumulated config. Returns RunResult. */
    run(options?: RunOptions): Promise<RunResult>;
}

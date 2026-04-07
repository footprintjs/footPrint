/**
 * Scope Type Definitions
 *
 * Core types for the composable Scope system with pluggable Recorders.
 * Architecture follows composition-over-inheritance: Recorders are
 * attached to Scope instances to observe read/write/commit operations.
 */
export interface RecorderContext {
    stageName: string;
    pipelineId: string;
    timestamp: number;
}
export interface ReadEvent extends RecorderContext {
    key?: string;
    value: unknown;
    /** True when the value has been redacted for PII protection. */
    redacted?: boolean;
}
export interface WriteEvent extends RecorderContext {
    key: string;
    value: unknown;
    operation: 'set' | 'update' | 'delete';
    /** True when the value has been redacted for PII protection. */
    redacted?: boolean;
}
export interface CommitEvent extends RecorderContext {
    mutations: Array<{
        key: string;
        value: unknown;
        operation: 'set' | 'update' | 'delete';
    }>;
}
export interface ErrorEvent extends RecorderContext {
    error: Error;
    operation: 'read' | 'write' | 'commit';
    key?: string;
}
export interface StageEvent extends RecorderContext {
    duration?: number;
}
export interface PauseEvent extends RecorderContext {
    stageId: string;
    pauseData?: unknown;
}
export interface ResumeEvent extends RecorderContext {
    stageId: string;
    hasInput: boolean;
}
/**
 * Declarative redaction configuration — define once, applied everywhere.
 *
 * Configure at the scope class level (static property) or pass to
 * FlowChartExecutor to apply across all stages.
 */
export interface RedactionPolicy {
    /** Exact key names to always redact (e.g. ['ssn', 'creditCard']). */
    keys?: string[];
    /**
     * Regex patterns — any key matching a pattern is auto-redacted.
     *
     * Pattern matching is skipped for keys that exceed an internal length cap
     * (designed to prevent ReDoS on pathological patterns). For very long key
     * names, use `keys` (exact match) instead of patterns.
     */
    patterns?: RegExp[];
    /** Field-level redaction within objects — key → array of fields to scrub.
     *  Supports dot-notation for nested paths (e.g. 'address.zip'). */
    fields?: Record<string, string[]>;
}
/**
 * Compliance-friendly report of what was redacted. Never includes values.
 */
export interface RedactionReport {
    /** Keys fully redacted (exact match or pattern match). */
    redactedKeys: string[];
    /** Keys with field-level redaction → which fields were scrubbed. */
    fieldRedactions: Record<string, string[]>;
    /** Source strings of registered patterns. */
    patterns: string[];
}
/**
 * Pluggable observer for scope operations.
 *
 * All methods are optional — implement only the hooks you need.
 * Recorders are invoked synchronously in attachment order.
 * If a recorder throws, the error is caught and passed to onError
 * hooks of other recorders; the scope operation continues normally.
 */
export interface Recorder {
    readonly id: string;
    onRead?(event: ReadEvent): void;
    onWrite?(event: WriteEvent): void;
    onCommit?(event: CommitEvent): void;
    onError?(event: ErrorEvent): void;
    onStageStart?(event: StageEvent): void;
    onStageEnd?(event: StageEvent): void;
    onPause?(event: PauseEvent): void;
    onResume?(event: ResumeEvent): void;
    /** Reset state before each executor.run() — prevents cross-run accumulation. */
    clear?(): void;
    /** Expose collected data for inclusion in executor.getSnapshot().recorders. */
    toSnapshot?(): {
        name: string;
        data: unknown;
    };
}

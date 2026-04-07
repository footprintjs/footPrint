/**
 * DiagnosticCollector — Per-stage metadata collector
 *
 * Collects non-execution metadata during a stage's run:
 * - logs, errors, metrics, evals, flowMessages
 *
 * Like a compiler's diagnostic collector — gathers warnings, errors,
 * and timing info without affecting the compilation output.
 */
import type { FlowMessage } from './types.js';
export declare class DiagnosticCollector {
    logContext: {
        [key: string]: any;
    };
    errorContext: {
        [key: string]: any;
    };
    metricContext: {
        [key: string]: any;
    };
    evalContext: {
        [key: string]: any;
    };
    flowMessages: FlowMessage[];
    addLog(key: string, value: any, path?: string[]): void;
    setLog(key: string, value: any, path?: string[]): void;
    addError(key: string, value: any, path?: string[]): void;
    addMetric(key: string, value: any, path?: string[]): void;
    setMetric(key: string, value: any, path?: string[]): void;
    addEval(key: string, value: any, path?: string[]): void;
    setEval(key: string, value: any, path?: string[]): void;
    addFlowMessage(flowMessage: FlowMessage): void;
}

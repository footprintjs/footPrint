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
import { setNestedValue, updateNestedValue } from './utils.js';

export class DiagnosticCollector {
  public logContext: { [key: string]: any } = {};
  public errorContext: { [key: string]: any } = {};
  public metricContext: { [key: string]: any } = {};
  public evalContext: { [key: string]: any } = {};
  public flowMessages: FlowMessage[] = [];

  addLog(key: string, value: any, path: string[] = []) {
    updateNestedValue(this.logContext, '', path, key, value);
  }

  setLog(key: string, value: any, path: string[] = []) {
    setNestedValue(this.logContext, '', path, key, value);
  }

  addError(key: string, value: any, path: string[] = []) {
    updateNestedValue(this.errorContext, '', path, key, value);
  }

  addMetric(key: string, value: any, path: string[] = []) {
    updateNestedValue(this.metricContext, '', path, key, value);
  }

  setMetric(key: string, value: any, path: string[] = []) {
    setNestedValue(this.metricContext, '', path, key, value);
  }

  addEval(key: string, value: any, path: string[] = []) {
    updateNestedValue(this.evalContext, '', path, key, value);
  }

  setEval(key: string, value: any, path: string[] = []) {
    setNestedValue(this.evalContext, '', path, key, value);
  }

  addFlowMessage(flowMessage: FlowMessage) {
    this.flowMessages.push(flowMessage);
  }
}

/**
 * DiagnosticCollector — Per-stage metadata collector
 *
 * Collects non-execution metadata during a stage's run:
 * - logs, errors, metrics, evals, flowMessages
 *
 * Like a compiler's diagnostic collector — gathers warnings, errors,
 * and timing info without affecting the compilation output.
 */

import type { RedactionRule } from './redaction.js';
import type { FlowMessage } from './types.js';
import { setNestedValue, updateNestedValue } from './utils.js';

/** @internal Diagnostic namespaces, separate from state paths. */
export type DiagnosticChannel = 'logs' | 'errors' | 'metrics' | 'evals';

const BAG_FIELDS = {
  logs: 'logContext',
  errors: 'errorContext',
  metrics: 'metricContext',
  evals: 'evalContext',
} as const;

export class DiagnosticCollector {
  public logContext: { [key: string]: any } = {};
  public errorContext: { [key: string]: any } = {};
  public metricContext: { [key: string]: any } = {};
  public evalContext: { [key: string]: any } = {};
  public flowMessages: FlowMessage[] = [];

  /** Read the current run policy, including policy swaps and resume. */
  constructor(private readonly readRule?: () => RedactionRule | undefined) {}

  /** A named entry: the run's rule maps its name to a state key, then adds the diagnostic selectors. */
  private retain(channel: DiagnosticChannel, path: string[], key: string, value: unknown): unknown {
    const rule = this.readRule?.();
    return rule && !rule.isDiagnosticInert() ? rule.retainDiagnostic([channel, ...path, key], value) : value;
  }

  private write(channel: DiagnosticChannel, key: string, value: unknown, path: string[], replace: boolean): unknown {
    const kept = this.retain(channel, path, key, value);
    const write = replace ? setNestedValue : updateNestedValue;
    write(this[BAG_FIELDS[channel]], [], path, key, kept);
    return kept;
  }

  /** @internal Add once, returning the retained incoming value for emit.
   * Legacy writers stay void: their result may be returned by a stage. */
  add(channel: DiagnosticChannel, key: string, value: unknown, path: string[] = []): unknown {
    return this.write(channel, key, value, path, false);
  }

  addLog(key: string, value: any, path: string[] = []) {
    this.add('logs', key, value, path);
  }

  setLog(key: string, value: any, path: string[] = []) {
    this.write('logs', key, value, path, true);
  }

  addError(key: string, value: any, path: string[] = []) {
    this.add('errors', key, value, path);
  }

  addMetric(key: string, value: any, path: string[] = []) {
    this.add('metrics', key, value, path);
  }

  setMetric(key: string, value: any, path: string[] = []) {
    this.write('metrics', key, value, path, true);
  }

  addEval(key: string, value: any, path: string[] = []) {
    this.add('evals', key, value, path);
  }

  setEval(key: string, value: any, path: string[] = []) {
    this.write('evals', key, value, path, true);
  }

  addFlowMessage(flowMessage: FlowMessage) {
    const rule = this.readRule?.();
    if (!rule || rule.isFlowTextInert()) {
      this.flowMessages.push(flowMessage);
      return;
    }
    // Only payload text is selectable — and it has no name of its own, so only
    // the diagnostic selectors reach it. Keep the evidence of what happened
    // (type, targets, timing, counts) even when its explanation is masked.
    const description = rule.retainFlowText(['flowMessages', 'description'], flowMessage.description);
    const rationale =
      flowMessage.rationale === undefined
        ? undefined
        : rule.retainFlowText(['flowMessages', 'rationale'], flowMessage.rationale);
    if (description === flowMessage.description && rationale === flowMessage.rationale) {
      this.flowMessages.push(flowMessage);
    } else {
      this.flowMessages.push({ ...flowMessage, description, ...(rationale === undefined ? {} : { rationale }) });
    }
  }
}

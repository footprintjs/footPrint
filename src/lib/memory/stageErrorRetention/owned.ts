import { thrownText } from '../../errors/errorInfo.js';
import type { RetainedProjection } from '../../errors/failureRetention/index.js';
import type { RedactionRule, StageSources } from '../redaction.js';

type Source = () => StageSources | undefined;
type Retainer = (error: unknown, text: string, kept: unknown, sources?: Source) => RetainedProjection;
const retainers = new WeakMap<object, Retainer>();

/** A private per-rule policy port, never a public method or current-origin slot. */
export function bindErrorRetainer(rule: object, retain: Retainer): void {
  retainers.set(rule, retain);
}
export function retainOwnedError(
  rule: object,
  error: unknown,
  text: string,
  kept: unknown,
  sources?: Source,
): RetainedProjection {
  const retain = retainers.get(rule);
  if (!retain) throw new TypeError('[footprint] Missing error retention owner');
  return retain(error, text, kept, sources);
}
export function serveOwnedError(
  rule: Pick<RedactionRule, 'servedError'> & Partial<Pick<RedactionRule, 'retainDiagnostic' | 'isDiagnosticInert'>>,
  error: unknown,
  sources: Source,
) {
  const retain = retainers.get(rule);
  if (!retain || rule.isDiagnosticInert?.()) return rule.servedError(error);
  const text = thrownText(error);
  return retain(error, text, rule.retainDiagnostic?.(['errors', 'stageExecutionError'], text) ?? text, sources)
    .structuredError;
}

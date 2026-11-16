import { thrownText } from '../../errors/errorInfo.js';
import type { RetainedProjection } from '../../errors/failureRetention/index.js';
import type { RedactionRule, StageSources } from '../redaction.js';
import { retainWrapper } from './retention.js';

type Source = () => StageSources | undefined;
type Retainer = (
  error: unknown,
  text: string,
  kept: unknown,
  sources?: Source,
  address?: readonly string[],
) => RetainedProjection;
type Diagnostic = (address: readonly string[], value: unknown) => { value: unknown; selected: boolean };
const retainers = new WeakMap<object, { retain: Retainer; diagnostic: Diagnostic }>();

/** A private per-rule policy port, never a public method or current-origin slot. */
export function bindErrorRetainer(rule: object, retain: Retainer, diagnostic: Diagnostic): void {
  retainers.set(rule, { retain, diagnostic });
}
export function retainOwnedError(
  rule: object,
  error: unknown,
  text: string,
  kept: unknown,
  sources?: Source,
  address?: readonly string[],
): RetainedProjection {
  const retain = retainers.get(rule);
  if (!retain) throw new TypeError('[footprint] Missing error retention owner');
  return retain.retain(error, text, kept, sources, address);
}
export function serveOwnedError(
  rule: Pick<RedactionRule, 'servedError'> & Partial<Pick<RedactionRule, 'retainDiagnostic' | 'isDiagnosticInert'>>,
  error: unknown,
  sources: Source,
) {
  const retain = retainers.get(rule);
  if (!retain || rule.isDiagnosticInert?.()) return rule.servedError(error);
  const text = thrownText(error);
  return retain.retain(error, text, text, sources, ['errors', 'stageExecutionError']).structuredError;
}

/** Apply exactly the wrapper diagnostic, keeping its selection separate from equal text. */
export function retainWrapperError(
  rule: object,
  projection: RetainedProjection,
  address: readonly string[],
): RetainedProjection {
  const port = retainers.get(rule);
  if (!port) throw new TypeError('[footprint] Missing error retention owner');
  const decision = port.diagnostic(address, projection.message);
  return retainWrapper(projection, decision.value, decision.selected);
}

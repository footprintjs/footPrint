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
interface Owner {
  readonly retain: Retainer;
  readonly diagnostic: Diagnostic;
}
const retainers = new WeakMap<object, Owner>();

/** Every property-based receiver uses the registered private pattern array. */
function ownerOf(rule: object): Owner | undefined {
  const carrier = (rule as { readonly pathPatterns?: unknown }).pathPatterns;
  return carrier !== null && typeof carrier === 'object' ? retainers.get(carrier) : undefined;
}

/** Stable policy identity only; native origin authority remains the actual pending token. */
export function errorRuleIdentity(rule: object): object {
  const owner = ownerOf(rule);
  if (!owner) throw new TypeError('[footprint] Missing error retention owner');
  return owner;
}

/** A private per-rule policy port, never a public method or current-origin slot. */
export function bindErrorRetainer(carrier: object, retain: Retainer, diagnostic: Diagnostic): void {
  retainers.set(carrier, { retain, diagnostic });
}
/** A policy update replaces its private pattern array without changing the registered policy owner. */
export function rebindErrorRetainer(previous: object, current: object): void {
  const owner = retainers.get(previous);
  if (owner) retainers.set(current, owner);
}
export function retainOwnedError(
  rule: object,
  error: unknown,
  text: string,
  kept: unknown,
  sources?: Source,
  address?: readonly string[],
): RetainedProjection {
  const retain = ownerOf(rule);
  if (!retain) throw new TypeError('[footprint] Missing error retention owner');
  return retain.retain(error, text, kept, sources, address);
}
export function serveOwnedError(
  rule: Pick<RedactionRule, 'servedError'> & Partial<Pick<RedactionRule, 'retainDiagnostic' | 'isDiagnosticInert'>>,
  error: unknown,
  sources: Source,
) {
  const retain = ownerOf(rule);
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
  const port = ownerOf(rule);
  if (!port) throw new TypeError('[footprint] Missing error retention owner');
  const decision = port.diagnostic(address, projection.message);
  return retainWrapper(projection, decision.value, decision.selected);
}

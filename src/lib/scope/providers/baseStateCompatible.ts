/** Thin convenience-method adapter. ScopeFacade owns every state/lifecycle rule. */
import type { StageContext } from '../../memory/StageContext.js';
import { registerScopeRuntime } from '../runtime.js';
import { ScopeFacade } from '../ScopeFacade.js';

/** One inventory for method attachment and schema-name collision checks. */
export const SCOPE_CONVENIENCE_METHODS = [
  'addDebugInfo',
  'addDebugMessage',
  'addErrorInfo',
  'addMetric',
  'addEval',
  'getInitialValueFor',
  'getValue',
  'setValue',
  'updateValue',
  'setObjectInRoot',
  'getArgs',
  'getEnv',
  'getPipelineId',
  'emitEvent',
] as const satisfies readonly (keyof ScopeFacade)[];

export type ScopeConvenienceMethods = Pick<ScopeFacade, (typeof SCOPE_CONVENIENCE_METHODS)[number]>;

/** Bind to an EXISTING facade: an adapter must not install a second commit observer. */
export function attachFacadeMethods<T extends object>(target: T, facade: ScopeFacade): T & ScopeConvenienceMethods {
  for (const name of SCOPE_CONVENIENCE_METHODS) {
    Object.defineProperty(target, name, {
      value: facade[name].bind(facade),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return registerScopeRuntime(target, { target: facade, handlesAssignments: false }) as T & ScopeConvenienceMethods;
}

/** Attach standard scope conveniences to an object backed by a real stage context. */
export function attachScopeMethods<T extends object>(
  target: T,
  ctx: StageContext,
  stageName: string,
  readOnly?: unknown,
  executionEnv?: ConstructorParameters<typeof ScopeFacade>[3],
): T & ScopeConvenienceMethods {
  return attachFacadeMethods(target, new ScopeFacade(ctx, stageName, readOnly, executionEnv));
}

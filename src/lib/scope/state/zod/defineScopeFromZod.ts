/**
 * defineScopeFromZod — Build a ScopeFactory from a Zod object schema
 */

import { attachFacadeMethods, SCOPE_CONVENIENCE_METHODS } from '../../providers/baseStateCompatible.js';
import type { ScopeFactory, StageContextLike, StrictMode } from '../../providers/types.js';
import { ScopeFacade } from '../../ScopeFacade.js';
import { prepareZodScope } from './scopeFactory.js';
import type { ZodSchema } from './utils/validateHelper.js';

export type DefineScopeOptions = {
  strict?: StrictMode;
};

export function defineScopeFromZod(schema: ZodSchema, opts?: DefineScopeOptions): ScopeFactory<any> {
  const createProxy = prepareZodScope(schema, SCOPE_CONVENIENCE_METHODS);
  const strict = opts?.strict ?? 'warn';
  return (context, stageName, readOnly, executionEnv) => {
    const facade = new ScopeFacade(context, stageName, readOnly, executionEnv);
    const access: StageContextLike = {
      getValue: (path, key) => facade.getValueAt(path, key),
      setObject: (path, key, value, redact, description) => facade.setValueAt(path, key, value, redact, description),
      updateObject: (path, key, value, description) => facade.updateValueAt(path, key, value, description),
      addLog: (key, value) => facade.addDebugInfo(key, value),
      addError: (key, value) => facade.addErrorInfo(key, value),
    };
    // Construction is not an argument read: mark this dependency only on actual access.
    const proxy = createProxy(access, strict, () => facade.getArgs());
    return attachFacadeMethods(proxy, facade);
  };
}

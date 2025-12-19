/* istanbul ignore file */
/**
 * installResolvers — Auto-registers the Zod scope resolver
 */

import { registerScopeResolver } from '../providers/resolve';
import { ZodScopeResolver } from './zod';

let installed = false;
export function installDefaultResolvers() {
  if (installed) return;
  registerScopeResolver(ZodScopeResolver);
  installed = true;
}

installDefaultResolvers();

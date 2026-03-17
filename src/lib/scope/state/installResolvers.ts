/* istanbul ignore file */
/**
 * installResolvers — Auto-registers the Zod scope resolver
 */

import { registerScopeResolver } from '../providers/resolve.js';
import { ZodScopeResolver } from './zod/index.js';

let installed = false;
export function installDefaultResolvers() {
  if (installed) return;
  registerScopeResolver(ZodScopeResolver);
  installed = true;
}

installDefaultResolvers();

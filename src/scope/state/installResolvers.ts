import { registerScopeResolver } from '../core/resolve';
import { ZodScopeResolver } from './zod';

let installed = false;
export function installDefaultResolvers() {
    if (installed) return;
    registerScopeResolver(ZodScopeResolver);
    installed = true;
}

installDefaultResolvers();
import type { ResolveOptions, ScopeFactory, ScopeProvider } from "./types";
import { resolveScopeProvider } from "./registry";

/** Normalize a factory/class/schema-like input into a ScopeFactory the pipeline expects */
export function toScopeFactory<TScope>(
    input: unknown,
    options?: ResolveOptions
): ScopeFactory<TScope> {
    const provider: ScopeProvider<TScope> = resolveScopeProvider<TScope>(input, options);
    return (ctx, stageName, ro) => provider.create(ctx, stageName, ro);
}

export { registerScopeResolver } from "./registry";
export type { ScopeProvider, ResolveOptions } from "./types";

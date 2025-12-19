import type { ProviderResolver, ScopeProvider, ResolveOptions } from "./types";
import { looksLikeFactory, looksLikeClassCtor, isSubclassOfStateScope } from "./guards";
import { makeClassProvider, makeFactoryProvider } from "./providers";

const resolvers: ProviderResolver[] = [];

export function registerScopeResolver(resolver: ProviderResolver) {
    resolvers.push(resolver);
}

// TEST-ONLY helper to avoid cross-test pollution
export function __clearScopeResolversForTests() {
    resolvers.splice(0, resolvers.length);
}

function resolveBuiltin<TScope>(input: unknown): ScopeProvider<TScope> | undefined {
    // Only allow classes that extend BaseState
    if (looksLikeClassCtor(input) && isSubclassOfStateScope(input)) {
        return makeClassProvider(input as any);
    }
    if (looksLikeFactory(input)) {
        return makeFactoryProvider(input as any);
    }
    return undefined;
}

export function resolveScopeProvider<TScope>(
    input: unknown,
    options?: ResolveOptions
): ScopeProvider<TScope> {
    for (const r of resolvers) {
        if (r.canHandle(input)) return r.makeProvider(input, options);
    }
    const built = resolveBuiltin<TScope>(input);
    if (built) return built;

    throw new Error(
        "Unsupported scope input. Provide a factory function, a class extending BaseState, or register a resolver plugin."
    );
}

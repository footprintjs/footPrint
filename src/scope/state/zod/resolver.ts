import { ProviderResolver, ScopeProvider, StageContextLike, StrictMode } from "../../core/types";
import { createScopeProxyFromZod } from "./scopeFactory";
import { isScopeSchema } from "./schema/builder";
import { z } from "zod";
import { attachBaseStateCompat } from "../../core/baseStateCompatible";

function makeZodProvider(schema: z.ZodObject<any>, strict: StrictMode = "warn"): ScopeProvider<any> {
    return {
        kind: "zod",
        create: (ctx: StageContextLike, stageName: string, ro?: unknown) => {
            const proxy = createScopeProxyFromZod(ctx, schema, strict, ro);
            // make it feel like BaseState (debug + get/set helpers)
            return attachBaseStateCompat(proxy, ctx, stageName, ro);
        },
    };
}

export const ZodScopeResolver: ProviderResolver = {
    name: "zod",
    canHandle(input: unknown): boolean {
        return isScopeSchema(input);
    },
    makeProvider(input: unknown, options?: { zod?: { strict?: StrictMode } }): ScopeProvider<any> {
        const schema = input as unknown as z.ZodObject<any>;
        const strict = options?.zod?.strict ?? "warn";
        return makeZodProvider(schema, strict);
    },
};

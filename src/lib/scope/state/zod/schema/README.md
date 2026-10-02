# scope/state/zod/schema/ — the brand

One file, `builder.ts`: `defineScopeSchema` (a strict `z.object` carrying `SCOPE_SCHEMA_BRAND`), the `ScopeSchema` type and the `isScopeSchema` guard that `ZodScopeResolver.canHandle` asks. Imports `zod` only. Everything about the scope it brands is in [`../README.md`](../README.md).

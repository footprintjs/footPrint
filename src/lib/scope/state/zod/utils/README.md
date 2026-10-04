# scope/state/zod/utils/ — Zod helpers

`validateHelper.ts` owns the classic Zod 3/4 metadata adapter. Detection delegates to `schema/detect`; `getZodKind`, `getObjectShape`, `getArrayElementType` and `getRecordValueType` distinguish structures without constructor identity. Arrays use the v3 `type` or v4 `element` slot; records use `valueType`. Neither is treated as a wrapper.

`unwrap` follows only known wrapper edges, including optional/nullable/default, effects, lazy, readonly, catch, branded and pipeline input (plus v4 prefault/nonoptional). Structural analysis keeps the original schema for `parseWithThis`, so exposing an array's `push` does not erase its wrapper/refinement validation. Defaults and transforms remain validation-only. Recursive schemas are outside the eager analyzer's contract.

`ZodSchema` is a structural type shared by real classic v3 and v4 values; it does not require a `zod/v3` import from consumers on older Zod 3 packages. Tests use both actual constructor families in `test/lib/scope/scenario/zod-wrapper-compat.test.ts`. The executor-facing ownership and safety rules are in [`../README.md`](../README.md).

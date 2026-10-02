# scope/state/zod/utils/ — cross-version Zod helpers

One file, `validateHelper.ts`: `isZodNode`, `unwrap` (peels wrapper types — optional, nullable, default, effects, lazy — down to the base node, but never an array's element type), `getRecordValueType` and `parseWithThis` (a parse that survives the method-binding differences between Zod versions). Detection is delegated to `schema/detect`; the only caller is `../scopeFactory.ts`. Everything about the scope they serve is in [`../README.md`](../README.md).

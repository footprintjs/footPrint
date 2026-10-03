# errors/ — the one place a thrown value becomes structured

> **Moved out of `engine/errors/` in 9.39.0 (F8)** — a leaf, so the scope channel's `ErrorEvent` (built by `recorder/hooks.ts · recorderFailureEvent`) carries the structured form without a scope/recorder → engine edge, which would close the engine ⇄ recorder ⇄ scope module cycle. Nothing else about it changed.

`extractErrorInfo` turns a thrown value into a `StructuredErrorInfo` — message, name, code, field-level `issues` and the `raw` original — and `formatErrorInfo` turns it back into text. It owns the extraction and the one safe rendering; it does not decide what the engine *does* with an error — `onError`, the commit-on-error law and retry belong to `engine/traversal/` and `engine/narrative/`. The structure reaches the FlowRecorder events — `FlowRecorderDispatcher` calls `extractErrorInfo` for `onError`, `onStageRetry` and `onThrottled`, the traverser calls it for `onRunFailed`, and each event carries the result as `structuredError` — and, since 9.39.0, the scope channel's `ErrorEvent.error` (a recorder that threw), on every delivery path.

**The laws.**

- *The structure rides the events, not the diagnostics bag.* The catch blocks (`FlowchartTraverser · executeNodeStep`, `DeciderHandler`, `SelectorHandler`, `SubflowExecutor`) still pass `error.toString()` to `context.addError(...)`, so an `InputValidationError`'s `.issues` is on the event but not in the diagnostics entry. Known gap: the `errorInfo.ts` header lists diagnostic collectors among the consumers of the structure, but they still get a string.
- *`raw` is for code, not for output.* It can carry a stack or a cycle, so `formatErrorInfo` prints the message plus one `- path: message` line per issue — never the stack and never `raw` (`test/lib/engine/security/structured-error-safety.test.ts`, `test/lib/engine/unit/errorInfo.test.ts`).
- *Extraction survives most hostile errors*: a throwing `.message` / `.code` getter, a Proxy whose `get` trap throws, a null-prototype object and a value whose `toString` throws all come back as an info object (`'[unserializable error]'` at worst). Known gap: a Proxy whose `getPrototypeOf` trap throws escapes `extractErrorInfo` when it is called directly (its first `instanceof` check sits outside the `try`); in a run the engine trips first — `StageRunner`'s `isInterruptSignal` check throws on that Proxy, so `run()` rejects with the trap's error and `onError`'s `raw` is that error, and the traverser's catch evaluates `error.toString()` before `onError`, so `throw null` or a null-prototype object skips `onError` and `run()` rejects with the resulting TypeError. Fixing `errorInfo.ts` alone would change neither.

```typescript
import { extractErrorInfo, formatErrorInfo, validateOrThrow } from 'footprintjs';

try {
  validateOrThrow({ type: 'object', required: ['id'] }, {});
} catch (error) {
  const info = extractErrorInfo(error);
  console.log(info.code);   // 'INPUT_VALIDATION_ERROR'
  console.log(info.issues); // [{ path: ['id'], message: 'Missing required field "id"', code: 'missing_field' }]
  console.log(formatErrorInfo(info)); // the message, then "  - id: Missing required field "id""
}
```

Layer L0 (`scripts/layering.config.cjs`): imports `schema/errors` (L0) only, and sits this low so `scope/` and `recorder/` (L5), `engine/narrative/` and the traverser (L6) can all use it. Public through `footprintjs` (`extractErrorInfo`, `formatErrorInfo`, `StructuredErrorInfo`). See also [`../engine/README.md`](../engine/README.md).

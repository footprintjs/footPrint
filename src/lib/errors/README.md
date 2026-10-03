# errors/ — the one place a thrown value becomes structured

> **Moved out of `engine/errors/` in 9.39.0 (F8)** — a leaf, so the scope channel's `ErrorEvent` (built by `recorder/hooks.ts · recorderFailureEvent`) carries the structured form without a scope/recorder → engine edge, which would close the engine ⇄ recorder ⇄ scope module cycle. Nothing else about it changed.

`extractErrorInfo` turns a thrown value into a `StructuredErrorInfo` — message, name, code, field-level `issues` and the `raw` original — and `formatErrorInfo` turns it back into text. It owns the extraction and the one safe rendering; it does not decide what the engine *does* with an error — `onError`, the commit-on-error law and retry belong to `engine/traversal/` and `engine/narrative/`. The structure reaches the FlowRecorder events — `FlowRecorderDispatcher` calls `extractErrorInfo` for `onError`, `onStageRetry` and `onThrottled`, the traverser calls it for `onRunFailed`, and each event carries the result as `structuredError` — and, since 9.39.0, the scope channel's `ErrorEvent.error` (a recorder that threw), on every delivery path.

**The laws.**

- *The structure rides the events, not the diagnostics bag.* The catch blocks (`FlowchartTraverser · executeNodeStep`, `DeciderHandler`, `SelectorHandler`, `SubflowExecutor`) still pass `thrownText(error)` to `context.addError(...)`, so an `InputValidationError`'s `.issues` is on the event but not in the diagnostics entry. Known gap: the `errorInfo.ts` header lists diagnostic collectors among the consumers of the structure, but they still get a string.
- *`raw` is for code, not for output.* It can carry a stack or a cycle, so `formatErrorInfo` prints the message plus one `- path: message` line per issue — never the stack and never `raw` (`test/lib/engine/security/structured-error-safety.test.ts`, `test/lib/engine/unit/errorInfo.test.ts`).
- *Extraction never throws*: a throwing `.message` / `.code` getter, a Proxy whose `get` or `getPrototypeOf` trap throws, a revoked Proxy, a null-prototype object and a value whose `toString` throws all come back as an info object (`'[unserializable error]'` at worst) — the `instanceof` checks sit inside a `try`. Its sibling `thrownText` is the engine's catch-block text: `error.toString()` wherever that works (so the text is unchanged for every Error), the info's `message` where it throws (`throw null` → `'null'`), so a catch that describes an error never replaces it with a TypeError of its own (`test/lib/engine/scenario/throw-hostile-values.test.ts`).

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

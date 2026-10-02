# engine/errors/ — the one place a thrown value becomes structured

`extractErrorInfo` turns *any* thrown value into a `StructuredErrorInfo` — message, name, code, field-level `issues` and the `raw` original — and `formatErrorInfo` turns it back into text. Before it, the engine's catch blocks called `error.toString()` and threw the structure away (an `InputValidationError` lost its `.issues`). It owns the extraction and the one safe rendering; it does not decide what the engine *does* with an error — `onError`, the commit-on-error law and retry belong to `engine/traversal/` and `engine/narrative/`.

**The laws.**

- *Strings are made at the rendering edge, not in the catch block.* Narrative recorders, `FlowRecorder.onError` handlers and diagnostics receive the structure and choose how to show it.
- *Extraction survives hostile errors* — a throwing `.message` or `.code` getter, a Proxy, a null-prototype object and a non-Error value all come back as an info object (`'[unserializable error]'` at worst).
- *`raw` is for code, not for output.* It can carry a stack or a cycle, so `formatErrorInfo` prints the message plus one `- path: message` line per issue — never the stack and never `raw` (`test/lib/engine/security/structured-error-safety.test.ts`, `test/lib/engine/unit/errorInfo.test.ts`).

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

Layer L1 (`scripts/layering.config.cjs`): imports `schema/errors` (L0) only, and sits this low so `engine/narrative/` (L5) and the traverser (L6) can both use it. Public through `footprintjs` (`extractErrorInfo`, `formatErrorInfo`, `StructuredErrorInfo`). See also [`../README.md`](../README.md).

# schema/ — tell what kind of schema a value is, and validate against it

The one place footprint decides whether something is a Zod schema, a Zod-like "parseable", a plain JSON Schema or nothing — and the one place it validates data against any of them. It owns detection (`detect.ts`), the structured error (`errors.ts`) and the single validation entry (`validate.ts`). It does not build schemas, convert them to JSON Schema (that is `contract/schema.ts`) or decide *when* to validate (`runner/validateInput.ts` calls it before a run).

**The law: duck-typed, one decision.** Nothing in this folder imports `zod`, or anything else. `detectSchema` reads only shape, in a fixed order: a Zod `def` / `_def` carrying a `type` / `typeName` string → `'zod'`; a `.safeParse` or `.parse` function → `'parseable'` (yup, superstruct, hand-rolled); a `type` string or a `properties` object → `'json-schema'`; anything else → `'none'`. `contract/`, `scope/state/` and `runner/` all ask this file instead of keeping their own test, so they cannot disagree (`test/lib/schema/unit/detect.test.ts`, `test/lib/schema/boundary/edge-cases.test.ts`).

**Validation returns; only `validateOrThrow` throws.** `validateAgainstSchema` hands back `{ success: true, data }` or `{ success: false, error }`, and a `'none'` schema passes the data straight through. The JSON Schema arm is deliberately light — `required` keys plus top-level `type` checks, no ajv. An `InputValidationError` lists a path and a message per field (`.issues`) and keeps the raw schema-library error in `.cause`; the JSON Schema arm never echoes the input into the error and never mutates it (`test/lib/schema/security/prototype-pollution.test.ts`).

```typescript
import { validateAgainstSchema, validateOrThrow } from 'footprintjs';

const schema = { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } };

const result = validateAgainstSchema(schema, { amount: 'ten' });
if (result.success === false) console.log(result.error.issues); // [{ path: ['amount'], message: 'Expected number, received string', … }]

validateOrThrow(schema, { amount: 10 }); // { amount: 10 } — or throws InputValidationError
```

Layer L0 (`scripts/layering.config.cjs`): a leaf, it imports nothing. Public through `footprintjs` (`detectSchema`, `isZod`, `isValidatable`, `validateAgainstSchema`, `validateOrThrow`, `InputValidationError`). See also the folder map in [`../README.md`](../README.md).

# schema/ — tell what kind of schema a value is, and validate against it

The one place footprint decides whether something is a Zod schema, a Zod-like "parseable", a plain JSON Schema or nothing — and the entry the engine validates a run's input through (`runner/validateInput.ts` calls `validateOrThrow` before a run). It owns detection (`detect.ts`), the structured error (`errors.ts`) and that entry (`validate.ts`). It is not the only code that validates: a scope built from a Zod schema checks each write with its own `parseWithThis` (`scope/state/zod/`). It does not build schemas, convert them to JSON Schema (that is `contract/schema.ts`) or decide *when* to validate (the runner does).

**The law: duck-typed, one decision.** Nothing in this folder imports `zod`, or anything else. `detectSchema` reads only shape, in a fixed order: anything that is not a non-null object → `'none'` (so a callable validator is `'none'` even with a `.parse`); a Zod `def` carrying a `type` string, or `_def` carrying a `type` / `typeName` string → `'zod'`; a `.safeParse` or `.parse` function → `'parseable'` (Zod-likes, hand-rolled validators); a `type` string or a `properties` object → `'json-schema'`; anything else → `'none'`. `contract/`, `scope/state/` and `runner/` all ask this file instead of keeping their own test, so they cannot disagree (`test/lib/schema/unit/detect.test.ts`, `test/lib/schema/boundary/edge-cases.test.ts`).

**Validation returns; only `validateOrThrow` throws on invalid data.** `validateAgainstSchema` hands back `{ success: true, data }` or `{ success: false, error }`, and a `'none'` schema passes the data straight through; it can still throw on a hostile schema or input (a `parse` that throws a value whose `issues` getter throws, a schema with a throwing getter, an input whose getter or Proxy trap throws). The JSON Schema arm is deliberately light — the input must be an object (an array passes), its `required` keys must be present and each top-level property's `type` is compared with `typeof` (an array reads as `'array'`, a `null` / `undefined` value is skipped, `'integer'` never matches and a type array is ignored); the schema's own `type` is never read, and there is no ajv. An `InputValidationError` lists a path and a message per field (`.issues`) and keeps the raw schema-library error in `.cause`; the JSON Schema arm never echoes the input into the error and never mutates it (`test/lib/schema/security/prototype-pollution.test.ts`).

```typescript
import { validateAgainstSchema, validateOrThrow } from 'footprintjs';

const schema = { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } };

const result = validateAgainstSchema(schema, { amount: 'ten' });
if (result.success === false) console.log(result.error.issues); // [{ path: ['amount'], message: 'Expected number, received string', … }]

validateOrThrow(schema, { amount: 10 }); // { amount: 10 } — or throws InputValidationError
```

Layer L0 (`scripts/layering.config.cjs`): a leaf, it imports nothing. Public through `footprintjs` (`detectSchema`, `isZod`, `isValidatable`, `validateAgainstSchema`, `validateOrThrow`, `InputValidationError`). See also the folder map in [`../README.md`](../README.md).

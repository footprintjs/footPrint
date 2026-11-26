# filter/ — the one filter-rule law

`evaluator.ts · evaluateFilter` evaluates a `WhereFilter` (Prisma-style: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`; every key ANDed) against a value reader and a redaction check, and returns `{ matched, conditions }` — the condition rows a `DecisionEvidence` carries. Pure: it receives callbacks, never a scope. It owns the two comparison laws: `gt`/`gte`/`lt`/`lte` hold only between two numbers, two bigints, two strings or two Dates (no coercion, so a missing value satisfies none of them), and `eq`/`ne`/`in`/`notIn` share one equality (`===`, plus `NaN` with `NaN` and two Dates at one time); the reasons and an example are in `decide/README.md`. Unknown operators and prototype keys are refused; array operands are capped; a redacted value is summarised as the placeholder. The rule runs on the real threshold. A fourth argument, `serveThreshold(key, threshold)`, is the run's answer passed in as data (`RedactionRule · serveThreshold`), asked after the key's read: what the row keeps, and whether that is a hole (the placeholder plus `thresholdRedacted: true`). Without it, the row keeps the value itself, or a hole when its key is masked.

Its readers sit in two modules that must not reach each other, so it is a module of its own (P2, 10.1):

| Reader | Why |
|---|---|
| `decide/decide.ts` — `decide()` / `select()` | a decider's filter rules, over the stage's scope |
| `filter/firstMatch.ts` — `ruleOver` | one rule without a scope: the retry rule table's rows (`attempt/decision.ts · decideAttempt`) and `decideFromFacts`'s (`decide/fromFacts.ts`) |

It lived in `decide/` until P2. There it made `attempt/` reach `scope/` (`decide.ts` imports the scope runtime), so `scope.$call` — a `scope → attempt` edge — closed an attempt ⇄ decide ⇄ scope module cycle (`scripts/layering.config.cjs`, `npm run check:layering`).

```typescript
import { evaluateFilter } from 'footprintjs/advanced';

const inputs: Record<string, unknown> = { outcome: 'failed', attempt: 2 };
const { matched, conditions } = evaluateFilter((key) => inputs[key], () => false, { attempt: { gte: 3 } });
// matched === false; conditions[0] = { key: 'attempt', op: 'gte', threshold: 3, actualSummary: '2', result: false, … }
```

## First match (`firstMatch.ts`)

The first-match core lives in this leaf, beside `evaluator.ts` (not in `decide/`, which would close the attempt → decide → scope cycle). `decide()`, `decideAttempt` and `decideFromFacts` all call it. For rules that return a boolean, `decide()`'s and `decideAttempt`'s evidence is byte-identical to before the core existed; a synchronous function rule records `matched` as the truthiness of its return (`functionRow`). A Promise or thenable is a non-match with the fixed diagnostic `a rule must return synchronously`. The evaluator does not await values from function rules.

| Symbol | One job |
|---|---|
| `firstMatch(rules, evaluate, defaultBranch)` | asks `evaluate` for each rule in order until one matches; builds the `DecisionEvidence` in `decide()`'s key order (`rules`, `chosen`, `default`, `defaultLabel` when the default has one, on both exits) |
| `normalizeDefaultBranch` | the two `DefaultBranch` forms as one shape; anything that is not the object form is the branch, so a JavaScript call with no default keeps `default: undefined`, and a `null` default is the branch `null` |
| `functionRow`, `filterRow` | the ONE row assembler, for `decide()`, `select()`, `decideAttempt` and `decideFromFacts`. A function rule's `matched` is `!!` what it returned, which is what routes the decision; the return is never stored, so `(s) => s.token` leaves no value on a row |
| `ruleOver(read, keeping?)` | one rule without a scope: a filter's rows from `evaluateFilter`, a function's reads through a view that records each string-keyed read and closes when the rule returns or throws |
| `KEEP_EVERY_VALUE`, `KEEP_NO_VALUE` | what a row keeps: every value (`decideAttempt`, the default), or names and operators only (`decideFromFacts`: the placeholder for every value and threshold, and for a thrown rule's text, which is never turned into text) |

`decide()` evaluates one rule over its stage's scope (recorders, the run's rule, the dev-mode warnings) and builds its rows with the same two builders; the other two doors evaluate over a reader. The property tests that pin the three to equal evidence are `test/lib/attempt/property/attempt-series.property.test.ts` and `test/lib/decide/property/decide-from-facts.property.test.ts`.

# filter/ — the one filter-rule law

`evaluator.ts · evaluateFilter` evaluates a `WhereFilter` (Prisma-style: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`; every key ANDed) against a value reader and a redaction check, and returns `{ matched, conditions }` — the condition rows a `DecisionEvidence` carries. Pure: it receives callbacks, never a scope. Unknown operators and prototype keys are refused; array operands are capped; a redacted value is summarised as the placeholder.

Two owners read it, so it is a module of its own (P2, 10.1):

| Reader | Why |
|---|---|
| `decide/decide.ts` — `decide()` / `select()` | a decider's filter rules, over the stage's scope |
| `attempt/decision.ts` — `decideAttempt` | the retry rule table's filter rows, over an attempt's inputs (no scope) |

It lived in `decide/` until P2. There it made `attempt/` reach `scope/` (`decide.ts` imports the scope runtime), so `scope.$call` — a `scope → attempt` edge — closed an attempt ⇄ decide ⇄ scope module cycle (`scripts/layering.config.cjs`, `npm run check:layering`).

```typescript
import { evaluateFilter } from 'footprintjs/advanced';

const inputs: Record<string, unknown> = { outcome: 'failed', attempt: 2 };
const { matched, conditions } = evaluateFilter((key) => inputs[key], () => false, { attempt: { gte: 3 } });
// matched === false; conditions[0] = { key: 'attempt', op: 'gte', threshold: 3, actualSummary: '2', result: false, … }
```

# filter/ — the one filter-rule law

`evaluator.ts · evaluateFilter` evaluates a `WhereFilter` (Prisma-style: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`; every key ANDed) against a value reader and a redaction check, and returns `{ matched, conditions }` — the condition rows a `DecisionEvidence` carries. Pure: it receives callbacks, never a scope. It owns the two comparison laws: `gt`/`gte`/`lt`/`lte` hold only between two numbers, two strings or two Dates (no coercion, so a missing value satisfies none of them), and `eq`/`ne`/`in`/`notIn` share one equality (`===`, plus `NaN` with `NaN` and two Dates at one time); the reasons and an example are in `decide/README.md`. Unknown operators and prototype keys are refused; array operands are capped; a redacted value is summarised as the placeholder. The rule runs on the real threshold. A fourth argument, `serveThreshold(key, threshold)`, is the run's answer passed in as data (`RedactionRule · serveThreshold`), asked after the key's read: what the row keeps, and whether that is a hole (the placeholder plus `thresholdRedacted: true`). Without it, the row keeps the value itself, or a hole when its key is masked.

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

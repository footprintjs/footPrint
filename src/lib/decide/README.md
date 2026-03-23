# decide/ -- Decision Reasoning Capture

Auto-captures evidence from decider/selector functions. Two `when` formats:
- **Function**: `(s) => s.creditScore > 700` — auto-captures which keys were read via temp recorder
- **Filter**: `{ creditScore: { gt: 700 } }` — captures keys + operators + thresholds (Prisma syntax)

## Usage

```typescript
import { decide, select } from 'footprintjs';

// Decider (first-match)
return decide(scope, [
  { when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } }, then: 'approved', label: 'Good credit' },
  { when: (s) => complexLogic(s), then: 'manual-review', label: 'Complex case' },
], 'rejected');

// Selector (all-match)
return select(scope, [
  { when: (s) => s.glucose > 100, then: 'diabetes', label: 'Elevated glucose' },
  { when: { bmi: { gt: 30 } }, then: 'obesity', label: 'High BMI' },
]);
```

## Architecture

```
decide/
  types.ts      -- DecideRule, FilterOps, WhereFilter, DecisionResult (Symbol brand)
  evaluator.ts  -- Prisma-style filter evaluator (8 ops, prototype denylist)
  evidence.ts   -- EvidenceCollector (temp recorder for function path)
  decide.ts     -- decide() (first-match) + select() (all-match)
  index.ts      -- barrel exports
```

## Design Patterns

### 1. Temporary Recorder (EvidenceCollector)

For function-based `when` clauses, evidence is captured by attaching a minimal Recorder
to the scope for the duration of the `when()` call, then immediately detaching:

```
before when(): scope.attachRecorder(collector)
call when(scope) -- reads fire onRead to collector
after when(): scope.detachRecorder(collector.id)   [in finally block]
```

The collector captures `ReadEvent.key`, `ReadEvent.value` (summarized via `summarizeValue()`),
and `ReadEvent.redacted` (for PII protection). No raw object references are held.

### 2. Scope Accessor Adaptation

`decide()` must work with both ScopeFacade (direct methods) and TypedScope ($-prefixed
methods routed through Proxy). Four accessor factories duck-type both without importing either:

- `getAttachFn(scope)` -- tries `attachRecorder`, then `$attachRecorder`
- `getDetachFn(scope)` -- tries `detachRecorder`, then `$detachRecorder`
- `getValueFn(scope)` -- tries `getValue`, then `$getValue`
- `getRedactedFn(scope)` -- uses `$toRaw()` to escape Proxy, then `getRedactedKeys()`

### 3. Symbol Branding (DECISION_RESULT)

`DecisionResult` and `SelectionResult` carry a private Symbol (`DECISION_RESULT`) to
distinguish them from accidental objects with a `branch` property. DeciderHandler and
SelectorHandler check `Reflect.has(stageOutput, DECISION_RESULT)` before extracting evidence.

## Filter Operators (Prisma naming, 8 ops)

| Operator | Meaning | Example |
|---|---|---|
| `eq` | === | `{ plan: { eq: 'premium' } }` |
| `ne` | !== | `{ status: { ne: 'banned' } }` |
| `gt` | > | `{ score: { gt: 700 } }` |
| `gte` | >= | `{ score: { gte: 700 } }` |
| `lt` | < | `{ dti: { lt: 0.43 } }` |
| `lte` | <= | `{ age: { lte: 65 } }` |
| `in` | includes | `{ region: { in: ['US', 'EU'] } }` |
| `notIn` | not includes | `{ region: { notIn: ['CN'] } }` |

Multiple operators on the same key are ANDed: `{ score: { gt: 600, lt: 800 } }` = range check.

## Security

- Prototype pollution denylist: `__proto__`, `constructor`, `prototype`, etc. silently fail the rule
- `in`/`notIn` array size capped at 1000 elements (DOS prevention)
- Unknown operators fail the rule (not silently match)
- Empty filter returns `matched: false` (prevents vacuous truth)
- Redacted values show `[REDACTED]` in evidence (via ReadEvent.redacted flag)

## Narrative Output

Filter evidence:
```
[Condition]: It evaluated Rule 0 "Good credit": creditScore 750 gt 700 check, dti 0.38 lt 0.43 check, and chose approved.
```

Function evidence:
```
[Condition]: It examined "Complex case": creditScore=750, dti=0.38, and chose manual-review.
```

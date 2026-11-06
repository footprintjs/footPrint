# decide/ -- Decision Reasoning Capture

Auto-captures evidence from decider/selector functions. Two `when` formats:

- **Function**: `(s) => s.creditScore > 700` — auto-captures which keys were read via temp recorder
- **Filter**: `{ creditScore: { gt: 700 } }` — captures keys + operators + thresholds (Prisma syntax)

## Usage

```typescript
import { flowChart, decide, select } from 'footprintjs';

// Decider (first-match): the helper runs inside a registered stage scope.
const lending = flowChart<{ creditScore: number; dti: number }>('Intake', (scope) => {
  scope.creditScore = 750;
  scope.dti = 0.35;
}, 'intake')
  .addDeciderFunction('Risk', (scope) => decide(scope, [
    { when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } }, then: 'approved', label: 'Good credit' },
    { when: (s) => s.creditScore > 600, then: 'manual-review', label: 'Marginal credit' },
  ], 'rejected'), 'risk')
  .addFunctionBranch('approved', 'Approve', () => {})
  .addFunctionBranch('manual-review', 'Review', () => {})
  .addFunctionBranch('rejected', 'Reject', () => {})
  .end()
  .build();

// Selector (all-match)
const screening = flowChart<{ glucose: number; bmi: number }>('Intake', (scope) => {
  scope.glucose = 120;
  scope.bmi = 31;
}, 'intake')
  .addSelectorFunction('Screen', (scope) => select(scope, [
    { when: (s) => s.glucose > 100, then: 'diabetes', label: 'Elevated glucose' },
    { when: { bmi: { gt: 30 } }, then: 'obesity', label: 'High BMI' },
  ]), 'screen')
  .addFunctionBranch('diabetes', 'Diabetes screening', () => {})
  .addFunctionBranch('obesity', 'BMI assessment', () => {})
  .end()
  .build();
```

## Naming the default branch

Every branch is named by the rule that chose it — the rule's `label` travels out
on `evidence.rules[].label`. The default branch is chosen by **no rule**: it
fires precisely when every rule failed, so no rule exists to carry its name. It
is the one branch evidence cannot otherwise name, and anything generated from
evidence (narrative, audit, a published "what each verdict means" map) has a
hole exactly where the run's own outcome sits.

Pass the default as an object to close it:

```typescript
decide(
  scope,
  [
    { when: { riskScore: { gt: 80 } }, then: 'quarantined', label: 'Risk above the quarantine line' },
    { when: { riskScore: { gt: 50 } }, then: 'flagged', label: 'Risk above the review line' },
  ],
  { branch: 'protected', label: 'No rule fired — asset stays protected' },
);
//  ↑ was: 'protected'
```

The label lands on `DecisionEvidence.defaultLabel`:

```typescript
evidence.defaultLabel; // 'No rule fired — asset stays protected'
evidence.default; // 'protected'
```

- **The bare string still works, byte for byte.** `'protected'` produces exactly
  the evidence it always did — `defaultLabel` is absent, not `undefined`.
- **The label is recorded on every decision**, including runs where a rule won.
  The default's meaning belongs to the decider, not to the run; emitting it only
  on the fallthrough would make a harvested meanings map appear and disappear
  with the data.
- **Narrative** prints it the way a matched rule's label is printed:
  `[Condition]: No rules matched, fell back to default "No rule fired — asset stays protected": Protect.`

Example: [examples/build-time-features/decide-select/05-default-label.ts](../../../examples/build-time-features/decide-select/05-default-label.ts)

## Architecture

```
decide/
  types.ts      -- DecideRule, FilterOps, WhereFilter, DefaultBranch, DecisionResult (Symbol brand)
  evidence.ts   -- EvidenceCollector (temp recorder for function path)
  decide.ts     -- decide() (first-match) + select() (all-match)
  index.ts      -- barrel exports
```

## Design Patterns

### 1. Temporary ScopeRecorder (EvidenceCollector)

For function-based `when` clauses, evidence is captured by attaching a minimal ScopeRecorder
to the scope for the duration of the `when()` call, then immediately detaching:

```
before when(): scope.attachScopeRecorder(collector)
call when(scope) -- reads fire onRead to collector
after when(): scope.detachScopeRecorder(collector.id)   [in finally block]
```

The collector captures `ReadEvent.key`, `ReadEvent.value` (summarized via `summarizeValue()`),
and `ReadEvent.redacted` (for PII protection). No raw object references are held.

### 2. Scope Accessor Adaptation

`decide()` and `select()` get their infrastructure port from `scope/runtime.ts`,
the same registration used by the executor. They bind recorder attachment,
tracked reads and redacted-key lookup to that port without probing data fields
on TypedScope or a strict Zod proxy. Built-ins register automatically. Standalone
custom scope objects must call `registerScopeRuntime` from `footprintjs/advanced`
too; a data-only port has no tracked reads/filter values to offer.

### 3. Symbol Branding (DECISION_RESULT)

`DecisionResult` and `SelectionResult` carry a private Symbol (`DECISION_RESULT`) to
distinguish them from accidental objects with a `branch` property. DeciderHandler and
SelectorHandler check `Reflect.has(stageOutput, DECISION_RESULT)` before extracting evidence.

## Filter Operators (Prisma naming, 8 ops)

| Operator | Meaning      | Example                            |
| -------- | ------------ | ---------------------------------- |
| `eq`     | ===          | `{ plan: { eq: 'premium' } }`      |
| `ne`     | !==          | `{ status: { ne: 'banned' } }`     |
| `gt`     | >            | `{ score: { gt: 700 } }`           |
| `gte`    | >=           | `{ score: { gte: 700 } }`          |
| `lt`     | <            | `{ dti: { lt: 0.43 } }`            |
| `lte`    | <=           | `{ age: { lte: 65 } }`             |
| `in`     | includes     | `{ region: { in: ['US', 'EU'] } }` |
| `notIn`  | not includes | `{ region: { notIn: ['CN'] } }`    |

Multiple operators on the same key are ANDed: `{ score: { gt: 600, lt: 800 } }` = range check.

> **Empty filter NEVER matches (anti-vacuous-truth).** `when: {}` returns
> `matched: false` — this deliberately **inverts the Prisma/SQL `where: {}`
> intuition** ("match everything"). In a decision rule, a rule that asserts
> nothing must not win a branch on vacuous truth; the catch-all belongs in
> `decide()`'s explicit `defaultBranch`. Unknown operators (e.g. a typo like
> `gle`) also never match — with `enableDevMode()` a console warning names
> the bad operator and key.

## Security

- Prototype pollution denylist: `__proto__`, `constructor`, `prototype`, etc. silently fail the rule
- `in`/`notIn` array size capped at 1000 elements (DOS prevention)
- Unknown operators fail the rule (not silently match)
- Empty filter returns `matched: false` (prevents vacuous truth)
- Redacted values show `[REDACTED]` in evidence (via ReadEvent.redacted flag)

### Under a redaction policy

Evidence is served where it is built, so there is one form everywhere and no second scrub on the way out. `decide/` holds no rule: it asks the scope's port (`ScopeRuntimeTarget · decisionEvidenceRule`) for answers from `RedactionRule · evidenceRule`.

| Field | Served by | Travels to |
| --- | --- | --- |
| `conditions[].threshold` | `RedactionRule · serveThreshold`, the one law. Served: one frozen copy. Masked: the placeholder plus `thresholdRedacted: true` | the returned result, `onDecision` / `onSelected`, narrative, control rows, `capture-history` |
| `conditions[].actualSummary` | `verdictAt`, not the marked set; `redacted: true` when masked | the same |
| `matchError` | `RedactionRule · retainStageText`, at `errors.matchError` | the same, and the dev-mode warning. The narrative prints only a count |
| `label`, `defaultLabel` | Nothing: author text. Do not build one from a selected value | the same |

A `$break(reason)` follows the same law at `logs.breakReason`, served once in `engine/handlers/breakFlag.ts`. It reaches only `onBreak`, the parent's propagated event included.

Under an active rule a threshold is read once. `serveThreshold` makes one detached, frozen copy, checks that copy and stores it, so what the check saw is what every reader gets, and an edit to the original afterwards reaches nothing. The rule itself still runs on the original. With no policy the row keeps the value itself, the same reference, and nothing reads it.

The copy is read from property descriptors, so a getter never runs. It holds primitives, plain objects, dense lists and `Date`s (one number and nothing else). Anything else, at any depth, is a hole even under a rule that selects nothing in it: an accessor, a non-enumerable or symbol key (a hidden `toJSON`), a function, a symbol, a `Map`, a `Set`, a class instance, a sparse list, a list with named keys, or a Proxy.

A threshold that is itself a scope handle (`{ in: s.allowed }`) is copied from the state behind it, without its traps. A handle inside an object the stage built is a Proxy like any other. A foreign Proxy's traps can run during the read, because JavaScript has no Proxy test that runs no author code: `structuredClone` refuses a Proxy unasked but runs a plain object's getters. So the descriptor walk goes first and the clone then tests every object it reached. The traps' answers never reach a reader.

`matchError` and a break reason are strings once made, so nothing can change them afterwards. An object where text belongs, such as an `Error` whose `message` is one, is a hole: its `toString` would run after the sources were asked.

A read counts when it hands the stage a value (`StageContext · taintedReads`). A key listing hands over names, so `Object.keys(s)` and `for…in` never count (`StageContext · inspectValue`). `JSON.stringify(s)` and `{ ...s }` count when their `get` reads reach a selected key, and a whole-state read counts when it holds a selected name at any depth (`RedactionRule · holdsSelected`).

**What stays uncovered.** A rule's `label`; a value the stage did not read in this stage; a selected name inside a `Map` or `Set` in the stage's args or in a whole-state read; a value inside a key the state rule leaves clear (`keys: ['a.ssn']` does not select `a` written whole, so use `fields`); a stage that edits the evidence object `decide()` returned, which is writing evidence by hand; a threshold checked before the run's first mark, under no policy; and a custom scope port with no `decisionEvidenceRule`, which keeps the reference. See `docs/guides/scope.md`, "Decision evidence and break reasons".

## Narrative Output

Filter evidence:

```
[Condition]: It evaluated Rule 0 "Good credit": creditScore 750 gt 700 check, dti 0.38 lt 0.43 check, and chose approved.
```

Function evidence:

```
[Condition]: It examined "Complex case": creditScore=750, dti=0.38, and chose manual-review.
```

Default branch (labelled, and the unchanged unlabelled line beneath it):

```
[Condition]: No rules matched, fell back to default "No rule fired — asset stays protected": Protect.
[Condition]: No rules matched, fell back to default: Protect.
```

## The same evidence, for retries (10.1)

A retry-or-stop decision is a `DecisionEvidence` too: the attempt runner evaluates `retryRules(policy)`
(`attempt/decision.ts`) — six ordinary `decide()` rules over an attempt's inputs, default `retry` — and keeps the
evidence on each `AttemptRecord.decision`. It has no scope, so it builds the rows itself (`decideAttempt`: the
filter rows come from the same `evaluateFilter` decide() uses — `filter/evaluator.ts`, a leaf module of its own since
P2), and `test/lib/attempt/property` pins that they equal what
`decide(scope, retryRules(policy), { branch: 'retry', label: 'retryable' })` records for the same inputs. One
evidence shape, so a renderer or an agent that reads a decider reads a retry the same way. `types.ts` is an L0 leaf
for that reason: the frame's snapshot type names it through `AttemptRecord`.

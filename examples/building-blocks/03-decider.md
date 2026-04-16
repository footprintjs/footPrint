---
name: Decider (Conditional)
group: Building Blocks
guide: https://footprintjs.github.io/footPrint/guides/building-blocks/decisions/
---

# Decider (Conditional Branching)

A **decider** is a stage that picks **one of many branches** to continue on. Think `if/else` or `switch`, but as a first-class flowchart concept — the decision is visible, the reasoning is captured, and the branch choice appears in the narrative.

```
                 ┌── "premium"  → ApplyLoyaltyDiscount
LoadCustomer → ClassifyTier ─┼── "standard" → SuggestUpgrade
                 └── "trial"    → ShowOnboarding    (default)
                                        │
                                   CalculateTotal
```

## When to use

- You have **mutually exclusive paths** — exactly one branch should run.
- The decision depends on runtime data (e.g., customer tier, status code, feature flag).
- You want the **why** captured automatically, not buried in an `if` statement.

## The `decide()` helper

Instead of writing `if/else` and returning a branch name, use `decide()` — it captures the evidence for you:

```typescript
return decide(scope, [
  { when: { creditScore: { gt: 700 }, dti: { lt: 0.43 } }, then: 'approved', label: 'Good credit' },
  { when: (s) => s.creditScore > 600, then: 'manual-review', label: 'Marginal' },
], 'rejected');
```

The narrative automatically becomes:
> "It evaluated Rule 0 'Good credit': creditScore 750 gt 700, and chose approved."

Every decision has **receipts** — which rule matched, which values drove it, what the fallback would have been.

## When to use decide vs plain return

| | Plain `return 'branch'` | `decide(scope, rules)` |
|---|---|---|
| Code | A few lines shorter | A few lines longer |
| Narrative | "Decider chose X" | "Rule 0 matched: creditScore 750 gt 700 → X" |
| Auditable | No | **Yes** — rule label, matched values, all captured |
| LLM-readable reasoning | Thin | Rich |

Use `decide()` for any decision that matters — compliance, business rules, routing. Use plain return for trivial branches.

## Key API

- `.addDeciderFunction('Name', fn, 'id')` — add a decider stage.
- `.addFunctionBranch(branchId, 'Name', fn)` — register a branch.
- `.setDefault('branchId')` — fallback if no branch matched.
- `.end()` — close the decider, continue the parent chain.

## Related concepts

- **[Selector](./04-selector.md)** — run **multiple** branches instead of one. Decider = XOR, Selector = OR.
- **[Subflow](./05-subflow.md)** — mount an entire flowchart as a branch.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/building-blocks/decisions/)** — covers decide(), select(), and all decision patterns.

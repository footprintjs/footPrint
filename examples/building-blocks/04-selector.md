---
name: Selector
group: Building Blocks
guide: https://footprintjs.github.io/footPrint/guides/building-blocks/decisions/
---

# Selector (Filtered Multi-Branch)

A **selector** picks **zero, one, or many** branches and runs them all in parallel. Unlike a decider (exactly one) or a fork (always all), selector is the "some matched, run those" pattern.

```
                      ┌── DiabetesScreening ──┐
LoadPatient → Triage ─┼── HypertensionCheck ──┼─→ GenerateReport
                      └── ObesityAssessment ──┘
                      (each runs iff its condition matches)
```

## When to use

- You have **N possible actions** and need to run all that apply.
- Common examples: **medical screening** (run tests relevant to the patient's conditions), **feature flags** (apply each active variant), **notification fanout** (email + SMS + push, only where user opted in), **validation suites** (run all applicable checks).

## The `select()` helper

Like `decide()` for deciders, `select()` captures the reasoning behind **which branches matched**:

```typescript
return select(scope, [
  { when: { conditions: { includes: 'diabetes' } }, then: 'diabetes', label: 'Has diabetes history' },
  { when: (s) => s.vitals.bloodPressure >= '140/90', then: 'hypertension', label: 'Elevated BP' },
  { when: (s) => s.vitals.bmi > 30, then: 'obesity', label: 'BMI > 30' },
]);
```

The narrative then records:
> "Selector evaluated 3 rules. Matched: diabetes (Has diabetes history, conditions includes 'diabetes'), hypertension (BP 148/92 >= 140/90). Skipped: obesity (BMI 28.5 not > 30). Running 2 branches in parallel."

Every match AND miss is evidence — critical for **compliance audits**.

## Selector vs Fork

| | Selector | Fork |
|---|---|---|
| Branches run | Conditionally (filter-picked) | Always all |
| Use case | "run what applies" | "run all, always" |

If the answer is always all, use Fork (simpler). If it's conditional, use Selector.

## Gotcha: returning empty match

If **zero branches match**, selector emits an empty-match event and continues to the next stage — no error, no default. Check this in your narrative: did you expect at least one branch to run? If so, add a `when: () => true` fallback rule that writes a default marker.

## Key API

- `.addSelectorFunction('Name', selectFn, 'id')` — add a selector stage.
- `.addFunctionBranch(branchId, 'Name', fn)` — register a branch.
- `.end()` — close the selector.
- `select(scope, rules)` — auto-capture which rules matched.

## Related concepts

- **[Decider](./03-decider.md)** — mutually exclusive (exactly one branch).
- **[Fork](./02-fork.md)** — unconditional parallel (all branches, no filter).
- **[Full guide](https://footprintjs.github.io/footPrint/guides/building-blocks/decisions/)** — covers decide(), select(), evidence capture.

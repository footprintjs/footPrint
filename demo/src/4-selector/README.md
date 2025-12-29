# Demo 4: Multi-Choice Parallel (Selector Pattern)

Dynamic multi-choice branching with `addSelector()` - pick one OR more branches.

## Pattern: Selector for Dynamic Parallel Selection

```
                    ┌──────────────┐
                    │   Analyze    │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Selector   │ ← "Which branches?" (can return array!)
                    └──────┬───────┘
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  Email   │ │   SMS    │ │   Push   │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
              │            │            │
              └────────────┼────────────┘
                           ▼
                    ┌──────────────┐
                    │   Confirm    │
                    └──────────────┘
```

## Key Concepts

1. **`addSelector(fn)`** - Returns a SelectorList for adding branches
2. **Selector returns `string | string[]`** - Single ID or array of IDs
3. **Selected branches run in parallel** - Like fork, but dynamic
4. **Decider vs Selector**:
   - Decider: Single choice (if/else)
   - Selector: Multi-choice (pick N of M)

## When to Use

- Notification routing (email AND/OR SMS AND/OR push)
- Feature flags (enable multiple features dynamically)
- A/B testing with multiple variants
- Dynamic workflow composition

## Run

```bash
npx ts-node demo/src/4-selector/index.ts
```

# Demo 3: Parallel Execution (Fork Pattern)

Execute multiple branches in parallel with `addListOfFunction()`.

## Pattern: Fork-Join for Parallel Execution

```
                    ┌──────────────┐
                    │   Prepare    │
                    └──────┬───────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   ┌──────────┐      ┌──────────┐      ┌──────────┐
   │ Fetch A  │      │ Fetch B  │      │ Fetch C  │
   └────┬─────┘      └────┬─────┘      └────┬─────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           ▼
                    ┌──────────────┐
                    │  Aggregate   │  ← Receives bundle of all results
                    └──────────────┘
```

## Key Concepts

1. **`addListOfFunction(specs)`** - Add parallel children
2. **Each child has `id`, `name`, `fn`** - ID is used in result bundle
3. **Results bundled** - Next stage receives `{ childId: result, ... }`
4. **True parallelism** - All children execute concurrently

## When to Use

- Fetching data from multiple sources
- Running independent validations
- Parallel API calls
- Map-reduce patterns

## Run

```bash
npx ts-node demo/src/3-parallel/index.ts
```

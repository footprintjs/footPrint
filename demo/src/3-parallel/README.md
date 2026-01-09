# Demo 3: Parallel Execution

**Pattern:** Fork  
**Complexity:** ⭐⭐  
**Time:** 10 minutes

## What You'll Learn

- Parallel execution with `addListOfFunction()`
- Fork-join pattern for concurrent operations
- Result aggregation from parallel children

## The Flow

```
                    ┌───────────────────┐
                ┌──▶│ FetchUserProfile  │──┐
┌───────────────┐│  └───────────────────┘  │  ┌──────────────────┐
│ PrepareRequest│┼─▶│ FetchUserOrders   │──┼─▶│ AggregateResults │
└───────────────┘│  └───────────────────┘  │  └──────────────────┘
                └──▶│FetchUserPreferences│──┘
                    └───────────────────────┘
```

## Key Concepts

### 1. Fork Pattern

All children execute in parallel, then results are aggregated:

```typescript
new FlowChartBuilder()
  .start('PrepareRequest', prepareFn)
  .addListOfFunction([
    { id: 'profile', name: 'FetchUserProfile', fn: profileFn },
    { id: 'orders', name: 'FetchUserOrders', fn: ordersFn },
    { id: 'prefs', name: 'FetchUserPreferences', fn: prefsFn },
  ])
  .addFunction('AggregateResults', aggregateFn);
```

### 2. True Parallelism

```
Sequential: 100ms + 150ms + 80ms = 330ms
Parallel:   max(100, 150, 80)   = 150ms  ← FootPrint does this!
```

### 3. Result Bundle

Children return a bundle object with results keyed by child ID:

```typescript
{
  profile: { result: { name: 'Alice', email: '...' }, isError: false },
  orders: { result: { orders: [...] }, isError: false },
  prefs: { result: { theme: 'dark' }, isError: false }
}
```

### 4. Error Handling

If a child throws, its error is captured without affecting siblings:

```typescript
{
  profile: { result: { name: 'Alice' }, isError: false },
  orders: { result: Error('timeout'), isError: true },  // ← Error captured
  prefs: { result: { theme: 'dark' }, isError: false }
}
```

## Run It

```bash
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/3-parallel/index.ts
```

## Expected Output

```
=== Parallel Demo (Fork Pattern) ===

Starting parallel execution...

  [Prepare] Setting up parallel fetches...
  [Profile] Fetching user profile...
  [Orders] Fetching user orders...
  [Prefs] Fetching user preferences...
  [Aggregate] Combining all results...

✓ Parallel demo complete! (152ms)
  Note: ~150ms total despite 330ms of work = true parallelism!
```

## Real-World Use Cases

- **API Aggregation**: Fetch from multiple services simultaneously
- **Data Enrichment**: Enrich records from multiple sources
- **Batch Processing**: Process items in parallel batches

## Next Steps

→ [Demo 4: Selector](../4-selector/) - Learn multi-choice parallel execution

# Backward Causal Chain — Algorithm Reference

## Problem

Given an ordered commit log (one entry per stage execution, recording what each stage wrote) and knowledge of what each stage read, walk backwards from a starting stage to find the full **causal DAG** — the set of stages that contributed data to a given result.

## Algorithm: BFS Backward Thin-Slicing

This is a simplified form of **backward program slicing** (Weiser 1984), specifically the **thin-slice** variant (Sridharan et al. 2007). Our case is simpler than general program slicing because:

1. **Linear execution order** — the commit log is strictly ordered
2. **Explicit reads/writes** — no pointer aliasing, no indirect data flow
3. **Post-hoc analysis** — execution is complete, all data is available

### Steps

```
Input:
  commitLog: CommitBundle[]       — ordered writes per stage
  startId: string                 — runtimeStageId to start from
  getKeysRead: (id) => string[]   — what each stage read

Output:
  CausalNode (DAG root)           — .parents forms the causal DAG

Algorithm (BFS):
  1. Build position index: runtimeStageId → array position  [O(N)]
  2. Locate startId → root CausalNode
  3. Queue ← [root]
  4. While queue is not empty:
     a. Dequeue node N at commit position P, depth D
     b. If D ≥ maxDepth → skip
     c. Get keysRead for N via callback
     d. For each key K in keysRead:
        i.  Find last writer of K before position P
        ii. If writer already in nodeMap → link as parent (DAG merge)
        iii. Else → create CausalNode, add to nodeMap, link, enqueue
  5. Return root
```

### DAG, Not Tree

A stage that reads `creditScore` AND `dti` from different writers has **two parents**. The `nodeMap` ensures each writer appears exactly once in the DAG (shared references, not duplicated subtrees). This is the key difference from a linked-list backtrack.

### Cycle Safety

The BFS visited set (`nodeMap`) prevents revisiting. Self-loops are impossible because `findLastWriter(log, key, idx)` searches strictly before `idx` — a stage at position 0 cannot find itself as a writer.

## Staged Optimization

Two writer-lookup strategies, selected automatically by commit log size:

```
┌─────────────────────────────────────────────────────────┐
│                    Decision Point                        │
│                                                          │
│  commitLog.length ≤ 256?                                │
│      YES → Linear Scan    (O(N) per lookup, 0 setup)    │
│      NO  → Reverse Index  (O(log N) per lookup, O(N×U)  │
│                             setup, binary search)        │
└─────────────────────────────────────────────────────────┘
```

**Why 256?** The reverse index build cost is O(N × U) where U = unique keys. For N ≤ 256, linear scan is fast enough that the index build cost isn't amortized. Above 256, the O(log N) per-lookup savings compound over the BFS traversal.

**Like a query optimizer:** A database picks sequential scan for small tables and index scan for large ones. Same principle — the caller never sees the strategy, it's chosen internally.

### Complexity

| Scenario | Strategy | Total Cost |
|----------|----------|------------|
| Small pipeline (N=20, V=5, K=3) | Linear | 20 × 3 × 5 = 300 ops |
| Medium pipeline (N=100, V=10, K=4) | Linear | 100 × 4 × 10 = 4K ops |
| Agent loop (N=500, V=20, K=5) | Reverse index | Build: 500 + Lookup: 20 × 5 × log(500) ≈ 1K ops |
| Large agent (N=2000, V=30, K=8) | Reverse index | Build: 2K + Lookup: 30 × 8 × log(2000) ≈ 3K ops |

Where: N = commit log length, V = visited nodes, K = avg keys per node.

## References

- **Weiser, M.** (1984). "Program Slicing." *IEEE Transactions on Software Engineering*, SE-10(4), 352–357. — Original backward slicing algorithm.
- **Sridharan, M., Fink, S. J., Bodik, R.** (2007). "Thin Slicing." *PLDI '07*, 112–122. — Thin-slice variant: follow only producer-consumer data dependencies (what we do).

## See Also

- `commitLogUtils.ts` — `findLastWriter()`, `findCommit()` (linear scan primitives)
- `backtrack.ts` — `causalChain()`, `flattenCausalDAG()`, `formatCausalChain()` (this algorithm)
- `../recorder/qualityTrace.ts` — Decorates causal chain with quality scores

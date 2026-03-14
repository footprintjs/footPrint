# Performance

Benchmarks measured on Node v22, Apple Silicon. Run `npm run bench` to reproduce.

## Results

| Benchmark | Time | Detail |
|-----------|------|--------|
| **Write 1K keys** | 811us | ~1.2M ops/s |
| **Write 10K keys** | 5.4ms | ~1.8M ops/s |
| **Read 100K keys** | 8.7ms | ~11.5M ops/s |
| **10 stages (linear)** | 106us | 0.011ms/stage |
| **200 stages (linear)** | 4.7ms | 0.023ms/stage |
| **500 stages (linear)** | 20ms | 0.040ms/stage |
| **100 concurrent pipelines** | 2.3ms | 3-stage each |
| **1,000 concurrent pipelines** | 24ms | 3-stage each |
| **structuredClone 1KB** | 2us | per call |
| **structuredClone 100KB** | 76us | per call |
| **structuredClone 1MB** | 2.5ms | per call |
| **Time-travel 100 commits** | 75us | 0.001ms/commit |
| **Time-travel 500 commits** | 385us | 0.001ms/commit |
| **Commit with 100 writes** | 375us | single stage |

## Key Takeaways

- A **200-stage pipeline** completes in under 5ms
- **Read throughput** exceeds 11M ops/s
- The primary cost at scale is `structuredClone` — keep state objects under 100KB per stage for sub-millisecond commit overhead
- **Concurrent pipelines** scale linearly — 1,000 concurrent 3-stage pipelines finish in 24ms

## Running Benchmarks

```bash
npm run bench
```

This runs `bench/run.ts` using `tsx`. Results vary by machine — the numbers above are reference values on Apple Silicon.

---

**[Back to guides](./README.md)** | **[Architecture](../internals/)**

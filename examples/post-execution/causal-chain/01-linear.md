---
name: Causal Chain
group: Post-Execution
guide: https://footprintjs.github.io/footPrint/guides/trace/causal-chain/
---

# Causal Chain — Backward Data Lineage

The **causal chain** answers a question no other pipeline library answers directly:

> **"Where did this value come from?"**

Pick any key in the final state. The causal chain walks backward through every stage that contributed to it — producing a stack-trace-like view of *data lineage*.

```
Seed → Process → Format
```

Ask for Format's causal chain:

```
Format   wrote: output
↑ Process   wrote: processed   ← via processed
↑ Seed (origin)   wrote: input   ← via input
```

Three stages, three hops, one clear line of cause.

## Why this is unique

Most tracing libraries (OpenTelemetry, Datadog, Honeycomb) show **when** something happened and **how long** it took. Few show **which prior stages caused a value**.

footprintjs captures this for free because every scope read is recorded during traversal (via `QualityRecorder` or the Commit Log). The causal DAG is reconstructed from the log — no separate instrumentation needed.

## What you can do with it

- **Debug "where did this wrong value come from?"** — click any final key, walk backward to the source.
- **Audit compliance** — prove which inputs drove a rejected loan / medical diagnosis / hiring decision.
- **Quality gates** — if an upstream stage had low quality, propagate a warning downstream.
- **Root-cause analysis** — for AI agents, find which tool call or LLM step produced a bad output.

## The API

```typescript
import { causalChain, formatCausalChain, QualityRecorder } from 'footprintjs/trace';

const quality = new QualityRecorder(() => ({ score: 1.0 }));
executor.attachRecorder(quality);
await executor.run();

const { commitLog } = executor.getSnapshot();
const dag = causalChain(
  commitLog,
  targetRuntimeStageId,
  (id) => quality.getByKey(id)?.keysRead ?? [],
);

console.log(formatCausalChain(dag));
```

The DAG can be:
- Flattened to a stack (`flattenCausalDAG`) for table views.
- Rendered graphically (as the Data Trace panel in the playground does).
- Serialized to JSON for audit storage.

## Visible in this playground

Run any sample, click a stage in the flowchart, then open **Inspector → Data Trace**. You're seeing this API in action — the panel renders a chain of stages linked by key names.

## Related

- **[Subflow Causal Chain](./03-subflow.md)** — causality across subflow boundaries.
- **[Loop Causal Chain](./04-loop.md)** — multi-iteration causality.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/trace/causal-chain/)** — causalChain(), QualityRecorder, and the commit log.

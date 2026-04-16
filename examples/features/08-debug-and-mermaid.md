---
name: Debug & Mermaid
group: Features
guide: https://footprintjs.github.io/footPrint/guides/features/debug/
---

# DebugRecorder + toMermaid — Diagnostics and Diagrams

Two tools for understanding your flow — one for runtime, one for build time.

- **`DebugRecorder`** captures every read, write, and error with full detail. The verbose sibling of MetricRecorder.
- **`chart.toMermaid()`** renders the flowchart as [Mermaid](https://mermaid.js.org) syntax you can drop into docs, PRs, and issues.

## DebugRecorder — when to use

- **Bug repros** — when a stage misbehaves, attach DebugRecorder and read the full event stream.
- **Local dev** — verbose logs during active development.
- **Test assertions** — inspect every read/write in a test without instrumenting stages.
- **Error forensics** — which key was being read when the error fired? DebugRecorder has it.

## The pattern

```typescript
import { DebugRecorder, FlowChartExecutor } from 'footprintjs';

const debug = new DebugRecorder({ verbosity: 'verbose' });
executor.attachRecorder(debug);

await executor.run();

debug.getEntries();   // every read/write/commit as structured objects
debug.getErrors();    // just the errors
```

## Verbosity levels

| Level | Records |
|---|---|
| `quiet` | Errors only |
| `normal` | Writes + errors |
| `verbose` | Reads + writes + commits + errors (everything) |

Start with `verbose` during development. Drop to `normal` or `quiet` if entries grow too large in production (MetricRecorder is the counterpart for hot-path production use).

## Production caveat

DebugRecorder stores every event in memory. For long-running flows with many stages, this can grow. Options:

- Use `normal` or `quiet` verbosity.
- Use a `stageFilter` to narrow scope.
- Flush periodically by reading + resetting.
- Use **MetricRecorder** instead if you only need counts, not values.

## toMermaid — when to use

Generate a **human-readable diagram** from a built chart:

```typescript
const chart = flowChart(...).build();
console.log(chart.toMermaid());
```

Output:
```
flowchart TD
  seed["Seed"]
  seed --> validate
  validate["Validate"]
  validate --> decide
  decide{"Classify"}
  decide -->|"high-risk"| reject
  decide -->|"low-risk"| approve
  reject["Reject"]
  approve["Approve"]
```

Paste that into:

- **Markdown** (GitHub renders Mermaid automatically).
- **Slack / Linear / Notion** — most tools support Mermaid blocks.
- **Design docs** — "here's exactly what the code does."
- **PR descriptions** — reviewers see the shape before reading the code.

## Why both matter together

**DebugRecorder** answers *"what happened during this specific run?"*
**toMermaid** answers *"what CAN happen in this chart, structurally?"*

Pair them: share the Mermaid diagram in a bug report + the DebugRecorder entries as the reproduction data.

## Key API — DebugRecorder

- `new DebugRecorder(options?)` — create. `options.verbosity`: `'quiet' | 'normal' | 'verbose'`.
- `debug.getEntries()` — all events.
- `debug.getErrors()` — errors only.
- `debug.reset()` — clear for next run.

## Key API — toMermaid

- `chart.toMermaid()` — returns Mermaid syntax as a string.
- Also available via **Flowchart → Description → Mermaid** in the playground after running.

## Related

- **[Metrics](./05-metrics.md)** — the production-ready counterpart (counts, not values).
- **[Redaction](./12-redaction.md)** — scrub sensitive fields from DebugRecorder entries.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/features/debug/)** — verbosity levels, filters, and best practices.

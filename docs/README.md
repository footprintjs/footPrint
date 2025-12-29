# FootPrint Documentation

Welcome to the FootPrint documentation. FootPrint is a tiny, production-minded runtime for building flowchart-like pipelines where each node is just a function.

## Documentation Index

| Document | Description |
|----------|-------------|
| [Getting Started](./GETTING_STARTED.md) | Quick start guide and installation |
| [Core Concepts](./CORE_CONCEPTS.md) | Pipeline, stages, scope, and memory model |
| [Patterns](./PATTERNS.md) | Fork, Decider, Selector patterns |
| [FlowChartBuilder API](./FLOWCHART_BUILDER.md) | Builder API reference |
| [Scope Communication](./SCOPE_COMMUNICATION.md) | Cross-stage data sharing (CRITICAL) |

## Key Features

- **Not a DAG** - Supports loops, re-entry, and partial/resumed execution
- **Parallel fan-out / structured fan-in** - Fork pattern with aggregation
- **Three-level memory scope** - Global → Path → Node
- **Patch-based state updates** - Snapshot + patch + safe merge
- **First-class observability** - Connected logs, traces, time-travel debugging

## Quick Links

- [GitHub Repository](https://github.com/amzn/footprint)
- [npm Package](https://www.npmjs.com/package/footprint)
- [Demo Examples](../demo/)

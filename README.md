# Tree Of Functions (ToF) - `@amzn/tree-of-functions`

> A tiny, production-minded runtime for building **flowchart-like pipelines** where each node is just a function. Supports **parallel children**, **scoped state**, **patch-based memory**, and **first-class observability**.

- Deterministic tree traversal (no cycles)
- Parallel fan-out / structured fan-in
- `breakFn()` to stop a branch without affecting siblings
- Three-level memory scope: **Global → Path → Node**
- Patch-based state updates (snapshot + patch + safe merge)
- Hooks for connected logs, traces, and time-travel debugging
---

## When should I use ToF?

Use ToF if you need to:

1. **Turn a flowchart into running code**  
   Your problem naturally fits a tree: gather data in parallel leaves, aggregate, then continue.

2. **Mix parallel + serial steps with explicit control**  
   You want deterministic execution and don’t want an opaque agent to “decide” structure for you.

3. **Keep state safe and sane**  
   You need scoped memory (global/path/node) and patch semantics that won’t bite you during read-after-write.

4. **Observe and debug in production**  
   You want connected logs, causal traces, and time-travel style debugging built in.

**Probably not for you** if:

- You need **arbitrary DAGs with cycles** or dynamic back-edges → use a workflow engine or task queue.
- Your job is a **simple linear script** → plain functions (or a promise chain) will be simpler.

---
- **Deterministic** stage execution with the ability to **early-exit** a branch.

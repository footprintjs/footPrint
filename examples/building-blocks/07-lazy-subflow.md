---
name: Lazy Subflow
group: Building Blocks
guide: https://footprintjs.github.io/footPrint/guides/building-blocks/subflows/
---

# Lazy Subflow (Graph of Services)

A **lazy subflow** is a subflow that's only **built when the branch is selected at runtime**. Unselected branches pay zero cost — no tree cloning, no registration.

```
Router → Selector → [ Auth ✓ | Payment ✓ | Notification ✗ ] → Response
                      ↑resolved    ↑resolved    ↑never resolved
                                                (zero cost)
```

## When to use

- You have **many possible sub-pipelines** but only a few run per request.
- Typical: **microservice orchestrator** (50+ services, 2-3 per request), **plugin systems** (dozens of plugins, only active ones execute), **multi-tenant routing** (variant flows per tenant).
- Eager mounting would **clone all trees at build time** — lazy mounting defers that to runtime.

## The pattern

```typescript
.addSelectorFunction('Route Services', (scope) => scope.requiredServices, 'route')
  .addLazySubFlowChartBranch('auth', () => authService, 'Auth Service')
  .addLazySubFlowChartBranch('payment', () => paymentService, 'Payment Service')
  .addLazySubFlowChartBranch('notification', () => notificationService, 'Notification')
  .end()
```

Key difference from regular subflow:
- `addSubFlowChartBranch(id, chart, ...)` — chart is built now, at registration.
- `addLazySubFlowChartBranch(id, () => chart, ...)` — chart is built later, only if the branch is chosen.

## What you get

At **build time**:
- Lazy nodes appear in the spec with `isLazy: true` (rendered with a dashed border + cloud icon in Visual tab).
- `chart.subflows` has 0 entries — no trees cloned yet.

At **runtime**:
- The selector picks some branches.
- Only those branches call their factory, resolving the actual subflow.
- After resolution, they behave identically to regular subflows (same narrative, same snapshot, same drill-down).

## Performance math

Say you have 50 services, each with 10 stages. Average 2 selected per request.

| | Eager | Lazy |
|---|---|---|
| Stages cloned at build time | 500 | 0 |
| Stages cloned per request | 0 | 20 |
| Build-time cost | High | Near-zero |
| Per-request cost | Low | Small (factory call + 2 clones) |
| Memory footprint | 500 stages × N instances | 20 stages × N instances |

For hot-path services with narrow selection, lazy wins decisively.

## Trade-off: first-call latency

The factory runs on first selection. If the factory does heavy work (parsing, validation), the first request on each server hits it.

- **Option 1:** Cache in module scope: `const authService = buildAuthService()` (once per process).
- **Option 2:** Pre-warm at startup by calling factories you know you'll need.

For most cases, factories are trivial (just return a pre-built chart), so this is a non-issue.

## Key API

- `.addLazySubFlowChartBranch(id, factoryFn, 'Name', options?)` — deferred branch.
- `chart.subflows` — always starts empty for lazy charts, grows at runtime.
- `executor.getSubflowResults()` — reflects resolved subflows only.

## Related concepts

- **[Subflow](./05-subflow.md)** — the eager counterpart. Use when all branches always run.
- **[Selector](./04-selector.md)** — most common host for lazy branches ("run what applies").
- **[Full guide](https://footprintjs.github.io/footPrint/guides/building-blocks/subflows/)** — covers mounting, snapshots, and graph-of-services patterns.

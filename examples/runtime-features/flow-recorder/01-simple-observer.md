---
name: Flow Recorders
group: Features
guide: https://footprintjs.github.io/footPrint/guides/features/flow-recorders/
---

# FlowRecorder — Pluggable Control-Flow Observers

`Recorder` observes **data** events (reads, writes, commits). `FlowRecorder` observes **control flow** events (decisions, loops, forks, subflow boundaries, breaks, errors). Together they cover the entire execution story.

```
  Data plane  ─→  Recorder         (reads, writes, commits)
  Control plane → FlowRecorder     (decisions, loops, forks, pause, break)
```

## When to use

- **Custom narratives** — render decisions in your team's voice ("Chose premium path because credit > 700") instead of the default wording.
- **Progress tracking** — emit UI events when stages start/finish, when a loop iterates, when a fork converges.
- **Audit logging** — send every decision to a compliance DB with exactly the fields legal needs.
- **Metrics outside the hot path** — count decisions, time loops, track fork slowest-branch without cluttering stage code.

## The event surface

```
onStageExecuted     onBreak
onNext              onError
onDecision          onPause
onFork              onResume
onSelected
onSubflowEntry
onSubflowExit
onLoop
```

Every event carries a `TraversalContext` with `runtimeStageId`, `subflowPath`, and any evidence captured by `decide()`/`select()`.

## The pattern

```typescript
import { FlowChartExecutor, type FlowRecorder } from 'footprintjs';

const auditRecorder: FlowRecorder = {
  id: 'audit',
  onDecision(event) {
    log.info({
      stage: event.stageName,
      branch: event.chosen,
      evidence: event.evidence,
    }, 'Decision made');
  },
  onBreak(event) {
    log.warn({ stage: event.stageName }, 'Pipeline broke');
  },
};

executor.attachFlowRecorder(auditRecorder);
await executor.run();
```

No decorators, no subclasses — just a plain object with the hooks you care about. Unused hooks are skipped entirely.

## Built-in strategies

footprintjs ships eight narrative strategies so you don't have to build one from scratch:

| Strategy | Use |
|---|---|
| `NarrativeFlowRecorder` | Full narrative — every event becomes a sentence |
| `WindowedNarrativeFlowRecorder` | Only the last N events — for long runs |
| `AdaptiveNarrativeFlowRecorder` | Full at first, summarized once the run grows |
| `MilestoneNarrativeFlowRecorder` | Only decisions + subflow boundaries — executive summary |
| `RLENarrativeFlowRecorder` | Collapse repeated stages (`FetchPage ×10`) — great for loops |
| `ProgressiveNarrativeFlowRecorder` | Render in chunks — streaming UI |
| `SeparateNarrativeFlowRecorder` | Emits a separate stream per event type |
| `SilentNarrativeFlowRecorder` | Nothing — for quiet runs |

Swap them without changing a line of stage code.

## Why two systems instead of one

| | Data Recorder | Flow Recorder |
|---|---|---|
| Fires when | Stage reads/writes scope | Engine moves between stages |
| Payload | key, value, operation | stage name, decision, evidence |
| Timing | During stage execution | After stage completes |
| Common use | Metrics, debug, redaction | Narrative, audit, UI progress |

Keeping them separate prevents a single observer from accidentally mixing concerns (and blocking progress on slow I/O).

## Idempotent by ID

`attachFlowRecorder` is idempotent by ID — attach the same ID twice and the second replaces the first. This prevents double-counting when a recorder is auto-attached by a framework and the consumer adds another.

```typescript
executor.attachFlowRecorder({ id: 'audit', onDecision: log1 });
executor.attachFlowRecorder({ id: 'audit', onDecision: log2 });  // replaces
executor.attachFlowRecorder({ id: 'extra-audit', onDecision: log3 });  // coexists
```

## Key API

- `executor.attachFlowRecorder(recorder)` — attach.
- `executor.detachFlowRecorder(id)` — remove.
- `onStageExecuted`, `onDecision`, `onFork`, `onLoop`, etc. — hook into any event.
- `CombinedNarrativeRecorder` — ships both Recorder + FlowRecorder interfaces; attach via `executor.recorder(narrative())`.

## Related

- **[Metrics](./05-metrics.md)** — the data-plane counterpart; typical partner for a FlowRecorder.
- **[decide() / select()](../building-blocks/03-decider.md)** — the source of the `evidence` field in `onDecision`.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/features/flow-recorders/)** — all 8 built-in strategies and custom recorder patterns.

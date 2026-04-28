---
name: Metrics
group: Features
guide: https://footprintjs.github.io/footPrint/guides/features/metrics/
---

# MetricRecorder — Per-Stage Observability

`MetricRecorder` tracks **per-stage metrics** as execution happens — read counts, write counts, commits, and duration (latency). Zero instrumentation in stages, full observability out.

```
Stage: ValidateCard
   reads:    3       ← auto-counted
   writes:   2       ← auto-counted
   commits:  1       ← auto-counted
   duration: 42.3ms  ← onStageStart/onStageEnd timing
```

## When to use

- **Find slow stages** — the narrative tells you what happened; metrics tell you how long.
- **Budget enforcement** — fail the run if any stage exceeds its SLA.
- **Dashboards** — export to Datadog/Prometheus/CloudWatch via a downstream exporter.
- **Capacity planning** — "our order flow reads 47 scope values per stage on average."

## The pattern

```typescript
import { MetricRecorder, FlowChartExecutor } from 'footprintjs';

const metrics = new MetricRecorder();
executor.attachRecorder(metrics);

await executor.run();

const report = metrics.getMetrics();
// {
//   totalDuration: 234.5,
//   totalReads: 47,
//   totalWrites: 23,
//   totalCommits: 7,
//   stageMetrics: Map { 'validate-card' => { reads: 3, writes: 2, duration: 42.3 }, ... }
// }
```

No wrapping, no decorators — attach and run. Every stage is observed automatically.

## Stage filter

If you only want metrics on hot stages, pass a filter:

```typescript
new MetricRecorder({ stageFilter: ['call-llm', 'db-query'] });
```

Other stages are skipped — zero overhead.

## Composing with other recorders

`MetricRecorder` plays well with anything else:

```typescript
executor.attachRecorder(new MetricRecorder('metric-1'));
executor.attachRecorder(new DebugRecorder({ id: 'debug-1', verbosity: 'verbose' }));
executor.attachFlowRecorder(new NarrativeFlowRecorder());
```

Three recorders, three different concerns, zero coupling. Or use `CompositeRecorder` to bundle them under one ID:

```typescript
executor.attachRecorder(
  new CompositeRecorder('observability', [new MetricRecorder(), new DebugRecorder()])
);
```

## Cost math

For a typical 10-stage pipeline with 5 reads + 3 writes per stage:

- Metric overhead: ~0.02ms per event
- Total overhead: 10 stages × 8 events × 0.02ms = **1.6ms**

Practically free. Attach in production.

## Exporting

`getMetrics()` returns a plain object — easy to serialize:

```typescript
const report = metrics.getMetrics();

// To Datadog
dogstatsd.gauge('footprintjs.duration', report.totalDuration, ['flow:checkout']);

// To Prometheus
for (const [stage, m] of report.stageMetrics) {
  stageDurationHistogram.observe({ stage }, m.duration);
}

// To logs
logger.info({ metrics: report }, 'Flow complete');
```

## Key API

- `new MetricRecorder(id?, options?)` — create.
- `executor.attachRecorder(metrics)` — attach.
- `metrics.getMetrics()` — full report.
- `metrics.reset()` — clear for next run.
- `options.stageFilter: string[]` — restrict to specific stages.

## Related

- **[Debug & Mermaid](./08-debug-and-mermaid.md)** — the sibling recorder for verbose diagnostics.
- **[Flow Recorders](./11-flow-recorders.md)** — control-plane observers that complement data-plane metrics.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/features/metrics/)** — exporter recipes for Datadog, Prometheus, OTel.

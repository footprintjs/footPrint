/**
 * Integration: OpenTelemetry Exporter (Sample FlowRecorder)
 *
 * Shows how to export flowchart execution as OpenTelemetry spans using
 * TraversalContext. This is a SAMPLE — no real OTel SDK dependency.
 * Replace the mock tracer with @opentelemetry/api in production.
 *
 * Key mapping:
 *   TraversalContext.stageId    → span name
 *   TraversalContext.parentStageId → parent span (builds the tree)
 *   TraversalContext.subflowId  → attribute "footprint.subflow.id"
 *   TraversalContext.depth      → attribute "footprint.depth"
 *
 * Run:  npm run int:otel
 */

import {
  flowChart,
  FlowChartExecutor,
  type FlowRecorder,
  type FlowStageEvent,
  type FlowDecisionEvent,
  type FlowErrorEvent,
  type FlowSubflowEvent,
  type FlowLoopEvent,
  type FlowBreakEvent,
} from 'footprintjs';

// ── Mock OpenTelemetry API (replace with @opentelemetry/api) ────────────

interface MockSpan {
  name: string;
  attributes: Record<string, string | number>;
  events: Array<{ name: string; attributes?: Record<string, string> }>;
  status: { code: number; message?: string };
  ended: boolean;
}

const mockTracer = {
  spans: [] as MockSpan[],

  startSpan(name: string, parentId?: string): MockSpan {
    const span: MockSpan = {
      name,
      attributes: {},
      events: [],
      status: { code: 0 },
      ended: false,
    };
    if (parentId) span.attributes['parent.id'] = parentId;
    this.spans.push(span);
    return span;
  },
};

function setAttribute(span: MockSpan, key: string, value: string | number) {
  span.attributes[key] = value;
}

function addEvent(span: MockSpan, name: string, attrs?: Record<string, string>) {
  span.events.push({ name, attributes: attrs });
}

function endSpan(span: MockSpan) {
  span.ended = true;
}

function setErrorStatus(span: MockSpan, message: string) {
  span.status = { code: 2, message }; // StatusCode.ERROR = 2
}

// ── OpenTelemetry FlowRecorder ──────────────────────────────────────────

class OpenTelemetryFlowRecorder implements FlowRecorder {
  readonly id = 'otel-exporter';

  private activeSpans = new Map<string, MockSpan>();

  onStageExecuted(event: FlowStageEvent): void {
    const ctx = event.traversalContext;
    const span = mockTracer.startSpan(
      `stage:${event.stageName}`,
      ctx?.parentStageId,
    );

    setAttribute(span, 'footprint.stage.name', event.stageName);
    setAttribute(span, 'footprint.stage.id', ctx?.stageId ?? 'unknown');
    setAttribute(span, 'footprint.subflow.id', ctx?.subflowId ?? 'root');
    setAttribute(span, 'footprint.depth', ctx?.depth ?? 0);

    if (event.description) {
      setAttribute(span, 'footprint.description', event.description);
    }
    if (ctx?.subflowPath) {
      setAttribute(span, 'footprint.subflow.path', ctx.subflowPath);
    }
    if (ctx?.loopIteration !== undefined) {
      setAttribute(span, 'footprint.loop.iteration', ctx.loopIteration);
    }

    if (ctx?.stageId) {
      // Close previous span for same stage (if looping)
      const prev = this.activeSpans.get(ctx.stageId);
      if (prev && !prev.ended) endSpan(prev);
      this.activeSpans.set(ctx.stageId, span);
    }

    endSpan(span);
  }

  onDecision(event: FlowDecisionEvent): void {
    const ctx = event.traversalContext;
    const span = mockTracer.startSpan(
      `decision:${event.decider}`,
      ctx?.parentStageId,
    );
    setAttribute(span, 'footprint.decision.branch', event.chosen);
    if (event.rationale) {
      setAttribute(span, 'footprint.decision.rationale', event.rationale);
    }
    endSpan(span);
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    const ctx = event.traversalContext;
    const span = mockTracer.startSpan(
      `subflow:${event.name}`,
      ctx?.parentStageId,
    );
    setAttribute(span, 'footprint.subflow.id', event.subflowId ?? event.name);
    setAttribute(span, 'footprint.depth', ctx?.depth ?? 0);
    if (event.description) {
      setAttribute(span, 'footprint.description', event.description);
    }

    if (event.subflowId) {
      this.activeSpans.set(`subflow:${event.subflowId}`, span);
    }
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    const key = `subflow:${event.subflowId ?? event.name}`;
    const span = this.activeSpans.get(key);
    if (span) {
      addEvent(span, 'subflow.exit');
      endSpan(span);
      this.activeSpans.delete(key);
    }
  }

  onLoop(event: FlowLoopEvent): void {
    const ctx = event.traversalContext;
    const span = mockTracer.startSpan(`loop:${event.target}`, ctx?.parentStageId);
    setAttribute(span, 'footprint.loop.iteration', event.iteration);
    setAttribute(span, 'footprint.loop.target', event.target);
    endSpan(span);
  }

  onBreak(event: FlowBreakEvent): void {
    const ctx = event.traversalContext;
    const span = mockTracer.startSpan(`break:${event.stageName}`, ctx?.parentStageId);
    addEvent(span, 'pipeline.break');
    endSpan(span);
  }

  onError(event: FlowErrorEvent): void {
    const ctx = event.traversalContext;
    const stageId = ctx?.stageId;
    const span = stageId ? this.activeSpans.get(stageId) : undefined;

    if (span) {
      setErrorStatus(span, event.message);
      addEvent(span, 'exception', { 'exception.message': event.message });
    } else {
      // Create a standalone error span
      const errorSpan = mockTracer.startSpan(`error:${event.stageName}`);
      setErrorStatus(errorSpan, event.message);
      endSpan(errorSpan);
    }
  }

  clear(): void {
    this.activeSpans.clear();
  }

  /** For demo — print collected spans. */
  printSpans(): void {
    console.log(`\n  Collected ${mockTracer.spans.length} spans:\n`);
    for (const span of mockTracer.spans) {
      const attrs = Object.entries(span.attributes)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      const status = span.status.code === 0 ? 'OK' : `ERROR: ${span.status.message}`;
      console.log(`  [${span.ended ? 'done' : 'open'}] ${span.name}`);
      console.log(`         attrs: ${attrs || '(none)'}`);
      if (span.events.length > 0) {
        console.log(`         events: ${span.events.map(e => e.name).join(', ')}`);
      }
      console.log(`         status: ${status}`);
    }
  }
}

// ── State types ─────────────────────────────────────────────────────────

interface ETLState {
  data: number[];
  transformed: number[];
}

interface IngestionState {
  source: string;
  stored: boolean;
}

// ── Demo flowchart ──────────────────────────────────────────────────────

const subChart = flowChart<ETLState>('FetchData', (scope) => {
  scope.data = [1, 2, 3];
}, 'fetch-data', undefined, 'Fetches data from source')
  .addFunction('Transform', (scope) => {
    scope.transformed = scope.data.map(x => x * 2);
  }, 'transform', 'Transforms fetched data')
  .build();

const chart = flowChart<IngestionState>('Ingest', (scope) => {
  scope.source = 'api';
}, 'ingest', undefined, 'Starts data ingestion')
  .addSubFlowChartNext('sf-etl', subChart, 'ETL Pipeline')
  .addFunction('Store', (scope) => {
    scope.stored = true;
  }, 'store', 'Persists to database')

  .build();

// ── Run ─────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== OpenTelemetry Exporter Sample ===\n');

  const otel = new OpenTelemetryFlowRecorder();
  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(otel);
  await executor.run();

  otel.printSpans();

  console.log('\n--- Narrative ---');
  executor.getNarrativeEntries().map(e => e.text).forEach(line => console.log(`  ${line}`));
})().catch(console.error);

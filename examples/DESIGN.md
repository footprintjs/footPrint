# Examples — Design & Coverage Plan

Examples serve as **integration tests**. Every `npm run test:examples` type-checks them against the library source via path mapping. If a contributor's PR breaks an example, CI catches it before merge.

## Folder Structure

```
examples/
├── building-blocks/              → Flowchart primitives (what you build with)
│   ├── 01-linear.ts
│   ├── 02-fork.ts
│   ├── 03-decider.ts
│   ├── 04-selector.ts
│   ├── 05-subflow.ts
│   ├── 06-loops.ts
│   ├── 07-structural-subflow.ts
│   └── 08-lazy-subflow.ts
│
├── runtime-features/             → During execution (what happens while stages run)
│   ├── streaming/
│   │   ├── 01-linear.ts          → basic streaming stage
│   │   ├── 02-subflow.ts         → streaming inside subflow
│   │   └── 03-loop.ts            → streaming in a loop
│   ├── pause-resume/
│   │   ├── 01-linear.ts          → basic pause/resume
│   │   ├── 02-decider.ts         → conditional pause (pause only on some branches)
│   │   └── 03-subflow.ts         → pause inside subflow
│   ├── break/
│   │   ├── 01-loop.ts            → $break() in loop (primary use case)
│   │   ├── 02-subflow.ts         → $break() stops subflow, parent continues
│   │   └── 03-decider.ts         → $break() in a decider branch
│   ├── redaction/
│   │   ├── 01-linear.ts          → keys, patterns, fields
│   │   ├── 02-subflow.ts         → redaction propagates to subflow
│   │   └── 03-decider.ts         → redaction in branched path
│   ├── data-recorder/            → Scope-level: onRead, onWrite, onCommit
│   │   ├── 01-metric-recorder.ts → MetricRecorder (built-in) + linear
│   │   ├── 02-debug-recorder.ts  → DebugRecorder (built-in) + decider
│   │   ├── 03-custom-recorder.ts → Implement Recorder interface
│   │   ├── 04-subflow.ts         → MetricRecorder across subflow boundary
│   │   └── 05-loop.ts            → MetricRecorder in loop (aggregation)
│   ├── flow-recorder/            → Engine-level: onDecision, onLoop, onFork
│   │   ├── 01-simple-observer.ts → Basic FlowRecorder (object literal)
│   │   ├── 02-custom-class.ts    → Class-based FlowRecorder
│   │   ├── 03-multiple.ts        → Multiple FlowRecorders coexist
│   │   ├── 04-subflow-events.ts  → onSubflowEntry/Exit events
│   │   ├── 05-selector-events.ts → onSelected with parallel branches
│   │   └── strategies/
│   │       ├── 01-windowed.ts
│   │       ├── 02-adaptive.ts
│   │       ├── 03-silent.ts
│   │       ├── 04-progressive.ts
│   │       ├── 05-rle.ts
│   │       ├── 06-separate.ts
│   │       ├── 07-milestone.ts
│   │       └── 08-comparison.ts  → All strategies side by side
│   └── combined-recorder/        → Both interfaces: narrative + data ops
│       ├── 01-narrative.ts       → narrative() factory, enableNarrative()
│       ├── 02-composite.ts       → CompositeRecorder bundling
│       ├── 03-operations.ts      → translate / accumulate / aggregate
│       └── 04-subflow.ts         → narrative across subflow boundary
│
├── build-time-features/          → Before execution (graph introspection)
│   ├── contract/
│   │   ├── 01-zod-schema.ts      → Zod input/output with validation
│   │   ├── 02-json-schema.ts     → Plain JSON Schema (no Zod)
│   │   └── 03-mapper.ts          → Output mapper function
│   ├── self-describing/
│   │   ├── 01-openapi.ts         → toOpenAPI() generation
│   │   ├── 02-mcp-tool.ts        → toMCPTool() generation
│   │   ├── 03-mermaid.ts         → toMermaid() diagram
│   │   └── 04-spec.ts            → toSpec() raw graph structure
│   └── decide-select/
│       ├── 01-filter-rules.ts    → Filter object rules with evidence
│       ├── 02-function-rules.ts  → Function-based rules with read tracking
│       ├── 03-mixed-rules.ts     → Mixed filter + function in one decide()
│       └── 04-select-parallel.ts → select() multi-match fan-out
│
├── post-execution/               → After execution (query the results)
│   ├── causal-chain/
│   │   ├── 01-linear.ts          → Linear backtrack
│   │   ├── 02-decider.ts         → Backtrack through chosen branch
│   │   ├── 03-subflow.ts         → Backtrack through subflow boundary
│   │   ├── 04-loop.ts            → Backtrack through loop iterations
│   │   └── 05-diamond.ts         → Fan-in DAG (multiple parents)
│   ├── quality-trace/
│   │   ├── 01-basic.ts           → QualityRecorder + qualityTrace()
│   │   └── 02-root-cause.ts      → Root cause detection across pipeline
│   ├── snapshot/
│   │   ├── 01-basic.ts           → getSnapshot() state inspection
│   │   ├── 02-subtree.ts         → getSubtreeSnapshot() subflow drill-down
│   │   └── 03-commit-log.ts      → commitLog queries (findLastWriter, findCommit)
│   └── narrative-query/
│       ├── 01-get-narrative.ts   → getNarrative() string array
│       ├── 02-entries.ts         → getNarrativeEntries() structured
│       └── 03-flow-narrative.ts  → getFlowNarrative() control-flow only
│
├── errors/                       → Error handling patterns
│   ├── 01-input-validation.ts    → InputValidationError with field-level issues
│   ├── 02-structured-errors.ts   → FlowRecorder error observation
│   └── 03-stage-errors.ts        → try/catch in stages, error propagation
│
├── getting-started/              → First contact (README links here)
│   ├── quick-start.ts
│   └── loan-application.ts
│
└── integrations/                 → External SDKs (excluded from type-check)
    ├── agent-react-loop.ts
    ├── parallel-agents.ts
    ├── agent-memory.ts
    ├── llm-agent-tool.ts
    ├── llm-claude-tool-call.ts
    ├── llm-langchain-agent.ts
    ├── llm-vercel-ai-tool.ts
    ├── datadog-exporter.ts
    ├── elastic-exporter.ts
    ├── opentelemetry-exporter.ts
    └── state-machine.ts
```

## Coverage Matrix — Runtime Features × Building Blocks

Every runtime feature must work across all relevant building blocks. Cells show which example covers it.

### Streaming

| Building Block | Example | Status |
|---|---|---|
| Linear | `runtime-features/streaming/01-linear.ts` | exists (06-streaming.ts) |
| Subflow | `runtime-features/streaming/02-subflow.ts` | **NEW** |
| Loop | `runtime-features/streaming/03-loop.ts` | **NEW** |

### Pause/Resume

| Building Block | Example | Status |
|---|---|---|
| Linear | `runtime-features/pause-resume/01-linear.ts` | exists (19-pause-resume.ts) |
| Decider | `runtime-features/pause-resume/02-decider.ts` | **NEW** — conditional pause |
| Subflow | `runtime-features/pause-resume/03-subflow.ts` | **NEW** — pause inside subflow |

### Break

| Building Block | Example | Status |
|---|---|---|
| Loop | `runtime-features/break/01-loop.ts` | exists (09-break-fn.ts) |
| Subflow | `runtime-features/break/02-subflow.ts` | **NEW** — $break stops subflow only |
| Decider | `runtime-features/break/03-decider.ts` | **NEW** — break in branch |

### Redaction

| Building Block | Example | Status |
|---|---|---|
| Linear | `runtime-features/redaction/01-linear.ts` | exists (12-redaction.ts) |
| Subflow | `runtime-features/redaction/02-subflow.ts` | exists (17-subflow-redaction.ts) |
| Decider | `runtime-features/redaction/03-decider.ts` | **NEW** — redacted keys in branches |

### Data Recorder (Scope-level)

| Building Block | Example | Status |
|---|---|---|
| Linear | `data-recorder/01-metric-recorder.ts` | exists (05-metrics.ts) |
| Decider | `data-recorder/02-debug-recorder.ts` | exists (08-debug-and-mermaid.ts partial) |
| Custom | `data-recorder/03-custom-recorder.ts` | exists (03-recorders.ts) |
| Subflow | `data-recorder/04-subflow.ts` | **NEW** — metrics cross subflow |
| Loop | `data-recorder/05-loop.ts` | **NEW** — metrics aggregation in loops |

### Flow Recorder (Engine-level)

| Building Block | Example | Status |
|---|---|---|
| Linear | `flow-recorder/01-simple-observer.ts` | exists |
| Custom | `flow-recorder/02-custom-class.ts` | exists (03-custom-recorder.ts) |
| Multiple | `flow-recorder/03-multiple.ts` | exists (04-multiple-recorders.ts) |
| Subflow | `flow-recorder/04-subflow-events.ts` | **NEW** — onSubflowEntry/Exit |
| Selector | `flow-recorder/05-selector-events.ts` | **NEW** — onSelected events |
| Strategies | `strategies/01-08` | exists (02-strategy-comparison.ts + individual) |

### Combined Recorder (Both interfaces)

| Building Block | Example | Status |
|---|---|---|
| Linear | `combined-recorder/01-narrative.ts` | exists (02-narrative.ts) |
| Composite | `combined-recorder/02-composite.ts` | exists (18-composite-recorder.ts) |
| Operations | `combined-recorder/03-operations.ts` | exists (21-recorder-operations.ts) |
| Subflow | `combined-recorder/04-subflow.ts` | **NEW** — narrative across subflow |

### Causal Chain (Post-execution)

| Building Block | Example | Status |
|---|---|---|
| Linear | `causal-chain/01-linear.ts` | **NEW** (integration test exists) |
| Decider | `causal-chain/02-decider.ts` | **NEW** |
| Subflow | `causal-chain/03-subflow.ts` | **NEW** |
| Loop | `causal-chain/04-loop.ts` | **NEW** |
| Diamond | `causal-chain/05-diamond.ts` | **NEW** — fan-in DAG |

## Gap Summary

| Category | Exists | New Needed | Total |
|---|---|---|---|
| Streaming | 1 | 2 | 3 |
| Pause/Resume | 1 | 2 | 3 |
| Break | 1 | 2 | 3 |
| Redaction | 2 | 1 | 3 |
| Data Recorder | 3 | 2 | 5 |
| Flow Recorder | 3 | 2 | 5 + 8 strategies |
| Combined Recorder | 3 | 1 | 4 |
| Causal Chain | 0 | 5 | 5 |
| Quality Trace | 1 | 1 | 2 |
| Snapshot | 1 | 2 | 3 |
| Narrative Query | 0 | 3 | 3 |
| Build-time | 5 | 5 | 10 |
| **Total new examples** | | **28** | |

## Implementation Order

### Phase 1: Critical gaps (features × building blocks we KNOW can break)
1. Streaming + subflow, + loop
2. Pause/resume + decider, + subflow
3. Break + subflow
4. Data recorder + subflow, + loop
5. Causal chain × all 5 building blocks

### Phase 2: Completeness
6. Flow recorder + subflow events, + selector events
7. Combined recorder + subflow narrative
8. Redaction + decider
9. Snapshot + subtree + commitLog
10. Narrative query × 3

### Phase 3: Build-time feature isolation
11. Contract (zod, json-schema, mapper)
12. Self-describing (openapi, mcp-tool, mermaid, spec)
13. Decide/select (filter, function, mixed, parallel)

## File Naming Convention

```
{nn}-{building-block-or-variant}.ts
```

Each file is self-contained, runnable with `npx tsx`, and has a top-level JSDoc comment explaining what it tests.

## Playground Integration

Each example maps to a playground sample via the `catalog.ts` registry. The three playground categories map to:

- **Building Blocks** → `examples/building-blocks/`
- **Features** → `examples/runtime-features/` + `examples/build-time-features/` + `examples/post-execution/`
- **Use Cases** → `examples/getting-started/` + `examples/integrations/`

## CI Integration

```
Gate 6: npm run test:examples
  → tsc -p examples/tsconfig.json
  → Type-checks all examples against library source via path mapping
  → Excludes integrations/ (external SDK deps)
```

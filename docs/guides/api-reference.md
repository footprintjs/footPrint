# API Reference

Complete reference for FootPrint's public API surface.

## Builder API

The `FlowChartBuilder` uses a fluent (D3-style) chaining API. Start with `flowChart()` and chain methods:

```typescript
import { flowChart } from 'footprintjs';

const chart = flowChart('Start', startFn, 'start-id')
  .addFunction('Next', nextFn, 'next-id')
  .build();
```

> **Note:** `fn` and `id` are required on all stage methods since v0.10.0.

| Method | Description |
|--------|-------------|
| `flowChart(name, fn, id, extractor?, description?)` | Create builder with root stage |
| `addFunction(name, fn, id, description?)` | Add linear next stage |
| `addListOfFunction(specs, opts?)` | Add parallel children (fork). Options: `{ failFast? }` |
| `addDeciderFunction(name, fn, id, description?)` | Single-choice branching (returns one branch ID) |
| `addSelectorFunction(name, fn, id, description?)` | Multi-choice branching (returns multiple branch IDs) |
| `addSubFlowChart(id, flow)` | Mount subflow as parallel child |
| `addSubFlowChartNext(id, flow, mount, opts?)` | Mount subflow as linear next. Options: `{ inputMapper?, outputMapper? }` |
| `addStreamingFunction(name, fn, id, streamId?, description?)` | Add streaming stage |
| `addTraversalExtractor(fn)` | Register per-stage data extractor |
| `setEnableNarrative()` | Enable runtime narrative generation |
| `setInputSchema(schema)` | Set input validation schema (Zod or JSON Schema) |
| `setOutputSchema(schema)` | Set output validation schema |
| `setOutputMapper(fn)` | Set output mapping function |
| `loopTo(stageId)` | Loop back to earlier stage |
| `build()` | Compile to `FlowChart` |
| `execute(scopeFactory?)` | Build + run (convenience) |
| `toSpec()` | Export pure JSON (no functions) |
| `toMermaid()` | Generate Mermaid diagram |

### Decider/Selector Sub-builder

After `.addDeciderFunction()` or `.addSelectorFunction()`:

| Method | Description |
|--------|-------------|
| `.addFunctionBranch(branchId, name, fn)` | Add a branch |
| `.setDefault(branchId)` | Set default branch (deciders only) |
| `.end()` | Close the branching block |

## Executor API

```typescript
import { FlowChartExecutor } from 'footprintjs';

const executor = new FlowChartExecutor(chart);
await executor.run({ input: { name: 'Alice' } });
```

| Method | Description |
|--------|-------------|
| `run(options?)` | Execute the flowchart. Options: `{ input?, signal?, timeoutMs? }` |
| `getNarrative()` | Combined narrative (flow + data) with ScopeFacade; flow-only otherwise |
| `getFlowNarrative()` | Flow-only narrative sentences |
| `getNarrativeEntries()` | Structured `CombinedNarrativeEntry[]` for programmatic use |
| `attachFlowRecorder(recorder)` | Attach a FlowRecorder for pluggable narrative control |
| `detachFlowRecorder(id)` | Detach a FlowRecorder by id |
| `getSnapshot()` | Full execution tree + state |
| `getExtractedResults()` | Extractor results map |
| `getEnrichedResults()` | Enriched snapshots (scope state, debug info, output) |
| `getSubflowResults()` | Nested subflow execution data |
| `getSubflowManifest()` | Subflow catalog tree (requires ManifestFlowRecorder) |
| `getSubflowSpec(id)` | Full spec for a specific subflow |
| `getRuntimeStructure()` | Serialized pipeline for visualization |
| `setRedactionPolicy(policy)` | Apply PII redaction across all stages |
| `getRedactionReport()` | Compliance-friendly audit trail |

## ScopeFacade API

Every stage function receives a `ScopeFacade` as its first argument:

```typescript
const myStage = (scope: ScopeFacade) => {
  const name = scope.getValue('name');      // tracked read → narrative
  scope.setValue('greeting', `Hi ${name}`);  // tracked write → narrative
};
```

| Method | Description |
|--------|-------------|
| `getValue(key)` | Read a value (tracked — appears in narrative) |
| `setValue(key, value, redact?)` | Write a value (tracked). Pass `true` to redact from recorders |
| `updateValue(key, partial)` | Deep merge (tracked) |
| `deleteValue(key)` | Delete a value (tracked) |
| `getArgs<T>()` | Frozen readonly input (NOT tracked) |
| `attachRecorder(recorder)` | Attach a scope-level recorder |
| `detachRecorder(id)` | Detach a scope-level recorder |

## Stage Function Signature

```typescript
type StageFn = (
  scope: ScopeFacade,
  breakPipeline: () => void,
  streamCallback?: StreamCallback
) => void | Promise<void>;
```

- `scope` — transactional state interface
- `breakPipeline` — call to stop after current stage (graceful early exit)
- `streamCallback` — only available in streaming stages (`addStreamingFunction`)

## Contract API

```typescript
import { defineContract, generateOpenAPI } from 'footprintjs';

const contract = defineContract(chart, {
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ result: z.string() }),
});

const openapi = generateOpenAPI(contract, { version: '1.0.0' });
```

| Function | Description |
|----------|-------------|
| `defineContract(chart, options)` | Create a typed contract with I/O schemas |
| `generateOpenAPI(contract, options)` | Generate OpenAPI 3.1 spec |
| `normalizeSchema(input)` | Convert Zod or raw JSON Schema to normalized form |
| `zodToJsonSchema(zodSchema)` | Zod v3/v4 → JSON Schema converter |

---

**[Back to guides](./README.md)** | **[Patterns](./patterns.md)** | **[Scope](./scope.md)** | **[Flow Recorders](./flow-recorders.md)**

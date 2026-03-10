# Error Handling

FootPrint's error handling is designed around one principle: **the trace must capture everything that happened, including failures**.

---

## Who Is Responsible for What

| Layer | Responsibility |
|-------|---------------|
| **Stage function** | Business logic. Throws errors when invariants break. |
| **Engine** | Infrastructure. Catches errors, commits the trace, records error metadata, then re-throws. |
| **Consumer** | Wraps `executor.run()` in try/catch. Inspects `getSnapshot()` after failure for debugging. |

---

## Commit-on-Error

When a stage throws, the engine calls `context.commit()` *before* re-throwing. This preserves everything up to the failure point:

```typescript
const executor = new FlowChartExecutor(chart);
try {
  await executor.run();
} catch (error) {
  const snapshot = executor.getSnapshot();
  // commitLog has entries for every stage that ran (including the one that failed)
  // executionTree shows scope writes, error metadata, and flow decisions
  // An LLM can use this to explain WHY the error happened
}
```

Without commit-on-error, a failed stage's partial writes would be lost. The trace would end at the last successful stage, hiding the context of the failure.

What gets preserved:
- **Scope writes** made before the throw
- **Error metadata** (`stageExecutionError`) recorded in the execution tree
- **Narrative** includes the error event (`"An error occurred at validate: ..."`)
- **Commit log** has an entry for the failed stage's state

---

## Error Narrative

A validation pipeline fails. The trace tells the story:

```
Stage 1: The process began with FetchData.
  Step 1: Write rawPayload = {name: "Bob", age: -5}
Stage 2: Next, it moved on to Validate.
  Step 1: Read rawPayload = {name: "Bob", age: -5}
  An error occurred at Validate: Validation failed: age must be positive.
```

An LLM reading this trace can immediately explain: *"The validation failed because the age field was -5, which was provided in the raw payload from FetchData. Age must be a positive number."* No log reconstruction needed.

---

## Structured Error Preservation

By default, errors flow through the trace system as structured objects — not flat strings. When a stage throws an `InputValidationError`, the field-level `.issues` are preserved all the way to FlowRecorders and the narrative output.

### How It Works

When a stage throws, the engine:
1. Calls `extractErrorInfo(error)` to build a `StructuredErrorInfo`
2. Attaches it to the `FlowErrorEvent` as `structuredError`
3. Dispatches to all FlowRecorders with the full structured data

```typescript
import {
  FlowChartExecutor,
  type FlowRecorder,
  type FlowErrorEvent,
  InputValidationError,
} from 'footprintjs';

// A custom recorder that uses structured error details
const errorObserver: FlowRecorder = {
  id: 'error-observer',
  onError(event: FlowErrorEvent) {
    console.log(`Stage: ${event.stageName}`);
    console.log(`Message: ${event.message}`);

    // Access structured details — no string parsing needed
    if (event.structuredError?.issues) {
      for (const issue of event.structuredError.issues) {
        console.log(`  Field: ${issue.path.join('.')} — ${issue.message}`);
      }
    }
  },
};

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(errorObserver);
```

### StructuredErrorInfo

```typescript
interface StructuredErrorInfo {
  message: string;             // Human-readable error message
  name?: string;               // Error class name (e.g. 'InputValidationError')
  issues?: ValidationIssue[];  // Field-level validation issues
  code?: string;               // Machine-readable code (e.g. 'INPUT_VALIDATION_ERROR', 'ENOENT')
  raw: unknown;                // Original error object
}
```

The `extractErrorInfo()` and `formatErrorInfo()` utilities are available as public API exports for use in custom recorders or error handling logic.

### Narrative Enrichment

When an `InputValidationError` is thrown, the default `NarrativeFlowRecorder` enriches the error sentence with field-level details:

```
An error occurred at Validate: Validation failed. Validation issues: email: Required; age: Must be positive.
```

Standard `Error` objects produce the same narrative as before — no regression.

---

## Recorder Error Isolation

Recorders observe scope operations. If a recorder throws, the error is caught and forwarded to `onError` hooks of other recorders. The scope operation continues normally. Recorders can never break execution.

This is tested with up to 50 concurrent recorders (25 throwing + 25 normal) — execution always continues.

---

## Debug Recorder

The `DebugRecorder` captures errors automatically and optionally captures mutations and reads:

```typescript
import { DebugRecorder, ScopeFacade } from 'footprintjs';

const debug = new DebugRecorder({ verbosity: 'verbose' });
const scopeFactory = (ctx: any, stageName: string) => {
  const scope = new ScopeFacade(ctx, stageName);
  scope.attachRecorder(debug);
  return scope;
};

// After execution:
const entries = debug.getEntries();
// [
//   { type: 'write', stageName: 'Validate', key: 'rawPayload', value: {...} },
//   { type: 'error', stageName: 'Validate', error: Error(...) },
//   ...
// ]
```

### Mermaid Diagrams

The builder can generate Mermaid flowchart diagrams for visualization:

```typescript
const chart = flowChart('A', fnA)
  .addFunction('B', fnB)
  .addDeciderFunction('Route', routeFn)
    .addFunctionBranch('x', 'X', xFn)
    .addFunctionBranch('y', 'Y', yFn)
    .end()
  .build();

console.log(chart.toMermaid?.() ?? 'N/A');
// graph TD
//   A --> B
//   B --> Route
//   Route -->|x| X
//   Route -->|y| Y
```

---

## What Consumers Can Do After Failure

- **Retry with modifications** — Inspect the snapshot, fix inputs, re-run
- **Partial results** — Fork children that succeed still return results (default mode)
- **Fail-fast** — Opt into `failFast: true` when any child error should abort the whole fork
- **Timeout/cancel** — Use `timeoutMs` or `AbortSignal` for external cancellation
- **Post-mortem** — Feed the narrative + snapshot to an LLM for root-cause analysis

---

For architecture details, see [src/lib/engine/README.md](../../src/lib/engine/README.md) and [src/lib/memory/README.md](../../src/lib/memory/README.md).

# Native terminal failure context

Use `executor.getFailureContext()` after a rejected `run()` or `resume()`. During a traversal failure, `FlowRecorder.onRunFailed` also receives the same frozen projection as `event.failure`. No model or retry-record correlation is needed.

```ts
import { flowChart, FlowChartExecutor, type TerminalFailureContext } from 'footprintjs';

const chart = flowChart('Read inventory', () => {
  throw Object.assign(new Error('synthetic private detail'), { status: 503 });
}, 'inventory').build();
const executor = new FlowChartExecutor(chart);
let observed: TerminalFailureContext | undefined;
executor.attachFlowRecorder({
  id: 'failure-context',
  onRunFailed(event) { observed = event.failure; },
});
try { await executor.run(); } catch {
  const failure = executor.getFailureContext();
  // { category: 'server', stage: { runId: '...', runtimeStageId: 'inventory#0' } }
  // observed === failure; the original rejection has not been wrapped.
}
```

The contract contains only the existing `AttemptCategory` and, when owned by a native stage, its exact run ID and full runtime-stage ID. Nested subflows, branch namespaces and loop execution indexes are preserved. The synthetic `event.traversalContext` remains the **run boundary** (`__root__#0`); use `event.failure.stage` for the failed stage. Legacy code may manually emit a run-failed event without `failure`, so that property remains optional in the event type.

Categories remain `timeout`, `network`, `rate-limited`, `server`, `auth`, `permanent` or `unknown`. They describe the observed failure, not proof that a provider is down. Native policy attempts supply their final category directly before diagnostic serving; masking or omitting HTTP status cannot erase it. An unresolved outside effect remains `unknown`, even if an earlier physical attempt timed out. There is no raw exception, message, stack, validation issue, input, request, arbitrary code or idempotency key in this projection. Run and stage IDs are chart/runtime names; do not put customer data in names. Existing served-error policies still govern the separate `structuredError` field.

## Ownership, not the last error

- A recovered retry does not own a later failure. A caught `$call` or an SDK `observed()` report does not make its containing stage fail.
- Ordinary fan-out errors remain contained results unless the chart selects fail-fast. The exact rejection chosen to escape owns the context; later siblings cannot replace it. An actual failure still wins over a concurrent pause.
- A failed stage commit owns that stage, even if its function or attempt succeeded. A successful function does not prove that its writes were saved.
- An escaping subflow failure retains the inner native identity. A mapper, serializer or enclosing run boundary that fails independently does not borrow an inner failure.
- Admission, initialization, pre-stage cancellation, retained-result serialization, checkpoint construction and terminal sink failures without a matching native stage produce `{ category: 'unknown' }`, with **no stage**. Unknown means no supported ownership, not the last successful stage.

`getFailureContext()` is `undefined` before execution, while a new leg is running, and after success or pause. A new run or resume starts a fresh slot. A rejected concurrent `run()`/`resume()` is refused before touching the active leg's slot. A refused idle admission clears a prior leg's failure context but leaves existing operational state/checkpoints under their established admission rules. During `onRunFailed`, the terminal projection is already readable; executor settlement seals it and releases private exception identity.

## Retention boundary

The API is an in-memory native fact, not a complete causal diagnosis. It does not certify capture completeness, reconstruct dependencies or make a root-cause claim. It is not added to commit bundles, checkpoints or sink entries by this change. A recorder may explicitly store `event.failure` alongside its authorized trace. Failures before the existing traversal event boundary (such as input admission), or after it (such as sink flush), are available through the accessor and do not manufacture a new traversal event. Snapshot completeness and durable ending notes are separate work.

The engine records ownership during execution. Sequential and exclusive-branch frames share one slot; parallel branches and subflows are isolated until their exact escaping rejection is selected. It does not scan attached recorders, attempt history or execution trees.

Run the local, synthetic [example](../../examples/errors/04-terminal-failure-context.ts):

```sh
npx tsx examples/errors/04-terminal-failure-context.ts
```

# Execution Control

FootPrint provides three mechanisms for controlling pipeline execution: `breakFn`, exceptions, and external cancellation.

---

## breakFn — Graceful Early Termination

Every stage receives `(scope, breakFn)`. Calling `breakFn()` completes the current stage normally, then skips all remaining stages.

```typescript
const validateInput = async (scope: ScopeFacade, breakFn: () => void) => {
  const amount = scope.getValue('loanAmount') as number;
  if (amount > 50_000) {
    scope.setValue('rejection', 'Exceeds maximum loan amount');
    breakFn();  // stage output is committed, pipeline stops — no error
  }
};
```

Use cases:
- Validation gates that reject early
- Budget or quota limits
- Conditional short-circuits where remaining stages are unnecessary

---

## Throwing — Hard Abort

Throwing from a stage immediately aborts execution. The engine commits the trace (including partial writes from the failing stage) before re-throwing. See [Error Handling](./error-handling.md) for details.

```typescript
const callExternalAPI = async (scope: ScopeFacade) => {
  const response = await fetch(scope.getValue('apiUrl') as string);
  if (response.status === 403) {
    throw new Error('Access denied — cannot continue');
  }
};
```

---

## Cancellation & Timeout

For LLM pipelines where API calls can hang, `FlowChartExecutor.run()` supports cooperative cancellation:

### Timeout

Auto-abort after a duration:

```typescript
const result = await executor.run({ timeoutMs: 30_000 });
```

### AbortSignal

Cancel from outside:

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 10_000);

const result = await executor.run({ signal: controller.signal });
```

The signal is checked before each stage starts and raced against async stage functions. Aborted executions throw with the signal's reason.

`env.signal` is honoured the same way (10.1 — it used to be readable only). A run that has a `signal`, an `env.signal` and a deadline composes them into ONE signal; a stage reads that one on `scope.$getEnv().signal` whenever the run has an env.

### Deadline

A timeout is a deadline in disguise. Give the run one, either way:

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

const chart = flowChart('Work', () => undefined, 'work').build();
const executor = new FlowChartExecutor(chart);

await executor.run({ deadline: Date.now() + 120_000 }); // epoch milliseconds
await executor.run({ timeoutMs: 120_000 }); // the same deadline, relative
```

| | |
|---|---|
| **Both given** | The earlier wins (and so does an `env.deadline` you pass, if it is earlier still). `timeoutMs` is honoured beside a `signal` too. |
| **What stages see** | `scope.$getEnv().deadline` (epoch ms), and `scope.$attempt().timeLeftMs()` — reading the time marks the stage's commit `untrackedSources: ['env']`. Subflows inherit it. |
| **When it passes** | The run's signal aborts, and traversal rejects with `Execution timed out after <timeoutMs>ms` (or `Execution passed its deadline …`). A deadline already past stops the run before its first stage. Registered cleanup is joined afterward and must bound its own time; the run stays pending if cleanup never settles. |
| **The record** | Every stage of a run with a deadline records its attempt on its execution-tree node (`attempts`), so a stage the deadline cut short says so: `outcome: 'timeout'`. A retried stage never starts a wait the deadline would cut: it stops `no-time-left`. |
| **Pause and resume** | The deadline is per leg, like the loop budget: the checkpoint does not carry it. Pass a fresh one to `resume(checkpoint, input, { deadline })`. |

A deadline is not a cancellation: an attempt it ends **timed out** (it had no answer in the time it had); `aborted` stays the word for a run you cancelled. To cap a single stage's attempt, use `RetryPolicy.timeoutMs` — see [Error handling → Time budget](./error-handling.md#time-budget).

---

## Comparison

| Mechanism | Trigger | Stage completes? | Returns |
|-----------|---------|-----------------|---------|
| `breakFn()` | Inside stage | Yes | Stage output (no error) |
| `throw` | Inside stage | No | Error propagates |
| `AbortSignal` | Outside pipeline | Races async | Error propagates |
| `deadline` / `timeoutMs` | The clock | Races async | Error propagates; the cut stage's attempt says `timeout` |

---

## Fail-Fast Forks

By default, parallel children run to completion even if some fail (errors captured as `{ isError: true }`). For cases where you want immediate failure:

```typescript
flowChart('Fetch', fetchFn, 'fetch')
  .addListOfFunction([
    { id: 'api1', name: 'CallAPI1', fn: api1Fn },
    { id: 'api2', name: 'CallAPI2', fn: api2Fn },
  ], { failFast: true })  // first child error rejects the whole fork
  .build();
```

---

## Loops and Iteration Limits

The engine tracks iteration count per node. Default maximum is 1000 iterations per back-edge to prevent infinite loops from user code.

```typescript
flowChart('Init', initFn, 'init')
  .addFunction('Retry', retryFn, 'retry')
  .addDeciderFunction('Check', checkFn, 'check')
    .addFunctionBranch('again', 'Process', processFn)
    .addFunctionBranch('done', 'Finish', finishFn)
    .end()
  .loopTo('retry')
  .build();
```

---

For architecture details, see [src/lib/engine/README.md](../../src/lib/engine/README.md).


## Component-local setup and joined cleanup

A mounted component can share a native run ID with its parent and siblings. Register component-local wiring through createRunLifecycle(..., { componentSetup }), then declare a component slot before entry. The callback receives ComponentRun: private cells, the captured native origin, an entry coordinate and onFinalize. Declared component roots get separate banks; undeclared internal charts inherit their enclosing component.

ComponentSetup may supply bindScope and an InlineComponentRecorder. Setup and binding are synchronous so a stage can read the effects of a preceding canonical event immediately. Component recorders accept absent/inline delivery; deferred or invalid delivery refuses with ERR_COMPONENT_RECORDER_DELIVERY rather than being silently changed. Existing event ordering, redaction and observer error isolation still apply. Scope-factory construction effects are outside this observation promise.

Use onFinalize for cleanup that must finish before its owner settles. It is joined lifecycle control, not a recorder hook. Registered callbacks run once in reverse order, and may return a Promise. An earlier body/native failure keeps precedence over a cleanup failure.

| Owner | When cleanup is joined |
| --- | --- |
| Owned lifecycle root | After the withRun body, native work and joined controls, including postprocessing, under the run lease. A body can run them earlier, inside itself, with `run.finish()` (see the [execution model](execution-model.md#finish-inside-the-body)). |
| Raw FlowChartExecutor root | In the native terminal path, before run/resume settles. |
| Declared mounted component | Around its admitted setup, mapping, execution and merge terminal. With failFast, a still-running sibling settles and cleans up later, after the parent has already rejected. |

The closed ComponentEnd kinds are completed, paused and failed; cancellation is failed. Pause closes this execution leg's observation and passes paused to cleanup, so a resource adapter can deliberately retain its paused resources. BOTH SAME and FRESH resume allocate fresh component cells and subscriptions. Restore admitted data explicitly; private cells, callbacks and handles are not checkpoint contents. Native checkpoint format 2 carries none of this private control machinery.

Keep the lifecycle object strongly reachable for as long as the chart can execute.
Component ports are weak registrations: retaining only a slot from
`createRunLifecycle(...).slot(...)` does not keep setup or cleanup installed.
`componentSetup` runs only after a component slot declares that chart root.
`bindScope` runs once for each scope, hence once per attempt; a throw there is an
attempt failure that the stage's retry policy may retry.

A finalizer bounds its own time. Neither `timeoutMs` nor `signal` limits cleanup;
a finalizer that never settles holds the run and its lease indefinitely. Cleanup
runs after observation closes: recorders have already seen the execution end.
Its failure reaches the logger and, for a completed run, the caller, rather than
adding a later failure to the record. During a pause, cleanup failures are logged
as a count and the usable pause wins at roots and mounts alike.

A failed `withRun` body withdraws any SAME continuation it offered, even if native
execution paused first. A caller can FRESH-resume a checkpoint it saved.
After withdrawal, `view().isPaused()` still reports the native pause, while
`continuation()` is undefined.
Lifecycle SAME continuations are one-shot: a setup refusal spends the token, so
save the checkpoint before relying on it. Direct executor checkpoint retries remain a
separate API and retain their checkpoint after setup refusal.

A later owned run or FRESH resume that reaches its origin also discards the earlier
continuation, even when `onOrigin` or `componentSetup` then refuses it. One refused
before that, for example by a malformed `setup` argument, keeps it.

A straggler inside a declared component stops at its next stage with
`Component scope binding has retired`, or at its next mount with
`Native component parent binding has retired`, even without component setup. The
declared component has ended; plain charts keep their existing straggler behavior.
When a `withRun` body rejects, cancellation cuts the running stage first, with that
failure, so these messages do not appear.

The same recorder object registered as a component recorder and as a deferred
global recorder receives both deliveries. Only inline registrations are deduplicated.

entry.ordinal is a native component occurrence coordinate within a leg. It distinguishes repeated mounts; it is not an application/user identity, stable resume identity or authorization. Capture actual entry data rather than filtering a global subscription by run ID. After retirement, old scopes cannot write or register new component callbacks; already-registered owned-root cleanup can still join after postprocessing.

### Two concurrent mounts, isolated fixture observations

This standalone TypeScript example mounts the SAME worker chart twice. It simulates a tool event and arbitrary fixture cost units; it makes no provider/tool calls, measures no real bill, and installs no global recorder. The barrier only demonstrates overlap. Each body checks its own observation immediately after emit, and the final reports exist before the parent run resolves.

```typescript
import {
  createRunLifecycle,
  flowChart,
  FlowChartExecutor,
  select,
  type RunLifecycle,
  type RunSlot,
  type TypedScope,
} from 'footprintjs';

type Fixture = { tool: string; costUnits: number };
type Totals = { tools: string[]; costUnits: number };
type Report = Totals & {
  entry: { readonly runId: string; readonly ordinal: number };
  end: 'completed' | 'paused' | 'failed';
};

function isFixture(value: unknown): value is Fixture {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.tool === 'string'
    && typeof row.costUnits === 'number'
    && Number.isSafeInteger(row.costUnits)
    && row.costUnits >= 0;
}

async function example() {
  const reports: Report[] = [];
  let entered = 0;
  let releaseBoth!: () => void;
  const bothEntered = new Promise<void>(resolve => { releaseBoth = resolve; });
  let totalsSlot: RunSlot<Totals>;

  const worker = flowChart<string, TypedScope<Record<string, unknown>>>(
    'Fixture tool',
    async scope => {
      const fixture = scope.$getArgs<Fixture>();
      entered += 1;
      if (entered === 2) releaseBoth();
      await bothEntered; // Both mounted bodies have entered.

      // SIMULATED tool event and cost units. No tool/provider call is made.
      scope.$emit('fixture.tool', fixture);

      // Read now, inside the body: no observer drain or terminal flush.
      const saved = workerOwner.forScope(scope).read(totalsSlot);
      if (!saved.present || saved.value.tools.length !== 1
        || saved.value.tools[0] !== fixture.tool
        || saved.value.costUnits !== fixture.costUnits) {
        throw new Error('Expected only this component\'s inline fixture event');
      }
      return fixture.tool;
    },
    'fixture-tool',
  ).build();

  const workerOwner: RunLifecycle = createRunLifecycle(worker, {
    runnerId: 'fixture-worker',
    componentSetup(component) {
      const totals = component.local(totalsSlot, () => ({
        tools: [] as string[],
        costUnits: 0,
      }));
      component.onFinalize(async end => {
        await Promise.resolve(); // Joined control, not an observer notification.
        reports.push({
          entry: component.entry,
          tools: [...totals.tools],
          costUnits: totals.costUnits,
          end: end.kind,
        });
      });
      return {
        recorder: {
          id: 'fixture-only', // Same ID; each mount has its own component bank.
          onEmit(event) {
            if (event.name !== 'fixture.tool' || !isFixture(event.payload)) return;
            totals.tools.push(event.payload.tool);
            totals.costUnits += event.payload.costUnits;
          },
        },
      };
    },
  });
  totalsSlot = workerOwner.slot<Totals>('component'); // Declare BEFORE entry.

  const parent = flowChart('Begin', () => undefined, 'begin')
    .addSelectorFunction('Both fixtures', scope => select(scope, [
      { when: () => true, then: 'alpha', label: 'Alpha fixture' },
      { when: () => true, then: 'beta', label: 'Beta fixture' },
    ]), 'both')
      .addSubFlowChartBranch('alpha', worker, 'Alpha fixture', {
        inputMapper: () => ({ tool: 'alpha.lookup', costUnits: 2 }),
      })
      .addSubFlowChartBranch('beta', worker, 'Beta fixture', {
        inputMapper: () => ({ tool: 'beta.lookup', costUnits: 7 }),
      })
      .end()
    .build();

  try {
    await new FlowChartExecutor(parent).run({ timeoutMs: 5_000 });
  } finally {
    releaseBoth(); // Release this demonstration's barrier on a failed run too.
  }

  const actual = reports.map(({ tools, costUnits, end }) => ({ tools, costUnits, end }))
    .sort((a, b) => a.tools[0]!.localeCompare(b.tools[0]!));
  const expected = [
    { tools: ['alpha.lookup'], costUnits: 2, end: 'completed' },
    { tools: ['beta.lookup'], costUnits: 7, end: 'completed' },
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || new Set(reports.map(report => report.entry.runId)).size !== 1
    || new Set(reports.map(report => report.entry.ordinal)).size !== 2) {
    throw new Error('Expected two isolated, joined fixture reports');
  }
  console.log(actual);
}

void example();
```

The expected reports contain only alpha.lookup/2 and beta.lookup/7 respectively. These numbers are fixture inputs, not benchmark or billing results. Each total covers this component leg's observed fixture events only; missing/redacted events do not establish no tool use or zero real cost. The example's reports array is a composition-root output, not an active-run registry.

Migration: move integration-local accumulators from global/run-ID subscriptions into componentSetup and component slots. Register joined cleanup before opening its resources. Resource preservation/reopening across pause belongs to the resource adapter; onFinalize does not certify a remote handle closed or cancel arbitrary application promises.

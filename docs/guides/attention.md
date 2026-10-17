# Stage attention: recorded facts before explanation

`StageSnapshot.attention?` contains bounded marks collected synchronously as an execution records a failure, retry, timeout, unknown effect or explicit quality drop. A mark has a `kind`, a fixed `reason`, and evidence references. Consumers can highlight a stage or pass those facts to a read-only cause query without asking a model to classify raw logs.

The shared `Attention` and `AttentionKind` types belong to the public `foottrace` root. FootPrint imports those types for `StageSnapshot`; it does not re-export them or import the optional `foottrace/cause` reader into the engine.

```ts
import type { Attention } from 'foottrace';
import type { StageSnapshot } from 'footprintjs/advanced';

function attentionFor(stage: StageSnapshot): readonly Attention[] {
  return stage.attention ?? [];
}
```

A normal execution with no captured attention has **no own `attention` field**, rather than an empty array. An absent field means no mark was recorded at this boundary. It is not a guarantee that every provider, deferred observer or business quality rule was checked. Existing healthy records remain byte-identical; the record law names attention-only additions to abnormal snapshots separately.

## What a mark says

| Kind | Recorded fact |
| --- | --- |
| `error` | The stage error path recorded `errors.stageExecutionError`. A failed attempt followed by recovery does not by itself make the final stage an error. |
| `retried` | A retained attempt recorded `next: 'retry'` or a later attempt ordinal. A retry decision can be visible before the stage commits. |
| `timeout` | A retained attempt recorded its own timeout. A timeout does not prove that an outside provider was down. |
| `unknown-effect` | A retained attempt explicitly recorded that the outside effect was unknown. It must not be presented as a confirmed failed payment. |
| `gave-up` | A recorded retry-capable compact series ended with a supported stop reason. Intentional pause or cancellation is not automatically exhaustion. |
| `quality-drop` | An inline quality recorder recorded an explicit drop for this execution. The bridge reads that recorded fact after synchronous delivery; it does not infer a drop from a numeric score or parse factor text. |
| `not-collected` | Known evidence or mark/reference capacity was omitted. This is an incompleteness signal, not a healthy outcome. |

`outlier` is a shared kind for future supported producers. C2 introduces no arbitrary latency, cost, score or outlier threshold. An application-specific quality number, `$eval` name or error message does not silently become a quality-drop rule.

A physical call in an explicit `retryLoop` still has its own outcome and attempt count. Its one-call stop does not establish that the whole logical retry workflow gave up. Read the explicit loop decision for that business-level conclusion. An unknown physical effect stays unknown until actual reconciliation establishes an outcome.

For an `observed()` SDK attempt, `next` and `reason` are the default retry table's interpretation, not an observed SDK decision. C2 does not use those suggestions to stamp `retried` or `gave-up`. An actual reported attempt ordinal above one can establish a retry; timeout and unknown-effect outcomes remain their own recorded facts.

## Resolve proof under the owning stage

References are **local to the same `StageSnapshot`**, identified by its `runtimeStageId` and run/subflow context. They are not global attempt IDs or provider request IDs. Keep that context when handing a mark to a viewer or agent.

| Reference | Resolution |
| --- | --- |
| `attempts:0` (or another zero-based retained index) | That exact element of the owning snapshot's `attempts` array. Its `series`, `attempt`, outcome and decision provide the physical evidence. |
| `attemptSummary` | The owning snapshot's recorded stage-series summary. It can arrive before the final attempt record. |
| `errors:stageExecutionError` | The own `stageExecutionError` field of this snapshot's `errors` bag. Error text remains governed by diagnostic redaction. |
| `attemptsDropped` | This snapshot's nonzero count of call/observed records that exceeded retention. No reference to an unretained attempt is invented. |

A consumer must resolve a reference before making a factual claim from it. Do not search a different stage with the same display name, infer an ID by shortening a long path, or treat a missing referenced row as proof of success. A local reference is useful only with its owning recorded stage.

Marks contain no raw error messages, factors, state values, inputs, outputs, idempotency keys or provider bodies. Reasons use fixed library wording. At most 32 marks are retained, with at most 16 evidence references per mark; references are at most 512 characters and exclude C0/C1 control characters. Unsupported or oversized references are omitted rather than truncated into different identities. A capacity/proof omission leaves a `not-collected` signal with `reason: 'EVIDENCE_NOT_COLLECTED'`; without a retained omission locator its evidence is empty. Actual call-record overflow cites `attemptsDropped`. That signal may cover more than one known omission and is not an exhaustive gap count.

## Collection timing and limits

Attention is updated at the existing traversal-time fact boundaries, not discovered by a walk when `getSnapshot()` is called. Snapshot export copies the marks already held by that frame. The execution's runtime ID is stamped first; a new execution resets only its attention bookkeeping. Retry staging resets do not clear earlier attention from the same execution, and a later healthy loop visit or a different parallel sibling does not inherit those marks.

The inline `QualityRecorder` currently records explicit attempt-related drops through its existing attempt-series rules. The bridge includes nested `CompositeRecorder` instances, checks at most 128 recorder/child slots per event, and discloses incomplete inspection as `not-collected`. It compares the actual row before and after delivery: an unchanged row left by a previous run cannot flag this execution. Merely having a score below 1 is not the same fact. Deferred quality delivery may happen after the stage has finished; its absence at the synchronous boundary stays unknown. C2 neither waits for deferred delivery nor retroactively rewrites a previously served stage snapshot from a later quality result.

These marks live in the **local served execution snapshot**. C2 does not add attention entries to the crash-safe record sink. Existing native attempt notes can survive a process kill; they do not imply that the local attention projection survived too. A durable extension must store and admit the needed facts explicitly. Do not label a crash prefix complete because a finished snapshot format supports attention.

The runnable example [01-stage-attention.ts](../../examples/runtime-features/attention/01-stage-attention.ts) executes a healthy stage, a recovered retry and another healthy stage. It checks that healthy stages omit the field and that retry evidence resolves to retained records. It uses no provider, model, network or credentials:

```sh
npx tsx examples/runtime-features/attention/01-stage-attention.ts
```

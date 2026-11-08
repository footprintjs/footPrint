# A fixed recording of a native prefix

An error can end a run while other work is still pending. A terminal status or a storage receipt does not prove that all evidence was collected. `captureClosure: true` opts into a separate, bounded copy of a supported native root prefix. It requires `captureCoverage: true` and `captureExtent: true`.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { controlDepRecorder } from 'footprintjs/trace';

const chart = flowChart<{ rateCount: number }>('Rates', (scope) => {
  scope.rateCount = 0;
}, 'rates').addFunction('Require a rate', (scope) => {
  if (scope.rateCount === 0) throw new Error('No rate available');
}, 'require-rate').build();

const executor = new FlowChartExecutor(chart, {
  captureCoverage: true,
  captureExtent: true,
  captureClosure: true,
  readSources: true,
});
executor.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
try {
  await executor.run();
} catch {
  // Keep handling the original native error normally.
}
const result = executor.getClosedCapture();
if (result.status === 'closed') {
  const { closure, capture } = result.record;
  // Failed remains failed. The selected invocation is a fact, not a semantic cause verdict.
  console.log(capture.boundary.status, closure.selectedFailure?.attemptId);
} else {
  console.log('Recording unavailable:', result.reason);
}
```

`getSnapshot()` remains the ordinary live observation and carries no new closure authority. `getClosedCapture()` serves only the separate immutable copy: capture note, native invocation book, execution tree, recorder rows, optional exact read sources, commit log and starting state. It never includes live `sharedState`. Later callbacks or another run cannot revise a previously returned copy. An admitted saved history exposes its descriptor as `history.closure`; that descriptor applies only to the exact history the reader admitted, not another snapshot or run.

The policy is `native-root-prefix-v1`. It means the library copied the collected native prefix at a fixed terminal cut, after the native error/attention/control tails. It does **not** mean every JavaScript callback finished, outside effects stopped, every channel was captured, the application succeeded, or a semantic root cause was proved. The original `NativeCaptureExtent` version 1 remains `unverified`; its counters are not promoted or reinterpreted.

For a failed prefix, `selectedFailure` identifies the actual stage-function invocation that supplied the exact escaping value. Its `attemptId` comes from actual entry, including a direct first attempt. A recovered retry cannot supply it. A later commit, preparation, callback or retention failure cannot borrow that invocation. Failures without such a binding remain unknown; the original thrown object is never replaced by a capture failure.

Each retained execution also has an opt-in `nativeInvocations` count collected at actual entry. A shared consistency check requires the descriptor's selected execution and primary commit to exist exactly once, ties its attempt to that execution's count, and checks the per-execution total against the native work book. Missing or contradictory witnesses are refused, even when an editor recomputes the checksum. These are consistency checks on producer facts, not authentication or an attempt to discover ownership from the finished tree.

The first policy supports fresh, built-in root stages with settled native invocations, including settled stage retries and sequential decisions. Children, fanout, detach, custom scopes, resumed segments, saturated counts, pending or abandoned native invocations remain unknown. Any use of `$call` is also unknown in this first policy, even when awaited: native helper ownership needs its own extension. A failed commit cannot supply the required invocation binding. Unawaited arbitrary JavaScript callbacks and external work are outside the attested prefix.

Closure and coverage are separate. Readers must still check every required channel and preserve disabled, partial, failed and unknown states, source gaps and redaction. Reading a value before a write is a possible contribution, not proof that an expression used it. `decide()`/`select()` can record their declared operators and comparison results; a Proxy cannot recover an arbitrary comparison or arithmetic expression after its primitive values left the scope.

## Bounds, privacy and storage

The copy has a fixed 1 MiB ceiling. A smaller configured `sink.capture.maxBytes` also limits it. The existing inert-data copier enforces byte, depth and node bounds; it never calls a stored getter or `toJSON`. Undefined tracked reads and writes retain their existing `absent` sidecar. Unsupported values or a refused/oversized copy yield a fixed unknown reason and do not change the native outcome.

This opt-in pays for a bounded detached copy of retained evidence. It skips preparing a public copy of live shared state and subflow results. The byte ceiling bounds the retained artifact, not all snapshot preparation, recorder callbacks or peak memory; closing and saving can perform several copies and source validations. It does not add a reaction to a stage Promise or rerun a predicate, comparator, getter or business function. Actual runtime overhead has not been benchmarked. The default-off record bytes and scheduling are unchanged.

The normal retention/redaction rules apply before evidence is copied. Protocol names selected by a hiding rule can make the descriptor unreadable; the result is unknown. Seed values use the same served-state policy as saved records. Existing retained error/diagnostic text is governed by that policy; the new selection descriptor contains only safe identities, never error text or a stack.

With `sink.capture`, the save path uses this exact frozen copy rather than calling a recorder again for a later mutable view. The existing explicit durability acknowledgement, time limit and checksum bind it to its log and starting state. If closure was refused, persistence reports unknown and does not substitute another snapshot. A flush alone is still not durability proof. Old readers refuse the new history field; they cannot drop it and claim completeness.

The checksum detects corruption, not deliberate rewriting by an authorized storage editor. The host still owns storage authorization and producer trust. Closure never authenticates the producer, proves remote cancellation or establishes a fault in another service. Owned-run finalizers and owner-body work remain outside the native prefix; an owner body can fail after `finish()` while the native prefix remains completed.

AgentFootprint admission and selected-failure explanations require a separate consumer change over this public contract. Existing completed-only cause tools do not automatically admit failed runs merely because this producer feature is enabled. No general root-cause accuracy or infrastructure diagnosis claim follows from this change.

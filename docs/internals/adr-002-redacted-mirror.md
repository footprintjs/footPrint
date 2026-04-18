# ADR-002: Redacted Snapshot — Parallel Mirror, Not Post-Pass Scrub

**Status:** Accepted (4.14.0)
**Date:** 2026-04-17
**Context:** closing the snapshot leak where `getSnapshot().sharedState` retained raw values for keys known to be redacted, enabling external trace sharing (paste-into-viewer, export-to-support).

## Decision

Maintain a **parallel `SharedMemory` mirror** during traversal, populated via the already-computed redacted patches from each `StageContext.commit()` (the same patches that feed the event log). `FlowChartExecutor.getSnapshot({ redact: true })` reads from the mirror; the default reads from raw `globalStore`.

## Alternative considered — post-pass scrub

`getSnapshot({ redact: true })` could have walked the final `sharedState` and scrubbed keys listed in `_redactedKeys`. Rejected.

## Why mirror won

### 1. Matches library's core principle

footprintjs's invariant (CLAUDE.md): **"Collect during traversal, never post-process."** All data collection — narrative, metrics, manifest, identity — is a side effect of the single DFS pass. A post-pass scrub would be the first exception, opening the door to "post-process this too" requests indefinitely. The mirror keeps the rule intact.

### 2. Redacted patches already exist

[StageContext.ts:235-236](src/lib/memory/StageContext.ts#L235-L236) already computes `redactedOverwrite` + `redactedUpdates` on every commit for the event log. The mirror reuses them at no incremental cost — one extra `applyPatch` call per commit, same shape as the raw one.

### 3. Zero-allocation when unused

Mirror creation is gated on `redactionPolicy !== undefined`. Consumers who don't configure a policy pay nothing: no second `SharedMemory`, no extra `applyPatch`, no branching in the hot path.

### 4. Snapshot-size independence

Post-pass scrub is O(sharedState size) on every `getSnapshot` call. Mirror is O(commit count) amortized over the run, touching only values actually mutated. For long-running flowcharts with large static state, the mirror wins.

### 5. Correctness against mid-run policy changes

With a post-pass scrub, a key added to `redactedKeys` mid-run could leak if it was *read* before the scrub ran. The mirror, being a write-time mechanism, reflects every redacted write immediately — no window where the "safe" snapshot contains raw data.

### 6. Composes cleanly with subflows

`StageContext` propagates `redactedSharedMemory` into every child / next context. Subflow commits write to the mirror through the same path as root commits. A post-pass would have to traverse the execution tree and stitch subflow results back into a scrubbed view — duplicating work the commit pipeline already does.

### 7. Separation of runtime vs. export views

The runtime needs raw values (pause/resume replays against real state, scope reads must return real data). The export view needs scrubbed values. Two stores make this separation structural — a post-pass would blur it (caller has to remember which version they're holding).

## Consequences

**Positive:**
- Redacted snapshot is load-bearing at commit time — no invisible scrub window.
- Zero overhead when no policy is set.
- Matches the architectural principle consumers expect from the library.
- Mirror can be extended later (e.g. to honor `policy.fields`) without changing the public API.

**Negative (accepted):**
- Memory cost: when a policy is set, a parallel `SharedMemory` lives alongside the raw one. For typical scope sizes (kB range), the cost is negligible. For very large scopes (MB range), callers who only need the raw view can skip `setRedactionPolicy`.
- `policy.fields` is not yet mirror-aware — recorder events honor it, mirror does not. Pinned by a regression test; fix requires field-level path representation in `redactedPaths`.

## References

- Implementation: `src/lib/memory/StageContext.ts::commit()`, `src/lib/runner/ExecutionRuntime.ts::enableRedactedMirror()`, `src/lib/runner/FlowChartExecutor.ts::getSnapshot()`
- Tests: `test/lib/runner/redacted-snapshot.test.ts`
- Upstream consumer: `agentfootprint.exportTrace()` (planned — will default to `{ redact: true }`)

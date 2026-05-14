# footprintjs 5.0.0 — Recorder Redesign + `runId`

**Status:** DRAFT — Phase 0 design doc, no code yet.
**Audience:** library maintainers + downstream consumer authors (agentfootprint, lens, explainable-ui).
**Decision authority:** project owner signoff required before Phase 1 implementation.

---

## 1. Why this redesign exists

We hit a sustained class of bugs in agentfootprint + lens that all trace to two root causes:

1. **No per-run identity in `TraversalContext`.** Two `executor.run()` calls (e.g., `committee.run()` then `tolerantCommittee.run()` in the same script) produce identical `runtimeStageId` values for the same stage names because each executor's counter resets to zero. Recorders that accumulate state across runs (fork tracking, sibling-handoff bookkeeping) silently alias the second run's events into the first run's state. **No diagnostic — just wrong output.**

2. **Abstract base classes invite "kitchen sink subclasses."** `BoundaryRecorder extends SequenceRecorder<DomainEvent>` ended up doing FOUR jobs: storage, FlowRecorder hooks, dispatcher subscription, per-run state. `RunStepRecorder extends SequenceRecorder<RunStep>` ended up doing FIVE: storage, fork tracking, sibling tracking, scope filtering, root inference. Each new bug required threading state through more concerns of the same monolithic class.

The 5.0.0 release fixes both, in one atomic break.

---

## 2. The design rule (project convention)

**One recorder, one purpose.**

A recorder owns exactly ONE concern. Multi-concern recorders MUST be decomposed into single-purpose pieces composed via a thin facade. Inheritance is allowed only when the subclass adds NO behavior beyond what the base provides — pure storage extension is fine, mixing in state machines is not.

This rule lives in `CLAUDE.md` and applies to every recorder authored after 5.0.0 in any consumer library.

---

## 3. What changes

### 3.1 `runId` in `TraversalContext` (additive)

Every event the engine fires carries a `runId` that uniquely identifies the `executor.run()` call that produced it.

```typescript
interface TraversalContext {
  readonly runId: string;          // NEW — required, generated per executor.run()
  readonly stageId: string;
  readonly runtimeStageId: string;
  readonly stageName: string;
  readonly parentStageId?: string;
  readonly subflowId?: string;
  readonly subflowPath?: string;
  readonly depth: number;
  readonly loopIteration?: number;
  readonly forkBranch?: string;
}
```

**Format:** `${Date.now()}-${counter}` — sortable lexicographically (= chronologically), no crypto dep, debuggable.

**Generation:** generated once at the start of `FlowChartExecutor.run({input})`. NOT generated at executor construction — the same executor can be reused for multiple runs.

**Resume semantics:** `executor.resume(checkpoint)` generates a NEW `runId`. Resumes are logically distinct runs. The original runId is recoverable from the checkpoint metadata for cross-run audit if needed.

**Nested executor semantics:** when a nested executor runs (e.g., a Parallel branch's `branch.runner.run()`), the nested executor gets its OWN `runId`. Lens and other consumers correlate parent-child via `subflowPath` + `runtimeStageId`, NOT via `runId`.

**Recorder responsibility:** recorders that maintain per-run state (e.g., fork bookkeeping, asks-emitted flag) detect "new run" via `event.runId !== this.lastRunId` and reset their transient bookkeeping. Recorders that don't care about scoping ignore the field. Documented as a convention in `lib/recorder/README.md`.

### 3.2 Concrete stores (breaking)

Today's abstract base classes:
- `SequenceRecorder<T>` — abstract; consumers `extends` it.
- `KeyedRecorder<T>` — abstract; consumers `extends` it.
- `BoundaryStateTracker<T>` — abstract; consumers `extends` it.

Replaced with concrete stores:
- `SequenceStore<T>` — concrete class, instantiable. Pure storage + indexing. Public methods identical to today's `SequenceRecorder<T>` except no event hook signatures (those move to interfaces).
- `KeyedStore<T>` — concrete class, instantiable. Pure 1:1 keyed storage.
- `BoundaryStateStore<T>` — concrete class. Per-boundary lifecycle storage (start / update / stop).

Consumers compose these via a class field:

```typescript
// Before (5.0)
class MyRecorder extends SequenceRecorder<MyEvent> implements CombinedRecorder {
  onSubflowEntry(e) { this.emit({...}); }
}

// After (5.0)
class MyRecorder implements CombinedRecorder {
  private events = new SequenceStore<MyEvent>();
  onSubflowEntry(e) { this.events.push({...}); }
  getEvents() { return this.events.getAll(); }
}
```

### 3.3 `Recorder` → `ScopeRecorder` rename (breaking)

The unqualified `Recorder` interface is renamed to `ScopeRecorder` for naming symmetry with `FlowRecorder` and `EmitRecorder`:

```typescript
// Before
interface Recorder { onRead?(...); onWrite?(...); ... }
executor.attachRecorder(rec);

// After
interface ScopeRecorder { onRead?(...); onWrite?(...); ... }
executor.attachScopeRecorder(rec);
```

Concrete recorder names (`MetricRecorder`, `DebugRecorder`, `LoggingRecorder`, `BoundaryRecorder`, etc.) are unchanged — those describe their PURPOSE, not their channel.

The four recorder INTERFACES become:

| Interface | Channel | Hooks |
|---|---|---|
| `ScopeRecorder` | scope (data ops on TypedScope) | `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd` |
| `FlowRecorder` | control flow | `onRunStart`, `onRunEnd`, `onSubflowEntry`, `onSubflowExit`, `onFork`, `onDecision`, `onLoop`, ... |
| `EmitRecorder` | typed events | `onEmit` |
| `CombinedRecorder` | multi-channel | partial of the above three |

### 3.4 Convention updates to `CLAUDE.md`

Two new conventions added at the project root:

**Convention 1 — One purpose per recorder.** (Section 2 of this doc.)

**Convention 2 — Examples are mandatory integration tests.** Every library-surface change MUST include:
- Unit tests (per-pattern coverage, all 7 test types — see Section 5).
- Integration tests via `examples/` — runnable end-to-end demos that exercise the feature in realistic scenarios.
- Documentation update (relevant README + `CLAUDE.md` if architectural).

PRs without all three are incomplete. Examples are not optional polish — they ARE the integration-test layer.

---

## 4. Migration map (consumer impact)

### Files affected in footprintjs

| File | Change |
|---|---|
| `src/lib/runner/FlowChartExecutor.ts` | Generate `runId` per run, thread through context |
| `src/lib/engine/narrative/types.ts` | Add `runId` to `TraversalContext`, rename `Recorder` interface |
| `src/lib/engine/handlers/*.ts` | Pass `runId` through every event-firing site |
| `src/lib/recorder/SequenceRecorder.ts` | Replace with `SequenceStore.ts` (concrete) |
| `src/lib/recorder/KeyedRecorder.ts` | Replace with `KeyedStore.ts` (concrete) |
| `src/lib/recorder/BoundaryStateTracker.ts` | Replace with `BoundaryStateStore.ts` (concrete) |
| `src/lib/recorder/index.ts` | New exports (stores), remove abstract bases |
| `src/lib/runner/FlowChartExecutor.ts` | Rename `attachRecorder` → `attachScopeRecorder` |
| Tests | Update to consume new APIs; add 7 test types per primitive |
| `examples/` | Update existing examples; add 9 new (Section 7) |
| `CLAUDE.md` | Add the two new conventions |

### Files affected in agentfootprint

| File | Decomposition |
|---|---|
| `src/recorders/observability/BoundaryRecorder.ts` | Split into `DomainEventStore` + `FlowEventBridge` + `TypedEventBridge` + `PerRunState` + facade |
| `src/recorders/observability/RunStepRecorder.ts` | Split into `RunStepStore` + `ForkTracker` + `SequenceTracker` + `ScopeFilter` + facade |
| `src/recorders/observability/MetricRecorder.ts` | Field of `KeyedStore<MetricEntry>` + `ScopeRecorder` impl |
| `src/recorders/observability/TokenRecorder.ts` | Field of `KeyedStore<TokenEntry>` + `ScopeRecorder` impl |
| `src/recorders/observability/LiveStateRecorder.ts` | Already composes — minor adjustments for new store API |
| All `extends`-based recorders elsewhere | Same composition rewrite |

### Files affected in agentfootprint-lens

| File | Change |
|---|---|
| `src/v2/core/LensRecorder.ts` | Composition rewrite (currently `extends SequenceRecorder<EventLogEntry>`) |
| `src/v2/core/selectors/selectAgentInstances.ts` | Consume `TopologyRecorder` instead of StepGraph for structure |
| Other selectors | Pass `runId` through where multi-run scoping matters |

### Files affected in agent-playground

- No direct recorder subclassing in playground code; just attaches recorders supplied by libraries.
- Update `executeCode.ts` to use the renamed `attachScopeRecorder` if directly attached anywhere.

---

## 5. The 7 test types (project convention)

Every new piece (each store, each interface, each composed recorder) ships with all 7 test types. Pattern test count is at least one per type, more when natural.

| # | Type | Asks |
|---|---|---|
| 1 | **Unit** | Does this single function/class behave correctly in isolation? Mock all dependencies. |
| 2 | **Functional** | Does this single feature work end-to-end on the happy path? |
| 3 | **Integration** | Do multiple components (store + bridge + facade + dispatcher) cooperate correctly? |
| 4 | **Property** | Does the invariant hold for ANY input? Use randomized fuzzing or many fixture variations. |
| 5 | **Security** | Does this protect against injection, leakage, redaction bypass? |
| 6 | **Performance** | Is the latency / memory within budget? Microbenchmarks in test suite. |
| 7 | **Load** | Does it sustain throughput at scale (1k, 10k, 100k events/sec)? |

Test naming convention: `*.unit.test.ts`, `*.functional.test.ts`, `*.integration.test.ts`, `*.property.test.ts`, `*.security.test.ts`, `*.perf.test.ts`, `*.load.test.ts`.

For runId specifically:

| # | Test |
|---|---|
| 1 | Unit | runId generator produces unique sortable strings |
| 2 | Functional | Single executor.run() carries a stable runId across all events |
| 3 | Integration | TopologyRecorder + RunStepRecorder both see the same runId |
| 4 | Property | N runs always produce N distinct runIds (fuzz N from 1 to 1000) |
| 5 | Security | runId doesn't include stack traces, env vars, or PII |
| 6 | Performance | runId generation < 1µs |
| 7 | Load | 100k runs/sec with no collisions |

---

## 6. The 7-panel review (project convention)

Each phase ends with a 7-panel review. Each persona votes GREEN / YELLOW / RED. RED blocks the phase from completing. Iterate until all GREEN.

| Persona | Reviews |
|---|---|
| **Platform engineer** | runtime correctness, multi-tenant safety, scalability, ID stability |
| **Security engineer** | data leakage, injection vectors, redaction integrity |
| **Performance engineer** | latency budgets, memory budgets, GC pressure, hot-path costs |
| **DS / logic engineer** | invariants, edge cases, algorithmic correctness, test coverage |
| **Modular code engineer** | one-purpose-per-recorder rule, separation of concerns, dependency direction |
| **Design-pattern engineer** | naming, composition vs inheritance, idiomatic TS, API ergonomics |
| **Product engineer** | does this solve the bug it was meant to solve? does it improve UX? |

Each phase's review block lives at the bottom of the phase's PR description.

---

## 7. New / updated examples

Per the "examples are integration tests" convention.

### footprintjs `examples/runtime-features/run-id/`
1. `01-detect-new-run.ts` — recorder logs "new run!" on each `runId` change.
2. `02-multi-run-scoping.ts` — accumulating recorder scopes its state per-run.
3. `03-nested-runs.ts` — Parallel branches with their own runIds; correlation via subflowPath.
4. `04-resume.ts` — resume-from-checkpoint produces a new runId; original runId recoverable from checkpoint metadata.

### footprintjs `examples/recorders/`
5. `01-compose-sequence-store.ts` — build a custom recorder by composing `SequenceStore<T>`.
6. `02-compose-keyed-store.ts` — same for `KeyedStore<T>`.
7. `03-compose-boundary-state.ts` — same for `BoundaryStateStore<T>`.
8. `04-multi-purpose-facade.ts` — multi-channel recorder (ScopeRecorder + FlowRecorder + EmitRecorder hooks) composed correctly.
9. `05-runtime-stage-id-scoping.ts` — recorder that uses `(runId, runtimeStageId)` as a composite key for cross-run-safe lookups.

### Updated examples (every existing example using deprecated APIs)
- All `examples/` files importing `Recorder`, `SequenceRecorder`, etc. updated to new API.
- All `examples/` files calling `attachRecorder` updated to `attachScopeRecorder`.

---

## 8. The 7-panel review of THIS DESIGN doc

Each persona reviews the design BEFORE implementation begins. RED blocks Phase 1. YELLOW noted with mitigation. GREEN signed.

### 8.1 Platform engineer

**Verdict:** GREEN, with two mitigations.

- ✅ `runId` solves the multi-run aliasing class of bugs at the source. Production agents serving batched requests (one executor, many runs) will get correct attribution.
- ✅ Deterministic format (`${Date.now()}-${counter}`) is sortable and debuggable. No crypto dep.
- ⚠️ **Mitigation 1:** what happens if two executors with the same global counter exist in different processes (e.g., distributed runs)? Counter is per-process. Same `${Date.now()}-${counter}` could theoretically collide across processes in the same millisecond. **Resolution:** the runId is process-local. Cross-process correlation uses `getEnv().traceId` (consumer-supplied). Document this distinction.
- ⚠️ **Mitigation 2:** what if `Date.now()` ticks backward (NTP adjustment)? Counter still monotonic but timestamp goes backwards → sort order breaks. **Resolution:** hold a monotonic-clock guard inside the generator: `lastTs = Math.max(Date.now(), lastTs)`. Cheap, robust.
- ✅ Nested executor semantics (each gets own runId) correct for production scenarios.

### 8.2 Security engineer

**Verdict:** GREEN.

- ✅ `runId` doesn't carry sensitive data. Just a counter + timestamp.
- ✅ Stores are read-only on snapshots (`getEntries()` returns spreads, not references).
- ✅ No new injection vectors. Recorder interfaces unchanged in shape, just renamed.
- ⚠️ **Note:** if consumers stringify `TraversalContext` for logging, `runId` shows up. Verify no security risk (it's not sensitive, but mention in docs).

### 8.3 Performance engineer

**Verdict:** GREEN.

- ✅ runId generation: `${Date.now()}-${counter}` is < 100ns. Negligible.
- ✅ Composition over inheritance: virtual call cost identical (single property dereference + virtual call).
- ✅ Stores keep existing `getEntryRanges()` O(1) per-step lookup. No regression.
- ⚠️ **Mitigation:** add benchmarks BEFORE refactor as baseline. Compare AFTER. Acceptable if no regression > 5%. Run as part of Pattern 6 + 7 tests.

### 8.4 DS / logic engineer

**Verdict:** GREEN, with one invariant to test.

- ✅ Composition pattern is straightforward — no algorithmic complexity changes.
- ✅ runId scoping is a simple `if (runId !== last) reset()` pattern, easy to reason about.
- ⚠️ **Invariant to test (Property test):** for any sequence of events from a single run, the recorder's output is independent of WHEN the recorder is queried (snapshot-monotonic). i.e., querying mid-run + at-end produces consistent prefixes.
- ⚠️ **Edge case:** what if `runId` changes WHILE a fork is in flight (e.g., crash + recovery)? Document as undefined behavior; recorders may emit a residual fork from the previous run. Acceptable.

### 8.5 Modular code engineer

**Verdict:** GREEN — this IS the refactor for modularity.

- ✅ "One recorder, one purpose" rule directly addresses the kitchen-sink anti-pattern we hit.
- ✅ Concrete stores enable composition, which enables single-purpose recorders.
- ✅ Facades provide ergonomics without re-introducing kitchen-sink classes.
- ✅ Each piece testable in isolation — improves overall test posture.
- ⚠️ **Mitigation:** the rule needs ENFORCEMENT — code review checklist + future refactor proposals must cite this rule.

### 8.6 Design-pattern engineer

**Verdict:** GREEN, with naming notes.

- ✅ `ScopeRecorder` rename restores naming symmetry with `FlowRecorder` / `EmitRecorder`. Self-documenting.
- ✅ Composition over inheritance for stateful recorders is the standard pattern (RxJS, immer, zustand).
- ✅ Stores as concrete CLASSES (not abstract bases) is the right call. Abstract bases invite subclass abuse.
- ⚠️ **Naming nit:** `BoundaryStateStore<T>` — confirm the name. Alternatives: `BoundaryLifecycleStore<T>`, `PerBoundaryStore<T>`. **Vote:** keep `BoundaryStateStore<T>` — matches the storage idiom; the lifecycle methods (start/update/stop) are part of the storage API.
- ⚠️ **Naming nit:** `attachScopeRecorder` is a mouthful. Alternatives: `attachScope(rec)`, `attach(rec)` with overloads. **Vote:** keep explicit `attachScopeRecorder` — symmetric with `attachFlowRecorder` / `attachEmitRecorder` / `attachCombinedRecorder`. Self-documenting wins over brevity.

### 8.7 Product engineer

**Verdict:** GREEN.

- ✅ Solves the bug class that's been blocking the playground (multi-run Parallel rendering).
- ✅ Future-proofs the recorder ecosystem — new recorders inherit (figuratively) the cleanliness.
- ✅ Examples-as-integration-tests convention catches regressions before users hit them.
- ⚠️ **Risk:** breaking change. Internal-only consumers today, but if anyone external is building on footprintjs, they need a clear migration path. **Mitigation:** ship `MIGRATION-5.md` with copy-paste-ready before/after for each pattern.

### Cross-panel synthesis

| Concern | Mitigation in plan |
|---|---|
| Cross-process runId collision | Documented: process-local; cross-process uses `traceId` |
| Clock drift breaks sort | Monotonic-clock guard in generator |
| Performance regression | Baseline + after benchmarks (Pattern 6 / 7) |
| Snapshot consistency | Property test for snapshot monotonicity |
| Modularity rule enforcement | Documented in CLAUDE.md + code-review checklist |
| Naming clarity | Resolved (`ScopeRecorder`, `BoundaryStateStore`, explicit `attachScopeRecorder`) |
| Migration burden | `MIGRATION-5.md` + codemod + examples |

**All 7 panels: GREEN with mitigations folded in.**

---

## 9. Open questions for project owner signoff

1. **runId format:** confirm `${Date.now()}-${counter}` (sortable, no crypto). ✅ assumed YES based on prior conversation.
2. **runId on resume:** confirm NEW runId. ✅ assumed YES.
3. **runId on nested executors:** confirm OWN runId per nested. ✅ assumed YES.
4. **Naming:** `ScopeRecorder` + `BoundaryStateStore` + `attachScopeRecorder`. ✅ assumed YES.
5. **Direct to 5.0.0** — no deprecation cycle. ✅ confirmed.
6. **Cascading version bumps** — agentfootprint x.0.0, lens x.0.0, explainable-ui x.0.0. ✅ implied.
7. **Examples-as-integration-tests** as a project convention. ✅ confirmed.
8. **One-purpose-per-recorder** as a project convention. ✅ confirmed.

If any answer differs, surface it now — Phase 1 starts after signoff.

---

## 10. Phase sequencing recap

```
Phase 0  (this doc)               — design + 7-panel review (current)
        ↓ signoff
Phase 1  footprintjs 5.0.0        — implementation + 9 examples + all 7 test types
        ↓ 7-panel review iteration → all green
Phase 2  agentfootprint migration — composition rewrite, one purpose per recorder
        ↓ 7-panel review iteration → all green
Phase 3  agentfootprint-lens      — consume new shapes, scope by runId
        ↓ 7-panel review iteration → all green
Phase 4  agent-playground         — end-to-end validation
        ↓ 7-panel review iteration → all green
Release  ecosystem version bump in lockstep
```

---

## 11. Risks not yet mitigated

- **Codemod completeness**: a manual edit on a recorder we miss will compile but produce wrong output. Mitigation: comprehensive test coverage + grep audit.
- **External consumers we don't know about**: low likelihood (no public release of footprintjs yet per project owner). Mitigation: ship `MIGRATION-5.md` regardless.
- **Documentation drift**: docs need to be refreshed in lockstep with code. Mitigation: doc updates included in each phase's PR; reviewer checks.

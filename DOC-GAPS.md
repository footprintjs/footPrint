# Doc Gaps — found by tracing where an AI reviewer's assumptions went wrong

*Method: the staff-engineer review made 2 refuted/partial claims and several near-misses. Each one is
traced back to the missing or misleading comment/doc that produced it. Fixing these makes the codebase
harder for the NEXT agent (or human) to misread. June 2026.*

---

## Part 1 — The gaps, traced

### Gap F-1 · `MAX_EXECUTE_DEPTH` JSDoc actively misleads (caused refuted claim #3)
FlowchartTraverser.ts:167–184. The comment says *"budget roughly 2 × (avg stages per subflow) of headroom"* — that formula only makes sense if subflow internals consume parent depth. **They don't** (each mount spawns a fresh traverser, depth 0). If each mount costs ~2 parent ticks, headroom is `2 × (number of mounts)`, not `2 × (stages per subflow)`. I read the formula as written → estimated 10–15 frames/agent-iteration → wrong wall at 35–50. The single missing sentence: *"Depth is PER-TRAVERSER. A mounted subflow runs in a fresh traverser whose counter starts at 0; subflow internals never count against the parent. Only the parent's own chain (including every loopTo iteration) accumulates."*

### Gap F-2 · The fresh-traverser fact is implemented but never stated
`_executeDepth` field comment (FlowchartTraverser.ts:148–153) and `createSubflowTraverserFactory` (:251–299) — neither says the counter is per-instance and resets per subflow. The code says it (a `new FlowchartTraverser` per mount) but no comment connects that to the depth model. Both refuted/partial claims (#3, #15b "caps total stages per run") trace here.

### Gap F-3 · No "execution limits" section anywhere in docs
CLAUDE.md mentions depth only inside a loop note ("depth guard (500) fires before iteration limit (1000)") — which *reinforces* the wrong whole-run framing. Missing: one doc section with the complete model — what increments depth, what resets it, how `maxDepth` interacts with loops/subflows/V8 stack, and the measured numbers (7.0 frames per full-feature agent iteration, wall ≈ 71).

### Gap A-1 · `clampIterations(50)` has no rationale comment (caused my wrong urgency AND hid the real coupling)
agentfootprint validators.ts:42–46. Why 50? Nothing says. The verifier's own word was "accidentally" inside the envelope — meaning even the owners' reasoning wasn't recorded. A comment like *"50 ≈ safe under footprintjs MAX_EXECUTE_DEPTH=500 at ~7 frames/iteration (measured; see bench X). Do not raise without footprintjs trampoline (#15)"* would have prevented my claim entirely **and** documented the #16→#15 dependency that everyone now agrees is the real issue.

### Gap A-2 · Cross-repo knowledge is invisible from the other repo (caused #10 to be a rediscovery)
footprintjs CLAUDE.md tells the `failFast` origin story ("swallowed a failing Tools slot in the agent request-assembly fork") — but agentfootprint's `core-flow/Parallel.ts` carries no comment that it *hasn't adopted* failFast and should. The knowledge existed in repo A's docs about repo B's bug; repo B's code is silent. Any boundary where one repo's docs explain another repo's behavior needs a stub comment on the code side.

### Gap F-5 · A false comment is worse than none (almost hid #13)
StageContext.ts:108: *"pay clone cost only if stage writes"* — untrue; `getValue()` instantiates the buffer too (:204–207). I caught it by reading both lines together, but the comment is an active trap. Until the code changes, the comment must state the truth: *"NOTE: currently created on first READ as well — see BACKLOG #13."*

### Gap F-7 · Commit-on-error has no comment at the line that does it
FlowchartTraverser.ts:730: the error path calls `context.commit()` bare — no explanation — while the pause path directly above carries a beautiful rationale comment. "Failed stage's partial writes are committed deliberately: they're evidence" lives nowhere near the code. I initially read it as a transaction-semantics bug; the name `TransactionBuffer` amplifies the misread (implies rollback that doesn't exist).

### Gap F-8 · `getState()` JSDoc implies a copy; it returns the live reference
SharedMemory.ts:53–56: *"Gets the entire state as a JSON object"* reads as a serialized copy. It returns `this.context` live. Same for `getSnapshot().sharedState` and the checkpoint docs ("store it in Redis") — nothing says "LIVE reference, do not mutate." Fed finding #8; until #8 lands, the JSDoc must carry the warning.

### Gap A-3 · Docs ahead of code with no status marker (the #5 causal overclaim)
README/CLAUDE.md sell "replay decision evidence, zero hallucination"; `writeSnapshot.ts:97–99` has the TODO. The only honest marker was an inline `// Populated by a follow-up FlowRecorder integration` — invisible from the docs. Features need a shipped/scaffolded status column in docs, or the claim reads as fact.

### Gap A-4 · No cost-model documentation for scope-resident history
Nothing in agentfootprint says "conversation history lives in footprintjs scope ⇒ inherits per-stage clone cost; O(N²·M) shape." I derived it only because I'd read footprintjs internals first. An agentfootprint-only reader (human or AI) cannot discover this from agentfootprint's docs.

### Gap F-6 · "Idempotent attach" is layer-dependent and the lower layer doesn't say so
CLAUDE.md: "every attach is idempotent by ID." True for `executor.attach*`; false for `FlowRecorderDispatcher.attach()` (exported via `/advanced`, just pushes). My sub-reviewer flagged it as a contract violation; cost a verification round-trip. The dispatcher needs one line: *"No dedup here — executor layer dedupes; /advanced users must dedupe by id themselves."*

---

## Part 2 — Task list (comments · docs · md · examples)

**Inline comments (S, do in one pass)**
- [ ] D1. [F] Rewrite `MAX_EXECUTE_DEPTH` JSDoc: per-traverser scoping sentence + corrected headroom formula (`2 × mounts`, not `2 × stages-per-subflow`) + pointer to limits doc. *(FlowchartTraverser.ts:167–184)*
- [ ] D2. [F] `_executeDepth` field + `createSubflowTraverserFactory`: add "fresh counter per subflow traverser" comments. *(:148–153, :251–299)*
- [ ] D3. [F] Fix the false lazy-buffer comment to state current truth + BACKLOG #13 link. *(StageContext.ts:108)*
- [ ] D4. [F] Comment the bare `context.commit()` on the error path: "deliberate — failed-stage writes are evidence, not rolled back." *(FlowchartTraverser.ts:730)*
- [ ] D5. [F] `getState()` / `getSnapshot()` / checkpoint JSDoc: "returns LIVE reference — do not mutate (until #8)." *(SharedMemory.ts:53, ExecutionRuntime.ts:122)*
- [ ] D6. [F] `FlowRecorderDispatcher.attach()`: "no dedup at this layer" note. *(FlowRecorderDispatcher.ts:31)*
- [ ] D7. [A] `clampIterations`: rationale comment with measured frames/iter + "blocked on footprintjs #15" warning. *(validators.ts:42–46)*
- [ ] D8. [A] `Parallel.ts`: comment that footprintjs `failFast` exists for exactly this and is not yet adopted (link BACKLOG #10). *(core-flow/Parallel.ts fan-out site)*

**Docs / md files (S–M)**
- [ ] D9. [F] `docs/guides/execution-limits.md`: the complete depth model — what counts, what resets, loops vs subflows, `maxDepth` vs V8 stack, measured agent numbers. Link from CLAUDE.md + the depth-guard error message.
- [ ] D10. [F] `docs/guides/state-cost-model.md`: clones per read/write/stage today; what #13/#14 change. CLAUDE.md gets the 5-line summary.
- [ ] D11. [A] Feature-status table in README/CLAUDE.md: shipped / scaffolded / planned per headline feature (causal memory = scaffolded until #5).
- [ ] D12. [A] "Inherited from footprintjs" doc section: depth budget, clone cost of scope-resident history, executor-per-run rationale — the cross-repo facts an agentfootprint-only reader can't otherwise learn.
- [ ] D13. [F+A] Convention for cross-repo knowledge: any time repo A's docs explain repo B's behavior, repo B's code gets a stub comment pointing back (audit existing cases: failFast story, ArrayMergeMode/outputMapper concat, propagateBreak).

**Examples / executable docs (M)**
- [ ] D14. [F] `examples/runtime-features/limits/01-depth-probe.ts`: prints frames-per-iteration and peak depth for a loop + subflow chart — the executable version of D9 (same script seeds BACKLOG #12/#17).
- [ ] D15. [A] `examples/features/limits-and-cost.ts`: full-feature agent at N iterations printing peak depth + history clone bytes — makes A-1/A-4 measurable by any future agent instead of estimable.
- [ ] D16. [F+A] CI check: grep-style test that every BACKLOG-referenced "known untruth" comment (D3, D5, D7) is removed when its backlog item closes — comments with expiry conditions.

*Pattern worth keeping: every gap above is a place where the code knew something the comments/docs didn't say, or the docs said something the code didn't do. Both directions broke an AI reader the same way they'd break a new hire.*

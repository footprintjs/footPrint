# Narrative

## Purpose

This module produces a human-readable execution story during pipeline traversal. Instead of reconstructing what happened after the fact from structured `FlowMessage` data, the narrative is generated at traversal time — the richest context point — where stage names, decider rationale, loop iterations, and subflow boundaries are all immediately available. The result is an ordered array of plain-English sentences that any consumer (a cheaper LLM, a follow-up agent, a logging system) can use directly without parsing technical structures.

## Key Concepts

- **INarrativeGenerator**: The interface that handlers call during traversal to append sentences. Coding to an interface enables the Null Object swap between active and disabled modes.
- **NarrativeGenerator**: The active implementation that accumulates sentences in execution order, applying consistent sentence patterns for each event type (stage execution, transitions, decisions, forks, loops, subflows, errors).
- **NullNarrativeGenerator**: The Null Object implementation — all methods are empty bodies. When narrative is disabled (the default), handlers call this unconditionally with zero allocation, zero string formatting, and zero branching overhead.
- **Opt-in via `enableNarrative()`**: Narrative generation is off by default. Consumers call `enableNarrative()` on `FlowChartExecutor` to activate it. Production pipelines that don't need it pay zero cost.
- **Traversal-time generation**: Sentences are appended as handlers execute, not reconstructed later. This guarantees execution-order fidelity and avoids a post-processing walk.

## Design Decisions

1. **Null Object pattern over conditional checks**: Rather than sprinkling `if (narrativeEnabled)` guards in every handler, the Pipeline holds an `INarrativeGenerator` reference that is either a real `NarrativeGenerator` or a `NullNarrativeGenerator`. Handlers call methods unconditionally. This keeps handler code clean and eliminates per-call branching.
2. **Traversal-time over post-hoc reconstruction**: Generating sentences during execution captures the richest context (display names, rationale, iteration counts) without needing a second pass. Trade-off: a small runtime cost when enabled, but zero cost when disabled.
3. **Defensive copy from `getSentences()`**: Returns a shallow copy of the internal array so callers cannot mutate the generator's state. This preserves integrity across multiple reads at the cost of one array spread per call.
4. **`isFirstStage` flag for opening sentence**: The first stage uses a distinct pattern ("The process began with…") to give the narrative a natural start. Subsequent stages are narrated via transition events (`onNext`, `onDecision`, etc.) to avoid duplicate mentions.

## Files Overview

| File | Purpose |
|------|---------|
| `types.ts` | `INarrativeGenerator` interface — the contract handlers call to append sentences |
| `NarrativeGenerator.ts` | Active implementation that accumulates plain-English sentences in execution order |
| `NullNarrativeGenerator.ts` | No-op implementation for zero-cost when narrative is disabled |
| `index.ts` | Barrel export for the module |

## Usage Example

```typescript
import { NarrativeGenerator, NullNarrativeGenerator, INarrativeGenerator } from './narrative';

// Active narrative (when enableNarrative() is called):
const narrator: INarrativeGenerator = new NarrativeGenerator();

narrator.onStageExecuted('validateInput', 'validate user input');
narrator.onNext('validateInput', 'checkPerms', 'check permissions');
narrator.onDecision('roleCheck', 'admin', 'grant full access', 'the user role equals admin');
narrator.onLoop('retryStage', 'retry request', 2);
narrator.onBreak('finalStage', 'final validation');

narrator.getSentences();
// → [
//   "The process began with validate user input.",
//   "Next, it moved on to check permissions.",
//   "A decision was made: the user role equals admin, so the path taken was grant full access.",
//   "On pass 2 through retry request.",
//   "Execution stopped at final validation."
// ]

// Disabled narrative (the default — zero cost):
const nullNarrator: INarrativeGenerator = new NullNarrativeGenerator();
nullNarrator.onStageExecuted('anyStage'); // no-op
nullNarrator.getSentences(); // → []
```

## Related Modules

- `../Pipeline.ts` — Creates the `NarrativeGenerator` or `NullNarrativeGenerator` based on the `enableNarrative` flag and passes it to handlers via `PipelineContext`
- `../FlowChartExecutor.ts` — Exposes `enableNarrative()` and `getNarrative()` as the public API for consumers
- `../handlers/` — Handler modules (`DeciderHandler`, `ChildrenExecutor`, `LoopHandler`, `SubflowExecutor`) call `INarrativeGenerator` methods during traversal
- `../types.ts` — `PipelineContext` holds the `narrativeGenerator` field that handlers access

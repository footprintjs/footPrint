# Narrative Generation: Runtime Execution Stories

## What It Is

`NarrativeGenerator` produces plain-English sentences during pipeline execution. It captures 11 event types — stage execution, transitions, decisions, loops, forks, selectors, subflows, breaks, and errors — and converts them to natural language.

Build-time description says "what I CAN do." Runtime narrative says "what I DID."

## Relatability

**Human:** A doctor who writes a full report after examining a patient. The next doctor reads the report and continues treatment without re-examining. Without the report, the next doctor starts from scratch — wasted time, repeated tests.

**LLM Bridge:** Runtime narrative is the "doctor's report." Inject it into the next LLM call's context. The model continues where the previous one left off. Follow-up questions get answered from the narrative — no additional tool calls needed.

## How to Use

### Enable Narrative

```typescript
// Option 1: Enable at build time
const chart = flowChart('start', startFn)
  .addFunction('process', processFn)
  .enableNarrative()
  .build();

// Option 2: Enable at execution time
const executor = new FlowChartExecutor(chart, scopeFactory);
executor.enableNarrative();
await executor.run();

// Option 3: Via AgentExecutor (always enabled)
const executor = new AgentExecutor(buildResult);
await executor.run('user message');
const narrative = executor.getNarrative();
```

### Get the Narrative

```typescript
const sentences = executor.getNarrative();
// → [
//   "The process began: Prepare the agent and load tools.",
//   "Next step: Combine system instructions with conversation history.",
//   "Next step: Send the message to the LLM.",
//   "A decision was made: hasToolCalls=true, so the path taken was Execute Tools.",
//   "1 paths were executed in parallel: search.",
//   "On pass 1: Send the message to the LLM again.",
//   "A decision was made: hasToolCalls=false, so the path taken was Finalize.",
// ]
```

### Narrative Sentence Patterns

The NarrativeGenerator produces different sentence patterns for each event type:

| Event | With Description | Without Description |
|-------|-----------------|-------------------|
| First stage | "The process began: {description}." | "The process began with {name}." |
| Next stage | "Next step: {description}." | "Next, it moved on to {name}." |
| Decision | "It {deciderDescription}: {rationale}, so it chose {branch}." | "A decision was made, and the path taken was {branch}." |
| Loop | "On pass {N}: {description} again." | "On pass {N} through {name}." |
| Fork | "{N} paths were executed in parallel: {children}." | — |
| Selector | "{selected} of {total} paths were selected: {names}." | — |
| Subflow entry | "It entered the {name} subflow." | — |
| Subflow exit | "It exited the {name} subflow." | — |
| Break | "Execution was stopped at {name}." | — |
| Error | "An error occurred at {name}: {message}." | — |

### Zero-Cost When Disabled

When narrative is not enabled, the Pipeline uses `NullNarrativeGenerator` — a no-op implementation with empty method bodies. Zero allocation, zero string work.

```typescript
// Production: no narrative overhead
const executor = new FlowChartExecutor(chart, scopeFactory);
await executor.run(); // NullNarrativeGenerator used internally

// Debug/agent: opt in
executor.enableNarrative();
await executor.run(); // Real NarrativeGenerator used
```

## Narrative Alone vs Narrative + Recorder Data

### Narrative Only (Flow Control)

```
1. The process began: Prepare the agent and load tools.
2. Next step: Combine instructions and history into a message.
3. Next step: Send the message to the LLM.
4. A decision was made: hasToolCalls=true, so it chose Execute Tools.
5. 1 paths were executed in parallel: getUserDetails.
6. On pass 1: Send the message to the LLM again.
7. A decision was made: hasToolCalls=false, so it chose Finalize.
```

The LLM knows getUserDetails ran, but NOT what it returned. It can't answer "What billing plan is the user on?"

### Narrative + NarrativeRecorder Data (Full Trace)

```
1. The process began: Prepare the agent and load tools.
2. Next step: Combine instructions and history into a message.
3. Next step: Send the message to the LLM.
     - Wrote: agent.lastResponse = {content, toolCalls, model, usage}
4. A decision was made: hasToolCalls=true, so it chose Execute Tools.
5. 1 paths were executed in parallel: getUserDetails.
     - Read: applicant.userId = "12345"
     - Wrote: user.name = "Jane Smith"
     - Wrote: user.plan = "Business Pro"
     - Wrote: user.billing_cycle = "annual"
6. On pass 1: Send the message to the LLM again.
     - Wrote: agent.lastResponse = {content, model, usage}
7. A decision was made: hasToolCalls=false, so it chose Finalize.
```

Now the LLM reads line 5: plan="Business Pro", billing_cycle="annual." It answers immediately without re-calling getUserDetails.

### How to Combine Them

```typescript
import { NarrativeRecorder } from 'footprint/dist/scope/recorders/NarrativeRecorder';

// Create both recorders
const narrativeRecorder = new NarrativeRecorder({ detail: 'full' });

// Attach to agent
const build = AgentBuilder.agent('myAgent', { provider, toolRegistry })
  .withRecorder(narrativeRecorder)
  .build();

// Run
const executor = new AgentExecutor(build);
await executor.run('user message');

// Get flow narrative (from NarrativeGenerator)
const flowNarrative = executor.getNarrative();
// → ["The process began: ...", "Next step: ...", ...]

// Get data narrative (from NarrativeRecorder)
const dataNarrative = narrativeRecorder.toFlatSentences();
// → ["CallLLM: Wrote: agent.lastResponse = {content, model, usage}", ...]

// Or get per-stage data for merging
const perStage = narrativeRecorder.toSentences();
// → Map { 'CallLLM' => ['  - Wrote: agent.lastResponse = ...'], ... }
```

## NarrativeRecorder API

The `NarrativeRecorder` is a scope-level recorder (like `DebugRecorder`) that captures per-stage reads and writes for narrative enrichment.

```typescript
import { NarrativeRecorder } from 'footprint/dist/scope/recorders/NarrativeRecorder';

const recorder = new NarrativeRecorder({
  id: 'my-narrative',     // Optional ID
  detail: 'full',         // 'full' (default) or 'summary'
  maxValueLength: 80,     // Max chars for value summaries
});

// Attach to scope (or use builder.withRecorder())
scope.attachRecorder(recorder);

// After execution:

// Structured data per stage
recorder.getStageData();
// → Map { 'CallLLM' => { reads: [...], writes: [...] } }

// Text sentences per stage (for merging with NarrativeGenerator)
recorder.toSentences();
// → Map { 'CallLLM' => ['  - Read: agent.messages = (3 items)', '  - Wrote: agent.lastResponse = {content, model}'] }

// Flat sentences with stage prefix
recorder.toFlatSentences();
// → ['CallLLM: Read: agent.messages = (3 items)', 'CallLLM: Wrote: agent.lastResponse = {content, model}']

// Detail modes
recorder.setDetail('summary');
recorder.toSentences();
// → Map { 'CallLLM' => ['  - Read 1 value, wrote 1 value'] }

// Reset for next run
recorder.clear();
```

### Value Summarization

NarrativeRecorder summarizes values to prevent token bloat:

| Value Type | Summary |
|-----------|---------|
| `undefined` | `undefined` |
| `null` | `null` |
| `"hello"` | `"hello"` |
| `"very long..."` | `"very long..." (truncated)` |
| `42` | `42` |
| `true` | `true` |
| `[1, 2, 3]` | `(3 items)` |
| `{ name: "John" }` | `{name}` |

## ROI

- **Eliminate follow-up tool calls:** Recorder data in narrative provides actual values for subsequent questions. Each avoided call saves $0.03-0.10.
- **Cheaper post-analysis:** A cheaper model reads the full narrative+recorder trace instead of the expensive model re-running the pipeline.
- **Context engineering:** 15-30% first-try accuracy improvement. The LLM has all values, not just flow.
- **Escalation efficiency:** Like a full patient report with lab results. The next handler has complete context including actual data values.

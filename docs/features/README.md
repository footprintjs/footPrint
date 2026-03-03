# The Cascade: How Stage Descriptions, Observability, and Narrative Work Together

FootPrint has three features that form a **cascade** — each builds on the one below it, creating a system where individual stage descriptions accumulate upward into tool/agent identity for LLMs, and runtime narrative provides execution history for follow-up context.

## The Problem

Two tools with similar names. An LLM needs to pick one:

```
tools: [
  { name: "getUserDetails", description: "Gets user details" },
  { name: "getUserInfo",    description: "Gets user info" }
]
```

The LLM guesses. 50/50 chance of picking wrong. Retry costs $0.03-0.10 per call. At scale, 3-5 retries per tool selection adds up fast.

The same problem applies to sub-agents in Hierarchy and Swarm patterns — a coordinator with vague agent descriptions delegates to the wrong specialist.

## The Cascade

```
Stage descriptions (bottom)     --> each stage carries its purpose
  | accumulate at build time
Tool/Agent description (mid)    --> LLM sees the full inner workflow
  | inform routing decisions
Coordinator LLM (top)           --> picks the right tool/agent on first try
  | after execution
Runtime narrative               --> tells what happened, enables follow-up answers
```

### How It Solves the Problem

**Without stage descriptions:**

Both tools say "Gets user info." The LLM can't distinguish them.

**With stage descriptions:**

```
getUserDetails:
  FlowChart: FetchRegistered
  Steps:
  1. ValidateUserId
  2. FetchFromRegisteredUsersTable -- Query registered users by ID
  3. IncludeBillingInfo -- Attach payment and subscription data

getUserInfo:
  FlowChart: FetchGuest
  Steps:
  1. ValidateSessionId
  2. FetchFromGuestSessions -- Query guest browse sessions
  3. IncludeBrowseHistory -- Attach page views and search queries
```

The LLM picks correctly on the first try. Registered user with billing question? `getUserDetails`. Anonymous visitor behavior? `getUserInfo`.

## Build-Time vs Runtime

| | Build-time (Description) | Runtime (Narrative) |
|---|---|---|
| **When** | FlowChart construction | FlowChart execution |
| **What** | "Here's what I CAN do" | "Here's what I DID" |
| **Who reads it** | LLM selecting tools/agents | LLM answering follow-ups |
| **Analogy** | A job applicant's resume | A doctor's examination report |

**Build-time description** is the capability map. It tells the LLM what each tool does so it can pick the right one.

**Runtime narrative** is the execution trace. It tells the next LLM call what happened so it can answer follow-up questions without re-running the pipeline.

## Feature Index

| Feature | What It Does | Key Benefit |
|---------|-------------|-------------|
| [Stage Descriptions](stage-descriptions.md) | Self-documenting FlowCharts for LLM tool understanding | LLMs pick the right tool on first try |
| [Recorders](recorders.md) | Composable observers for debugging, metrics, narrative, and cost tracking | Full operational visibility with zero-overhead when disabled |
| [Traversal Extractor](traversal-extractor.md) | Per-stage data capture during execution | Stage-level snapshots for debugging, auditing, and custom dashboards |
| [Observability](observability-enriched-snapshots.md) | The 3-layer observability model and enriched snapshots | Debug without re-running. Know what values flowed where. |
| [Narrative Generation](narrative-generation.md) | Plain-English execution stories for LLM context engineering | Follow-up questions answered from trace, no re-execution |

## Concrete LLM Prompt Example

Here's what the system prompt looks like with and without the cascade:

**Without descriptions:**
```json
{
  "tools": [
    { "name": "getUserDetails", "description": "Gets user details" },
    { "name": "getUserInfo", "description": "Gets user info" }
  ]
}
```

**With cascade (auto-generated from stage descriptions):**
```json
{
  "tools": [
    {
      "name": "getUserDetails",
      "description": "FlowChart: FetchRegistered\nSteps:\n1. ValidateUserId\n2. FetchFromRegisteredUsersTable -- Query registered users by ID\n3. IncludeBillingInfo -- Attach payment and subscription data"
    },
    {
      "name": "getUserInfo",
      "description": "FlowChart: FetchGuest\nSteps:\n1. ValidateSessionId\n2. FetchFromGuestSessions -- Query guest browse sessions\n3. IncludeBrowseHistory -- Attach page views and search queries"
    }
  ]
}
```

The LLM sees exactly what each tool does internally. No manual description writing needed.

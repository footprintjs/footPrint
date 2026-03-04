# Stage Descriptions: Self-Documenting FlowCharts

## What It Is

Every FlowChartBuilder method accepts a `description` parameter. At build time, these descriptions accumulate into `FlowChart.description` (a numbered step list) and `FlowChart.stageDescriptions` (a per-stage map). When registered as a tool, the description is auto-extracted as the tool description.

Zero manual description writing. Stages describe themselves.

## Relatability

**Human:** An airport arrivals board showing every flight's origin, gate, and status. Without it, passengers wander between gates asking "Is this the flight from Chicago?" With it, they walk directly to the right gate.

**LLM Bridge:** The description IS the arrivals board for an LLM choosing between tools. Each stage says where data comes from and what it does. The LLM doesn't wander between tools — it picks the right one immediately.

## How to Use

### Adding Descriptions to Stages

The `description` parameter is the 5th argument on builder methods:

```typescript
flowChart('stageName', stageFunction, 'stage-id', 'Display Name', 'What this stage does')
```

Every builder method supports it:

```typescript
const chart = flowChart('validate', validateFn, 'validate', undefined, 'Check that the user ID exists and is valid')
  .addFunction('fetch', fetchFn, 'fetch', undefined, 'Query the registered users table by ID')
  .addFunction('enrich', enrichFn, 'enrich', undefined, 'Attach payment and subscription data')
  .build();
```

### What You Get at Build Time

After `build()`, the FlowChart object contains:

```typescript
chart.description
// → "FlowChart: validate\nSteps:\n1. validate — Check that the user ID exists and is valid\n2. fetch — Query the registered users table by ID\n3. enrich — Attach payment and subscription data"

chart.stageDescriptions
// → Map {
//     'validate' => 'Check that the user ID exists and is valid',
//     'fetch' => 'Query the registered users table by ID',
//     'enrich' => 'Attach payment and subscription data'
//   }
```

### All Builder Patterns Support Descriptions

**Linear chain:**
```typescript
flowChart('seed', seedFn, 'seed', undefined, 'Initialize the pipeline')
  .addFunction('process', processFn, 'process', undefined, 'Transform the raw data')
  .build();
```

**Decider function (scope-based):**
```typescript
builder
  .addDeciderFunction('classify', classifyFn, 'classify', undefined, 'Classify the request type')
  .addBranch('billing', billingFn, 'billing', undefined, 'Handle billing inquiries')
  .addBranch('technical', technicalFn, 'technical', undefined, 'Resolve technical issues')
  .endDecider()
  .build();
```

**Fork (parallel execution):**
```typescript
builder
  .addFork('parallel')
  .addBranch('research', researchFn, 'research', undefined, 'Research the topic')
  .addBranch('factcheck', factcheckFn, 'factcheck', undefined, 'Verify claims')
  .endFork()
  .build();
```

**Selector (conditional parallel):**
```typescript
builder
  .addSelector('pick', selectorFn, 'pick', undefined, 'Select relevant data sources')
  .addBranch('db', dbFn, 'db', undefined, 'Query the database')
  .addBranch('cache', cacheFn, 'cache', undefined, 'Check the cache')
  .endSelector()
  .build();
```

### How It Flows to LLMs

When using AgentFootPrints, `ToolRegistry.registerTool()` auto-extracts `FlowChart.description` as the tool description. Developers writing agent tools don't need to manually write descriptions:

```typescript
// This happens automatically inside ToolRegistry.registerTool()
const toolDefinition = {
  name: agentBuild.name,
  description: agentBuild.flowChart.description, // Auto-extracted!
  inputSchema: { ... },
  handler: async (input) => { ... },
};
```

### The LLM System Prompt Before and After

**Without descriptions:**
```
Available tools:
- getUserDetails: Gets user details
- getUserInfo: Gets user info
```

**With descriptions (auto-generated):**
```
Available tools:
- getUserDetails:
    FlowChart: FetchRegistered
    Steps:
    1. ValidateUserId — Check that the user ID exists and is valid
    2. FetchFromRegisteredUsersTable — Query registered users by ID
    3. IncludeBillingInfo — Attach payment and subscription data

- getUserInfo:
    FlowChart: FetchGuest
    Steps:
    1. ValidateSessionId — Check the session token is active
    2. FetchFromGuestSessions — Query guest browse sessions
    3. IncludeBrowseHistory — Attach page views and search queries
```

## ROI

- **Cheaper coordinator models:** With full tool context, GPT-3.5-class models can route as accurately as GPT-4, at a fraction of the cost.
- **First-try accuracy:** Eliminates 3-5 retries per tool selection. Each retry costs $0.03-0.10 in LLM calls.
- **Developer time:** No manual tool description writing. Stages self-document as they're built.
- **Maintenance:** When a stage changes, the description updates automatically. No separate docs to keep in sync.

## Runtime Narrative Uses Descriptions Too

The same descriptions that inform build-time tool definitions also power runtime narrative. When narrative generation is enabled, the `NarrativeGenerator` uses each stage's `description` to produce natural sentences:

```
Without description: "Next, it moved on to Call LLM."
With description:    "Next step: Send the assembled message to the LLM and receive its response."
```

See [Narrative Generation](narrative-generation.md) for details.

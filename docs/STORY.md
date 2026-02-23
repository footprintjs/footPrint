# The FootPrint Story

> Every application has a story. FootPrint makes it readable.

---

## The Problem We Saw

Every developer has been in this meeting: someone draws a flowchart on a whiteboard. "First we validate the input, then we call the pricing API, then we check inventory, then we process payment." Everyone nods. The flowchart makes sense.

Then the project starts. The flowchart becomes scattered across files, buried in callbacks, hidden behind abstractions. Six months later, when something breaks in production, nobody can trace what actually happened. The flowchart that everyone understood is gone — replaced by stack traces and log files that only the original developer can decipher.

We asked: **what if the flowchart was the code?**

---

## What FootPrint Actually Is

FootPrint is not a workflow automation tool. It's not n8n, not Step Functions, not a job scheduler.

FootPrint is an **execution abstraction layer**. Like how React abstracts DOM updates with rules for efficient rendering, FootPrint abstracts application execution with rules for **connected, semantic, observable operations**.

You write small functions. You connect them with scope. FootPrint gives you:

- **Connected execution data** — not scattered logs, but a structured trace of every decision, every data flow, every branch taken
- **Semantic operations** — each stage has a name, a description, and a purpose that humans and machines can read
- **Observable by design** — not bolted-on monitoring, but execution traces that are a first-class output of your application

This is not logging. Logging is what developers add after the fact to debug their code. FootPrint produces **execution context** — a complete, structured record of what your application did and why, generated automatically as a byproduct of running your code.

---

## The Origin: Whiteboard to Code

The idea started simple. In every design meeting, someone draws a flowchart:

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Validate │────▶│ Process  │────▶│  Notify  │
└──────────┘     └──────────┘     └──────────┘
```

Everyone understands it. The PM understands it. The designer understands it. The new hire understands it.

Then we write code, and that clarity disappears into `async/await` chains, service classes, and middleware stacks.

FootPrint preserves the flowchart. Your code IS the flowchart. When it runs, it produces a trace that looks like the whiteboard drawing — because it IS the whiteboard drawing, just executable.

```typescript
const chart = flowChart('Validate', validateFn, undefined, undefined, 'Check input data')
  .addFunction('Process', processFn, undefined, undefined, 'Run business logic')
  .addFunction('Notify', notifyFn, undefined, undefined, 'Send confirmation')
  .build();

// After execution, chart.description reads:
// Pipeline: Validate
// Steps:
// 1. Validate — Check input data
// 2. Process — Run business logic
// 3. Notify — Send confirmation
```

The project starts and ends with the same artifact. Everyone — developer, PM, customer — can read it.

---

## Who This Is Really For

### The SaaS Customer Who Pays But Can't See

In a typical SaaS model, the end user gets two things:

1. **The application** — they use it daily
2. **An admin panel** — they can configure some settings

But operations? That's outsourced. When something goes wrong:

1. Customer notices a problem
2. Customer files a support ticket
3. SaaS team investigates (hours to days)
4. SaaS team fixes or recommends a workaround
5. Customer waits

This cycle costs everyone:
- **The customer** pays subscription fees AND waits for resolution
- **The SaaS team** spends engineering time on support instead of features
- **Both sides** lose trust with every slow resolution

### FootPrint Changes the Equation

When your application is built with FootPrint, every execution produces a readable trace. The customer — a non-technical business user — can see:

```
Pipeline: Process Order
Steps:
1. ✅ Validate Cart — Check items and quantities (12ms)
2. ✅ Check Inventory — Verify stock levels (45ms)
3. ❌ Process Payment — Charge customer card (ERROR: Gateway timeout after 30s)
4. ○ Send Confirmation — Not reached
```

They don't need to read code. They don't need to file a ticket. They can see: "Payment gateway timed out. I'll retry later." Or: "This keeps happening — I'll escalate with specific evidence."

**The customer becomes the first responder.**

This means:
- Fewer support tickets (customer self-diagnoses)
- Faster resolution (customer provides exact context when they do escalate)
- Lower subscription costs (less dependency on the SaaS team for operations)
- More trust (transparency builds confidence)

### The Small Business That Can't Afford a DevOps Team

Enterprise companies have SRE teams, observability platforms, and 24/7 on-call rotations. Small businesses don't.

FootPrint gives small businesses the same operational visibility that enterprises get from million-dollar monitoring stacks — built into the application itself, readable by the business owner, not just the developer.

**We're bringing the fortune of the lucky few — the ability to understand and maintain their own application — to everyone.**

---

## Why "FootPrint"?

Think of Google Maps. Before GPS, navigating a new city meant paper maps, asking for directions, and getting lost. Google Maps didn't just give you a map — it gave you a map of YOUR journey, in real time, with every turn visible.

FootPrint does the same for your application's execution. We give you the map. You travel the map. Every step leaves a footprint — a trace of where you've been, what happened, and why.

Your application's execution is no longer a black box. It's a journey you can follow, understand, and explain to anyone.

---

## The AI Angle: Your Application, AI-Compatible

Here's where it gets interesting.

The same execution trace that makes your application understandable to humans also makes it understandable to LLMs.

### Why This Matters

LLM-based applications need structured input. When an LLM calls tools, processes data, and generates responses, the quality of its output depends on the quality of its context. Most applications feed LLMs raw data — unstructured, disconnected, missing the "why."

FootPrint applications produce **structured execution context** as a natural byproduct of running. This context includes:
- What tools were called and what they returned
- What decisions were made and why
- What data flowed between stages
- The complete reasoning chain from input to output

### What This Enables

1. **Chatbots for your end users** — Build a support chatbot that reads your application's execution traces. It can answer "what happened with my order?" by reading the actual execution context, not guessing from logs.

2. **Ops agents for your team** — Build an AI agent that monitors execution traces and flags anomalies. It understands the flowchart structure, so it knows when a stage that usually takes 50ms suddenly takes 5 seconds.

3. **Explainability for decisions** — When your application makes a recommendation (career advice, investment analysis, medical triage), the execution trace shows exactly which data sources influenced the decision and by how much.

4. **Cheaper AI, fewer iterations** — Because the LLM gets rich, structured context instead of raw text, it needs fewer turns to understand the situation. Cheaper models work better. Fewer API calls needed.

**Your application becomes AI-compatible not by adding AI to it, but by making its execution context structured enough for AI to consume.**

---

## What FootPrint Is NOT

Let's be clear about what this library doesn't do:

| FootPrint is NOT | It IS |
|-----------------|-------|
| A workflow automation tool (n8n, Zapier) | An execution abstraction for your application code |
| A job scheduler (Temporal, Step Functions) | A runtime that makes execution observable |
| A logging framework (Winston, Pino) | A system that produces structured execution context |
| An AI/LLM framework (LangChain) | A foundation that makes any application AI-compatible |
| A monitoring platform (Datadog, New Relic) | Built-in observability as a byproduct of execution |

FootPrint is to application execution what React is to DOM updates: **an abstraction with rules that makes the hard thing (understanding what your application did) automatic.**

---

## The Three Libraries

FootPrint is a family of three libraries that work together:

### [FootPrint](https://github.com/sanjay1909/footPrint) (Core Runtime)
The execution abstraction layer. Build flowcharts, execute them, get structured traces. This is the foundation everything else builds on.

### [AgentFootPrint](https://github.com/sanjay1909/agentFootPrints) (AI Agent Layer)
Build LLM-powered agents as flowcharts. Every agent decision, tool call, and response is a traced stage. Sub-agents compose as subflows with isolated scope.

### [FootPrintsDebugUI](https://github.com/sanjay1909/footPrintsExplainableUi) (Visualization Layer)
React components for rendering execution traces as interactive flowcharts. Time-travel debugging, subflow drill-down, and real-time execution monitoring.

Together, they deliver the full vision: **applications whose execution is understandable by developers, business users, and AI alike.**

---

## Start Here

- **[FootPrint README](https://github.com/sanjay1909/footPrint)** — Technical guide to building flowcharts
- **[AgentFootPrint README](https://github.com/sanjay1909/agentFootPrints)** — Building AI agents as flowcharts
- **[Training Path](./training/README.md)** — Learn the concepts from scratch (~2 hours)
- **[Demo Examples](../demo/README.md)** — Progressive examples from simple to complex

---
name: Agent Loop (Pure FootPrint)
group: Use Cases
guide: https://footprintjs.github.io/footPrint/guides/patterns/agent-loop/
---

# Agent Loop — Built with Just footprintjs Primitives

You don't need a separate agent framework. A **ReAct-style agent loop** — reason, act, observe, repeat — is three footprintjs primitives composed together:

```
ReceiveQuery ──> Reason ──> [ tool A | tool B | tool C | finalize ]
                  ↑                                         ↓
                  └───────────── Observe ←──────────────────┘
```

## Why this matters

Most "agent frameworks" (LangChain, CrewAI, Strands) give you a big opinionated loop. footprintjs gives you **the building blocks** — so you can:

- **Trace every decision** — the decider captures which rule matched and why.
- **Trace every tool call** — each branch is a named stage with its own scope writes.
- **Explain the full conversation** — narrative shows reasoning → action → observation → next reasoning, in plain English.
- **Drop in safety primitives** — `pause/resume` for human approval, `redaction` for PII, `contract` for input validation.

No black-box agent "runtime." Every cycle is visible, auditable, and composable with the rest of your system.

## The three primitives

```typescript
.addDeciderFunction('Reason', (scope) => {      // 1. DECIDER — picks what to do next
  return decide(scope, [
    { when: (s) => s.toolsCalled.length > 0, then: 'finalize', label: 'Have info — respond' },
    { when: (s) => /bill/.test(query),        then: 'billing',  label: 'Billing keywords' },
    { when: (s) => /ship/.test(query),        then: 'shipping', label: 'Shipping keywords' },
  ], 'finalize');
}, 'reason')
  .addFunctionBranch('billing', 'CallBillingTool', callBilling)     // 2. BRANCHES — tools
  .addFunctionBranch('shipping', 'CallShippingTool', callShipping)
  .addFunctionBranch('finalize', 'Respond', respond)
  .setDefault('finalize')
  .end()
.loopTo('reason')                                 // 3. LOOP — back to Reason
```

That's it. **`decide()` + branches + `loopTo()` = agent loop.**

## The narrative you get for free

```
1. [Stage: ReceiveQuery] The process began with ReceiveQuery.
   Step 1: Write userQuery = "When will my order arrive?"

2. [Stage: Reason] Decider evaluated 4 rules:
   - Rule 2 'Shipping keywords detected' matched → shipping

3. [Stage: CallShippingTool] Wrote gatheredInfo.shipping, toolsCalled.

4. [Stage: Reason]  (loop iteration 2)
   Decider evaluated 4 rules:
   - Rule 0 'Have info from tools — respond' matched → finalize

5. [Stage: Respond] Wrote finalAnswer. Execution stopped due to break.
```

Every reasoning step is a narrative line. Every tool call is a named stage in the trace. An LLM reading this can answer *"why did the agent call the shipping tool instead of billing?"* — the evidence is right there.

## When to use this pattern vs a dedicated agent framework

| | Pure footprintjs | Dedicated agent framework |
|---|---|---|
| **Scope** | One flow, traced end-to-end | Agent-specific abstractions |
| **Observability** | Full causal trace built-in | Depends on the framework |
| **Learning curve** | Know footprintjs → know this | New vocabulary to learn |
| **Best for** | "Agent as a stage in my pipeline" | "Agent IS the application" |

If you're already using footprintjs for non-agent pipelines, reaching for an agent framework to do *one agent step* is overkill. Use this pattern.

## Extending it

- **Real LLM reasoning:** swap the decider body for a Claude/GPT call that returns one of the branch IDs.
- **Tool result evaluation:** add a stage after each tool branch to score the result.
- **Max iterations guard:** add a rule `{ when: (s) => s.iteration >= s.maxIterations, then: 'finalize' }` at the top.
- **Human approval:** replace a tool branch with `.addPausableFunction` — the agent pauses, a human approves, execution resumes.
- **Multi-turn:** wrap the whole thing in a subflow, mount it inside a conversation loop.

## Related

- **[Claude + FootPrint Tool](./llm-agent-tool.md)** — the inverse pattern: flowchart exposed AS a tool for an LLM.
- **[Loops](../building-blocks/06-loops.md)** — the primitive powering the agent's iteration.
- **[decide() / select()](../building-blocks/03-decider.md)** — the primitive powering the reasoning step.

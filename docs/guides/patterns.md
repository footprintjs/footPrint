# Flowchart Patterns

FootPrint supports seven composition patterns. Each builds on the same fluent builder API.

---

## Linear

Stages execute in sequence. The simplest pattern.

```typescript
import { flowChart } from 'footprintjs';

flowChart('A', fnA)
  .addFunction('B', fnB)
  .addFunction('C', fnC)
  .build();
```

```
A → B → C
```

---

## Parallel (Fork)

Multiple stages run concurrently via `Promise.allSettled`, then rejoin at the next linear stage.

```typescript
flowChart('Fetch', fetchFn)
  .addListOfFunction([
    { id: 'html', name: 'ParseHTML', fn: parseHTML },
    { id: 'css',  name: 'ParseCSS',  fn: parseCSS },
    { id: 'js',   name: 'ParseJS',   fn: parseJS },
  ])
  .addFunction('Merge', mergeFn)
  .build();
```

```
         ┌─ ParseHTML ─┐
Fetch ──>├─ ParseCSS  ─┤──> Merge
         └─ ParseJS   ─┘
```

By default, all children run to completion even if some fail (errors captured as `{ isError: true }`). Use `failFast` to abort immediately on the first error:

```typescript
.addListOfFunction(specs, { failFast: true })
```

---

## Conditional (Decider)

A decider reads scope and returns the ID of **exactly one** branch to execute. Think radio button — single select.

```typescript
flowChart('Classify', classifyFn)
  .addDeciderFunction('Route', (scope) => {
    const type = scope.getValue('fulfillmentType');
    return type === 'digital' ? 'digital' : 'physical';
  })
    .addFunctionBranch('digital', 'DigitalDelivery', digitalFn)
    .addFunctionBranch('physical', 'ShipPackage', shipFn)
    .setDefault('physical')
    .end()
  .build();
```

```
              ┌─ digital ──> DigitalDelivery
Classify ──> Route
              └─ physical ─> ShipPackage
```

The decider function's return value picks the branch. `setDefault()` specifies which branch runs if the return value doesn't match any branch ID.

---

## Multi-Select (Selector)

Like a decider, but returns an **array** of branch IDs — enabling fan-out to multiple branches. Think checkbox — multi select.

```typescript
flowChart('Entry', entryFn)
  .addSelectorFunction('PickChannels', (scope) => {
    const prefs = scope.getValue('notificationPrefs') as string[];
    return prefs; // e.g., ['email', 'sms']
  })
    .addFunctionBranch('email', 'SendEmail', emailFn)
    .addFunctionBranch('sms', 'SendSMS', smsFn)
    .addFunctionBranch('push', 'SendPush', pushFn)
    .end()
  .build();
```

```
              ┌─ email ─> SendEmail
Entry ──> PickChannels ─┤
              └─ sms ──> SendSMS
              (push not selected)
```

---

## Subflow Composition

Mount entire flowcharts as nodes in a larger workflow. Each subflow runs in isolation with its own runtime and memory — clean I/O mapping at boundaries.

```typescript
const faqFlow = flowChart('FAQ_Entry', faqEntryFn)
  .addFunction('FAQ_Answer', faqAnswerFn)
  .build();

const ragFlow = flowChart('RAG_Entry', ragEntryFn)
  .addFunction('RAG_Retrieve', ragRetrieveFn)
  .addFunction('RAG_Answer', ragAnswerFn)
  .build();

const mainChart = flowChart('Router', routerFn)
  .addSubFlowChart('faq', faqFlow, 'FAQ Handler')
  .addSubFlowChart('rag', ragFlow, 'RAG Handler')
  .addFunction('Aggregate', aggregateFn)
  .build();
```

Subflow names are auto-prefixed to prevent collisions: `'FAQ_Entry'` becomes `'faq/FAQ_Entry'` in the parent.

### Input/Output Mapping

Control data flow between parent and subflow:

```typescript
mainChart = flowChart('Router', routerFn)
  .addSubFlowChart('faq', faqFlow, 'FAQ Handler', {
    inputMapper: (parentScope) => ({
      query: parentScope.getValue('userQuery'),
    }),
    outputMapper: (subflowResult) => ({
      answer: subflowResult.response,
    }),
  })
  .build();
```

---

## Streaming (LLM)

Built-in streaming stages for LLM token emission:

```typescript
const chart = flowChart('PreparePrompt', prepareFn)
  .addStreamingFunction('AskLLM', 'llm-stream', askLLMFn)
  .onStream((streamId, token) => process.stdout.write(token))
  .onStreamEnd((streamId, fullText) => console.log('\nDone:', fullText))
  .addFunction('ProcessResponse', processFn)
  .build();
```

---

## Loops

Use `loopTo()` with a stage ID to create back-edges. Combine with `breakFn()` or a decider to control termination.

```typescript
flowChart('Init', initFn)
  .addFunction('AskLLM', askFn, 'ask-llm')
  .addFunction('ParseResponse', parseFn)
  .addDeciderFunction('HasToolCalls', deciderFn)
    .addFunctionBranch('yes', 'ExecuteTools', toolsFn)
    .addFunctionBranch('no', 'Finalize', finalizeFn)
    .end()
  .loopTo('ask-llm')  // loop back until no more tool calls
  .build();
```

```
Init → AskLLM → ParseResponse → HasToolCalls
          ↑                         ├─ yes → ExecuteTools ─┐
          └─────────────────────────┘                      │
                                    └─ no  → Finalize
```

The engine tracks iteration count per node (default max: 1000) to prevent infinite loops.

---

## Combining Patterns

Patterns compose naturally. A real pipeline often mixes several:

```typescript
flowChart('ReceiveApplication', receiveFn)
  .addListOfFunction([                        // parallel
    { id: 'credit', name: 'PullCredit', fn: creditFn },
    { id: 'dti', name: 'CalculateDTI', fn: dtiFn },
    { id: 'emp', name: 'VerifyEmployment', fn: empFn },
  ])
  .addFunction('AssessRisk', assessFn)        // linear
  .addDeciderFunction('Decide', deciderFn)    // conditional
    .addFunctionBranch('approved', 'Approve', approveFn)
    .addFunctionBranch('rejected', 'Reject', rejectFn)
    .addFunctionBranch('review', 'ManualReview', reviewFn)
    .setDefault('review')
    .end()
  .build();
```

---

For architecture details, see [src/lib/builder/README.md](../../src/lib/builder/README.md).

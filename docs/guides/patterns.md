# Flowchart Patterns

FootPrint supports seven composition patterns. Each builds on the same fluent builder API.

---

## Linear

Stages execute in sequence. The simplest pattern.

```typescript
import { flowChart } from 'footprintjs';

flowChart('A', fnA, 'a')
  .addFunction('B', fnB, 'b')
  .addFunction('C', fnC, 'c')
  .build();
```

```
A → B → C
```

---

## Parallel (Fork)

Multiple stages run concurrently via `Promise.allSettled`, then rejoin at the next linear stage.

```typescript
flowChart('Fetch', fetchFn, 'fetch')
  .addListOfFunction([
    { id: 'html', name: 'ParseHTML', fn: parseHTML },
    { id: 'css',  name: 'ParseCSS',  fn: parseCSS },
    { id: 'js',   name: 'ParseJS',   fn: parseJS },
  ])
  .addFunction('Merge', mergeFn, 'merge')
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
flowChart('Classify', classifyFn, 'classify')
  .addDeciderFunction('Route', (scope) => {
    const type = scope.getValue('fulfillmentType');
    return type === 'digital' ? 'digital' : 'physical';
  }, 'route')
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
flowChart('Entry', entryFn, 'entry')
  .addSelectorFunction('PickChannels', (scope) => {
    const prefs = scope.getValue('notificationPrefs') as string[];
    return prefs; // e.g., ['email', 'sms']
  }, 'pick-channels')
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
const faqFlow = flowChart('FAQ_Entry', faqEntryFn, 'faq-entry')
  .addFunction('FAQ_Answer', faqAnswerFn, 'faq-answer')
  .build();

const ragFlow = flowChart('RAG_Entry', ragEntryFn, 'rag-entry')
  .addFunction('RAG_Retrieve', ragRetrieveFn, 'rag-retrieve')
  .addFunction('RAG_Answer', ragAnswerFn, 'rag-answer')
  .build();

const mainChart = flowChart('Router', routerFn, 'router')
  .addSubFlowChart('faq', faqFlow, 'FAQ Handler')
  .addSubFlowChart('rag', ragFlow, 'RAG Handler')
  .addFunction('Aggregate', aggregateFn, 'aggregate')
  .build();
```

Subflow names are auto-prefixed to prevent collisions: `'FAQ_Entry'` becomes `'faq/FAQ_Entry'` in the parent.

### Input/Output Mapping

Control data flow between parent and subflow:

```typescript
mainChart = flowChart('Router', routerFn, 'router')
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
const chart = flowChart('PreparePrompt', prepareFn, 'prepare-prompt')
  .addStreamingFunction('AskLLM', askLLMFn, 'ask-llm', 'llm-stream')
  .onStream((streamId, token) => process.stdout.write(token))
  .onStreamEnd((streamId, fullText) => console.log('\nDone:', fullText))
  .addFunction('ProcessResponse', processFn, 'process-response')
  .build();
```

---

## Loops

Use `loopTo()` with a stage ID to create back-edges. Combine with `scope.$break()` (or the stage function's `breakPipeline` callback) or a decider to control termination.

```typescript
flowChart('Init', initFn, 'init')
  .addFunction('AskLLM', askFn, 'ask-llm')
  .addFunction('ParseResponse', parseFn, 'parse-response')
  .addDeciderFunction('HasToolCalls', deciderFn, 'has-tool-calls')
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
flowChart('ReceiveApplication', receiveFn, 'receive')
  .addListOfFunction([                        // parallel
    { id: 'credit', name: 'PullCredit', fn: creditFn },
    { id: 'dti', name: 'CalculateDTI', fn: dtiFn },
    { id: 'emp', name: 'VerifyEmployment', fn: empFn },
  ])
  .addFunction('AssessRisk', assessFn, 'assess-risk')        // linear
  .addDeciderFunction('Decide', deciderFn, 'decide')         // conditional
    .addFunctionBranch('approved', 'Approve', approveFn)
    .addFunctionBranch('rejected', 'Reject', rejectFn)
    .addFunctionBranch('review', 'ManualReview', reviewFn)
    .setDefault('review')
    .end()
  .build();
```

---

For architecture details, see [src/lib/builder/README.md](../../src/lib/builder/README.md).

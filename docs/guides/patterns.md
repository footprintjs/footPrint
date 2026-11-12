# Flowchart Patterns

FootPrint supports seven composition patterns. Each builds on the same fluent builder API.

---

## Linear

Stages execute in sequence. The simplest pattern.

```typescript
import { flowChart } from 'footprintjs';

const fnA = () => { console.log('A'); };
const fnB = () => { console.log('B'); };
const fnC = () => { console.log('C'); };
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

### Deciding on what a fork wrote

A fork's children write under their own name, `runs/<child id>/`, so two siblings can never overwrite each other's keys. The price: after the fork, a value a child wrote is at the path `runs.html.title`, not at the top-level name `title`.

A `decide()` filter rule reads **top-level state names** and does not follow a path. So this rule can never match, and the decision falls to the default branch:

```typescript
{ when: { 'runs.html.title': { eq: 'Home' } }, then: 'home' }   // reads a key the state does not hold
```

In dev mode (`enableDevMode()`) `decide()` and `select()` warn once per key per run when a rule key contains a `.` and the state holds no key of exactly that name. Nothing is said in production, and nothing about the decision changes. Two ways to read what a fork wrote:

```typescript
// 1. Lift the values to top-level names in a small stage after the fork, then decide by name.
//    The evidence keeps one row per condition: key, operator, threshold, value, result.
.addFunction('LiftTitle', (s) => { s.title = s.$read('runs.html.title') as string; }, 'lift-title')
.addDeciderFunction('Route', (s) => decide(s, [
  { when: { title: { eq: 'Home' } }, then: 'home', label: 'Home page' },
], 'other'), 'route')

// 2. Use a function rule that reads the path. It matches, but its evidence names only what
//    it read (`runs`) and records no operator or threshold.
.addDeciderFunction('Route', (s) => decide(s, [
  { when: (s) => s.$read('runs.html.title') === 'Home', then: 'home', label: 'Home page' },
], 'other'), 'route')
```

Prefer the first when the decision matters: the per-condition evidence is what the narrative and an audit read. A runnable version of both, and of the warning: [examples/build-time-features/decide-select/07-after-a-fork.ts](../../examples/build-time-features/decide-select/07-after-a-fork.ts).

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
    inputMapper: (parent) => ({
      query: parent.userQuery,
    }),
    outputMapper: (subflowResult) => ({
      answer: subflowResult.response,
    }),
  })
  .build();
```

A mapper only reads. It is handed a view of the state: pick values from it and return what the other side should get. Do not change a value in place:

```typescript
inputMapper: (parent) => {
  parent.profile.name = 'changed'; // edits committed state itself; no row records it
  return { name: parent.profile.name };
},
```

Such an edit changes the parent's state with no line in the record, so the record and the state no longer agree. The engine cannot stop it without wrapping every value a mapper reads, so it reports it instead: in dev mode (`enableDevMode()`) each mapper call is checked when it ends, and a change is reported with the mount, the mapper, the key and the path.

To change the parent's state, return the change from the `outputMapper`. What it returns is not simply stored: it is merged into the state, as a recorded write, by these rules.

| The `outputMapper` returns, under a key | What happens to the parent's value |
|---|---|
| a list: `({ list: [item] })` | The items are **added** to the list that is there. Return only the new items. With `arrayMerge: ArrayMergeMode.Replace` on the mount (the enum is on `footprintjs/advanced`) the list **replaces** the one that is there. |
| an object: `({ profile: { name: 'changed' } })` | It is **merged** into the object that is there: each field is written into it. A field that holds a list is added to the list there; a field that holds an object is merged into the object there (its fields replace the ones of the same name). |
| anything deeper than that | It **replaces** what is there. To change `profile.address.geo.lat`, return `geo` whole: `({ profile: { address: { geo: { ...parent.profile.address.geo, lat: 1 } } } })`. |
| a text, a number, `null` | It replaces what is there. |
| a `Map`, a `Set`, a `Date`, a class instance | It is not merged: it **replaces** what is there. Return the whole new value: `({ seen: new Set([...parent.seen, id]) })`. |
| `undefined`, under a key or as a field | The key stays and holds `undefined`. |

Nothing can be removed this way: a field that is not handed back stays, and one handed back as `undefined` keeps its key. To remove something, or to change an item of a list inside an object, use a stage after the mount.

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
    .loopTo('ask-llm')  // only 'yes' loops back
    .addFunctionBranch('no', 'Finalize', finalizeFn)
    .end()
  .build();
```

```
Init → AskLLM → ParseResponse → HasToolCalls
          ↑                         ├─ yes → ExecuteTools ─┐
          └────────────────────────────────────────────────┘
                                    └─ no  → Finalize (end)
```

A `.loopTo()` placed after `.end()` is unconditional: every branch loops, and the run stops only at the iteration cap.

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
